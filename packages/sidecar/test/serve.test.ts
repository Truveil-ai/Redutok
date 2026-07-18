import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyPatch } from 'diff';
import { readAuditFile } from '@redutok/shared';
import { AuditWriter } from '../src/audit.js';
import { fileIdFor, serveFile } from '../src/serve.js';
import { openStore } from '../src/store.js';

function rig() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'redutok-serve-'));
  return {
    store: openStore(path.join(dir, 'state.db')),
    audit: new AuditWriter(path.join(dir, 'audit.jsonl')),
    auditPath: path.join(dir, 'audit.jsonl'),
  };
}

const V1 = 'line one\nline two\nline three\n';
const V2 = 'line one\nline two changed\nline three\nline four\n';
const V3 = 'line zero\nline one\nline two changed\nline three\nline four\n';

describe('fileIdFor', () => {
  it('is stable for a path and distinct across paths', () => {
    expect(fileIdFor('src/a.ts')).toBe(fileIdFor('src/a.ts'));
    expect(fileIdFor('src/a.ts')).not.toBe(fileIdFor('src/b.ts'));
    expect(fileIdFor('src/a.ts')).toMatch(/^F[0-9a-f]{4}$/);
  });
});

describe('serveFile delta registry', () => {
  it('serves full first, then diffs, and applying the diffs reconstructs byte-equal', () => {
    const r = rig();
    const first = serveFile(r.store, r.audit, 's-1', 'src/a.ts', V1);
    expect(first.mode).toBe('full');
    expect(first.ref).toMatch(/^F[0-9a-f]{4}@[0-9a-f]{16}$/);
    expect(first.text).toBe(V1);

    const second = serveFile(r.store, r.audit, 's-1', 'src/a.ts', V2);
    expect(second.mode).toBe('diff');
    expect(second.text).toContain('@@');
    const reconstructed2 = applyPatch(V1, second.text);
    expect(reconstructed2).toBe(V2);

    const third = serveFile(r.store, r.audit, 's-1', 'src/a.ts', V3);
    expect(third.mode).toBe('diff');
    expect(applyPatch(reconstructed2 as string, third.text)).toBe(V3);
    expect(third.ref.split('@')[0]).toBe(first.ref.split('@')[0]);
    expect(third.ref.split('@')[1]).not.toBe(first.ref.split('@')[1]);
    r.store.close();
  });

  it('never re-serves an unchanged file', () => {
    const r = rig();
    serveFile(r.store, r.audit, 's-1', 'src/a.ts', V1);
    const again = serveFile(r.store, r.audit, 's-1', 'src/a.ts', V1);
    expect(again.mode).toBe('unchanged');
    expect(again.text).toContain('unchanged since last serve');
    expect(again.text.length).toBeLessThan(V1.length + 100);
    r.store.close();
  });

  it('tracks per session: a second session gets a full serve', () => {
    const r = rig();
    serveFile(r.store, r.audit, 's-1', 'src/a.ts', V1);
    expect(serveFile(r.store, r.audit, 's-2', 'src/a.ts', V1).mode).toBe('full');
    r.store.close();
  });

  it('audits every serve decision', () => {
    const r = rig();
    serveFile(r.store, r.audit, 's-1', 'src/a.ts', V1);
    serveFile(r.store, r.audit, 's-1', 'src/a.ts', V2);
    const events = readAuditFile(r.auditPath, 's-1').events;
    expect(events.filter((e) => e.module === 'sidecar.serve')).toHaveLength(2);
    expect(events.some((e) => e.reason.includes('unified diff'))).toBe(true);
    r.store.close();
  });
});
