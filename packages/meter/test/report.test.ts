import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildReport, locateLastSessionLog, renderText } from '../src/report.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.join(here, '..', '..', '..', 'fixtures', 'sessions', name);

describe('buildReport on small.jsonl', () => {
  it('assembles ledger, cost, parse counts and audit trail', async () => {
    const report = await buildReport(fixture('small.jsonl'));
    expect(report.ledger.sessionId).toBe('s-small');
    expect(report.grandTotal).toBe(20100);
    expect(report.cost.pricedTurns).toBe(3);
    expect(report.parse.unknownType).toBe(1);
    // report.audit is the sidecar session trail (none for this fixture); the
    // parse skip above is reported via parse counts, not as an audit event.
    expect(report.audit).toEqual([]);
    // Shipped prices are source-cited, so no TODO-VERIFY note appears; the
    // thinking-rate assumption is always stated.
    expect(report.notes.join(' ')).toContain('Thinking tokens are priced at the output rate');
    // Price rows are cited, so no TODO-VERIFY there, but the energy note must
    // flag the unverified energy and grid rows.
    expect(report.notes.join(' ')).toContain('never measurements');
    // small.jsonl has no cache_creation tier breakdown, so every cache-write
    // token was conservatively assumed at the 1-hour tier; disclosed, not silent.
    expect(report.notes.join(' ')).toContain(
      '920 of 920 cache-write tokens had no 5-minute/1-hour tier breakdown',
    );
    expect(report.energy.wh.base).toBeCloseTo(6.03, 9);
    expect(report.energy.region).toBe('world');
    expect(report.energy.sidecarWh).toBe(0);
  });

  it('scores context efficiency only from audit events attributed to the transcript session', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'redutok-report-audit-'));
    const auditPath = path.join(dir, 'audit.jsonl');
    const event = (sessionId: string, action: string, bytesOut: number, id: string) =>
      JSON.stringify({
        id,
        timestamp: '2026-07-19T10:00:00.000Z',
        sessionId,
        module: 'sidecar.distill',
        action,
        reason: 'x',
        // Both halves: a serve says what it replaced, not only what it served.
        bytesIn: action === 'serve-raw' ? bytesOut : bytesOut * 10,
        bytesOut,
      });
    writeFileSync(
      auditPath,
      [
        event('s-small', 'distill', 900, 'e1'),
        event('s-small', 'serve-raw', 100, 'e2'),
        // A foreign session's raw serve must not drag the score down.
        event('s-other', 'serve-raw', 90_000, 'e3'),
      ].join('\n') + '\n',
    );
    const report = await buildReport(fixture('small.jsonl'), { auditPath });
    // 9000B raw distilled to 900B plus 100B served raw: 8100 of 9100 avoided.
    // The foreign session's 90,000B never enters either half.
    expect(report.scores.contextEfficiency).toMatchObject({ scorable: true, score: 89 });
  });

  it('footer audit-event count and scoring serve count read the same trail', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'redutok-report-footer-'));
    const auditPath = path.join(dir, 'audit.jsonl');
    const event = (sessionId: string, action: string, bytesOut: number, id: string) =>
      JSON.stringify({
        id,
        timestamp: '2026-07-19T10:00:00.000Z',
        sessionId,
        module: 'sidecar.distill',
        action,
        reason: 'x',
        // Both halves: a serve says what it replaced, not only what it served.
        bytesIn: action === 'serve-raw' ? bytesOut : bytesOut * 10,
        bytesOut,
      });
    writeFileSync(
      auditPath,
      [
        event('s-small', 'distill', 900, 'e1'),
        event('s-small', 'serve-raw', 100, 'e2'),
        event('s-other', 'serve-raw', 90_000, 'e3'),
      ].join('\n') + '\n',
    );
    const report = await buildReport(fixture('small.jsonl'), { auditPath });
    // Both counters derive from report.audit: the session-attributed sidecar
    // trail scoring consumed, never the parse audit.
    expect(report.audit).toHaveLength(2);
    const text = renderText(report);
    expect(text).toContain('Audit events: 2.');
    expect(text).toContain('across 2 serves');
  });

  it('round-trips through JSON for --json output', async () => {
    const report = await buildReport(fixture('small.jsonl'));
    const back = JSON.parse(JSON.stringify(report));
    expect(back.ledger.totals).toEqual(report.ledger.totals);
  });
});

describe('renderText', () => {
  it('renders totals, tools and skip counts in the house style', async () => {
    const text = renderText(await buildReport(fixture('small.jsonl')));
    expect(text).toContain('Redutok report');
    expect(text).toContain('total        20,100');
    expect(text).toContain('cache write  920  (5m: 0, 1h: 920)');
    expect(text).toMatch(/Note: 920 of 920 cache-write tokens had no 5-minute\/1-hour tier breakdown/);
    expect(text).toContain('Read');
    expect(text).toContain('Skipped records: 1 unknown type, 0 malformed');
    // Energy is always rendered as an estimate with the band, never bare.
    expect(text).toContain('estimated 6.03 Wh (band 2.01 to 20.10 Wh)');
    // 6.03 Wh at the verified world intensity of 473 gCO2e/kWh.
    expect(text).toContain('estimated 2.85 gCO2e (band 0.95 to 9.51 gCO2e), grid region world');
    expect(text).toContain('sidecar self-consumption: 0 Wh');
    // Phase 6B scores: fixture session has no audit trail, so context
    // efficiency is explicitly not scorable while the rest compute.
    expect(text).toMatch(/context efficiency\s+not scorable:/);
    expect(text).toMatch(/output discipline\s+100/);
    expect(text).toMatch(/cache utilization\s+92/);
    // Three of the four scores contribute here, so the grade stands but the
    // line now says what it rests on (docs/SCORING.md, composite disclosure).
    expect(text).toMatch(/composite\s+97 \(A, from 3 of 4 scores\)/);
    expect(text).not.toMatch(/[—!]|\p{Extended_Pictographic}/u);
  });
});

describe('locateLastSessionLog', () => {
  it('finds the newest .jsonl in a nested directory tree', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'redutok-logs-'));
    const nested = path.join(root, 'project-a');
    mkdirSync(nested, { recursive: true });
    const older = path.join(nested, 'old.jsonl');
    const newer = path.join(root, 'new.jsonl');
    writeFileSync(path.join(root, 'ignored.txt'), 'x');
    writeFileSync(older, '{}');
    writeFileSync(newer, '{}');
    const now = Date.now() / 1000;
    utimesSync(older, now - 3600, now - 3600);
    utimesSync(newer, now, now);
    expect(locateLastSessionLog(root)).toBe(newer);
  });

  it('returns undefined when the directory does not exist', () => {
    expect(locateLastSessionLog(path.join(os.tmpdir(), 'redutok-does-not-exist'))).toBeUndefined();
  });
});
