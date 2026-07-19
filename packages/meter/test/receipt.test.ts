import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildLedger } from '../src/ledger.js';
import { parseSessionFile } from '../src/parser.js';
import { buildSessionReceipt, renderReceiptBlock } from '../src/receipt.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, '..', '..', '..', 'fixtures', 'sessions', 'small.jsonl');

async function smallLedger() {
  return buildLedger(await parseSessionFile(fixture));
}

interface EventSpec {
  id: string;
  sessionId: string;
  action: string;
  bytesIn?: number;
  bytesOut?: number;
  profile?: string;
  inputRef?: string;
}

function writeAudit(specs: EventSpec[]): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'redutok-receipt-'));
  const auditPath = path.join(dir, 'audit.jsonl');
  const lines = specs.map((s) =>
    JSON.stringify({
      id: s.id,
      timestamp: '2026-07-19T10:00:00.000Z',
      sessionId: s.sessionId,
      module: 'sidecar.distill',
      action: s.action,
      reason: 'x',
      inputRef: s.inputRef,
      bytesIn: s.bytesIn,
      bytesOut: s.bytesOut,
      details: s.profile === undefined ? undefined : { profile: s.profile },
    }),
  );
  writeFileSync(auditPath, lines.join('\n') + '\n');
  return auditPath;
}

describe('buildSessionReceipt', () => {
  it('sums avoided tokens and ranks the top three distillations for this session only', async () => {
    const auditPath = writeAudit([
      // 2304 -> 274 tok, 2030 avoided.
      { id: 'e1', sessionId: 's-small', action: 'distill', bytesIn: 9216, bytesOut: 1096, profile: 'build-log', inputRef: 'a1' },
      // 1000 -> 100 tok, 900 avoided.
      { id: 'e2', sessionId: 's-small', action: 'distill', bytesIn: 4000, bytesOut: 400, profile: 'file-skeleton', inputRef: 'a2' },
      // 500 -> 200 tok, 300 avoided.
      { id: 'e3', sessionId: 's-small', action: 'distill', bytesIn: 2000, bytesOut: 800, profile: 'test-output', inputRef: 'a3' },
      // 300 -> 250 tok, 50 avoided: ranked fourth, must not appear in the top three.
      { id: 'e4', sessionId: 's-small', action: 'distill', bytesIn: 1200, bytesOut: 1000, profile: 'search-results', inputRef: 'a4' },
      // Gate-failure raw serve avoids nothing.
      { id: 'e5', sessionId: 's-small', action: 'serve-raw', bytesIn: 4000, bytesOut: 4000, profile: 'build-log', inputRef: 'a5' },
      // A foreign session's giant distillation must not leak into this receipt.
      { id: 'e6', sessionId: 's-other', action: 'distill', bytesIn: 400_000, bytesOut: 4000, profile: 'build-log', inputRef: 'a6' },
    ]);
    const receipt = buildSessionReceipt(await smallLedger(), { auditPath });
    expect(receipt.sessionId).toBe('s-small');
    expect(receipt.billedTokens).toBe(20100);
    expect(receipt.turns).toBe(3);
    expect(receipt.costUsd).toBeGreaterThan(0);
    expect(receipt.auditEvents).toBe(5);
    expect(receipt.avoidedTokens).toBe(2030 + 900 + 300 + 50);
    expect(receipt.topDistillations.map((d) => d.label)).toEqual([
      'build-log',
      'file-skeleton',
      'test-output',
    ]);
    expect(receipt.topDistillations[0]).toMatchObject({
      ref: 'a1',
      rawTokens: 2304,
      servedTokens: 274,
      avoidedTokens: 2030,
    });
    // With audit events present the composite includes context efficiency.
    expect(receipt.grade).toMatch(/^\d+ \([A-F]\)$/);
  });

  it('reports no distillations when the audit trail has no events for this session', async () => {
    const auditPath = writeAudit([
      { id: 'e1', sessionId: 's-other', action: 'distill', bytesIn: 4000, bytesOut: 400 },
    ]);
    const receipt = buildSessionReceipt(await smallLedger(), { auditPath });
    expect(receipt.auditEvents).toBe(0);
    expect(receipt.avoidedTokens).toBe(0);
    expect(receipt.topDistillations).toEqual([]);
  });

  it('tolerates a missing audit file entirely', async () => {
    const missing = path.join(os.tmpdir(), 'redutok-receipt-none', 'audit.jsonl');
    const receipt = buildSessionReceipt(await smallLedger(), { auditPath: missing });
    expect(receipt.auditEvents).toBe(0);
    expect(receipt.billedTokens).toBe(20100);
  });
});

describe('renderReceiptBlock', () => {
  it('renders billed, avoided, top three and grade in the house style', async () => {
    const auditPath = writeAudit([
      { id: 'e1', sessionId: 's-small', action: 'distill', bytesIn: 9216, bytesOut: 1096, profile: 'build-log', inputRef: 'a1' },
    ]);
    const text = renderReceiptBlock(buildSessionReceipt(await smallLedger(), { auditPath }));
    expect(text).toContain('Redutok receipt for session s-small');
    expect(text).toContain('billed   20,100 tokens across 3 turns, est ');
    expect(text).toContain('avoided  2,030 tokens across 1 audit events');
    expect(text).toContain('1. build-log (a1): 2,304 raw to 274 served, 2,030 avoided');
    expect(text).toMatch(/grade\s+\d+ \([A-F]\)/);
    expect(text).not.toMatch(/[—!]|\p{Extended_Pictographic}/u);
  });

  it('prints the no-distillations line instead of zeros for an unattributed session', async () => {
    const missing = path.join(os.tmpdir(), 'redutok-receipt-none', 'audit.jsonl');
    const text = renderReceiptBlock(buildSessionReceipt(await smallLedger(), { auditPath: missing }));
    expect(text).toContain('no distillations this session');
    expect(text).not.toContain('avoided  0 tokens');
    expect(text).not.toContain('top distillations');
  });
});
