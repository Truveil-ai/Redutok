import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CandidateRecordSchema,
  readCandidatesFile,
  type CandidateRecord,
} from '../src/index.js';

const tmpFile = (): string =>
  path.join(mkdtempSync(path.join(os.tmpdir(), 'redutok-cand-')), 'candidates.jsonl');

export function sampleCandidate(overrides: Partial<CandidateRecord> = {}): CandidateRecord {
  return CandidateRecordSchema.parse({
    id: 'cand-abcd1234',
    type: 'error-fix',
    key: 'error-fix:build-log:error TS2304',
    signature: "error TS2304: Cannot find name 'x'",
    evidence: ['distilled-a1', 'distilled-a2'],
    firstSeen: '2026-07-19T12:00:00.000Z',
    lastSeen: '2026-07-19T12:05:00.000Z',
    occurrences: 1,
    ...overrides,
  });
}

describe('CandidateRecordSchema', () => {
  it('accepts the three v1 candidate types and defaults the reserved contradiction field to null', () => {
    for (const type of ['error-fix', 'zoom-hotspot', 'recurrence'] as const) {
      const record = sampleCandidate({ type });
      expect(record.type).toBe(type);
      expect(record.contradiction).toBeNull();
    }
  });

  it('rejects an unknown type and a non-positive occurrence count', () => {
    expect(() => sampleCandidate({ type: 'novel' as never })).toThrow();
    expect(() => sampleCandidate({ occurrences: 0 })).toThrow();
  });

  it('defaults evidence and details to empty', () => {
    const record = CandidateRecordSchema.parse({
      id: 'c1',
      type: 'recurrence',
      key: 'recurrence:pnpm build',
      signature: 'recurring command: pnpm build',
      firstSeen: '2026-07-19T12:00:00.000Z',
      lastSeen: '2026-07-19T12:00:00.000Z',
      occurrences: 2,
    });
    expect(record.evidence).toEqual([]);
    expect(record.details).toEqual({});
  });
});

describe('readCandidatesFile', () => {
  it('reports a missing file without throwing', () => {
    const result = readCandidatesFile(path.join(os.tmpdir(), 'nope', 'candidates.jsonl'));
    expect(result.missing).toBe(true);
    expect(result.records).toEqual([]);
    expect(result.malformed).toBe(0);
  });

  it('reads valid lines and counts malformed ones instead of throwing', () => {
    const file = tmpFile();
    writeFileSync(
      file,
      [
        JSON.stringify(sampleCandidate()),
        'not json at all',
        JSON.stringify({ id: 'x', type: 'error-fix' }),
        JSON.stringify(sampleCandidate({ id: 'cand-2', type: 'zoom-hotspot', occurrences: 3 })),
        '',
      ].join('\n'),
    );
    const result = readCandidatesFile(file);
    expect(result.missing).toBe(false);
    expect(result.records).toHaveLength(2);
    expect(result.records[1]?.occurrences).toBe(3);
    expect(result.malformed).toBe(2);
  });
});
