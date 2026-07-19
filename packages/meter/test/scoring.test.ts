import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadEnergyFactors, loadGridIntensity, type AuditEvent } from '@redutok/shared';
import { computeSessionEnergy } from '../src/energy.js';
import { buildLedger } from '../src/ledger.js';
import { parseSessionFile } from '../src/parser.js';
import { gradeFor, scoreSession } from '../src/scoring.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.join(here, '..', '..', '..', 'fixtures', 'sessions', name);

const auditEvent = (action: 'distill' | 'serve-raw', bytesOut: number): AuditEvent => ({
  id: `e-${action}-${bytesOut}`,
  timestamp: '2026-07-19T10:00:00.000Z',
  sessionId: 's-small',
  module: 'sidecar.distill',
  action,
  reason: 'x',
  bytesOut,
});

describe('scoreSession on small.jsonl, hand computed', () => {
  // Ledger: 3 turns; input 2160, output 1470, cacheRead 15100, thinking 450.
  // OD: avg (1470+450)/3 = 640 <= 1500, score 100.
  // CU over turns 2..3: cacheRead 5200+5900 = 11100, input 900+60 = 960,
  //   100 * 11100/12060 = 92.04 -> 92.
  // EPO: 2 of 3 turns invoke tools, density 0.67 -> agentic shape, baseline
  //   25 Wh/turn; wh base 6.03 over 3 turns = 2.01 Wh/turn -> caps at 100.
  // CE without audit: not scorable. Composite over OD, CU, EPO weights
  //   .25/.25/.15: (25 + 23 + 15) / 0.65 = 96.9 -> 97 -> A.
  it('matches the hand-computed scores and reweighted composite', async () => {
    const ledger = buildLedger(await parseSessionFile(fixture('small.jsonl')));
    const energy = computeSessionEnergy(ledger, loadEnergyFactors(), loadGridIntensity());
    const scores = scoreSession(ledger, energy, []);
    expect(scores.contextEfficiency).toEqual({
      scorable: false,
      reason: 'no audit events recorded for this session (sidecar not installed or not used)',
    });
    expect(scores.outputDiscipline).toMatchObject({ scorable: true, score: 100 });
    expect(scores.cacheUtilization).toMatchObject({ scorable: true, score: 92 });
    expect(scores.energyPerOutcome).toMatchObject({ scorable: true, score: 100 });
    if (scores.energyPerOutcome.scorable) {
      expect(scores.energyPerOutcome.detail).toContain('agentic reference');
      expect(scores.energyPerOutcome.detail).toContain('(proxy: turns, see docs/SCORING.md)');
    }
    expect(scores.composite?.value).toBe(97);
    expect(scores.composite?.grade).toBe('A');
    expect(Object.keys(scores.composite?.weightsUsed ?? {})).not.toContain('contextEfficiency');
  });

  it('scores context efficiency from audit serve bytes when present', async () => {
    const ledger = buildLedger(await parseSessionFile(fixture('small.jsonl')));
    const audit = [auditEvent('distill', 900), auditEvent('serve-raw', 100)];
    const scores = scoreSession(ledger, undefined, audit);
    expect(scores.contextEfficiency).toMatchObject({ scorable: true, score: 90 });
    // Energy missing is explicit, never defaulted.
    expect(scores.energyPerOutcome).toEqual({ scorable: false, reason: 'no energy estimate available' });
  });
});

describe('not-scorable paths', () => {
  const ledgerWithTools = (byTool: Record<string, { calls: number; outputTokenShare: number }>) => ({
    sessionId: 's',
    entries: [],
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
    byTool,
  });

  it('reports attribution, not non-use, when dcp tools are visible but no audit events match', () => {
    const mcpNamed = scoreSession(
      ledgerWithTools({ mcp__redutok__dcp__read: { calls: 1, outputTokenShare: 0 } }),
      undefined,
      [],
    );
    expect(mcpNamed.contextEfficiency).toMatchObject({ scorable: false });
    if (!mcpNamed.contextEfficiency.scorable) {
      expect(mcpNamed.contextEfficiency.reason).toContain('audit events not attributable to this session');
      expect(mcpNamed.contextEfficiency.reason).not.toContain('not installed or not used');
    }
    const bareNamed = scoreSession(
      ledgerWithTools({ dcp__run: { calls: 2, outputTokenShare: 10 } }),
      undefined,
      [],
    );
    if (!bareNamed.contextEfficiency.scorable) {
      expect(bareNamed.contextEfficiency.reason).toContain('audit events not attributable to this session');
    }
  });

  it('keeps the non-use reason when no dcp tools appear in the tool table', () => {
    const scores = scoreSession(
      ledgerWithTools({ Read: { calls: 3, outputTokenShare: 100 } }),
      undefined,
      [],
    );
    if (!scores.contextEfficiency.scorable) {
      expect(scores.contextEfficiency.reason).toContain('sidecar not installed or not used');
    }
  });

  it('refuses to score an empty session with reasons on every score', () => {
    const empty = {
      sessionId: 's',
      entries: [],
      totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
      byTool: {},
    };
    const scores = scoreSession(empty, undefined, []);
    expect(scores.outputDiscipline.scorable).toBe(false);
    expect(scores.cacheUtilization.scorable).toBe(false);
    expect(scores.energyPerOutcome.scorable).toBe(false);
    expect(scores.composite).toBeUndefined();
  });
});

describe('gradeFor', () => {
  it('maps the documented boundaries', () => {
    expect(gradeFor(97)).toBe('A');
    expect(gradeFor(90)).toBe('A');
    expect(gradeFor(89)).toBe('B');
    expect(gradeFor(70)).toBe('C');
    expect(gradeFor(60)).toBe('D');
    expect(gradeFor(59)).toBe('F');
  });
});
