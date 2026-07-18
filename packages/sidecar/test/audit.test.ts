import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readAuditFile } from '@redutok/shared';
import { AuditWriter } from '../src/audit.js';

const tmpFile = () => path.join(mkdtempSync(path.join(os.tmpdir(), 'redutok-audit-')), 'audit.jsonl');

const event = (id: string, sessionId = 's-1') => ({
  id,
  timestamp: '2026-07-19T10:00:00.000Z',
  sessionId,
  module: 'sidecar.distill',
  action: 'distill' as const,
  reason: 'profile applied',
  details: { ratio: 10 },
});

describe('AuditWriter', () => {
  it('appends schema-validated events as one JSON line each', () => {
    const file = tmpFile();
    const writer = new AuditWriter(file);
    writer.write(event('e1'));
    writer.write(event('e2'));
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string).id).toBe('e1');
  });

  it('is append-only: a second writer never truncates existing events', () => {
    const file = tmpFile();
    new AuditWriter(file).write(event('e1'));
    new AuditWriter(file).write(event('e2'));
    expect(readAuditFile(file).events.map((e) => e.id)).toEqual(['e1', 'e2']);
  });

  it('rejects an event that fails the shared schema', () => {
    const writer = new AuditWriter(tmpFile());
    expect(() => writer.write({ ...event('e1'), action: 'invent' as never })).toThrow();
  });
});

describe('readAuditFile', () => {
  it('filters by session and tolerates malformed lines with a counter', () => {
    const file = tmpFile();
    const writer = new AuditWriter(file);
    writer.write(event('e1', 's-1'));
    writer.write(event('e2', 's-2'));
    appendFileSync(file, '{broken\n');
    const all = readAuditFile(file);
    expect(all.events).toHaveLength(2);
    expect(all.malformed).toBe(1);
    expect(readAuditFile(file, 's-2').events.map((e) => e.id)).toEqual(['e2']);
  });

  it('returns empty for a missing file instead of throwing', () => {
    const result = readAuditFile(path.join(os.tmpdir(), 'redutok-nope', 'audit.jsonl'));
    expect(result.events).toEqual([]);
    expect(result.missing).toBe(true);
  });
});
