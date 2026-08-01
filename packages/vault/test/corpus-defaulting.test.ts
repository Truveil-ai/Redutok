import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore plain-mjs fixture generator, no type declarations
import { writeDocFixtures } from '../../../scripts/doc-fixtures.mjs';
import { mountCorpus, type Corpus } from '../src/corpus.js';
import { runIngest } from '../src/ingest.js';
import type { VaultRollup } from '../src/rollup.js';
import { newVaultSession, vaultAsk, vaultCodex, vaultReceipt, vaultZoom } from '../src/tools.js';
import { monorepoRoot } from './helpers.js';

const docCorpus = path.join(monorepoRoot, 'fixtures', 'doc-corpus');

function closeCorpus(corpus: Corpus): void {
  corpus.store.close();
  corpus.ledger.close();
}

/**
 * Field regression (corpus idf, 2026-08-02): with fixtures mounted before
 * idf, vault_receipt without a corpus argument silently rolled up the
 * fixtures ledger and reported it empty while the session's work sat in idf.
 * An empty result must be distinguishable from a wrong-target result: when a
 * corpus is unspecified and multiple are mounted, a tool either resolves
 * across all mounts with per-corpus attribution or refuses by name — it
 * never silently picks the first mount.
 */
describe('no tool silently defaults to the first mounted corpus', () => {
  let decoyRoot: string;
  let targetRoot: string;
  let decoy: Corpus;
  let target: Corpus;
  let corpora: Map<string, Corpus>;

  beforeAll(async () => {
    decoyRoot = mkdtempSync(path.join(os.tmpdir(), 'vault-default-decoy-'));
    targetRoot = mkdtempSync(path.join(os.tmpdir(), 'vault-default-target-'));
    for (const root of [decoyRoot, targetRoot]) {
      cpSync(docCorpus, root, { recursive: true });
      writeDocFixtures(root);
    }
    await runIngest(decoyRoot, { corpus: 'decoy' });
    await runIngest(targetRoot, { corpus: 'target' });
    decoy = mountCorpus(decoyRoot, { name: 'decoy' });
    target = mountCorpus(targetRoot, { name: 'target' });
    // Mount order matters: the decoy comes first, exactly the field setup
    // where the silent default sent every unspecified call to the wrong one.
    corpora = new Map([
      [decoy.name, decoy],
      [target.name, target],
    ]);
  }, 60_000);

  afterAll(() => {
    closeCorpus(decoy);
    closeCorpus(target);
    rmSync(decoyRoot, { recursive: true, force: true, maxRetries: 5 });
    rmSync(targetRoot, { recursive: true, force: true, maxRetries: 5 });
  });

  it('vault_ask refuses by name when no corpus is given and several are mounted', async () => {
    const session = newVaultSession('defaulting-ask');
    await expect(
      vaultAsk(corpora, session, { question: 'What fee applies to the Meridian engagement?' }),
    ).rejects.toThrow(/decoy.*target|target.*decoy/);
  });

  it('vault_codex refuses by name when no corpus is given and several are mounted', () => {
    const session = newVaultSession('defaulting-codex');
    expect(() => vaultCodex(corpora, session, {})).toThrow(/decoy.*target|target.*decoy/);
  });

  it('vault_receipt without a corpus reports every mounted corpus, attributed by name', async () => {
    const session = newVaultSession('defaulting-receipt');
    // The session's work happens in the second-mounted corpus — the field
    // shape where the first-mount default reported an empty ledger.
    await vaultAsk(corpora, session, {
      corpus: 'target',
      question: 'What fixed fee applies to the Meridian valuation engagement?',
    });
    const text = vaultReceipt(corpora, session, {});
    expect(text).toContain('corpus: decoy');
    expect(text).toContain('corpus: target');
    // The target section must carry the ask; a decoy-only render would show
    // exactly one receipt with zero asks.
    const targetSection = text.slice(text.indexOf('corpus: target'));
    expect(targetSection).toMatch(/1 asks/);
  }, 120_000);

  it('vault_receipt json without a corpus returns one attributed rollup per mount', () => {
    const session = newVaultSession('defaulting-receipt-json');
    const rollups = JSON.parse(vaultReceipt(corpora, session, { json: true })) as VaultRollup[];
    expect(Array.isArray(rollups)).toBe(true);
    expect(rollups.map((r) => r.corpus).sort()).toEqual(['decoy', 'target']);
  });

  it('vault_zoom refuses by name on a handle no mounted corpus holds', () => {
    const session = newVaultSession('defaulting-zoom');
    // Before the fix this fell through to the first mount and failed with
    // that corpus's own "no artifact in the store" — indistinguishable from
    // a wrong-target miss.
    expect(() => vaultZoom(corpora, session, { handle: 'a000000' })).toThrow(
      /decoy.*target|target.*decoy/,
    );
  });
});

/** Single-mount sessions keep the ergonomic default: the only corpus. */
describe('a single mounted corpus still serves unspecified-corpus calls', () => {
  let root: string;
  let corpus: Corpus;
  let corpora: Map<string, Corpus>;

  beforeAll(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'vault-default-single-'));
    cpSync(docCorpus, root, { recursive: true });
    writeDocFixtures(root);
    await runIngest(root, { corpus: 'only' });
    corpus = mountCorpus(root, { name: 'only' });
    corpora = new Map([[corpus.name, corpus]]);
  }, 60_000);

  afterAll(() => {
    closeCorpus(corpus);
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });

  it('ask, codex, and receipt all resolve to the only corpus', async () => {
    const session = newVaultSession('defaulting-single');
    const askText = await vaultAsk(corpora, session, {
      question: 'What fixed fee applies to the Meridian valuation engagement?',
    });
    expect(askText).toContain('[vault accounting:');
    expect(vaultCodex(corpora, session, {})).toContain('only');
    const receipt = vaultReceipt(corpora, session, {});
    expect(receipt).toContain('corpus: only');
    expect(receipt).toMatch(/1 asks/);
  }, 120_000);
});
