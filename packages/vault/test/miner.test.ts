import { randomUUID } from 'node:crypto';
import type { AuditEvent } from '@redutok/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { mountCorpus, type Corpus } from '../src/corpus.js';
import { mineVault, readVaultGraduated, TOUCHED_SECTIONS_KEY } from '../src/miner.js';
import { makeCorpusDir } from './helpers.js';

function mount(root: string, name: string): Corpus {
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

/**
 * Conversational graduation for the vault (Session 4). The miner reads
 * vault.ask / vault.zoom audit events, keys asks by touched-sections
 * signature, and promotes recurring neighborhoods and repeatedly-zoomed
 * sections into a persisted graduated set that the codex emitter reads.
 */

const cleanups: Array<() => void> = [];

afterEach(() => {
  // Reverse so mount closers (pushed after tmpdir cleanup) run before rmSync.
  for (const c of cleanups.splice(0).reverse()) c();
});

function askEvent(
  sessionId: string,
  touched: Array<{ document: string; section: string }>,
  question = 'q',
): AuditEvent {
  return {
    id: `vault-ask-${randomUUID()}`,
    timestamp: new Date().toISOString(),
    sessionId,
    module: 'vault.ask',
    action: 'summarize',
    reason: `ask "${question}"`,
    details: { [TOUCHED_SECTIONS_KEY]: touched, question },
  };
}

function zoomEvent(sessionId: string, artifactId: string, document: string): AuditEvent {
  return {
    id: `vault-zoom-${randomUUID()}`,
    timestamp: new Date().toISOString(),
    sessionId,
    module: 'vault.zoom',
    action: 'zoom',
    reason: `zoom on ${document}`,
    inputRef: artifactId,
    details: { document },
  };
}

describe('vault miner (conversational graduation)', () => {
  it('promotes an ask-neighborhood after it recurs across two sessions', () => {
    const c = makeCorpusDir();
    cleanups.push(c.cleanup);
    const corpus = mount(c.root, 'neighborhood');
    const touched = [
      { document: 'src/url-builder.ts', section: 'assembleAddress' },
      { document: 'src/url-builder.ts', section: 'combineSegments' },
    ];
    for (const ev of [
      askEvent('vault-session-a', touched, 'how does assembleAddress work?'),
      askEvent('vault-session-a', touched, 'what does assembleAddress return?'),
      askEvent('vault-session-b', touched, 'explain address assembly'),
    ]) {
      corpus.audit.write(ev);
      corpus.store.insertAuditEvent(ev);
    }

    const result = mineVault(corpus, { sync: true });
    expect(result.graduated.length).toBe(1);
    expect(result.graduated[0]?.kind).toBe('ask-neighborhood');
    expect(result.graduated[0]?.document).toBe('src/url-builder.ts');
    expect(result.graduated[0]?.sections).toContain('assembleAddress');
    // Persisted so the codex emitter picks it up next call.
    const persisted = readVaultGraduated(corpus.dcpDir);
    expect(persisted.entries.map((e) => e.candidate)).toEqual(
      result.graduated.map((e) => e.candidate),
    );
  });

  it('does not graduate a one-session neighborhood no matter how many asks', () => {
    const c = makeCorpusDir();
    cleanups.push(c.cleanup);
    const corpus = mount(c.root, 'single-session');
    const touched = [{ document: 'a.md', section: 'intro' }];
    for (let i = 0; i < 5; i += 1) {
      const ev = askEvent('vault-session-solo', touched);
      corpus.audit.write(ev);
      corpus.store.insertAuditEvent(ev);
    }
    const result = mineVault(corpus, { sync: true });
    // The signature has one session: it belongs in candidates only.
    expect(result.graduated).toHaveLength(0);
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
  });

  it('promotes a zoom hotspot when a document is zoomed by two sessions', () => {
    const c = makeCorpusDir();
    cleanups.push(c.cleanup);
    const corpus = mount(c.root, 'hotspot');
    for (const ev of [
      zoomEvent('vault-session-x', 'a1', 'src/url-builder.ts'),
      zoomEvent('vault-session-x', 'a1', 'src/url-builder.ts'),
      zoomEvent('vault-session-y', 'a1', 'src/url-builder.ts'),
    ]) {
      corpus.audit.write(ev);
      corpus.store.insertAuditEvent(ev);
    }
    const result = mineVault(corpus, { sync: true });
    const hotspot = result.graduated.find((g) => g.kind === 'zoom-hotspot');
    expect(hotspot).toBeDefined();
    expect(hotspot?.document).toBe('src/url-builder.ts');
  });

  it('is idempotent: re-running the miner does not duplicate graduated entries', () => {
    const c = makeCorpusDir();
    cleanups.push(c.cleanup);
    const corpus = mount(c.root, 'idempotent');
    const touched = [{ document: 'src/url-builder.ts', section: 'assembleAddress' }];
    for (const s of ['vault-session-a', 'vault-session-b', 'vault-session-c']) {
      for (let i = 0; i < 2; i += 1) {
        const ev = askEvent(s, touched);
        corpus.audit.write(ev);
        corpus.store.insertAuditEvent(ev);
      }
    }
    const first = mineVault(corpus, { sync: true });
    const second = mineVault(corpus, { sync: true });
    expect(second.graduated.map((e) => e.candidate).sort()).toEqual(
      first.graduated.map((e) => e.candidate).sort(),
    );
    // Occurrence and session counts merge (they do not double).
    for (const gid of first.graduated.map((e) => e.candidate)) {
      const a = first.graduated.find((e) => e.candidate === gid);
      const b = second.graduated.find((e) => e.candidate === gid);
      expect(b?.occurrences).toBe(a?.occurrences);
      expect(b?.sessions).toBe(a?.sessions);
    }
  });
});
