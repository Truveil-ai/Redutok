import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LIMITS } from '@redutok/shared';
import { estimateTokens } from '@redutok/sidecar';
import { afterEach, describe, expect, it } from 'vitest';
import { mountCorpus, type Corpus } from '../src/corpus.js';
import { emitCodex, readCodexState } from '../src/codex.js';
import { makeCorpusDir } from './helpers.js';

function mount(root: string, name: string): Corpus {
  const corpus = mountCorpus(root, { name });
  cleanups.push(() => {
    try {
      corpus.store.close();
    } catch {
      // Already closed by another closer; safe to ignore.
    }
    try {
      corpus.ledger.close();
    } catch {
      // ditto
    }
  });
  return corpus;
}

/**
 * Session 4 contract for the vault codex emission: a Markdown block small
 * enough to paste into a claude.ai Project instructions box, deterministic
 * across identical inputs, versioned so a client can detect staleness, and
 * degradable by lowest-confidence exclusion when the graduated section
 * exceeds its budget.
 */

const cleanups: Array<() => void> = [];

afterEach(() => {
  // Reverse so mount closers (pushed after tmpdir cleanup) run before rmSync.
  for (const c of cleanups.splice(0).reverse()) c();
});

function writeGraduated(dcpDir: string, entries: unknown[]): void {
  writeFileSync(
    path.join(dcpDir, 'vault-graduated.json'),
    JSON.stringify({ entries, candidates: [], generatedAt: new Date(0).toISOString() }, null, 2) +
      '\n',
    'utf8',
  );
}

describe('vault_codex emission', () => {
  it('renders corpus map, protocol, and versioned footer under the token budget', () => {
    const c = makeCorpusDir();
    cleanups.push(c.cleanup);
    const corpus = mount(c.root, 'urlbuilder');
    const emission = emitCodex(corpus);
    expect(emission.text).toContain('# Redutok Vault');
    expect(emission.text).toContain('urlbuilder');
    expect(emission.text).toMatch(/vault_ask/);
    expect(emission.text).toMatch(/vault_zoom/);
    expect(emission.text).toMatch(/vault_receipt/);
    expect(emission.text).toMatch(/<!-- redutok-vault codex v\d+ /);
    expect(estimateTokens(emission.text)).toBeLessThanOrEqual(LIMITS.VAULT_CODEX.MAX_TOKENS);
    expect(emission.version).toBe(1);
    // Footer names the pinned rate row so clients can spot repricing.
    expect(emission.text).toContain(emission.rateRow.referenceModel);
  });

  it('is deterministic and stable: re-emitting the same corpus does not bump the version', () => {
    const c = makeCorpusDir();
    cleanups.push(c.cleanup);
    const corpus = mount(c.root, 'stable');
    const a = emitCodex(corpus);
    const b = emitCodex(corpus);
    // The generatedAt line is stamped from stored state, so identical inputs
    // yield byte-identical bodies and the persisted version does not move.
    expect(b.version).toBe(a.version);
    expect(b.textHash).toBe(a.textHash);
    expect(b.text).toBe(a.text);
  });

  it('bumps the persisted version when the emitted content changes', () => {
    const c = makeCorpusDir();
    cleanups.push(c.cleanup);
    const corpus = mount(c.root, 'bumpy');
    const v1 = emitCodex(corpus);
    writeGraduated(corpus.dcpDir, [
      {
        id: 'ask-neighborhood/1',
        kind: 'ask-neighborhood',
        document: 'src/url-builder.ts',
        sections: ['assembleAddress'],
        occurrences: 4,
        sessions: 2,
        oneLiner: 'assembleAddress is asked about repeatedly across sessions',
        confidence: 0.7,
        candidate: 'ask-neighborhood/1',
      },
    ]);
    const v2 = emitCodex(corpus);
    expect(v2.version).toBe(v1.version + 1);
    expect(v2.text).toContain('assembleAddress is asked about repeatedly');
    // State on disk matches the last emission.
    const state = readCodexState(corpus.dcpDir);
    expect(state?.version).toBe(v2.version);
    expect(state?.textHash).toBe(v2.textHash);
  });

  it('excludes lowest-confidence graduated entries first when the graduated budget is exceeded', () => {
    const c = makeCorpusDir();
    cleanups.push(c.cleanup);
    const corpus = mount(c.root, 'degrade');
    const filler = 'x'.repeat(400); // pushes each entry well over the budget together
    writeGraduated(
      corpus.dcpDir,
      [0.9, 0.8, 0.7, 0.6, 0.5].map((confidence, i) => ({
        id: `ask-neighborhood/${i}`,
        kind: 'ask-neighborhood',
        document: `src/doc-${i}.md`,
        sections: [`section-${i}`],
        occurrences: 3,
        sessions: 2,
        oneLiner: `entry ${i}: ${filler}`,
        confidence,
        candidate: `ask-neighborhood/${i}`,
      })),
    );
    const emission = emitCodex(corpus, { graduatedMaxTokens: 200 });
    // Lowest-confidence exclusion: the 0.9 entry is retained; 0.5 is not.
    expect(emission.includedGraduated).toContain('ask-neighborhood/0');
    expect(emission.excludedGraduated).toContain('ask-neighborhood/4');
    // Lowest-confidence entries are trimmed first — so the first pop lands
    // at index 0 of excluded, and every survivor has strictly higher confidence
    // than the lowest excluded.
    expect(emission.excludedGraduated[0]).toBe('ask-neighborhood/4');
    // The footer notes the drop count so a reader knows the block is degraded.
    expect(emission.text).toMatch(/entries excluded to fit/);
  });

  it('persists version+hash across process restarts and does not double-bump on identical inputs', () => {
    const c = makeCorpusDir();
    cleanups.push(c.cleanup);
    const first = mount(c.root, 'reopen');
    const a = emitCodex(first);
    // Simulate a restart by closing before re-mounting from the same on-disk state.
    first.store.close();
    first.ledger.close();
    const second = mount(c.root, 'reopen');
    const b = emitCodex(second);
    expect(b.version).toBe(a.version);
    expect(b.textHash).toBe(a.textHash);
    expect(existsSync(path.join(c.root, '.dcp', 'vault-codex.json'))).toBe(true);
    // Sanity: the state file is JSON and readable.
    const raw = readFileSync(path.join(c.root, '.dcp', 'vault-codex.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version: number };
    expect(parsed.version).toBe(a.version);
  });
});
