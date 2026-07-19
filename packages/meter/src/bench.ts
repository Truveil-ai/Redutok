import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadEnergyFactors, loadGridIntensity, loadPrices } from '@redutok/shared';
import { computeSessionCost } from './cost.js';
import { computeSessionEnergy, type SessionEnergy } from './energy.js';
import { buildLedger, grandTotal, type SessionLedger } from './ledger.js';
import { parseSessionFile } from './parser.js';
import { scoreSession, type SessionScores } from './scoring.js';

/**
 * Bench harness, architecture section 8. Replay mode measures committed
 * fixture session logs offline; live mode drives real headless claude CLI
 * runs and is argument-validated here but only ever executed by an explicit
 * operator command, never by tests. Public claims come only from this
 * harness's RESULTS.md.
 */

export type Variant = 'vanilla' | 'redutok';

export interface SuccessCheck {
  kind: 'file-contains' | 'file-exists' | 'command-succeeds' | 'file-matches' | 'file-changed' | 'answer-contains';
  path?: string;
  needle?: string;
  /** file-matches: regex source, matched case-insensitively. */
  pattern?: string;
  command?: string;
  variant?: Variant | 'both';
}

export interface BenchTask {
  id: string;
  tier: 'small' | 'medium' | 'large';
  repo: { url: string; commit: string; localPath: string };
  prompt: string;
  success: SuccessCheck[];
  fixtureLogs: Record<Variant, string>;
}

export function loadBenchTasks(dir: string): BenchTask[] {
  const tasks: BenchTask[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort()) {
    const raw = parseYaml(readFileSync(path.join(dir, file), 'utf8')) as BenchTask;
    for (const field of ['id', 'tier', 'repo', 'prompt', 'success', 'fixtureLogs'] as const) {
      if (raw[field] === undefined) throw new Error(`${file}: missing required field ${field}`);
    }
    if (raw.repo.url === undefined || raw.repo.commit === undefined) {
      throw new Error(`${file}: repo pin requires url and commit`);
    }
    tasks.push(raw);
  }
  return tasks;
}

/** Bench task prompts that require a written answer append this instruction
 * so an explain-style task has a graded artifact instead of only chat text. */
export const ANSWER_FILE_NAME = 'ANSWER.md';

export function needsAnswerFile(task: BenchTask): boolean {
  return task.success.some((c) => c.kind === 'answer-contains');
}

export function buildLivePrompt(task: BenchTask): string {
  if (!needsAnswerFile(task)) return task.prompt;
  return `${task.prompt}\n\nWrite your complete answer to a new file named ${ANSWER_FILE_NAME} in the current directory. The file is what gets graded, not the chat reply.`;
}

function runChecks(task: BenchTask, variant: Variant, repoRoot: string): { passed: boolean; detail: string[] } {
  const detail: string[] = [];
  let passed = true;
  for (const check of task.success) {
    if (check.variant !== undefined && check.variant !== 'both' && check.variant !== variant) continue;
    // Live-only kinds need a real claude run against a mutable working copy
    // (an edited file diffed against its pre-run baseline, or a written
    // ANSWER.md); replay only parses committed fixture logs, so these are
    // not evaluated there, matching the command-succeeds precedent.
    if (check.kind === 'command-succeeds' || check.kind === 'file-changed' || check.kind === 'answer-contains') {
      detail.push(`${check.kind} skipped in replay: ${check.command ?? check.needle ?? check.path ?? ''}`);
      continue;
    }
    let ok = false;
    const target = check.path === undefined ? '' : path.join(repoRoot, task.repo.localPath, check.path);
    if (check.kind === 'file-exists') ok = existsSync(target);
    else if (check.kind === 'file-contains') {
      ok = existsSync(target) && readFileSync(target, 'utf8').includes(check.needle ?? '');
    } else if (check.kind === 'file-matches') {
      ok = existsSync(target) && new RegExp(check.pattern ?? '', 'i').test(readFileSync(target, 'utf8'));
    }
    passed = passed && ok;
    detail.push(`${check.kind} ${check.path ?? ''}: ${ok ? 'pass' : 'FAIL'}`);
  }
  return { passed, detail };
}

/** Captures pre-run file content for every file-changed check in the task,
 * so runLiveChecks can later prove a genuine edit happened rather than
 * trusting that expected-looking text merely appears somewhere in the file. */
export function captureBaselines(task: BenchTask, workDir: string): Map<string, string | undefined> {
  const baselines = new Map<string, string | undefined>();
  for (const check of task.success) {
    if (check.kind !== 'file-changed' || check.path === undefined) continue;
    const target = path.join(workDir, check.path);
    baselines.set(check.path, existsSync(target) ? readFileSync(target, 'utf8') : undefined);
  }
  return baselines;
}

/**
 * Live-mode success checks against a real, claude-edited working copy.
 * Complements runChecks (replay, static-content only): file-changed and
 * answer-contains need an actual pre/post run comparison or a written
 * ANSWER_FILE_NAME, neither of which exists in replay's fixture-log-only
 * world (see runChecks's skip branch for the replay side of this split).
 */
export function runLiveChecks(
  task: BenchTask,
  variant: Variant,
  workDir: string,
  baselines: Map<string, string | undefined> = new Map(),
): { passed: boolean; detail: string[] } {
  const detail: string[] = [];
  let passed = true;
  for (const check of task.success) {
    if (check.variant !== undefined && check.variant !== 'both' && check.variant !== variant) continue;
    let ok = false;
    const target = check.path === undefined ? '' : path.join(workDir, check.path);
    if (check.kind === 'file-exists') ok = existsSync(target);
    else if (check.kind === 'file-contains') {
      ok = existsSync(target) && readFileSync(target, 'utf8').includes(check.needle ?? '');
    } else if (check.kind === 'file-matches') {
      ok = existsSync(target) && new RegExp(check.pattern ?? '', 'i').test(readFileSync(target, 'utf8'));
    } else if (check.kind === 'file-changed') {
      // Proves a genuine edit happened: current content differs from the
      // pre-run baseline, rather than a needle that could already be
      // present in the unedited file.
      const current = existsSync(target) ? readFileSync(target, 'utf8') : undefined;
      ok = check.path !== undefined && baselines.has(check.path) && current !== baselines.get(check.path);
    } else if (check.kind === 'answer-contains') {
      // buildLivePrompt instructs the model to write its explanation to
      // ANSWER_FILE_NAME; grading the file (not the chat transcript) checks
      // a real deliverable, not prose that mentions the right words in passing.
      const answerPath = path.join(workDir, ANSWER_FILE_NAME);
      ok =
        existsSync(answerPath) &&
        readFileSync(answerPath, 'utf8').toLowerCase().includes((check.needle ?? '').toLowerCase());
    } else if (check.kind === 'command-succeeds') {
      try {
        // check.command is one whole shell command string (may use pipes,
        // &&, etc.), passed with no args array: the intentional
        // single-string shell:true form, which has none of the
        // word-splitting hazard that shell:true plus an args array has.
        execFileSync(check.command ?? 'false', { cwd: workDir, shell: true, stdio: 'pipe' });
        ok = true;
      } catch {
        ok = false;
      }
    }
    passed = passed && ok;
    detail.push(`${check.kind} ${check.path ?? check.command ?? check.needle ?? ''}: ${ok ? 'pass' : 'FAIL'}`);
  }
  return { passed, detail };
}

export interface RunMeasurement {
  taskId: string;
  tier: string;
  variant: Variant;
  ledger: SessionLedger;
  totalTokens: number;
  costUsd: number;
  energy: SessionEnergy;
  scores: SessionScores;
  wallMs: number;
  success: boolean;
  successDetail: string[];
  model: string;
}

export async function replayTask(task: BenchTask, repoRoot: string): Promise<RunMeasurement[]> {
  const prices = loadPrices();
  const factors = loadEnergyFactors();
  const grid = loadGridIntensity();
  const out: RunMeasurement[] = [];
  for (const variant of ['vanilla', 'redutok'] as Variant[]) {
    const logPath = path.join(repoRoot, task.fixtureLogs[variant]);
    const parsed = await parseSessionFile(logPath);
    const ledger = buildLedger(parsed, `${task.id}-${variant}`);
    const energy = computeSessionEnergy(ledger, factors, grid);
    const stamps = ledger.entries.map((e) => Date.parse(e.timestamp)).filter((t) => !Number.isNaN(t));
    const check = runChecks(task, variant, repoRoot);
    out.push({
      taskId: task.id,
      tier: task.tier,
      variant,
      ledger,
      totalTokens: grandTotal(ledger.totals),
      costUsd: computeSessionCost(ledger, prices).totalUsd,
      energy,
      scores: scoreSession(ledger, energy, []),
      wallMs: stamps.length > 1 ? Math.max(...stamps) - Math.min(...stamps) : 0,
      success: check.passed,
      successDetail: check.detail,
      model: ledger.entries[0]?.model ?? 'unknown',
    });
  }
  return out;
}

export function dryRunMatrix(tasks: BenchTask[], n: number, model: string): string[] {
  if (!Number.isInteger(n) || n < 1) throw new Error(`repetition count must be a positive integer, got ${n}`);
  if (model === '') throw new Error('model must not be empty');
  const lines: string[] = [];
  for (const task of tasks) {
    for (let rep = 1; rep <= n; rep += 1) {
      for (const variant of ['vanilla', 'redutok'] as Variant[]) {
        const logFile = `bench/runs/${task.id}-${variant}-${rep}.jsonl`;
        lines.push(
          `# ${task.id} rep ${rep} ${variant} (cwd ${task.repo.localPath}, pin ${task.repo.url}@${task.repo.commit})`,
          `claude -p ${JSON.stringify(buildLivePrompt(task))} --model ${model} --output-format stream-json${variant === 'redutok' ? ' # after: redutok init . and redutok up' : ''} > ${logFile}`,
        );
      }
    }
  }
  return lines;
}

const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');

export function generateResults(measurements: RunMeasurement[], n: number): string {
  const model = measurements.find((m) => m.model !== 'unknown')?.model ?? 'unknown';
  const date = measurements
    .flatMap((m) => m.ledger.entries.map((e) => e.timestamp))
    .sort()
    .pop()
    ?.slice(0, 10);
  const lines: string[] = [
    '# Bench results',
    '',
    `model: ${model}`,
    `date: ${date ?? 'unknown'} (latest fixture log timestamp)`,
    `repetitions: ${n} (replay mode measures committed fixture logs once)`,
    `machine: ${os.platform()}-${os.arch()}, node ${process.version}`,
    '',
    'Replay-mode figures measure committed fixture session logs, not fresh live runs. Energy and carbon are estimates with bands, never measurements.',
    '',
    '| task | tier | variant | input | output | cache read | cache write | thinking | total | USD | Wh (band) | gCO2e (band) | wall ms | grade | success |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: | --- | --- |',
  ];
  for (const m of measurements) {
    const t = m.ledger.totals;
    const e = m.energy;
    lines.push(
      `| ${m.taskId} | ${m.tier} | ${m.variant} | ${fmt(t.input)} | ${fmt(t.output)} | ${fmt(t.cacheRead)} | ${fmt(t.cacheWrite)} | ${fmt(t.thinking)} | ${fmt(m.totalTokens)} | ${m.costUsd.toFixed(4)} | ${e.wh.base.toFixed(2)} (${e.wh.low.toFixed(2)} to ${e.wh.high.toFixed(2)}) | ${e.gCo2e.base.toFixed(2)} (${e.gCo2e.low.toFixed(2)} to ${e.gCo2e.high.toFixed(2)}) | ${m.wallMs} | ${m.scores.composite?.grade ?? 'n/a'} | ${m.success ? 'pass' : 'FAIL'} |`,
    );
  }
  lines.push('', '## Savings per task (vanilla over redutok, medians across repetitions)', '');
  const byTask = new Map<string, RunMeasurement[]>();
  for (const m of measurements) byTask.set(m.taskId, [...(byTask.get(m.taskId) ?? []), m]);
  const failures: string[] = [];
  for (const [taskId, runs] of byTask) {
    const vanilla = runs.find((r) => r.variant === 'vanilla');
    const redutok = runs.find((r) => r.variant === 'redutok');
    if (vanilla === undefined || redutok === undefined) continue;
    const ratio = redutok.totalTokens === 0 ? 0 : vanilla.totalTokens / redutok.totalTokens;
    lines.push(`- ${taskId}: ${ratio.toFixed(1)}x tokens (${fmt(vanilla.totalTokens)} to ${fmt(redutok.totalTokens)})`);
    if (ratio > 1 && vanilla.success && !redutok.success) {
      failures.push(
        `- ${taskId}: ${ratio.toFixed(1)}x savings but redutok run failed its success checks (${redutok.successDetail.join('; ')}). Savings without success are failures.`,
      );
    }
  }
  lines.push('', '## Failures (savings with success degradation)', '');
  lines.push(...(failures.length > 0 ? failures : ['None in this run set.']));
  lines.push('');
  return lines.join('\n');
}

export async function runReplay(repoRoot: string, tasksDir: string, outPath: string): Promise<string> {
  const tasks = loadBenchTasks(tasksDir);
  const measurements: RunMeasurement[] = [];
  for (const task of tasks) measurements.push(...(await replayTask(task, repoRoot)));
  const results = generateResults(measurements, 1);
  writeFileSync(outPath, results, 'utf8');
  return results;
}
