import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore plain-mjs fixture generator, no type declarations
import { makeRawStreamPdf, makeUsptoExamplesPdf, writeDocFixtures } from '../../../scripts/doc-fixtures.mjs';
import { AuditWriter } from '../src/audit.js';
import {
  buildStructureMap,
  extractDocument,
  isDocumentPath,
  readDocumentIndex,
  searchDocumentSections,
  sectionText,
  writeDocumentIndex,
  type DocSection,
  type DocumentIndex,
  type DocumentIndexEntry,
} from '../src/docs.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { NoopLlmPass } from '../src/llm.js';
import { storeRedactedArtifact } from '../src/redact.js';
import { openStore } from '../src/store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..', '..');
const docCorpus = path.join(repoRoot, 'fixtures', 'doc-corpus');

const noop = new NoopLlmPass();
let binDir: string;
const indexDirs: string[] = [];

beforeAll(() => {
  binDir = mkdtempSync(path.join(os.tmpdir(), 'doc-fixtures-'));
  writeDocFixtures(binDir);
});

afterAll(() => {
  // Best-effort: on Windows the closed store's handles can outlive the
  // worker's afterAll by long enough to EPERM; a leftover tmpdir is not a
  // test failure.
  for (const dir of [binDir, ...indexDirs]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // leave it to the OS temp cleaner
    }
  }
});

const byId = (sections: DocSection[], id: string): DocSection => {
  const section = sections.find((s) => s.id === id);
  if (section === undefined) throw new Error(`no section ${id} in ${sections.map((s) => s.id).join(',')}`);
  return section;
};

describe('document classification', () => {
  it('recognizes the v1 document extensions and nothing else', () => {
    for (const p of ['a.md', 'b.txt', 'c.pdf', 'd.docx', 'e.markdown']) {
      expect(isDocumentPath(p), p).toBe(true);
    }
    for (const p of ['a.ts', 'b.js', 'c.py', 'd.json', 'e.yaml']) {
      expect(isDocumentPath(p), p).toBe(false);
    }
  });
});

describe('markdown extraction and structure', () => {
  it('maps headings to sections with first-sentence rule summaries', async () => {
    const extraction = extractDocument(path.join(docCorpus, 'billing-policy.md'));
    expect(extraction.kind).toBe('markdown');
    expect(extraction.outOfScope).toBeUndefined();
    const sections = await buildStructureMap(extraction, noop);
    expect(sections.map((s) => s.title)).toEqual([
      'Billing Policy',
      'Invoicing',
      'Late Payment',
      'Disbursements',
    ]);
    // Unnumbered headings get positional ids.
    expect(sections.map((s) => s.id)).toEqual(['s1', 's2', 's3', 's4']);
    const invoicing = byId(sections, 's2');
    // NoopLlmPass returns null, so the summary is the rule fallback: the
    // section body's first sentence.
    expect(invoicing.summary).toContain('Engagement fees are invoiced monthly in arrears');
  });

  it('slices a section byte-exactly from the extracted text', async () => {
    const extraction = extractDocument(path.join(docCorpus, 'billing-policy.md'));
    const sections = await buildStructureMap(extraction, noop);
    const late = byId(sections, 's3');
    const slice = sectionText(extraction.text, late);
    const lines = extraction.text.split(/\r?\n/);
    expect(slice).toBe(lines.slice(late.startLine - 1, late.endLine).join('\n'));
    expect(slice).toContain('1.5% per month');
  });
});

describe('plain-text extraction and structure', () => {
  it('detects numbered and all-caps headings, ids from the numbering', async () => {
    const extraction = extractDocument(path.join(docCorpus, 'retention-schedule.txt'));
    expect(extraction.kind).toBe('text');
    const sections = await buildStructureMap(extraction, noop);
    expect(sections.map((s) => s.id)).toEqual(['s1', '1', '2', '3', '4', '5', '6', '7']);
    expect(byId(sections, 's1').title).toBe('RECORDS RETENTION SCHEDULE');
    const workpapers = byId(sections, '2');
    expect(workpapers.title).toBe('WORKPAPER RETENTION');
    expect(workpapers.summary).toContain('seven years');
  });
});

describe('pdf extraction and structure', () => {
  it('extracts text with page anchors from a script-built multi-page pdf', async () => {
    const extraction = extractDocument(path.join(binDir, 'valuation-report.pdf'));
    expect(extraction.kind).toBe('pdf');
    expect(extraction.outOfScope).toBeUndefined();
    expect(extraction.pages?.length).toBe(2);
    expect(extraction.text).toContain('WACC');
    expect(extraction.text).toContain('USD 2,300,000');
    const sections = await buildStructureMap(extraction, noop);
    const conclusion = byId(sections, '4');
    expect(conclusion.title).toBe('Conclusion of Value');
    expect(conclusion.page).toBe(2);
    expect(byId(sections, '1').page).toBe(1);
  });

  it('declares a text-free pdf out of scope instead of returning silence', () => {
    const extraction = extractDocument(path.join(binDir, 'scanned-notes.pdf'));
    expect(extraction.outOfScope).toMatch(/no extractable text|scanned/i);
    expect(extraction.outOfScope).not.toBe('');
  });
});

describe('extended pdf heading detection', () => {
  // The 109-page USPTO 101 examples PDF surfaced this: default heading
  // detection only knows "1. ", "1.2 ", and ALL-CAPS lines, so headings like
  // "Example 1", "Claim 1", "Part One", lettered outlines, and Title Case
  // banners silently collapsed into one generic preamble with an s1 id and
  // char offsets. This suite locks the new pattern set against a small
  // deterministic PDF that reproduces the same shapes.
  const dir = (): string => {
    const d = mkdtempSync(path.join(os.tmpdir(), 'uspto-fixture-'));
    indexDirs.push(d);
    writeFileSync(path.join(d, 'uspto.pdf'), makeUsptoExamplesPdf());
    return d;
  };

  it('detects Example/Claim/Part/lettered/title-case headings with semantic ids', async () => {
    const extraction = extractDocument(path.join(dir(), 'uspto.pdf'));
    expect(extraction.kind).toBe('pdf');
    const sections = await buildStructureMap(extraction, noop);
    const ids = sections.map((s) => s.id);
    expect(ids).toContain('part-one');
    expect(ids).toContain('example-1');
    expect(ids).toContain('example-2');
    expect(ids).toContain('claim-1');
    expect(ids).toContain('claim-2');
    expect(ids).toContain('a');
    const analysis = sections.find((s) => s.title === 'Analysis of Prior Art');
    expect(analysis, 'title-case standalone heading detected').toBeDefined();
  });

  it('keeps the full heading line as the section title, not just the label', async () => {
    const extraction = extractDocument(path.join(dir(), 'uspto.pdf'));
    const sections = await buildStructureMap(extraction, noop);
    const ex1 = sections.find((s) => s.id === 'example-1');
    expect(ex1?.title).toBe('Example 1: Isolated DNA');
    const letteredA = sections.find((s) => s.id === 'a');
    expect(letteredA?.title).toBe('Preliminary Considerations');
  });

  it('binds sections to their page anchor so citations read as p.N', async () => {
    const extraction = extractDocument(path.join(dir(), 'uspto.pdf'));
    const sections = await buildStructureMap(extraction, noop);
    const ex1 = sections.find((s) => s.id === 'example-1');
    expect(ex1?.page).toBe(1);
    // The Example 2 heading sits after the pageBreak in the fixture.
    const ex2 = sections.find((s) => s.id === 'example-2');
    expect(ex2?.page).toBe(2);
  });

  it('honors per-document extraHeadingPatterns for corpus-specific formats', async () => {
    // A bespoke pattern the built-in detectors do not know: an override lets
    // the corpus owner teach the ingester without patching the detector.
    const text = [
      'Preamble line.',
      '',
      'USPTO-2019-EX-01',
      'Body of the first custom example.',
      '',
      'USPTO-2019-EX-02',
      'Body of the second custom example.',
      '',
    ].join('\n');
    const extraction = { kind: 'text' as const, method: 'utf8-text', text };
    const sections = await buildStructureMap(extraction, noop, {
      extraHeadingPatterns: [/^USPTO-\d{4}-EX-\d+$/],
    });
    const custom = sections.filter((s) => /^USPTO-\d{4}-EX-\d+$/.test(s.title));
    expect(custom.length).toBe(2);
    expect(custom[0]?.id).toBe('uspto-2019-ex-01');
  });
});

describe('pdf logical-line joining (real USPTO operator excerpts)', () => {
  // PR #21's declared gap: the real 109-page USPTO 101 examples PDF emits one
  // visual line as several text-showing fragments. Two mechanisms appear in
  // the wild, both captured here as verbatim excerpts of the decoded content
  // streams (kerning arrays, Tc/Tw noise and all):
  //   (a) same-baseline Td continuation — "(2. )Tj" then "1.5 0 Td" then the
  //       title fragments, each "tx 0 Td" apart (ty = 0, same line);
  //   (b) per-block Tm positioning — page furniture and patched glyphs are
  //       emitted in separate BT/ET blocks whose Tm shares the same y.
  // Before the joining pass, every fragment was its own line and headings
  // like "2. E-Commerce ..." never existed as a matchable token.

  // Excerpt of the decoded stream around Example 2's heading (object 6 of the
  // real PDF): label fragment, then two same-baseline continuations that
  // split mid-word ("/Gen" + "erating"), then the body at a new baseline.
  const TD_FRAGMENT_STREAM = [
    'BT',
    '/TT2 1 Tf',
    '0 Tc 0 Tw 12 0 0 12 72 720 Tm',
    '[(The following exam)8(ples are inform)8(ed by Federal Circuit )]TJ',
    '0 Tc 0 Tw -12.375 -3 Td',
    '(2. )Tj',
    '0.0006 Tc -0.0006 Tw 1.5 0 Td',
    '[(E-Commer)4(ce Outsour)4(c)-1(ing System)4(/Gen)]TJ',
    '-0.0002 Tc 0.0002 Tw 16.615 0 Td',
    '(erating a Composite Web Page )Tj',
    '0.0003 Tc -0.0003 Tw -19.615 -1.645 Td',
    '(The following claim was found eligible by th)Tj',
    '0.0001 Tc -0.0008 Tw 17.815 0 Td',
    '(e Federal Circuit in that the claimed )Tj',
    'ET',
  ].join('\n');

  // Excerpt of object 30: page-header fragments in separate BT/ET blocks, all
  // positioned by Tm at y=744.78, then the body starting at y=708.9. Includes
  // the real duplicated patch glyphs ("s", "t") the producer emits twice.
  const TM_BASELINE_STREAM = [
    'BT',
    '/TT1 1 Tf',
    '0.0012 Tc 0 Tr 11.9773 0 0 12 238.32 744.78 Tm',
    '(Example)Tj',
    'ET',
    'BT',
    '/TT1 1 Tf',
    '0 Tc 11.9773 0 0 12 283.68 744.78 Tm',
    '(s)Tj',
    'ET',
    'BT',
    '/TT1 1 Tf',
    '0.0016 Tc -0.0036 Tw 11.9773 0 0 12 288.3 744.78 Tm',
    '[(: )-248(Abstract)]TJ',
    'ET',
    'BT',
    '/TT1 1 Tf',
    '0.0014 Tc -0.0009 Tw 11.9773 0 0 12 343.32 744.78 Tm',
    '[( Id)7(eas )]TJ',
    'ET',
    'BT',
    '/TT0 1 Tf',
    '0.0017 Tc -0.0037 Tw 11.9773 0 0 12 72.12 708.9 Tm',
    '(In this illustrative hypothetical, the claim recites a method. )Tj',
    'ET',
  ].join('\n');

  const rawPdfIn = (streams: string[]): string => {
    const d = mkdtempSync(path.join(os.tmpdir(), 'uspto-raw-'));
    indexDirs.push(d);
    const file = path.join(d, 'excerpt.pdf');
    writeFileSync(file, makeRawStreamPdf(streams));
    return file;
  };

  it('joins same-baseline Td fragments into one logical line, mid-word joins unspaced', () => {
    const extraction = extractDocument(rawPdfIn([TD_FRAGMENT_STREAM]));
    expect(extraction.outOfScope).toBeUndefined();
    const lines = extraction.text.split('\n');
    expect(lines).toContain('2. E-Commerce Outsourcing System/Generating a Composite Web Page ');
    // The ty≠0 Td after the heading starts a fresh line, joined across its
    // own same-baseline continuation.
    expect(lines).toContain(
      'The following claim was found eligible by the Federal Circuit in that the claimed ',
    );
    // Nothing bled across the baseline boundary.
    expect(
      lines.some((l) => l.includes('Web Page') && l.includes('found eligible')),
      'heading and body remain separate lines',
    ).toBe(false);
  });

  it('the joined three-fragment heading is detected with its numbering as the id', async () => {
    const extraction = extractDocument(rawPdfIn([TD_FRAGMENT_STREAM]));
    const sections = await buildStructureMap(extraction, noop);
    const ex2 = sections.find((s) => s.id === '2');
    expect(ex2, 'joined heading matched NUMBERED_HEADING').toBeDefined();
    expect(ex2?.title).toBe('E-Commerce Outsourcing System/Generating a Composite Web Page');
  });

  it('joins same-y Tm blocks and breaks on a Tm at a different y', () => {
    const extraction = extractDocument(rawPdfIn([TM_BASELINE_STREAM]));
    const lines = extraction.text.split('\n');
    // Patch glyphs excluded, this is the header on one line (the duplicated
    // "s"/"t" patches were trimmed from the excerpt's true sibling blocks —
    // what matters is that the four same-y fragments join).
    expect(lines[0]).toBe('Examples: Abstract Ideas ');
    expect(lines[1]).toBe('In this illustrative hypothetical, the claim recites a method. ');
  });

  it('keeps page attribution intact across joined multi-stream pages', () => {
    const extraction = extractDocument(rawPdfIn([TD_FRAGMENT_STREAM, TM_BASELINE_STREAM]));
    expect(extraction.pages?.length).toBe(2);
    const [p1, p2] = extraction.pages ?? [];
    const lines = extraction.text.split('\n');
    expect(lines.slice((p1?.startLine ?? 1) - 1, p1?.endLine).join('\n')).toContain('E-Commerce');
    expect(lines.slice((p2?.startLine ?? 1) - 1, p2?.endLine).join('\n')).toContain(
      'Examples: Abstract Ideas',
    );
    // The byte-exact slice contract still holds over the joined text.
    const slice = sectionText(extraction.text, { startLine: p2?.startLine ?? 1, endLine: p2?.endLine ?? 1 });
    expect(slice.split('\n')[0]).toBe('Examples: Abstract Ideas ');
  });

  it('does not promote joined lowercase list items to numbered headings', async () => {
    // After joining, list items like "3. continue scanning until ..." become
    // full lines that would match NUMBERED_HEADING but for the lowercase
    // guard: a numbered heading's title never starts lowercase.
    const stream = [
      'BT',
      '0 Tc 0 Tw 12 0 0 12 72 720 Tm',
      '(1. )Tj',
      '1.5 0 Td',
      '(Isolating and Removing Malicious Code)Tj',
      '-1.5 -1.65 Td',
      '(3. )Tj',
      '1.248 0 Td',
      '(continue scanning until no further malicious code marker is found; and )Tj',
      'ET',
    ].join('\n');
    const extraction = extractDocument(rawPdfIn([stream]));
    const sections = await buildStructureMap(extraction, noop);
    expect(sections.find((s) => s.id === '1')?.title).toBe(
      'Isolating and Removing Malicious Code',
    );
    expect(
      sections.find((s) => s.title.startsWith('continue scanning')),
      'lowercase list item stays body text',
    ).toBeUndefined();
  });
});

describe('pdf CID hex-string text (real USPTO pages 40-43)', () => {
  // Field finding on the 109-page USPTO 101 examples PDF: §21's introductory
  // paragraph extracted cleanly but the body — hypothetical claims 1 and 2
  // and the Step 2A/2B analysis — came out as whitespace. Those pages
  // typeset body text in Type0/CID fonts as hex strings, which the literal-
  // only tokenizer skipped; all that survived were the literal space
  // fragments between words. The fonts and their ToUnicode CMaps sit in
  // compressed /ObjStm containers the object scan also could not see. The
  // loss predates the line-joining pass (the pre-join tokenizer was equally
  // literal-only). Fixture: the real pages sliced byte-verbatim, ObjStm
  // containers intact (scripts/slice-pdf-fixture.mjs); the .ref.txt beside
  // it is an independent pypdf extraction of the same pages used as a
  // volume baseline, not a byte-exact expectation.
  const fixture = path.join(here, 'fixtures', 'uspto-101-p40-43.pdf');
  const refFixture = path.join(here, 'fixtures', 'uspto-101-p40-43.ref.txt');
  const norm = (s: string): string => s.replace(/\s+/g, ' ');

  it('decodes Type0 hex-string body text through ObjStm-resident ToUnicode CMaps', () => {
    const extraction = extractDocument(fixture);
    expect(extraction.kind).toBe('pdf');
    expect(extraction.outOfScope).toBeUndefined();
    expect(extraction.pages).toHaveLength(4);
    const text = norm(extraction.text);
    // The literal-string layer that always extracted stays intact.
    expect(text).toContain('21. Transmission Of Stock Quote Data');
    // The CID-hex body that used to extract as whitespace: claim 1's own
    // words, both eligibility conclusions, and the two-step analysis.
    expect(text).toContain('A method of distributing stock quotes');
    expect(text).toContain('remote subscriber computer');
    expect(text).toContain('Claim 1: Ineligible');
    expect(text).toContain('Claim 2: Eligible');
    expect(text).toContain('Step 2A');
    expect(text).toContain('Step 2B');
    expect(text).toContain('significantly more');
  });

  it('holds per-page non-whitespace volume near the independent reference', () => {
    const extraction = extractDocument(fixture);
    const chunks = readFileSync(refFixture, 'utf8').split('\f');
    // The first chunk carries the provenance header comment.
    chunks[0] = (chunks[0] as string)
      .split('\n')
      .filter((l) => !l.startsWith('#'))
      .join('\n');
    const ink = (s: string): number => s.replace(/\s+/g, '').length;
    expect(chunks).toHaveLength(4);
    for (const [i, page] of (extraction.pages ?? []).entries()) {
      const ours = ink(
        sectionText(extraction.text, { startLine: page.startLine, endLine: page.endLine }),
      );
      const reference = ink(chunks[i] as string);
      expect(ours, `page ${40 + i} ink ${ours} vs reference ${reference}`).toBeGreaterThanOrEqual(
        Math.floor(reference * 0.9),
      );
      expect(ours, `page ${40 + i} ink ${ours} vs reference ${reference}`).toBeLessThanOrEqual(
        Math.ceil(reference * 1.2),
      );
    }
  });

  it('the recovered body forms §21, claim, and analysis sections in the structure map', async () => {
    const extraction = extractDocument(fixture);
    const sections = await buildStructureMap(extraction, noop);
    const s21 = sections.find((s) => /Transmission Of Stock Quote Data/i.test(s.title));
    expect(s21, 'Example 21 heading detected').toBeDefined();
    expect(s21?.page).toBe(1);
    // The claims and their analyses — pure CID-hex text — become sections of
    // their own, which is what §21 zooms and asks resolve against.
    const claim1 = sections.find((s) => s.id === 'claim-1');
    const claim2 = sections.find((s) => s.id === 'claim-2');
    expect(norm(claim1?.title ?? '')).toContain('Ineligible');
    expect(norm(claim2?.title ?? '')).toContain('Eligible');
    expect(norm(sectionText(extraction.text, byId(sections, '1')))).toContain(
      'A method of distributing stock quotes',
    );
    expect(norm(sectionText(extraction.text, claim1 as DocSection))).toContain('Step 2A');
  });

  it('hex strings under simple or unknown fonts decode as raw bytes', () => {
    // Tokenizer-level coverage without CMaps: hex Tj and hex-in-TJ items are
    // text like their literal siblings, decoded bytewise when no Type0 font
    // is in effect.
    const stream = [
      'BT',
      '0 Tc 0 Tw 12 0 0 12 72 720 Tm',
      '<48656C6C6F20>Tj',
      '[(from )<6D69786564>( array)]TJ',
      'ET',
    ].join('\n');
    const d = mkdtempSync(path.join(os.tmpdir(), 'uspto-hex-'));
    indexDirs.push(d);
    const file = path.join(d, 'hex.pdf');
    writeFileSync(file, makeRawStreamPdf([stream]));
    const extraction = extractDocument(file);
    expect(extraction.text.split('\n')[0]).toBe('Hello from mixed array');
  });
});

describe('docx extraction and structure', () => {
  it('reads paragraphs and style-based headings from a script-built docx', async () => {
    const extraction = extractDocument(path.join(binDir, 'engagement-letter.docx'));
    expect(extraction.kind).toBe('docx');
    expect(extraction.text).toContain('USD 12,500');
    const sections = await buildStructureMap(extraction, noop);
    const fees = byId(sections, '3');
    expect(fees.title).toBe('Fees and Billing');
    expect(fees.summary).toContain('USD 12,500');
    // Paragraph anchor: sections carry their line range in the extracted text.
    expect(sectionText(extraction.text, fees)).toContain('Meridian valuation engagement');
  });
});

describe('document index round trip and search', () => {
  it('persists documents.json and finds section hits from stored artifacts', async () => {
    // Removed in afterAll rather than inline: Windows releases the closed
    // store's WAL handles a beat after close(), and an immediate rmSync EPERMs.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'doc-index-'));
    indexDirs.push(dir);
    {
      const store = openStore(path.join(dir, 'state.db'));
      const audit = new AuditWriter(path.join(dir, 'audit.jsonl'));
      const extraction = extractDocument(path.join(docCorpus, 'retention-schedule.txt'));
      const sections = await buildStructureMap(extraction, noop);
      storeRedactedArtifact(store, audit, {
        id: 'a0d0c1',
        sessionId: 'ingest-test',
        artifactClass: 'doc-serve',
        createdAt: new Date().toISOString(),
        raw: extraction.text,
        gatesPassed: true,
        meta: { filePath: 'retention-schedule.txt' },
      });
      const entry: DocumentIndexEntry = {
        path: 'retention-schedule.txt',
        sha256: 'deadbeef',
        bytes: 1,
        kind: extraction.kind,
        method: extraction.method,
        ingestedAt: new Date().toISOString(),
        artifactId: 'a0d0c1',
        sections,
      };
      const index: DocumentIndex = {
        version: '1',
        corpus: 'practice',
        generatedAt: new Date().toISOString(),
        documents: [entry],
      };
      writeDocumentIndex(dir, index);
      const roundTripped = readDocumentIndex(dir);
      expect(roundTripped?.documents[0]?.sections.map((s) => s.id)).toEqual(
        sections.map((s) => s.id),
      );

      const hits = searchDocumentSections(store, [entry], ['workpapers', 'retained']);
      expect(hits.length).toBeGreaterThan(0);
      const hit = hits.find((h) => h.section.id === '2');
      expect(hit?.path).toBe('retention-schedule.txt');
      expect(hit?.text.toLowerCase()).toMatch(/workpapers|retained/);
      store.close();
    }
  });
});
