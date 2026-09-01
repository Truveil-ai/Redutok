import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { GovernanceStatus } from '@redutok/shared';
import { buildLedger } from '../src/ledger.js';
import { parseSessionFile } from '../src/parser.js';
import { buildSessionReceipt, renderReceiptBlock } from '../src/receipt.js';

/**
 * The receipt names a dead sidecar as the reason nothing was governed.
 *
 * "nothing was governed this session" is already honest, but it reads the
 * same whether there was nothing worth distilling or the sidecar had been
 * dead since the first turn. The field session was the second case for 392
 * turns and the receipt could not tell the user which one it was.
 */

const SESSION = 's-small';
const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'fixtures',
  'sessions',
  'small.jsonl',
);

function writePosture(dir: string, governance?: GovernanceStatus, sessionId = SESSION): string {
  const file = path.join(dir, 'session-posture.json');
  writeFileSync(
    file,
    JSON.stringify({
      sessionId,
      posture: 'full',
      pinned: false,
      files: 156,
      sourceBytes: 2_969_600,
      learnedEntries: 19,
      pitfallEntries: 0,
      capped: false,
      decidedAt: '2026-09-01T09:00:00.000Z',
      governance,
    }),
  );
  return file;
}

async function receiptFor(governance?: GovernanceStatus, sessionId?: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'redutok-receipt-gov-'));
  const auditPath = path.join(dir, 'audit.jsonl');
  writeFileSync(auditPath, '');
  const ledger = buildLedger(await parseSessionFile(fixture));
  return buildSessionReceipt(ledger, {
    auditPath,
    posturePath: writePosture(dir, governance, sessionId),
  });
}

const DEAD: GovernanceStatus = {
  condition: 'stale-pidfile',
  active: false,
  detail: 'the sidecar died and left a stale pidfile behind (pid 4242 no longer exists)',
};

describe('a receipt for an ungoverned session names the cause', () => {
  it('attributes the empty session to the dead sidecar, right after the verdict', async () => {
    const receipt = await receiptFor(DEAD);
    expect(receipt.governed).toBe(false);
    expect(receipt.governanceOff).toContain('governance was off for the whole session');
    expect(receipt.governanceOff).toContain('stale pidfile');

    const lines = renderReceiptBlock(receipt).split('\n');
    expect(lines[1]).toContain('nothing was governed this session');
    expect(lines[2]).toContain('reason');
    expect(lines[2]).toContain('stale pidfile');
  });

  it('claims no cause when governance was engaged and the session simply had nothing to distill', async () => {
    const receipt = await receiptFor({
      condition: 'ok',
      active: true,
      detail: 'the sidecar is running on port 48642',
    });
    expect(receipt.governed).toBe(false);
    expect(receipt.governanceOff).toBeUndefined();
    expect(renderReceiptBlock(receipt)).not.toContain('reason ');
  });

  it('claims no cause when the record predates the governance field', async () => {
    // Absence is "unknown", never "governance was on": an old record must not
    // make the receipt assert something it does not know.
    const receipt = await receiptFor(undefined);
    expect(receipt.governanceOff).toBeUndefined();
  });

  it('ignores a record belonging to a different session', async () => {
    const receipt = await receiptFor(DEAD, 's-other');
    expect(receipt.governanceOff).toBeUndefined();
    expect(receipt.posture).toBeUndefined();
  });
});
