import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readAuditFile } from '@redutok/shared';
import { readDocumentIndex, storeRedactedArtifact } from '@redutok/sidecar';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore plain-mjs fixture generator, no type declarations
import { makeUsptoExamplesPdf, writeDocFixtures } from '../../../scripts/doc-fixtures.mjs';
import { mountCorpus, type Corpus } from '../src/corpus.js';
import { runIngest } from '../src/ingest.js';
import { newVaultSession, servableZoomHandles, vaultAsk, vaultZoom } from '../src/tools.js';
import { monorepoRoot } from './helpers.js';

const docCorpus = path.join(monorepoRoot, 'fixtures', 'doc-corpus');

/** Every handle a rendered dossier offers, in order of appearance. */
function handlesIn(dossierText: string): string[] {
  return [...dossierText.matchAll(/vault_zoom\("([0-9a-f]+)"/g)].map((m) => m[1] as string);
}

function closeCorpus(corpus: Corpus): void {
  corpus.store.close();
  corpus.ledger.close();
}

/**
 * Field regression (corpus idf, 2026-08-02): with two corpora mounted, every
 * handle a vault_ask dossier offered failed vault_zoom with "no artifact in
 * the store" when the zoom call carried no corpus argument — the lookup
 * defaulted to the first mounted corpus instead of the one that minted the
 * handle. A dossier handle must resolve for the life of its corpus no matter
 * which corpus the zoom call names (or omits).
 */
describe('vault_zoom resolves dossier handles across mounted corpora', () => {
  let decoyRoot: string;
  let targetRoot: string;
  let decoy: Corpus;
  let target: Corpus;
  let corpora: Map<string, Corpus>;

  beforeAll(async () => {
    decoyRoot = mkdtempSync(path.join(os.tmpdir(), 'vault-zoom-decoy-'));
    targetRoot = mkdtempSync(path.join(os.tmpdir(), 'vault-zoom-target-'));
    for (const root of [decoyRoot, targetRoot]) {
      cpSync(docCorpus, root, { recursive: true });
      writeDocFixtures(root);
    }
    await runIngest(decoyRoot, { corpus: 'decoy' });
    await runIngest(targetRoot, { corpus: 'target' });
    decoy = mountCorpus(decoyRoot, { name: 'decoy' });
    target = mountCorpus(targetRoot, { name: 'target' });
    // Mount order matters: the decoy comes first, so a zoom that defaults to
    // the first corpus instead of resolving the handle would miss.
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

  it('zooms every handle an ask dossier offers, with and without a corpus argument', async () => {
    const session = newVaultSession('zoom-cross-corpus');
    const text = await vaultAsk(corpora, session, {
      corpus: 'target',
      question:
        'What fixed fee applies to the Meridian valuation engagement and how long must its workpapers be retained?',
    });
    const handles = handlesIn(text);
    expect(handles.length).toBeGreaterThan(0);
    for (const handle of handles) {
      const explicit = vaultZoom(corpora, session, { handle, corpus: 'target' });
      // The regression: no corpus argument defaulted to the decoy and threw.
      const defaulted = vaultZoom(corpora, session, { handle });
      expect(defaulted).toBe(explicit);
    }
  });

  it('still errors on a handle no mounted corpus holds', () => {
    const session = newVaultSession('zoom-cross-corpus-miss');
    expect(() => vaultZoom(corpora, session, { handle: 'a000000' })).toThrow(/no artifact/);
  });

  it('refuses an ambiguous handle held by two corpora unless one is named', () => {
    const session = newVaultSession('zoom-cross-corpus-ambiguous');
    const shared = {
      id: 'afeedf0',
      artifactClass: 'doc-serve',
      createdAt: new Date().toISOString(),
      gatesPassed: false,
      meta: {},
    };
    storeRedactedArtifact(decoy.store, decoy.audit, {
      ...shared,
      sessionId: 'ambiguity-decoy',
      raw: 'decoy bytes',
    });
    storeRedactedArtifact(target.store, target.audit, {
      ...shared,
      sessionId: 'ambiguity-target',
      raw: 'target bytes',
    });
    expect(() => vaultZoom(corpora, session, { handle: 'afeedf0' })).toThrow(/decoy.*target|ambiguous/);
    expect(vaultZoom(corpora, session, { handle: 'afeedf0', corpus: 'target' })).toBe('target bytes');
  });
});

/**
 * Durability invariant: a handle minted in a dossier resolves byte-equal for
 * the life of the corpus, across re-ingests and detector upgrades. Re-ingest
 * appends new artifacts and rewrites the index; it must never invalidate a
 * handle already handed out.
 */
describe('dossier handles survive re-ingest with a detector bump', () => {
  let root: string;
  let corpus: Corpus;
  let corpora: Map<string, Corpus>;

  beforeAll(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'vault-zoom-durable-'));
    cpSync(docCorpus, root, { recursive: true });
    writeDocFixtures(root);
    writeFileSync(path.join(root, 'uspto.pdf'), makeUsptoExamplesPdf());
    await runIngest(root, { corpus: 'durable' });
    corpus = mountCorpus(root, { name: 'durable' });
    corpora = new Map([[corpus.name, corpus]]);
  }, 60_000);

  afterAll(() => {
    closeCorpus(corpus);
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });

  it('a pre-upgrade handle zooms byte-equal after the re-ingest', async () => {
    const session = newVaultSession('zoom-durability');
    const text = await vaultAsk(corpora, session, {
      question: 'How does Example 1 treat the abstract-idea inquiry?',
    });
    const handles = handlesIn(text);
    expect(handles.length).toBeGreaterThan(0);
    const before = new Map(
      handles.map((h) => [h, vaultZoom(corpora, session, { handle: h })]),
    );

    // Simulate a detector upgrade over an existing corpus: stamp every index
    // entry with a stale detectorVersion (exactly what a version bump sees)
    // and re-ingest, forcing a full re-extract that mints fresh artifacts.
    closeCorpus(corpus);
    const dcp = path.join(root, '.dcp');
    const index = readDocumentIndex(dcp);
    if (index === undefined) throw new Error('document index missing');
    const stale = {
      ...index,
      documents: index.documents.map((d) => ({ ...d, detectorVersion: 1 })),
    };
    writeFileSync(path.join(dcp, 'documents.json'), `${JSON.stringify(stale, null, 2)}\n`, 'utf8');
    await runIngest(root, { corpus: 'durable' });
    const after = readDocumentIndex(dcp);
    const changed = after?.documents.some(
      (d) => d.artifactId !== index.documents.find((p) => p.path === d.path)?.artifactId,
    );
    expect(changed, 're-ingest actually re-extracted (new artifact ids)').toBe(true);

    corpus = mountCorpus(root, { name: 'durable' });
    corpora = new Map([[corpus.name, corpus]]);
    for (const [handle, expected] of before) {
      expect(vaultZoom(corpora, session, { handle })).toBe(expected);
    }
  });
});

/**
 * The guard: a dossier can never offer a handle whose artifact is absent from
 * the store. An unservable handle is dropped before rendering, with a 'drop'
 * audit event — the failure surfaces here in tests, not at query time.
 */
describe('dossiers never offer unservable handles', () => {
  let root: string;
  let corpus: Corpus;
  let corpora: Map<string, Corpus>;

  beforeAll(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'vault-zoom-guard-'));
    cpSync(docCorpus, root, { recursive: true });
    writeDocFixtures(root);
    await runIngest(root, { corpus: 'guarded' });
    corpus = mountCorpus(root, { name: 'guarded' });
    corpora = new Map([[corpus.name, corpus]]);
  }, 60_000);

  afterAll(() => {
    closeCorpus(corpus);
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });

  it('every handle an ask emits resolves in the corpus store', async () => {
    const session = newVaultSession('zoom-guard-ask');
    const text = await vaultAsk(corpora, session, {
      question: 'What are the retention periods for engagement workpapers?',
    });
    for (const handle of handlesIn(text)) {
      expect(corpus.store.getArtifact(handle), `handle ${handle} must be in the store`).toBeDefined();
    }
  });

  it('drops an absent handle and audits the drop', () => {
    const entry = corpus.documents.find((d) => d.artifactId !== undefined);
    if (entry?.artifactId === undefined) throw new Error('no ingested document artifact');
    const kept = servableZoomHandles(corpus, 'guard-test#ask1', [entry.artifactId, 'a000000']);
    expect(kept).toEqual([entry.artifactId]);
    const drops = readAuditFile(corpus.auditPath).events.filter(
      (e) => e.module === 'vault.ask' && e.action === 'drop',
    );
    expect(drops.length).toBeGreaterThan(0);
    expect(drops.at(-1)?.reason).toContain('a000000');
  });
});
