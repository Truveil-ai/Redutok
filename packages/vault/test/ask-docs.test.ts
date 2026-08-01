import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sectionText } from '@redutok/sidecar';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore plain-mjs fixture generator, no type declarations
import { writeDocFixtures } from '../../../scripts/doc-fixtures.mjs';
import { mountCorpus, type Corpus } from '../src/corpus.js';
import { runIngest } from '../src/ingest.js';
import { newVaultSession, vaultAsk, vaultZoom } from '../src/tools.js';
import { monorepoRoot } from './helpers.js';

const docCorpus = path.join(monorepoRoot, 'fixtures', 'doc-corpus');

let root: string;
let corpus: Corpus;
let corpora: Map<string, Corpus>;

beforeAll(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'vault-ask-docs-'));
  cpSync(docCorpus, root, { recursive: true });
  writeDocFixtures(root);
  await runIngest(root, { corpus: 'practice' });
  corpus = mountCorpus(root, { name: 'practice' });
  corpora = new Map([[corpus.name, corpus]]);
}, 60_000);

afterAll(() => {
  corpus.store.close();
  corpus.ledger.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

describe('vault_ask over an ingested document corpus', () => {
  it('answers across two documents, citing document, section, and page', async () => {
    const session = newVaultSession('ask-docs-test');
    const text = await vaultAsk(corpora, session, {
      question:
        'What fixed fee applies to the Meridian valuation engagement and how long must its workpapers be retained?',
    });
    // The dossier spans both documents...
    expect(text).toContain('engagement-letter.docx');
    expect(text).toContain('retention-schedule.txt');
    // ...cites like a professional would: section (and page where pages exist)...
    expect(text).toMatch(/§3/);
    expect(text).toMatch(/§2/);
    // ...and closes with the mandatory accounting block.
    expect(text).toContain('[vault accounting: ask');
    expect(text).toMatch(/reduction\s+[\d.]+x raw-versus-served/);
  });

  it('the mounted corpus carries its document index', () => {
    expect(corpus.documents.length).toBeGreaterThanOrEqual(5);
    const pdf = corpus.documents.find((d) => d.path === 'valuation-report.pdf');
    expect(pdf?.sections.some((s) => s.page === 2)).toBe(true);
  });
});

describe('vault_zoom over an ingested document', () => {
  it('recovers a cited section byte-equal from the store', () => {
    const session = newVaultSession('zoom-docs-test');
    const entry = corpus.documents.find((d) => d.path === 'engagement-letter.docx');
    if (entry?.artifactId === undefined) throw new Error('engagement letter not ingested');
    const fees = entry.sections.find((s) => s.id === '3');
    if (fees === undefined) throw new Error('fees section missing');
    const stored = corpus.store.getArtifact(entry.artifactId);
    const expected = sectionText(stored?.raw ?? '', fees);
    const text = vaultZoom(corpora, session, { handle: entry.artifactId, query: '§3' });
    expect(text).toBe(expected);
    expect(text).toContain('USD 12,500');
  });
});
