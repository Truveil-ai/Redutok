import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '@redutok/shared';
import { buildLedger } from '../src/ledger.js';
import { parseSessionFile } from '../src/parser.js';
import { scoreSession } from '../src/scoring.js';

/**
 * Context efficiency against a real raw denominator.
 *
 * A live session scored 100 with the detail "22138B distilled vs 0B raw
 * across 2 serves". Both halves of that were wrong: the score compared what
 * was served against what else was served raw, so a session where nothing
 * failed open scored a perfect 100 no matter how little it actually saved,
 * and the on-demand document path contributes no raw serve at all, so the
 * comparison ran against zero.
 *
 * The score now compares what was served against the raw it stood in for.
 * A raw serve still carries the redundancy signal it always did: its served
 * bytes equal its raw bytes, so it avoids nothing and drags the score down.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, '..', '..', '..', 'fixtures', 'sessions', 'small.jsonl');

const serve = (
  action: 'distill' | 'serve-raw',
  bytesIn: number | undefined,
  bytesOut: number,
): AuditEvent => ({
  id: `e-${action}-${bytesOut}`,
  timestamp: '2026-08-04T10:00:00.000Z',
  sessionId: 's-small',
  module: 'sidecar.distill',
  action,
  reason: 'x',
  ...(bytesIn === undefined ? {} : { bytesIn }),
  bytesOut,
});

const ledgerFor = async () => buildLedger(await parseSessionFile(fixture));

describe('context efficiency measures served against the raw it replaced', () => {
  it('does not score 100 just because nothing was served raw', async () => {
    // The field shape exactly: two on-demand document skeletons, no raw serve.
    const scores = scoreSession(await ledgerFor(), undefined, [
      serve('distill', 268_762, 18_002),
      serve('distill', 85_047, 11_502),
    ]);
    expect(scores.contextEfficiency.scorable).toBe(true);
    if (!scores.contextEfficiency.scorable) return;
    // 353,809B touched, 29,504B served: 91.66 percent avoided.
    expect(scores.contextEfficiency.score).toBe(92);
    expect(scores.contextEfficiency.detail).toContain('29504B served for 353809B raw');
    expect(scores.contextEfficiency.detail).not.toContain('0B raw');
  });

  it('a raw serve avoids nothing and drags the score down', async () => {
    const distilledOnly = scoreSession(await ledgerFor(), undefined, [serve('distill', 10_000, 1_000)]);
    const withRawServe = scoreSession(await ledgerFor(), undefined, [
      serve('distill', 10_000, 1_000),
      // Gate failure: the raw went into context whole, so it saved nothing.
      serve('serve-raw', 10_000, 10_000),
    ]);
    expect(distilledOnly.contextEfficiency.scorable && distilledOnly.contextEfficiency.score).toBe(90);
    expect(withRawServe.contextEfficiency.scorable && withRawServe.contextEfficiency.score).toBe(45);
  });

  it('is not scorable when no serve carries a raw byte count', async () => {
    // Events that record only what was served say nothing about what it
    // replaced; a ratio against zero is not a score.
    const scores = scoreSession(await ledgerFor(), undefined, [
      serve('distill', undefined, 900),
      serve('serve-raw', undefined, 100),
    ]);
    expect(scores.contextEfficiency.scorable).toBe(false);
    if (scores.contextEfficiency.scorable) return;
    expect(scores.contextEfficiency.reason).toContain('raw byte count');
    // And it must not reach the composite, so no grade can rest on it.
    expect(Object.keys(scores.composite?.weightsUsed ?? {})).not.toContain('contextEfficiency');
  });

  it('never renders a score above 100 or below 0', async () => {
    // A distillate larger than its raw (a short document whose map exceeds
    // it) would otherwise produce a negative share.
    const scores = scoreSession(await ledgerFor(), undefined, [serve('distill', 100, 400)]);
    expect(scores.contextEfficiency.scorable).toBe(true);
    if (!scores.contextEfficiency.scorable) return;
    expect(scores.contextEfficiency.score).toBeGreaterThanOrEqual(0);
    expect(scores.contextEfficiency.score).toBeLessThanOrEqual(100);
  });
});
