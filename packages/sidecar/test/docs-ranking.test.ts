import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditWriter } from '../src/audit.js';
import {
  headingMatch,
  matchedDocSections,
  parseSectionRefs,
  rankDocuments,
  scoreSections,
  searchDocumentSections,
  sectionMatchesRef,
  type DocSection,
  type DocumentIndexEntry,
} from '../src/docs.js';
import { storeRedactedArtifact } from '../src/redact.js';
import { openStore, type Store } from '../src/store.js';

/**
 * Regression suite for the idf-corpus field failure (memory:
 * vault-ask-retrieval-gap): six differently-phrased asks naming USPTO
 * Example 21 all lost to keyword-frequency decoys. Section identity and
 * heading matches must dominate body similarity.
 */

// The fixture mirrors the real failure shape: §21 "Transmission Of Stock
// Quote Data" holds the answer; §2 is a decoy dense in the generic terms
// (claim, eligibility, abstract) that outranked it in the field.
const USPTO_LINES = [
  'Subject Matter Eligibility Examples',
  '',
  '2. Diagnostic Method Using A Blue Noise Mask',
  'The claim recites detecting eligibility of a sample using a blue noise mask.',
  'Eligibility analysis: the claim is directed to an abstract idea. Claim after claim,',
  'the eligibility discussion repeats eligibility, abstract, abstract idea, and claim.',
  '',
  '21. Transmission Of Stock Quote Data',
  'Background: a system transmits stock quote data to a remote subscriber device.',
  'In SimpleAir, Inc. v. Sony Ericsson Mobile Communications AB, the Federal Circuit',
  'considered analogous claims to transmitting data alerts.',
  'Claim 1 is ineligible because it recites the abstract idea of delivering information.',
  'Claim 2 is eligible: the stock quote alert eligibility limitation integrates the idea',
  'into a practical application by activating the subscriber device on the alert threshold.',
];
const USPTO_TEXT = USPTO_LINES.join('\n');

const USPTO_SECTIONS: DocSection[] = [
  { id: 's1', title: 'Subject Matter Eligibility Examples', level: 1, startLine: 1, endLine: 2, summary: 'preamble' },
  { id: '2', title: 'Diagnostic Method Using A Blue Noise Mask', level: 1, startLine: 3, endLine: 7, summary: 'decoy' },
  { id: '21', title: 'Transmission Of Stock Quote Data', level: 1, startLine: 8, endLine: 14, summary: 'the answer' },
];

describe('parseSectionRefs', () => {
  it('finds named, marked, and generic section references', () => {
    expect(parseSectionRefs('What does Example 21 hold about stock quotes?')).toEqual([
      { label: 'example', number: '21', raw: 'Example 21' },
    ]);
    expect(parseSectionRefs('summarize §21 for me')).toEqual([{ number: '21', raw: '§21' }]);
    expect(parseSectionRefs('what is in section 21')).toEqual([{ number: '21', raw: 'section 21' }]);
    expect(parseSectionRefs('the holding of claim 2 in Example 21')).toEqual([
      { label: 'claim', number: '2', raw: 'claim 2' },
      { label: 'example', number: '21', raw: 'Example 21' },
    ]);
  });

  it('returns nothing for a question with no enumeration', () => {
    expect(parseSectionRefs('how are workpapers retained')).toEqual([]);
  });
});

describe('sectionMatchesRef', () => {
  const numbered = USPTO_SECTIONS[2] as DocSection; // id "21"
  const named: DocSection = { id: 'example-21', title: 'Example 21', level: 2, startLine: 1, endLine: 2, summary: '' };
  const otherLabel: DocSection = { id: 'claim-21', title: 'Claim 21', level: 2, startLine: 1, endLine: 2, summary: '' };

  it('matches a numbered id from every phrasing of the reference', () => {
    for (const ask of ['Example 21', '§21', 'section 21']) {
      const refs = parseSectionRefs(ask);
      expect(refs.length, ask).toBeGreaterThan(0);
      expect(refs.some((r) => sectionMatchesRef(numbered, r)), ask).toBe(true);
    }
  });

  it('matches a named-item id from a bare § reference', () => {
    const refs = parseSectionRefs('§21');
    expect(refs.some((r) => sectionMatchesRef(named, r))).toBe(true);
  });

  it('never crosses labels: an Example ref does not match a Claim section', () => {
    const refs = parseSectionRefs('Example 21');
    expect(refs.some((r) => sectionMatchesRef(otherLabel, r))).toBe(false);
  });

  it('does not match on number alone against a different number', () => {
    const refs = parseSectionRefs('Example 2');
    expect(refs.some((r) => sectionMatchesRef(numbered, r))).toBe(false);
  });
});

describe('headingMatch', () => {
  it('grades exact, strong, partial, and none', () => {
    expect(headingMatch('Transmission Of Stock Quote Data', 'Transmission of stock quote data')).toBe('exact');
    expect(
      headingMatch('Transmission Of Stock Quote Data', 'what does the stock quote data transmission section say'),
    ).toBe('strong');
    expect(headingMatch('Transmission Of Stock Quote Data', 'stock quote alert eligibility')).toBe('partial');
    expect(headingMatch('Diagnostic Method Using A Blue Noise Mask', 'stock quote alert eligibility')).toBe('none');
  });
});

describe('scoreSections and matchedDocSections rank section identity over body similarity', () => {
  const asks = [
    'What does Example 21 hold about stock quote alert eligibility?',
    'summarize §21',
    'What is the holding in the section titled Transmission Of Stock Quote Data?',
    'stock quote alert eligibility',
  ];

  it.each(asks)('ranks §21 first for: %s', (ask) => {
    const matched = matchedDocSections(USPTO_TEXT, USPTO_SECTIONS, ask, 2);
    expect(matched.length).toBeGreaterThan(0);
    // Document order is restored after ranking, so assert membership of the
    // capped set: §21 must survive the cap even though §2 out-frequencies it.
    expect(matched.map((m) => m.section.id)).toContain('21');
    const scored = scoreSections(USPTO_TEXT, USPTO_SECTIONS, ask);
    const s21 = scored.find((s) => s.section.id === '21');
    const s2 = scored.find((s) => s.section.id === '2');
    expect(s21).toBeDefined();
    expect(s2).toBeDefined();
    // The tier, not the body count, is what must dominate.
    expect(['ref', 'exact', 'strong', 'partial']).toContain(s21?.tier ?? 'none');
    expect(s2?.tier).toBe('none');
  });

  it('a section named by enumeration survives a cap of one against a denser decoy', () => {
    const matched = matchedDocSections(USPTO_TEXT, USPTO_SECTIONS, 'summarize Example 21', 1);
    expect(matched.map((m) => m.section.id)).toEqual(['21']);
  });

  it('an enumeration-only ask with no 4-char keywords still targets its section', () => {
    // askKeywords drops "21" (under 4 chars); the ref path must not.
    const matched = matchedDocSections(USPTO_TEXT, USPTO_SECTIONS, '§21', 4);
    expect(matched.map((m) => m.section.id)).toContain('21');
  });
});

describe('rankDocuments is corpus-aware', () => {
  let dir: string;
  let store: Store;
  let entries: DocumentIndexEntry[];

  const DECOY_LINES = [
    '1. Sequencing Disclosure',
    'This disclosure describes claim eligibility for a biotech abstract. Claim eligibility,',
    'claim eligibility, abstract claim, eligibility of the claim, and more eligibility talk.',
    'Every line repeats eligibility and claim and abstract to win any frequency contest.',
  ];

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'docs-ranking-'));
    store = openStore(path.join(dir, 'state.db'));
    const audit = new AuditWriter(path.join(dir, 'audit.jsonl'));
    storeRedactedArtifact(store, audit, {
      id: 'a-uspto',
      sessionId: 's',
      artifactClass: 'doc-serve',
      createdAt: new Date().toISOString(),
      raw: USPTO_TEXT,
      gatesPassed: true,
      meta: { filePath: 'uspto-examples.pdf' },
    });
    storeRedactedArtifact(store, audit, {
      id: 'a-decoy',
      sessionId: 's',
      artifactClass: 'doc-serve',
      createdAt: new Date().toISOString(),
      raw: DECOY_LINES.join('\n'),
      gatesPassed: true,
      meta: { filePath: 'bio-disclosure.txt' },
    });
    const base = { sha256: 'x', bytes: 1, kind: 'text' as const, method: 'utf8-text', ingestedAt: 'now' };
    entries = [
      {
        ...base,
        path: 'bio-disclosure.txt',
        artifactId: 'a-decoy',
        sections: [
          { id: '1', title: 'Sequencing Disclosure', level: 1, startLine: 1, endLine: 4, summary: 'decoy' },
        ],
      },
      { ...base, path: 'uspto-examples.pdf', artifactId: 'a-uspto', sections: USPTO_SECTIONS },
    ];
  });

  afterAll(() => {
    store.close();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // leave it to the OS temp cleaner
    }
  });

  it('a heading-matched document outranks a decoy with more keyword hits', () => {
    const ask = 'What does Example 21 hold about stock quote alert eligibility?';
    const hits = searchDocumentSections(store, entries, ['stock', 'quote', 'alert', 'eligibility']);
    // The decoy genuinely wins on raw hit count...
    const decoyHits = hits.filter((h) => h.path === 'bio-disclosure.txt').length;
    const usptoHits = hits.filter((h) => h.path === 'uspto-examples.pdf').length;
    expect(decoyHits).toBeGreaterThan(0);
    // ...but ranking puts the document whose section identity matches first.
    const ranked = rankDocuments(store, entries, ask, hits);
    expect(ranked[0]?.entry.path).toBe('uspto-examples.pdf');
    expect(ranked[0]?.tier).toBe('ref');
    expect(usptoHits + decoyHits).toBe(hits.length);
  });

  it('a document reachable only by enumeration (zero keyword hits) is still ranked', () => {
    const ranked = rankDocuments(store, entries, 'summarize §21', []);
    expect(ranked.map((r) => r.entry.path)).toContain('uspto-examples.pdf');
  });
});
