import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAuditReport, renderAuditText } from '../src/audit-render.js';

function writeAuditFixture(): string {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'redutok-audit-render-')), 'audit.jsonl');
  const events = [
    {
      id: 'e1',
      timestamp: '2026-07-19T10:00:00.000Z',
      sessionId: 's-1',
      module: 'sidecar.distill',
      action: 'distill',
      reason: 'build-log profile, ratio 40.0x',
      bytesIn: 40000,
      bytesOut: 1000,
    },
    {
      id: 'e2',
      timestamp: '2026-07-19T10:01:00.000Z',
      sessionId: 's-1',
      module: 'sidecar.gates',
      action: 'serve-raw',
      reason: 'entity-preservation gate failed',
    },
    {
      id: 'e3',
      timestamp: '2026-07-19T10:02:00.000Z',
      sessionId: 's-other',
      module: 'sidecar.distill',
      action: 'distill',
      reason: 'other session event',
    },
  ];
  writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

describe('buildAuditReport and renderAuditText', () => {
  it('filters to the requested session and renders one line per event', () => {
    const report = buildAuditReport('s-1', writeAuditFixture());
    expect(report.events).toHaveLength(2);
    const text = renderAuditText(report, 's-1');
    expect(text).toContain('distill');
    expect(text).toContain('40000B to 1000B');
    expect(text).toContain('entity-preservation gate failed');
    expect(text).not.toContain('other session event');
    expect(text).toContain('Events: 2. Malformed lines skipped: 0.');
    expect(text).not.toMatch(/[—!]|\p{Extended_Pictographic}/u);
  });

  it('reports a missing audit file without throwing', () => {
    const report = buildAuditReport('s-1', path.join(os.tmpdir(), 'redutok-none', 'audit.jsonl'));
    expect(renderAuditText(report, 's-1')).toContain('No audit file found');
  });
});
