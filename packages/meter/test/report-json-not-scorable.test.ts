import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { buildReport, renderText } from '../src/report.js';
import { renderBadgeSvg, renderShareLine } from '../src/badge.js';
import type { ScoreResult, SessionScores } from '../src/scoring.js';

/**
 * Every not-scorable combination, driven through the real `report --json`
 * path: the 0.1.1 field review asked whether a partial composite could crash
 * or corrupt the JSON rendering. Each case asserts the command exits 0, the
 * output parses as JSON, not-scorable scores carry their reason, and the
 * composite follows the disclosure rules (absent when nothing contributed,
 * partial and gradeless below the grade floor).
 */

const line = (obj: unknown): string => JSON.stringify(obj) + '\n';

function assistantTurn(opts: {
  uuid: string;
  sessionId: string;
  model?: string;
  tools?: string[];
  usage?: Record<string, number>;
}): string {
  return line({
    type: 'assistant',
    uuid: opts.uuid,
    timestamp: '2026-08-03T10:00:00.000Z',
    sessionId: opts.sessionId,
    message: {
      role: 'assistant',
      model: opts.model ?? 'claude-sonnet-5',
      content: [
        { type: 'text', text: 'working' },
        ...(opts.tools ?? []).map((name, i) => ({
          type: 'tool_use',
          id: `t-${opts.uuid}-${i}`,
          name,
          input: {},
        })),
      ],
      usage: opts.usage ?? {
        input_tokens: 1000,
        output_tokens: 200,
        cache_read_input_tokens: 3000,
        cache_creation_input_tokens: 100,
      },
    },
  });
}

let workDir: string;
let priorCwd: string;
beforeEach(() => {
  // A clean cwd so the default .dcp/audit.jsonl lookup finds nothing unless a
  // case plants one — the CLI has no --audit flag to point elsewhere.
  workDir = mkdtempSync(path.join(os.tmpdir(), 'redutok-json-'));
  priorCwd = process.cwd();
  process.chdir(workDir);
});
afterEach(() => {
  process.chdir(priorCwd);
});

async function reportJson(transcript: string): Promise<{ exit: number; report: { scores: SessionScores } }> {
  const logged: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((msg: unknown) => {
    logged.push(String(msg));
  });
  try {
    const exit = await main(['report', transcript, '--json']);
    expect(logged, 'report --json must print exactly one document').toHaveLength(1);
    return { exit, report: JSON.parse(logged[0] ?? '') as { scores: SessionScores } };
  } finally {
    spy.mockRestore();
  }
}

const notScorable = (s: ScoreResult): string => {
  expect(s.scorable).toBe(false);
  return s.scorable ? '' : s.reason;
};

describe('report --json across every not-scorable combination', () => {
  it('all four not scorable: empty transcript, composite absent entirely', async () => {
    const transcript = path.join(workDir, 'empty.jsonl');
    writeFileSync(transcript, '');
    const { exit, report } = await reportJson(transcript);
    expect(exit).toBe(0);
    expect(notScorable(report.scores.contextEfficiency)).toContain('no audit events');
    expect(notScorable(report.scores.outputDiscipline)).toContain('no assistant turns');
    expect(notScorable(report.scores.cacheUtilization)).toContain('fewer than two turns');
    expect(notScorable(report.scores.energyPerOutcome)).toContain('no assistant turns');
    expect(report.scores.composite).toBeUndefined();
  });

  it('one contributor: single turn of an unknown model, partial composite with no grade', async () => {
    const transcript = path.join(workDir, 'single.jsonl');
    writeFileSync(transcript, assistantTurn({ uuid: 'a1', sessionId: 's-one', model: 'mystery-model-x' }));
    const { exit, report } = await reportJson(transcript);
    expect(exit).toBe(0);
    notScorable(report.scores.contextEfficiency);
    notScorable(report.scores.cacheUtilization);
    expect(notScorable(report.scores.energyPerOutcome)).toContain('mystery-model-x');
    expect(report.scores.outputDiscipline.scorable).toBe(true);
    expect(report.scores.composite).toMatchObject({ contributing: 1, total: 4, partial: true });
    expect(report.scores.composite?.grade, 'a partial composite must not carry a grade').toBeUndefined();
  });

  it('audit present but without byte counts: context efficiency names the gap, grade from three', async () => {
    mkdirSync(path.join(workDir, '.dcp'));
    writeFileSync(
      path.join(workDir, '.dcp', 'audit.jsonl'),
      line({
        id: 'e1',
        timestamp: '2026-08-03T10:00:01.000Z',
        sessionId: 's-bytes',
        module: 'hooks.pretooluse',
        action: 'rewrite',
        reason: 'command rewritten',
      }),
    );
    const transcript = path.join(workDir, 'two.jsonl');
    writeFileSync(
      transcript,
      assistantTurn({ uuid: 'a1', sessionId: 's-bytes' }) + assistantTurn({ uuid: 'a2', sessionId: 's-bytes' }),
    );
    const { exit, report } = await reportJson(transcript);
    expect(exit).toBe(0);
    expect(notScorable(report.scores.contextEfficiency)).toContain('raw byte count');
    expect(report.scores.composite).toMatchObject({ contributing: 3, total: 4, partial: false });
    expect(report.scores.composite?.grade).toBeDefined();
  });

  it('dcp tools visible but unattributed: the guardrail reason survives the JSON path', async () => {
    const transcript = path.join(workDir, 'dcp.jsonl');
    writeFileSync(
      transcript,
      assistantTurn({ uuid: 'a1', sessionId: 's-unattr', tools: ['dcp__read'] }) +
        assistantTurn({ uuid: 'a2', sessionId: 's-unattr' }),
    );
    const { exit, report } = await reportJson(transcript);
    expect(exit).toBe(0);
    expect(notScorable(report.scores.contextEfficiency)).toContain('not attributable to this session');
  });

  it('every combination also renders text and badge without leaking undefined', async () => {
    for (const name of ['empty.jsonl', 'single.jsonl'] as const) {
      const transcript = path.join(workDir, name);
      if (name === 'empty.jsonl') writeFileSync(transcript, '');
      else writeFileSync(transcript, assistantTurn({ uuid: 'a1', sessionId: 's-one', model: 'mystery-model-x' }));
      const report = await buildReport(transcript);
      for (const rendered of [renderText(report), renderBadgeSvg(report), renderShareLine(report)]) {
        expect(rendered).not.toContain('undefined');
      }
    }
  });
});
