import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore plain-mjs fixture generator, no type declarations
import { writeDocFixtures } from '../../../scripts/doc-fixtures.mjs';
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
import { NoopLlmPass } from '../src/llm.js';
import { storeRedactedArtifact } from '../src/redact.js';
import { openStore } from '../src/store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..', '..');
const docCorpus = path.join(repoRoot, 'fixtures', 'doc-corpus');

const noop = new NoopLlmPass();
let binDir: string;

beforeAll(() => {
  binDir = mkdtempSync(path.join(os.tmpdir(), 'doc-fixtures-'));
  writeDocFixtures(binDir);
});

afterAll(() => {
  rmSync(binDir, { recursive: true, force: true, maxRetries: 5 });
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
    expect(sections.map((s) => s.id)).toEqual(['s1', '1', '2', '3']);
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
    const dir = mkdtempSync(path.join(os.tmpdir(), 'doc-index-'));
    try {
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
      const hit = hits[0];
      expect(hit?.path).toBe('retention-schedule.txt');
      expect(hit?.section.id).toBe('2');
      expect(hit?.text.toLowerCase()).toMatch(/workpapers|retained/);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
