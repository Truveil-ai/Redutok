import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '@redutok/shared';
import { buildLedger } from '../src/ledger.js';
import { parseSessionFile } from '../src/parser.js';
import { buildReport, renderText } from '../src/report.js';
import { buildSessionReceipt } from '../src/receipt.js';

/**
 * `redutok report` is what a user actually runs, and until now it printed the
 * ledger, the scores and a per-tool table without ever saying what the tool
 * saved. The receipt knew; the report did not. Both now read one computation,
 * so the two can never disagree about a session.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, '..', '..', '..', 'fixtures', 'sessions', 'small.jsonl');

const distill = (id: string, profile: string, bytesIn: number, bytesOut: number): AuditEvent => ({
  id,
  timestamp: '2026-08-04T10:00:00.000Z',
  sessionId: 's-small',
  module: 'sidecar.distill',
  action: 'distill',
  reason: `profile ${profile} served ${bytesOut}B for ${bytesIn}B raw`,
  inputRef: id,
  bytesIn,
  bytesOut,
  details: { profile },
});

const passthrough = (file: string, bytes: number, reason: string): AuditEvent => ({
  id: `p-${file}`,
  timestamp: '2026-08-04T10:00:00.000Z',
  sessionId: 's-small',
  module: 'sidecar.prepare',
  action: 'passthrough',
  reason: `${file} read raw: ${reason}`,
  bytesIn: bytes,
  bytesOut: bytes,
  details: { path: file, reason },
});

function auditFile(events: AuditEvent[]): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'redutok-savings-'));
  const file = path.join(dir, 'audit.jsonl');
  writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + (events.length > 0 ? '\n' : ''));
  return file;
}

const GOVERNED = [
  distill('a1', 'doc-skeleton', 268_762, 18_002),
  distill('a2', 'doc-skeleton', 85_047, 11_502),
  distill('a3', 'build-log', 9_216, 1_096),
];

describe('the report says what the session saved', () => {
  it('renders every savings figure the receipt knows, with its bands', async () => {
    const auditPath = auditFile(GOVERNED);
    const report = await buildReport(fixture, { auditPath });
    const text = renderText(report);

    expect(text).toContain('Savings');
    // Raw touched, served, avoided and the ratio between them, in tokens.
    expect(text).toContain('raw touched     90,756 tokens across 3 serves');
    expect(text).toContain('served          7,650 tokens');
    expect(text).toContain('avoided         83,106 tokens');
    expect(report.savings.rawTokens).toBe(Math.round(363_025 / 4));
    expect(report.savings.servedTokens).toBe(Math.round(30_600 / 4));
    expect(report.savings.avoidedTokens).toBe(
      report.savings.rawTokens - report.savings.servedTokens,
    );
    expect(text).toMatch(/11\.9x|11\.86x/);

    // Cost at the session's own rate row, named.
    expect(text).toMatch(/cost avoided/i);
    expect(text).toContain('claude-sonnet-5');
    expect(report.savings.costAvoidedUsd).toBeGreaterThan(0);

    // Energy and carbon as bands, never as measurements (METHODOLOGY.md).
    expect(text).toMatch(/energy avoided.*band/i);
    expect(text).toMatch(/carbon avoided.*band/i);
    expect(text).toContain('estimate');
    expect(report.savings.energyAvoidedWh?.low).toBeLessThanOrEqual(
      report.savings.energyAvoidedWh?.base ?? 0,
    );
    expect(report.savings.co2AvoidedGrams?.high).toBeGreaterThanOrEqual(
      report.savings.co2AvoidedGrams?.base ?? 0,
    );

    // Top distillations by tokens avoided.
    expect(text).toContain('top distillations by tokens avoided');
    expect(text).toContain('doc-skeleton');
    expect(report.savings.topDistillations[0]?.avoidedTokens).toBeGreaterThan(
      report.savings.topDistillations[1]?.avoidedTokens ?? 0,
    );

    // House style.
    expect(text).not.toMatch(/[—–!]|\p{Extended_Pictographic}/u);
  });

  it('carries the savings section through --json', async () => {
    const auditPath = auditFile(GOVERNED);
    const report = await buildReport(fixture, { auditPath });
    const parsed = JSON.parse(JSON.stringify(report)) as typeof report;
    expect(parsed.savings.avoidedTokens).toBe(report.savings.avoidedTokens);
    expect(parsed.savings.topDistillations).toHaveLength(3);
    expect(parsed.savings.energyAvoidedWh?.base).toBeCloseTo(
      report.savings.energyAvoidedWh?.base ?? 0,
      10,
    );
  });

  it('states plainly when nothing was governed, matching the receipt', async () => {
    const auditPath = auditFile([passthrough('data-export.csv', 356_704, 'no skeleton builder for .csv')]);
    const report = await buildReport(fixture, { auditPath });
    const text = renderText(report);
    expect(report.savings.governed).toBe(false);
    expect(text).toContain('nothing was governed this session');
    expect(text).toContain('context efficiency is not scorable');
    expect(text).toContain('data-export.csv');
    expect(text).toContain('no skeleton builder for .csv');
    expect(text).toMatch(/estimated .* tokens would have been avoided/);
    // No savings figures that would imply a result.
    expect(text).not.toContain('top distillations by tokens avoided');
  });
});

describe('report and receipt cannot disagree', () => {
  it('reports identical avoided figures for the same session', async () => {
    const auditPath = auditFile(GOVERNED);
    const report = await buildReport(fixture, { auditPath });
    const receipt = buildSessionReceipt(buildLedger(await parseSessionFile(fixture)), { auditPath });

    expect(report.savings.avoidedTokens).toBe(receipt.avoidedTokens);
    expect(report.savings.rawTokens).toBe(receipt.savings.rawTokens);
    expect(report.savings.servedTokens).toBe(receipt.savings.servedTokens);
    expect(report.savings.governed).toBe(receipt.governed);
    expect(report.savings.topDistillations).toEqual(receipt.topDistillations);
    expect(report.savings.costAvoidedUsd).toBe(receipt.savings.costAvoidedUsd);
  });

  it('agrees on the ungoverned case too', async () => {
    const auditPath = auditFile([passthrough('big.csv', 400_000, 'no skeleton builder for .csv')]);
    const report = await buildReport(fixture, { auditPath });
    const receipt = buildSessionReceipt(buildLedger(await parseSessionFile(fixture)), { auditPath });
    expect(report.savings.governed).toBe(receipt.governed);
    expect(report.savings.passthroughs).toEqual(receipt.passthroughs);
    expect(report.savings.estimatedAvoidableTokens).toBe(receipt.estimatedAvoidableTokens);
  });
});

/**
 * Field, 0.1.8: a session whose large Read was rewritten to its skeleton
 * mirror reported "nothing was governed" and an unscorable context
 * efficiency, because savings counted only distill and serve-raw events and
 * the rewrite event carried no byte counts. A rewrite now records the raw it
 * stood in for and the mirror entry it served.
 */
const mirrorRewrite = (file: string, bytesIn: number | undefined, bytesOut: number | undefined, prepared = false): AuditEvent => ({
  id: `rewrite-m-${file}`,
  timestamp: '2026-09-13T10:00:00.000Z',
  sessionId: 's-small',
  module: 'hooks.pretooluse',
  action: 'rewrite',
  reason: 'large Read rewritten to the skeleton mirror, rule read-mirror',
  ...(bytesIn === undefined ? {} : { bytesIn }),
  ...(bytesOut === undefined ? {} : { bytesOut }),
  details: {
    rule: 'read-mirror',
    realPath: `/project/${file}`,
    mirrorPath: `/project/.dcp/mirror/${file}`,
    path: file,
    ...(bytesIn === undefined ? {} : { prepared }),
  },
});

describe('a read-mirror rewrite is a governed serve', () => {
  it('appears in the savings block with its avoided tokens, and makes context efficiency scorable', async () => {
    // The NIST source from the field session: 189,725 bytes raw, served as a
    // 4,328-byte mirror entry. 47,431 raw tokens to 1,082 served.
    const auditPath = auditFile([mirrorRewrite('sources/nist.md', 189_725, 4_328)]);
    const report = await buildReport(fixture, { auditPath });
    const text = renderText(report);
    expect(text).not.toContain('nothing was governed');
    expect(text).toContain('raw touched     47,431 tokens across 1 serves');
    expect(text).toContain('served          1,082 tokens');
    expect(text).toContain('avoided         46,349 tokens (43.8x)');
    expect(text).toContain('1. read-mirror (sources/nist.md): 47,431 raw to 1,082 served, 46,349 avoided');

    const receipt = buildSessionReceipt(buildLedger(await parseSessionFile(fixture)), { auditPath });
    expect(receipt.governed).toBe(true);
    expect(receipt.avoidedTokens).toBe(46_349);
    expect(receipt.notScorableReason).toBeUndefined();
    expect(report.savings.avoidedTokens).toBe(receipt.avoidedTokens);
  });

  it('counts a skeleton built on demand once, not as both its distill and its rewrite', async () => {
    // The hook asked the sidecar to build this entry, which audited the build
    // as a distill with bytes; the rewrite that served it is the same Read.
    const auditPath = auditFile([
      distill('d-pdf', 'doc-skeleton', 153_617, 29_377),
      mirrorRewrite('sources/difc_dpl.pdf', 153_617, 29_656, true),
    ]);
    const report = await buildReport(fixture, { auditPath });
    expect(report.savings.serves).toBe(1);
    expect(report.savings.rawTokens).toBe(38_404);
  });

  it('leaves a rewrite recorded before byte counts existed out of the figures', async () => {
    const auditPath = auditFile([mirrorRewrite('sources/nist.md', undefined, undefined)]);
    const report = await buildReport(fixture, { auditPath });
    expect(report.savings.governed).toBe(false);
  });
});
