import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { dryRunMatrix, loadBenchTasks, runReplay } from '../src/bench.js';

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
});
