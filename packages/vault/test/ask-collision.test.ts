import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore plain-mjs fixture generator, no type declarations
import { makeCollidingExamplesPdf } from '../../../scripts/doc-fixtures.mjs';
import { mountCorpus, type Corpus } from '../src/corpus.js';
import { runIngest } from '../src/ingest.js';
import { newVaultSession, vaultAsk } from '../src/tools.js';
import { monorepoRoot } from './helpers.js';

/**
 * End-to-end regression for the idf heading collision (field failure
 * 2026-08-02): an ask for "Example 5" returned the Genetically Modified
 * Bacterium example from the Nature-Based Products part instead of Digital
 * Image Processing from the Abstract Ideas part, because the two sections
 * tied on section identity and the tie fell to keyword volume. The right
 * candidate must lead, and the collision must be disclosed rather than
 * silently resolved.
 */

let root: string;
let corpus: Corpus;
let corpora: Map<string, Corpus>;

beforeAll(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'vault-ask-collision-'));
  writeFileSync(path.join(root, 'uspto-collisions.pdf'), makeCollidingExamplesPdf());
  mkdirSync(path.join(root, '.dcp'));
  writeFileSync(
    path.join(root, '.dcp', 'config.json'),
    `${JSON.stringify({ port: 48643, profilesDir: path.join(monorepoRoot, 'profiles') }, null, 2)}\n`,
    'utf8',
  );
  await runIngest(root, { corpus: 'idf-collision' });
  corpus = mountCorpus(root, { name: 'idf-collision' });
  corpora = new Map([[corpus.name, corpus]]);
}, 60_000);

afterAll(() => {
  corpus.store.close();
  corpus.ledger.close();
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // leave it to the OS temp cleaner
  }
});

const evidenceLines = (text: string): string[] =>
  text.split('\n').filter((l) => l.startsWith('- ') && !l.startsWith('- vault_zoom'));

describe('vault_ask on a repeated example number', () => {
  it('leads with the first Example 5 and names the other candidate with its part', async () => {
    const session = newVaultSession('ask-collision-bare');
    const text = await vaultAsk(corpora, session, { question: 'What is the analysis in Example 5 about claim eligibility?' });
    const evidence = evidenceLines(text);
    expect(evidence[0]).toContain('§5 ');
    expect(evidence[0]).toContain('Digital Image Processing');
    // The disclosure: the reader is told the enumeration repeats, which
    // section was taken, and which other one exists — with its part.
    expect(text).toContain('ambiguous section reference');
    expect(text).toContain('Genetically Modified Bacterium');
    expect(text).toContain('Nature-Based Products');
    expect(text).toContain('Examples: Abstract Ideas');
  }, 60_000);

  it('an undiscriminated collision holds the confidence band below high', async () => {
    const session = newVaultSession('ask-collision-band');
    const text = await vaultAsk(corpora, session, { question: 'What is the analysis in Example 5 about claim eligibility?' });
    expect(text).not.toMatch(/confidence {3}high/);
  }, 60_000);

  it('a part-qualified ask resolves to the other candidate without a warning', async () => {
    const session = newVaultSession('ask-collision-part');
    const text = await vaultAsk(corpora, session, {
      question:
        'What is the claim eligibility analysis in Example 5 of the Nature-Based Products examples?',
    });
    const evidence = evidenceLines(text);
    expect(evidence[0]).toContain('Genetically Modified Bacterium');
    expect(text).not.toContain('ambiguous section reference');
  }, 60_000);

  it('a title-qualified ask picks the section by name across the collision', async () => {
    const session = newVaultSession('ask-collision-title');
    const text = await vaultAsk(corpora, session, {
      question: 'Summarize Example 3 on amazonic acid pharmaceutical compositions.',
    });
    expect(evidenceLines(text)[0]).toContain('Amazonic Acid');
  }, 60_000);

  it('the corpus really carries the colliding ids the asks target', () => {
    const entry = corpus.documents.find((d) => d.path === 'uspto-collisions.pdf');
    const ids = entry?.sections.map((s) => s.id) ?? [];
    expect(ids).toContain('5');
    expect(ids).toContain('5-2');
    const five = entry?.sections.find((s) => s.id === '5');
    const fiveB = entry?.sections.find((s) => s.id === '5-2');
    expect(five?.title).toBe('Digital Image Processing');
    expect(fiveB?.title).toBe('Genetically Modified Bacterium');
    expect(five?.context).toBe('Examples: Abstract Ideas');
    expect(fiveB?.context).toBe('Nature-Based Products');
  });
});
