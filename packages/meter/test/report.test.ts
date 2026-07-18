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
    expect(report.audit).toHaveLength(1);
    // Shipped prices are source-cited, so no TODO-VERIFY note appears; the
    // thinking-rate assumption is always stated.
    expect(report.notes.join(' ')).toContain('Thinking tokens are priced at the output rate');
    // Price rows are cited, so no TODO-VERIFY there, but the energy note must
    // flag the unverified energy and grid rows.
    expect(report.notes.join(' ')).toContain('never measurements');
    expect(report.energy.wh.base).toBeCloseTo(6.03, 9);
    expect(report.energy.region).toBe('world');
    expect(report.energy.sidecarWh).toBe(0);
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
    expect(text).toContain('Read');
    expect(text).toContain('Skipped records: 1 unknown type, 0 malformed');
    // Energy is always rendered as an estimate with the band, never bare.
    expect(text).toContain('estimated 6.03 Wh (band 2.01 to 20.10 Wh)');
    // 6.03 Wh at the verified world intensity of 473 gCO2e/kWh.
    expect(text).toContain('estimated 2.85 gCO2e (band 0.95 to 9.51 gCO2e), grid region world');
    expect(text).toContain('sidecar self-consumption: 0 Wh');
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
