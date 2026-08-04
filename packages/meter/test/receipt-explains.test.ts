import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '@redutok/shared';
import { buildLedger } from '../src/ledger.js';
import { parseSessionFile } from '../src/parser.js';
import { buildSessionReceipt, renderReceiptBlock } from '../src/receipt.js';

/**
 * A receipt that explains itself. The field session that prompted this read a
 * 263KB Markdown, a 186KB Markdown and a 1.2MB PDF entirely raw and reported
 * "no distillations this session" with a grade beside it — technically true,
 * and useless: it named neither the posture that decided the engagement nor
 * the artifacts that escaped it, and the grade read as though the tool had
 * worked. A session that governed nothing has to say so first, and say why.
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

function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'redutok-receipt-'));
}

function writeAudit(dir: string, events: AuditEvent[]): string {
  const file = path.join(dir, 'audit.jsonl');
  writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + (events.length > 0 ? '\n' : ''));
  return file;
}

function writePosture(dir: string, posture: string, files: number, sourceBytes: number): string {
  const file = path.join(dir, 'session-posture.json');
  writeFileSync(
    file,
    JSON.stringify({
      sessionId: SESSION,
      posture,
      pinned: false,
      files,
      sourceBytes,
      learnedEntries: 0,
      pitfallEntries: 0,
      capped: false,
      decidedAt: '2026-08-04T13:20:44.403Z',
    }),
  );
  return file;
}

const passthrough = (id: string, filePath: string, bytes: number, reason: string): AuditEvent => ({
  id,
  timestamp: '2026-08-04T13:21:00.000Z',
  sessionId: SESSION,
  module: 'sidecar.prepare',
  action: 'passthrough',
  reason: `${filePath} read raw: ${reason}`,
  bytesIn: bytes,
  bytesOut: bytes,
  details: { path: filePath, reason },
});

const distill = (id: string, profile: string, bytesIn: number, bytesOut: number): AuditEvent => ({
  id,
  timestamp: '2026-08-04T13:22:00.000Z',
  sessionId: SESSION,
  module: 'sidecar.distill',
  action: 'distill',
  reason: `profile ${profile} served ${bytesOut}B for ${bytesIn}B raw`,
  inputRef: id,
  bytesIn,
  bytesOut,
  details: { profile },
});

async function receiptFor(dir: string, events: AuditEvent[], posture?: { name: string; files: number; bytes: number }) {
  const ledger = buildLedger(await parseSessionFile(fixture));
  return buildSessionReceipt(ledger, {
    auditPath: writeAudit(dir, events),
    posturePath:
      posture === undefined ? undefined : writePosture(dir, posture.name, posture.files, posture.bytes),
  });
}

describe('a session that governed nothing says so, and why', () => {
  it('leads with the fact, names the posture and its inputs, and withholds a grade', async () => {
    const dir = tmpDir();
    // The field shape: light posture, three large documents read raw.
    const receipt = await receiptFor(
      dir,
      [
        passthrough('p1', 'sources/difc-reg-10.md', 268_762, 'no skeleton builder for .md'),
        passthrough('p2', 'sources/nist-ai-600-1.md', 189_725, 'no skeleton builder for .md'),
        passthrough('p3', 'sources/uae_pdpl.pdf', 1_309_574, 'no skeleton builder for .pdf'),
      ],
      { name: 'light', files: 81, bytes: 1_103_982 },
    );
    expect(receipt.governed).toBe(false);
    expect(receipt.passthroughs).toHaveLength(3);
    expect(receipt.estimatedAvoidableTokens).toBeGreaterThan(0);

    const text = renderReceiptBlock(receipt);
    const lines = text.split('\n');
    // The first line after the header is the honest verdict, not a grade.
    expect(lines[1]).toContain('nothing was governed this session');
    expect(text).toContain('light');
    expect(text).toContain('81 files');
    // Every artifact that escaped, with the reason it escaped.
    expect(text).toContain('sources/uae_pdpl.pdf');
    expect(text).toContain('no skeleton builder for .pdf');
    // The counterfactual, labelled as the estimate it is.
    expect(text).toMatch(/estimated/);
    expect(text).toContain('context efficiency is not scorable');
    // A composite letter must not appear where it would read as success.
    expect(text).not.toMatch(/grade\s+\d+ \([A-F]\)/);
    // House style.
    expect(text).not.toMatch(/[—–!]|\p{Extended_Pictographic}/u);
  });
});

describe('a session that governed a little accounts for what escaped', () => {
  it('reports the distillations and still lists the artifacts read raw', async () => {
    const dir = tmpDir();
    const receipt = await receiptFor(
      dir,
      [
        distill('a1', 'doc-skeleton', 268_762, 18_248),
        passthrough('p1', 'data/export.csv', 402_000, 'no skeleton builder for .csv'),
      ],
      { name: 'light', files: 81, bytes: 1_103_982 },
    );
    expect(receipt.governed).toBe(true);
    expect(receipt.passthroughs).toHaveLength(1);

    const text = renderReceiptBlock(receipt);
    expect(text).toContain('avoided');
    expect(text).toContain('doc-skeleton');
    // What escaped is still named, so a partial result cannot read as total.
    expect(text).toContain('read raw');
    expect(text).toContain('data/export.csv');
    expect(text).toContain('no skeleton builder for .csv');
  });
});

describe('a fully governed session reads as it always did', () => {
  it('keeps the avoided line, the top distillations and the grade', async () => {
    const dir = tmpDir();
    const receipt = await receiptFor(dir, [
      distill('a1', 'doc-skeleton', 268_762, 18_248),
      distill('a2', 'file-skeleton', 90_000, 9_000),
      distill('a3', 'build-log', 9_216, 1_096),
    ]);
    expect(receipt.governed).toBe(true);
    expect(receipt.passthroughs).toEqual([]);

    const text = renderReceiptBlock(receipt);
    expect(text).toContain('avoided');
    expect(text).toContain('top distillations by tokens avoided');
    expect(text).not.toContain('nothing was governed');
    expect(text).not.toContain('read raw');
    expect(text).toMatch(/grade\s+/);
  });
});
