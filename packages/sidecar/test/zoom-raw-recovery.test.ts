import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditWriter } from '../src/audit.js';
import { zoom } from '../src/distill.js';
import { sectionText, type DocSection } from '../src/docs.js';
import { storeRedactedArtifact } from '../src/redact.js';
import { openStore, type Store } from '../src/store.js';

/**
 * The zoom byte-recoverability contract (field failure
 * vault-ask-retrieval-gap): a handle must recover its stored raw slice
 * unconditionally — a query narrows within the raw, it never gates access
 * to it, and it never silently drops matching regions.
 */

const USPTO_LINES = [
  'Subject Matter Eligibility Examples',
  '',
  '2. Diagnostic Method Using A Blue Noise Mask',
  'The claim recites detecting eligibility of a sample using a blue noise mask.',
  'Eligibility analysis: the claim is directed to an abstract idea.',
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
const CITATION = 'In SimpleAir, Inc. v. Sony Ericsson Mobile Communications AB, the Federal Circuit';
const CLAIM2_HOLDING = 'Claim 2 is eligible: the stock quote alert eligibility limitation integrates the idea';

const SECTIONS: DocSection[] = [
  { id: 's1', title: 'Subject Matter Eligibility Examples', level: 1, startLine: 1, endLine: 2, summary: 'preamble' },
  { id: '2', title: 'Diagnostic Method Using A Blue Noise Mask', level: 1, startLine: 3, endLine: 6, summary: 'decoy' },
  { id: '21', title: 'Transmission Of Stock Quote Data', level: 1, startLine: 7, endLine: 13, summary: 'the answer' },
];

let dir: string;
let store: Store;
let audit: AuditWriter;

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'zoom-recovery-'));
  store = openStore(path.join(dir, 'state.db'));
  audit = new AuditWriter(path.join(dir, 'audit.jsonl'));
  storeRedactedArtifact(store, audit, {
    id: 'a-doc',
    sessionId: 's',
    artifactClass: 'doc-serve',
    createdAt: new Date().toISOString(),
    raw: USPTO_TEXT,
    gatesPassed: true,
    meta: { filePath: 'uspto-examples.pdf', doc: { sections: SECTIONS } },
  });
  // The doc-search hits artifact: its raw is a subset of hit lines that do
  // NOT contain the citation — exactly the artifact the field session was
  // left holding when ranking failed.
  storeRedactedArtifact(store, audit, {
    id: 'a-hits',
    sessionId: 's',
    artifactClass: 'doc-search',
    createdAt: new Date().toISOString(),
    raw: [
      'uspto-examples.pdf §2:4: The claim recites detecting eligibility of a sample using a blue noise mask.',
      'uspto-examples.pdf §21:8: Background: a system transmits stock quote data to a remote subscriber device.',
    ].join('\n'),
    gatesPassed: true,
    meta: { docRefs: [{ path: 'uspto-examples.pdf', artifactId: 'a-doc' }] },
  });
});

afterAll(() => {
  store.close();
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // leave it to the OS temp cleaner
  }
});

describe('zoom serves the raw slice unconditionally', () => {
  it('no query: the full raw artifact, byte-exact', () => {
    const result = zoom(store, audit, 'a-doc');
    expect(result.found).toBe(true);
    expect(result.text).toBe(USPTO_TEXT);
  });

  it('a query matching nothing serves the full raw, never an error string', () => {
    const result = zoom(store, audit, 'a-doc', 'zebra-nonsense-term');
    expect(result.found).toBe(true);
    expect(result.text).toContain(CITATION);
    expect(result.text).toContain(USPTO_TEXT);
    expect(result.queryMatched).toBe(false);
  });

  it('a section reference recovers the whole raw section byte-exact', () => {
    const s21 = SECTIONS[2] as DocSection;
    const expected = sectionText(USPTO_TEXT, s21);
    for (const query of ['§21', 'Example 21', 'section 21', 'Transmission Of Stock Quote Data']) {
      const result = zoom(store, audit, 'a-doc', query);
      expect(result.text, query).toBe(expected);
      expect(result.text, query).toContain(CITATION);
      expect(result.text, query).toContain(CLAIM2_HOLDING);
      expect(result.queryMatched, query).toBe(true);
    }
  });

  it('a text query windows within the raw: the Simpleair citation line', () => {
    const result = zoom(store, audit, 'a-doc', 'SimpleAir');
    expect(result.text).toContain(CITATION);
    expect(result.queryMatched).toBe(true);
  });

  it('a reference plus residual terms narrows within that section', () => {
    const result = zoom(store, audit, 'a-doc', 'Example 21 SimpleAir');
    expect(result.text).toContain(CITATION);
    expect(result.text).not.toContain('blue noise mask');
  });

  it('a reference whose residual matches nothing still serves the whole section', () => {
    const s21 = SECTIONS[2] as DocSection;
    const result = zoom(store, audit, 'a-doc', '§21 zebra-nonsense-term');
    expect(result.text).toContain(sectionText(USPTO_TEXT, s21));
  });
});

describe('zoom reaches through a hits artifact to the source document', () => {
  it('a section reference on the doc-search artifact serves the section raw', () => {
    const result = zoom(store, audit, 'a-hits', '§21');
    expect(result.text).toContain(CITATION);
    expect(result.text).toContain(CLAIM2_HOLDING);
    expect(result.filePath).toBe('uspto-examples.pdf');
    expect(result.artifactId).toBe('a-doc');
  });

  it('a text query absent from the hit lines still recovers the source line', () => {
    const result = zoom(store, audit, 'a-hits', 'SimpleAir');
    expect(result.text).toContain(CITATION);
    expect(result.queryMatched).toBe(true);
  });
});

describe('zoom never silently drops matching lines', () => {
  it('marks the elision when matches exceed the serve cap', () => {
    const raw = Array.from({ length: 400 }, (_v, i) => `needle line ${i + 1}`).join('\n');
    storeRedactedArtifact(store, audit, {
      id: 'a-wide',
      sessionId: 's',
      artifactClass: 'generic-stdout',
      createdAt: new Date().toISOString(),
      raw,
      gatesPassed: true,
      meta: {},
    });
    const result = zoom(store, audit, 'a-wide', 'needle');
    expect(result.text).toMatch(/\[dcp: omitted \d+ more matching lines/);
  });
});
