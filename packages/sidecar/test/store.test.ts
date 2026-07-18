import { mkdtempSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from '../src/store.js';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'redutok-store-'));
let store: Store | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
});

describe('openStore', () => {
  it('creates the database, applies all migrations, and is idempotent on reopen', () => {
    const dbPath = path.join(tmp(), 'state.db');
    store = openStore(dbPath);
    const v1 = store.migrationVersion();
    expect(v1).toBeGreaterThanOrEqual(1);
    store.close();
    store = openStore(dbPath);
    expect(store.migrationVersion()).toBe(v1);
  });
});

describe('artifacts', () => {
  it('round-trips an artifact with raw retention and metadata', () => {
    store = openStore(path.join(tmp(), 'state.db'));
    store.insertArtifact({
      id: 'aX7f',
      sessionId: 's-1',
      artifactClass: 'build-log',
      tool: 'Bash',
      createdAt: '2026-07-19T10:00:00.000Z',
      raw: 'raw build output',
      distilled: 'VERDICT: ok',
      profile: 'build-log',
      gatesPassed: true,
      meta: { ratio: 12.5 },
    });
    const got = store.getArtifact('aX7f');
    expect(got?.raw).toBe('raw build output');
    expect(got?.distilled).toBe('VERDICT: ok');
    expect(got?.gatesPassed).toBe(true);
    expect(got?.meta).toEqual({ ratio: 12.5 });
    expect(store.getArtifact('missing')).toBeUndefined();
  });
});

describe('served files registry', () => {
  it('records and looks up the last served hash per session and path', () => {
    store = openStore(path.join(tmp(), 'state.db'));
    store.recordServedFile('s-1', 'src/index.ts', 'hash-1', '2026-07-19T10:00:00.000Z');
    store.recordServedFile('s-1', 'src/index.ts', 'hash-2', '2026-07-19T10:05:00.000Z');
    expect(store.getServedFile('s-1', 'src/index.ts')?.hash).toBe('hash-2');
    expect(store.getServedFile('s-2', 'src/index.ts')).toBeUndefined();
  });
});

describe('session state', () => {
  it('upserts and reads rolling session state', () => {
    store = openStore(path.join(tmp(), 'state.db'));
    store.upsertSessionState('s-1', 'task: build', '2026-07-19T10:00:00.000Z');
    store.upsertSessionState('s-1', 'task: build, step 2', '2026-07-19T10:01:00.000Z');
    expect(store.getSessionState('s-1')?.stateMd).toBe('task: build, step 2');
  });
});

describe('audit table', () => {
  it('stores and lists audit events per session in insert order', () => {
    store = openStore(path.join(tmp(), 'state.db'));
    const base = {
      timestamp: '2026-07-19T10:00:00.000Z',
      sessionId: 's-1',
      module: 'sidecar.distill',
      action: 'distill' as const,
      reason: 'build-log profile applied',
    };
    store.insertAuditEvent({ ...base, id: 'e1' });
    store.insertAuditEvent({ ...base, id: 'e2', action: 'serve-raw', reason: 'gate failed' });
    const events = store.listAuditEvents('s-1');
    expect(events.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(store.listAuditEvents('s-other')).toEqual([]);
  });
});

describe('migrations directory', () => {
  it('contains only versioned sql files in order', () => {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
    const files = readdirSync(dir);
    expect(files.length).toBeGreaterThanOrEqual(1);
    for (const f of files) expect(f).toMatch(/^\d{3}_[a-z0-9-]+\.sql$/);
  });
});
