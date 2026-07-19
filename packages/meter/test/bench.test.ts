import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadEnergyFactors, loadGridIntensity, loadPrices } from '@redutok/shared';
import {
  ANSWER_FILE_NAME,
  buildLivePrompt,
  captureBaselines,
  dryRunMatrix,
  generateLiveResults,
  loadBenchTasks,
  needsAnswerFile,
  runLiveChecks,
  runReplay,
  type BenchTask,
  type LiveRunMeasurement,
} from '../src/bench.js';
import { computeSessionCost } from '../src/cost.js';
import { computeSessionEnergy } from '../src/energy.js';
import { buildLedger, grandTotal } from '../src/ledger.js';
import { parseSessionFile } from '../src/parser.js';
import { scoreSession } from '../src/scoring.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..', '..');
const tasksDir = path.join(repoRoot, 'bench', 'tasks');

describe('bench task definitions', () => {
  it('loads ten pinned tasks across the tiers', () => {
    const tasks = loadBenchTasks(tasksDir);
    expect(tasks).toHaveLength(10);
    const tiers = new Set(tasks.map((t) => t.tier));
    expect(tiers).toEqual(new Set(['small', 'medium', 'large']));
    for (const task of tasks) {
      expect(task.repo.url.length).toBeGreaterThan(0);
      expect(task.repo.commit.length).toBeGreaterThan(0);
      expect(task.fixtureLogs.vanilla).toContain('.jsonl');
      expect(task.fixtureLogs.redutok).toContain('.jsonl');
    }
  });
});

describe('replay mode', () => {
  it('produces a complete RESULTS.md with hand-verified numbers on two tasks', async () => {
    const out = path.join(mkdtempSync(path.join(os.tmpdir(), 'redutok-bench-')), 'RESULTS.md');
    const results = await runReplay(repoRoot, tasksDir, out);
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out, 'utf8')).toBe(results);
    // Mandatory header block.
    expect(results).toContain('model: claude-sonnet-5');
    expect(results).toMatch(/date: \d{4}-\d{2}-\d{2}/);
    expect(results).toContain('repetitions: 1');
    expect(results).toContain(`machine: ${os.platform()}-${os.arch()}`);
    // Hand-verified: small.jsonl total 20,100 (redutok side of t01);
    // medium.jsonl totals 26,335 input and 250,850 grand total.
    expect(results).toContain('| t01 | small | redutok |');
    expect(results).toContain('| 20,100 |');
    expect(results).toContain('| 26,335 |');
    expect(results).toContain('| 250,850 |');
    // Scoring appears per run.
    expect(results).toMatch(/\| [A-F] \| (pass|FAIL) \|/);
    // Savings lines and the mandatory failures section with t10 listed.
    expect(results).toContain('## Savings per task');
    expect(results).toContain('## Failures (savings with success degradation)');
    expect(results).toMatch(/- t10: [\d.]+x savings but redutok run failed/);
    // Every one of the ten tasks appears twice (vanilla and redutok rows).
    for (let i = 1; i <= 10; i += 1) {
      const id = `t${String(i).padStart(2, '0')}`;
      const rows = results.split('\n').filter((l) => l.startsWith(`| ${id} |`));
      expect(rows, id).toHaveLength(2);
    }
  }, 120_000);
});

describe('dry-run live matrix', () => {
  it('prints the exact command matrix without executing anything', () => {
    const tasks = loadBenchTasks(tasksDir);
    const lines = dryRunMatrix(tasks, 2, 'claude-sonnet-5');
    // 10 tasks x 2 reps x 2 variants x 2 lines each.
    expect(lines).toHaveLength(10 * 2 * 2 * 2);
    expect(lines.some((l) => l.includes('claude -p'))).toBe(true);
    expect(lines.some((l) => l.includes('vanilla'))).toBe(true);
    expect(lines.some((l) => l.includes('redutok init . and redutok up'))).toBe(true);
    expect(lines.some((l) => l.includes('--model claude-sonnet-5'))).toBe(true);
    expect(lines.some((l) => l.includes('bench/runs/t01-vanilla-1.jsonl'))).toBe(true);
  });

  it('validates arguments', () => {
    const tasks = loadBenchTasks(tasksDir);
    expect(() => dryRunMatrix(tasks, 0, 'm')).toThrow('positive integer');
    expect(() => dryRunMatrix(tasks, 1, '')).toThrow('model');
  });

  it('appends the answer-file instruction to the printed command for explain-style tasks', () => {
    const tasks = loadBenchTasks(tasksDir);
    const lines = dryRunMatrix(tasks, 1, 'claude-sonnet-5');
    const t01Line = lines.find((l) => l.includes('bench/runs/t01-vanilla-1.jsonl'));
    expect(t01Line).toContain(ANSWER_FILE_NAME);
    const t02Line = lines.find((l) => l.includes('bench/runs/t02-vanilla-1.jsonl'));
    expect(t02Line).not.toContain(ANSWER_FILE_NAME);
  });
});

function task(success: BenchTask['success']): BenchTask {
  return {
    id: 't-test',
    tier: 'small',
    repo: { url: 'local:x', commit: 'c', localPath: '.' },
    prompt: 'do the thing',
    success,
    fixtureLogs: { vanilla: 'a.jsonl', redutok: 'b.jsonl' },
  };
}

describe('buildLivePrompt and needsAnswerFile', () => {
  it('leaves the prompt untouched when no check needs a written answer', () => {
    const t = task([{ kind: 'file-exists', path: 'x.ts' }]);
    expect(needsAnswerFile(t)).toBe(false);
    expect(buildLivePrompt(t)).toBe('do the thing');
  });

  it('appends the answer-file instruction when an answer-contains check is present', () => {
    const t = task([{ kind: 'answer-contains', needle: 'Foo' }]);
    expect(needsAnswerFile(t)).toBe(true);
    const prompt = buildLivePrompt(t);
    expect(prompt).toContain('do the thing');
    expect(prompt).toContain(ANSWER_FILE_NAME);
  });
});

describe('runLiveChecks', () => {
  function tmpRepo(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'redutok-bench-live-checks-'));
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'src', 'store.ts'), 'export class MemoryStore {}\n');
    return dir;
  }

  it('file-matches passes only when the pattern is present, case-insensitively', () => {
    const dir = tmpRepo();
    const t = task([{ kind: 'file-matches', path: 'src/store.ts', pattern: 'MEMORYSTORE' }]);
    expect(runLiveChecks(t, 'vanilla', dir).passed).toBe(true);
    const missing = task([{ kind: 'file-matches', path: 'src/store.ts', pattern: 'delete\\s*\\(' }]);
    expect(runLiveChecks(missing, 'vanilla', dir).passed).toBe(false);
  });

  it('file-changed fails when the content is identical to the captured baseline', () => {
    const dir = tmpRepo();
    const t = task([{ kind: 'file-changed', path: 'src/store.ts' }]);
    const baselines = captureBaselines(t, dir);
    // No edit happened between capture and check: must not pass.
    expect(runLiveChecks(t, 'vanilla', dir, baselines).passed).toBe(false);
  });

  it('file-changed passes once the file genuinely differs from the captured baseline', () => {
    const dir = tmpRepo();
    const t = task([{ kind: 'file-changed', path: 'src/store.ts' }]);
    const baselines = captureBaselines(t, dir);
    writeFileSync(
      path.join(dir, 'src', 'store.ts'),
      'export class MemoryStore { delete(id: string) { this.rows.delete(id); } }\n',
    );
    expect(runLiveChecks(t, 'vanilla', dir, baselines).passed).toBe(true);
  });

  it('file-changed without a captured baseline never silently passes', () => {
    const dir = tmpRepo();
    const t = task([{ kind: 'file-changed', path: 'src/store.ts' }]);
    // captureBaselines was never called: no baseline entry exists for this path.
    expect(runLiveChecks(t, 'vanilla', dir, new Map()).passed).toBe(false);
  });

  it('answer-contains reads the answer file and matches case-insensitively', () => {
    const dir = tmpRepo();
    writeFileSync(path.join(dir, ANSWER_FILE_NAME), 'The Fail-Open rule lives in HOOK_FAIL_OPEN_MS.\n');
    const t = task([
      { kind: 'answer-contains', needle: 'fail-open' },
      { kind: 'answer-contains', needle: 'HOOK_FAIL_OPEN_MS' },
    ]);
    expect(runLiveChecks(t, 'vanilla', dir).passed).toBe(true);
  });

  it('answer-contains fails when the answer file was never written', () => {
    const dir = tmpRepo();
    const t = task([{ kind: 'answer-contains', needle: 'anything' }]);
    expect(runLiveChecks(t, 'vanilla', dir).passed).toBe(false);
  });

  it('command-succeeds runs the whole command string and reports pass or fail by exit code', () => {
    const dir = tmpRepo();
    const passing = task([{ kind: 'command-succeeds', command: process.platform === 'win32' ? 'exit 0' : 'true' }]);
    expect(runLiveChecks(passing, 'vanilla', dir).passed).toBe(true);
    const failing = task([{ kind: 'command-succeeds', command: process.platform === 'win32' ? 'exit 1' : 'false' }]);
    expect(runLiveChecks(failing, 'vanilla', dir).passed).toBe(false);
  });
});

describe('replay mode treats live-only checks as skipped, not failed, and evaluates file-matches for real', () => {
  it('a task with only answer-contains checks is vacuously pass in replay (nothing evaluable there)', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'redutok-bench-replay-live-only-'));
    mkdirSync(path.join(dir, 'fixtures', 'sessions'), { recursive: true });
    mkdirSync(path.join(dir, 'bench', 'tasks'), { recursive: true });
    const small = readFileSync(path.join(repoRoot, 'fixtures', 'sessions', 'small.jsonl'));
    writeFileSync(path.join(dir, 'fixtures', 'sessions', 'a.jsonl'), small);
    writeFileSync(path.join(dir, 'fixtures', 'sessions', 'b.jsonl'), small);
    writeFileSync(
      path.join(dir, 'bench', 'tasks', 't01.yaml'),
      [
        'id: t01',
        'tier: small',
        'repo:',
        '  url: local:.',
        '  commit: c',
        '  localPath: .',
        "prompt: 'explain it'",
        'success:',
        '  - kind: answer-contains',
        "    needle: 'x'",
        'fixtureLogs:',
        '  vanilla: fixtures/sessions/a.jsonl',
        '  redutok: fixtures/sessions/b.jsonl',
      ].join('\n'),
    );
    const out = path.join(dir, 'RESULTS.md');
    const results = await runReplay(dir, path.join(dir, 'bench', 'tasks'), out);
    expect(results).toContain('| t01 | small | vanilla |');
    expect(results).toMatch(/\| t01 \| small \| vanilla \|.*\| pass \|/);
  });
});

async function liveMeasurement(
  fixture: string,
  taskId: string,
  variant: 'vanilla' | 'redutok',
  rep: number,
  overrides: Partial<LiveRunMeasurement> = {},
): Promise<LiveRunMeasurement> {
  const prices = loadPrices();
  const factors = loadEnergyFactors();
  const grid = loadGridIntensity();
  const parsed = await parseSessionFile(path.join(repoRoot, 'fixtures', 'sessions', fixture));
  const ledger = buildLedger(parsed, `${taskId}-${variant}-${rep}`);
  const energy = computeSessionEnergy(ledger, factors, grid);
  return {
    taskId,
    tier: 'small',
    variant,
    rep,
    ledger,
    totalTokens: grandTotal(ledger.totals),
    costUsd: computeSessionCost(ledger, prices).totalUsd,
    energy,
    scores: scoreSession(ledger, energy, []),
    wallMs: 1000,
    success: true,
    successDetail: [],
    model: ledger.entries[0]?.model ?? 'unknown',
    ...overrides,
  };
}

describe('generateLiveResults', () => {
  it('reports token, USD, and non-cache-read reduction as three distinct columns, and gates only on token reduction', async () => {
    // small.jsonl: 20,100 tokens (2,160 input, 1,470 output, 15,100 cache
    // read, 920 cache write, 450 thinking). long-agentic.jsonl: 8,772,809
    // tokens, cache read 8,348,542 (hand-verified in the replay test above).
    const vanilla = await liveMeasurement('long-agentic.jsonl', 't01', 'vanilla', 1);
    const redutok = await liveMeasurement('small.jsonl', 't01', 'redutok', 1);
    const summary = generateLiveResults([vanilla, redutok], [], { model: 'claude-sonnet-5', n: 1, done: true });

    // Token reduction: 8,772,809 / 20,100.
    expect(summary.medianTokenRatio).toBeCloseTo(8_772_809 / 20_100, 1);
    // USD reduction: vanilla is far more expensive (dominated by cache read
    // and raw input volume), so the ratio must be greater than 1.
    expect(summary.medianUsdRatio).toBeGreaterThan(1);
    // Non-cache-read reduction: (8,772,809 - 8,348,542) / (20,100 - 15,100).
    expect(summary.medianNonCacheReadRatio).toBeCloseTo((8_772_809 - 8_348_542) / (20_100 - 15_100), 1);
    // The three ratios must not collapse to the same number: cache-read
    // dominance is exactly the effect these columns exist to surface.
    expect(summary.medianTokenRatio).not.toBeCloseTo(summary.medianNonCacheReadRatio, 0);

    expect(summary.markdown).toContain(
      '| task | vanilla tokens | redutok tokens | token reduction | vanilla USD | redutok USD | USD reduction | vanilla non-cache-read tokens | redutok non-cache-read tokens | non-cache-read reduction | vanilla success | redutok success |',
    );
    expect(summary.markdown).toMatch(/median token reduction across tasks: [\d.]+x \(threshold: at least 10x, applies to this metric/);
    expect(summary.markdown).toMatch(/median USD reduction across tasks: [\d.]+x \(context only, no threshold\)/);
    expect(summary.markdown).toMatch(/median non-cache-read token reduction across tasks: [\d.]+x \(context only, no threshold/);
    // Only one line states a threshold verdict tied to the 10x number.
    const thresholdLines = summary.markdown.split('\n').filter((l) => l.includes('MET') || l.includes('NOT MET'));
    expect(thresholdLines.filter((l) => l.includes('reduction'))).toHaveLength(1);
  });

  it('marks an in-progress checkpoint distinctly from a done report', async () => {
    const vanilla = await liveMeasurement('long-agentic.jsonl', 't01', 'vanilla', 1);
    const checkpoint = generateLiveResults([vanilla], [], { model: 'claude-sonnet-5', n: 1, done: false });
    expect(checkpoint.markdown).toContain('CHECKPOINT: matrix in progress');
    const final = generateLiveResults([vanilla], [], { model: 'claude-sonnet-5', n: 1, done: true });
    expect(final.markdown).not.toContain('CHECKPOINT');
  });

  it('lists not-run records under their own section', async () => {
    const vanilla = await liveMeasurement('long-agentic.jsonl', 't02', 'vanilla', 1);
    const summary = generateLiveResults(
      [vanilla],
      [{ taskId: 't02', variant: 'redutok', rep: 1, reason: 'claude CLI not authenticated' }],
      { model: 'claude-sonnet-5', n: 1, done: true },
    );
    expect(summary.markdown).toContain('## Not run');
    expect(summary.markdown).toContain('t02 redutok rep 1: claude CLI not authenticated');
  });

  it('prefers the claude CLI reported cost in cumulative spend when present', async () => {
    const withReported = await liveMeasurement('small.jsonl', 't01', 'redutok', 1, { reportedCostUsd: 0.5 });
    const summary = generateLiveResults([withReported], [], { model: 'claude-sonnet-5', n: 1, done: true });
    expect(summary.markdown).toContain('0.5000 USD (claude CLI reported)');
  });
});
