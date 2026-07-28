import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CandidateRecordSchema, type CandidateRecord } from '@redutok/shared';
import { buildCandidatesReport, renderCandidatesText } from '../src/candidates-render.js';
import { main } from '../src/cli.js';

const NOW = new Date('2026-07-29T12:00:00.000Z');

function record(overrides: Partial<CandidateRecord>): CandidateRecord {
  return CandidateRecordSchema.parse({
    id: 'cand-1',
    type: 'error-fix',
    key: 'error-fix:build-log:error TS2304',
    signature: "error TS2304: Cannot find name 'x'",
    evidence: ['e1'],
    firstSeen: '2026-07-19T12:00:00.000Z',
    lastSeen: '2026-07-29T11:30:00.000Z',
    occurrences: 1,
    ...overrides,
  });
}

function tmpCandidates(records: CandidateRecord[]): string {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'redutok-candcli-')), 'candidates.jsonl');
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

describe('renderCandidatesText', () => {
  it('renders counts and ages, most-observed first, preferring the drafted lesson', () => {
    const file = tmpCandidates([
      record({ id: 'c1' }),
      record({
        id: 'c2',
        type: 'zoom-hotspot',
        key: 'zoom-hotspot:source/index.ts',
        signature: 'distillate of source/index.ts required zooming back to raw',
        lesson: 'Serve createStyler with its body in the skeleton.',
        occurrences: 4,
      }),
    ]);
    const text = renderCandidatesText(buildCandidatesReport(file), NOW);
    const lines = text.split('\n');
    expect(lines[0]).toContain('2 candidates');
    expect(lines[0]).toContain('5 observations');
    // Sorted by occurrences: the hotspot with 4 observations leads.
    const hotspotLine = lines.findIndex((l) => l.includes('zoom-hotspot'));
    const fixLine = lines.findIndex((l) => l.includes('error-fix'));
    expect(hotspotLine).toBeGreaterThan(0);
    expect(hotspotLine).toBeLessThan(fixLine);
    expect(text).toContain('x4');
    expect(text).toContain('Serve createStyler with its body in the skeleton.');
    expect(text).toContain("error TS2304: Cannot find name 'x'");
    expect(text).toContain('first seen 10d ago');
    expect(text).toContain('last seen 30m ago');
  });

  it('says so when no candidates have been mined yet', () => {
    const missing = path.join(os.tmpdir(), 'redutok-none', 'candidates.jsonl');
    const text = renderCandidatesText(buildCandidatesReport(missing), NOW);
    expect(text).toContain('No candidates mined yet');
  });

  it('reports malformed lines without dropping the valid ones silently', () => {
    const file = tmpCandidates([record({})]);
    writeFileSync(file, 'garbage\n', { flag: 'a' });
    const text = renderCandidatesText(buildCandidatesReport(file), NOW);
    expect(text).toContain('1 candidates');
    expect(text).toContain('Malformed lines skipped: 1');
  });
});

describe('redutok candidates command', () => {
  it('renders the candidate list from --file', async () => {
    const file = tmpCandidates([record({})]);
    const logs: string[] = [];
    const original = console.log;
    console.log = (msg: string): void => {
      logs.push(msg);
    };
    try {
      const code = await main(['candidates', '--file', file]);
      expect(code).toBe(0);
    } finally {
      console.log = original;
    }
    expect(logs.join('\n')).toContain('error TS2304');
  });
});
