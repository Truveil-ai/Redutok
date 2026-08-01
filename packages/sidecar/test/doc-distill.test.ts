import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readAuditFile } from '@redutok/shared';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore plain-mjs fixture generator, no type declarations
import { writeDocFixtures } from '../../../scripts/doc-fixtures.mjs';
import { AuditWriter } from '../src/audit.js';
import { distillArtifact, loadProfiles, runProfile, zoom } from '../src/distill.js';
import { buildStructureMap, extractDocument, sectionText, type DocSection } from '../src/docs.js';
import { NoopLlmPass } from '../src/llm.js';
import { openStore, type Store } from '../src/store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..', '..');
const docCorpus = path.join(repoRoot, 'fixtures', 'doc-corpus');
const profiles = loadProfiles(path.join(repoRoot, 'profiles'));

const noop = new NoopLlmPass();
let binDir: string;
let dir: string;
let store: Store;
let audit: AuditWriter;
let auditPath: string;

beforeAll(() => {
  binDir = mkdtempSync(path.join(os.tmpdir(), 'doc-distill-fixtures-'));
  writeDocFixtures(binDir);
  dir = mkdtempSync(path.join(os.tmpdir(), 'doc-distill-'));
  store = openStore(path.join(dir, 'state.db'));
  auditPath = path.join(dir, 'audit.jsonl');
  audit = new AuditWriter(auditPath);
});

afterAll(() => {
  store.close();
  rmSync(binDir, { recursive: true, force: true, maxRetries: 5 });
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

const profile = (name: string) => {
  const p = profiles.get(name);
  if (p === undefined) throw new Error(`profile ${name} not found in profiles/`);
  return p;
};

async function retentionDoc(): Promise<{ text: string; sections: DocSection[] }> {
  const extraction = extractDocument(path.join(docCorpus, 'retention-schedule.txt'));
  const sections = await buildStructureMap(extraction, noop);
  return { text: extraction.text, sections };
}

describe('doc-serve profile', () => {
  it('ships with the repo profiles and has a distiller branch', () => {
    expect(profile('doc-serve').name).toBe('doc-serve');
    expect(profile('doc-search').name).toBe('doc-search');
  });

  it('serves the structure map alone when there is no ask', async () => {
    const { text, sections } = await retentionDoc();
    const out = await runProfile(profile('doc-serve'), text, {
      filePath: 'retention-schedule.txt',
      artifactId: 'a000001',
      doc: { sections },
    });
    expect(out).toContain('document retention-schedule.txt');
    expect(out).toContain('§2 WORKPAPER RETENTION');
    expect(out).toContain('dcp__zoom("a000001"');
    // Structure map only: the summary survives, the body does not.
    expect(out).not.toContain('destruction review on 2033-03-31');
  });

  it('adds the ask-relevant sections verbatim and passes the prose gates', async () => {
    const { text, sections } = await retentionDoc();
    const outcome = await distillArtifact(store, audit, {
      raw: text,
      profile: profile('doc-serve'),
      sessionId: 'doc-distill-test',
      tool: 'vault_ask',
      context: {
        filePath: 'retention-schedule.txt',
        doc: { sections, ask: 'how long must valuation workpapers be retained' },
      },
    });
    expect(outcome.served).toBe('distilled');
    // The matched section rides along verbatim, entities intact.
    expect(outcome.text).toContain('retained for seven years');
    expect(outcome.text).toContain('2033-03-31');
    // The artifact remembers its structure so zoom can slice by section.
    const stored = store.getArtifact(outcome.artifactId);
    expect((stored?.meta['doc'] as { sections: DocSection[] }).sections.length).toBe(
      sections.length,
    );
  });

  it('entity gate blocks a distillate that drops a date and serves raw', async () => {
    const { text, sections } = await retentionDoc();
    // Doctored profile: truncating section bodies to one line drops the
    // 2026-03-31 / 2033-03-31 dates from the conclusion-relevant region.
    const doctored = {
      ...profile('doc-serve'),
      rules: [{ kind: 'relevant-sections', config: { maxSections: 4, maxSectionLines: 1 } }],
    };
    const outcome = await distillArtifact(store, audit, {
      raw: text,
      profile: doctored,
      sessionId: 'doc-distill-gate-test',
      tool: 'vault_ask',
      context: {
        filePath: 'retention-schedule.txt',
        doc: { sections, ask: 'how long must valuation workpapers be retained' },
      },
    });
    expect(outcome.served).toBe('raw');
    const entityGate = outcome.gateReport.results.find((r) => r.gate === 'entity-preservation');
    expect(entityGate?.passed).toBe(false);
    const events = readAuditFile(auditPath).events.filter(
      (e) => e.sessionId === 'doc-distill-gate-test',
    );
    expect(events.some((e) => e.action === 'serve-raw')).toBe(true);
  });
});

describe('doc-search profile', () => {
  it('keeps ranked hit lines verbatim with document, section, and page context', async () => {
    const raw = [
      'valuation-report.pdf §4 p.2:31: fair market value of Meridian Instruments Ltd as at 2026-03-31 is USD 2,300,000',
      'engagement-letter.docx §3:12: The fixed fee for the Meridian valuation engagement is USD 12,500',
      'retention-schedule.txt §2:11: retained for seven years from the report date',
    ].join('\n');
    const out = await runProfile(profile('doc-search'), raw, { artifactId: 'a000002' });
    expect(out).toContain('3 hits');
    expect(out).toContain('valuation-report.pdf §4 p.2:31');
    expect(out).toContain('USD 12,500');
    expect(out).toContain('dcp__zoom("a000002"');
  });
});

describe('zoom by section and page', () => {
  it('recovers a cited section byte-equal from the store', async () => {
    const { text, sections } = await retentionDoc();
    const outcome = await distillArtifact(store, audit, {
      raw: text,
      profile: profile('doc-serve'),
      sessionId: 'doc-zoom-test',
      context: { filePath: 'retention-schedule.txt', doc: { sections } },
    });
    const workpapers = sections.find((s) => s.id === '2');
    if (workpapers === undefined) throw new Error('section 2 missing');
    const stored = store.getArtifact(outcome.artifactId);
    const expected = sectionText(stored?.raw ?? '', workpapers);

    const bySectionRef = zoom(store, audit, outcome.artifactId, '§2');
    expect(bySectionRef.found).toBe(true);
    expect(bySectionRef.text).toBe(expected);

    const byTitle = zoom(store, audit, outcome.artifactId, 'workpaper retention');
    expect(byTitle.text).toBe(expected);
  });

  it('recovers a pdf page slice by page reference', async () => {
    const extraction = extractDocument(path.join(binDir, 'valuation-report.pdf'));
    const sections = await buildStructureMap(extraction, noop);
    const outcome = await distillArtifact(store, audit, {
      raw: extraction.text,
      profile: profile('doc-serve'),
      sessionId: 'doc-zoom-page-test',
      context: {
        filePath: 'valuation-report.pdf',
        doc: { sections, pages: extraction.pages },
      },
    });
    const page2 = extraction.pages?.find((p) => p.page === 2);
    if (page2 === undefined) throw new Error('page 2 missing');
    const stored = store.getArtifact(outcome.artifactId);
    const expected = sectionText(stored?.raw ?? '', page2);
    const result = zoom(store, audit, outcome.artifactId, 'page 2');
    expect(result.found).toBe(true);
    expect(result.text).toBe(expected);
    expect(result.text).toContain('USD 2,300,000');
  });
});
