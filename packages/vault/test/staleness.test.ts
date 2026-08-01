import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { emitCodex } from '../src/codex.js';
import { mountCorpus, type Corpus } from '../src/corpus.js';
import { runIngest } from '../src/ingest.js';
import { newVaultSession, vaultAsk } from '../src/tools.js';

/**
 * Session 4 staleness handshake: when the client's pasted codex is older
 * than the current emission, `vault_ask` appends exactly one refresh line;
 * when it is current, or the arg is absent, the answer body is unaffected.
 */

const fixturesRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'fixtures',
  'doc-corpus',
);

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

function copyDocFixture(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vault-staleness-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  cpSync(fixturesRoot, root, { recursive: true });
  return root;
}

function withMount(root: string, name: string): Corpus {
  const corpus = mountCorpus(root, { name });
  cleanups.push(() => {
    try {
      corpus.store.close();
    } catch { /* already closed */ }
    try {
      corpus.ledger.close();
    } catch { /* already closed */ }
  });
  return corpus;
}

describe('vault_ask codex_version handshake', () => {
  it('appends exactly one refresh line when the client version is older', async () => {
    const root = copyDocFixture();
    await runIngest(root, { corpus: 'staleness' });
    const first = withMount(root, 'staleness');
    const v1 = emitCodex(first);
    expect(v1.version).toBe(1);
    // Bump the emission by adding a graduated entry, so v2 exists.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      path.join(first.dcpDir, 'vault-graduated.json'),
      JSON.stringify(
        {
          entries: [
            {
              candidate: 'ask-neighborhood/x',
              kind: 'ask-neighborhood',
              document: 'billing-policy.md',
              sections: ['fees'],
              occurrences: 3,
              sessions: 2,
              firstSeen: new Date(0).toISOString(),
              lastSeen: new Date(0).toISOString(),
              oneLiner: 'Billing fees are asked about recurrently.',
              confidence: 0.6,
              status: 'graduated',
              source: 'graduated',
            },
          ],
          candidates: [],
          generatedAt: new Date(0).toISOString(),
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );
    const v2 = emitCodex(first);
    expect(v2.version).toBe(2);
    const corpora = new Map<string, Corpus>([['staleness', first]]);
    const session = newVaultSession('stale-test');
    const staleBody = await vaultAsk(corpora, session, {
      question: 'what is the billing policy fee?',
      codex_version: 1,
    });
    const freshBody = await vaultAsk(corpora, session, {
      question: 'what is the billing policy fee?',
      codex_version: 2,
    });
    const noArgBody = await vaultAsk(corpora, session, {
      question: 'what is the billing policy fee?',
    });
    const refreshLines = staleBody.match(/\[vault codex refresh:/g) ?? [];
    expect(refreshLines).toHaveLength(1);
    expect(staleBody).toMatch(/current v2/);
    expect(freshBody).not.toMatch(/\[vault codex refresh:/);
    expect(noArgBody).not.toMatch(/\[vault codex refresh:/);
  }, 30_000);
});
