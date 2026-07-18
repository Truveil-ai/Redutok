import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LIMITS } from '@redutok/shared';
import {
  SPLIT_SUGGESTION,
  shouldSuggestSplit,
  verbosityReport,
  writeHandoff,
} from '../src/discipline.js';
import type { SessionLedger } from '../src/ledger.js';

function ledgerWith(entries: { input: number; output: number; cacheRead?: number; thinking?: number }[]): SessionLedger {
  return {
    sessionId: 's',
    entries: entries.map((t, i) => ({
      sessionId: 's',
      turn: i + 1,
      timestamp: '2026-07-19T10:00:00.000Z',
      model: 'claude-sonnet-5',
      tools: [],
      tokens: {
        input: t.input,
        output: t.output,
        cacheRead: t.cacheRead ?? 0,
        cacheWrite: 0,
        thinking: t.thinking ?? 0,
      },
    })),
    totals: entries.reduce(
      (acc, t) => ({
        input: acc.input + t.input,
        output: acc.output + t.output,
        cacheRead: acc.cacheRead + (t.cacheRead ?? 0),
        cacheWrite: 0,
        thinking: acc.thinking + (t.thinking ?? 0),
      }),
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
    ),
    byTool: {},
  };
}

describe('verbosityReport', () => {
  it('scores adherence against the limits.ts threshold', () => {
    const quiet = verbosityReport(ledgerWith([{ input: 100, output: 200 }, { input: 100, output: 300 }]));
    expect(quiet.adherent).toBe(true);
    const noisy = verbosityReport(
      ledgerWith([{ input: 100, output: LIMITS.VERBOSE_OUTPUT_TOKENS_PER_TURN * 2 }]),
    );
    expect(noisy.adherent).toBe(false);
    expect(noisy.verboseTurns).toBe(1);
  });
});

describe('shouldSuggestSplit', () => {
  it('fires only when the last turn context crosses the threshold', () => {
    expect(shouldSuggestSplit(ledgerWith([{ input: 500, output: 10, cacheRead: 4000 }]))).toBe(false);
    expect(
      shouldSuggestSplit(
        ledgerWith([{ input: 500, output: 10, cacheRead: LIMITS.SPLIT_ADVISOR_CONTEXT_TOKENS + 1 }]),
      ),
    ).toBe(true);
    expect(shouldSuggestSplit(ledgerWith([]))).toBe(false);
    expect(SPLIT_SUGGESTION).toContain('redutok handoff');
  });
});

describe('writeHandoff', () => {
  it('writes the handoff from codex reference plus rolling state and prints resume', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'redutok-handoff-'));
    const dcp = path.join(root, '.dcp');
    mkdirSync(dcp);
    writeFileSync(path.join(dcp, 'session-state.md'), '# Session state\n- edited src/a.ts\n');
    writeFileSync(
      path.join(dcp, 'codex.lock'),
      JSON.stringify({ version: 1, repoFingerprint: 'abcd1234', files: { 'src/a.ts': 'x' } }),
    );
    const result = writeHandoff(root);
    expect(existsSync(result.file)).toBe(true);
    const content = readFileSync(result.file, 'utf8');
    expect(content).toContain('fingerprint abcd1234');
    expect(content).toContain('edited src/a.ts');
    expect(result.resumeCommand).toContain('.dcp/handoff.md');
  });
});
