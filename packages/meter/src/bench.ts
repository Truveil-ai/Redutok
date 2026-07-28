import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
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

/**
 * Build-freshness gate for the live harness: workspace packages (those with a
 * build script) whose dist is missing or older than their newest src file.
 * The 4.36M-token h03 incident ran against a stale dist whose installer still
 * hardcoded the sidecar port; the harness now rebuilds before any run and
 * fails loudly if anything is still stale afterwards.
 */
export function staleDistPackages(root: string): string[] {
  const newestMtime = (dir: string): number => {
    let newest = 0;
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return 0;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      const stats = statSync(full);
      newest = Math.max(newest, stats.isDirectory() ? newestMtime(full) : stats.mtimeMs);
    }
    return newest;
  };
  const stale: string[] = [];
  const packagesDir = path.join(root, 'packages');
  if (!existsSync(packagesDir)) return stale;
  for (const name of readdirSync(packagesDir).sort()) {
    const pkgDir = path.join(packagesDir, name);
    const pkgJson = path.join(pkgDir, 'package.json');
    if (!existsSync(pkgJson)) continue;
    const pkg = JSON.parse(readFileSync(pkgJson, 'utf8')) as { scripts?: Record<string, string> };
    if (pkg.scripts?.['build'] === undefined) continue;
    const src = newestMtime(path.join(pkgDir, 'src'));
    const dist = newestMtime(path.join(pkgDir, 'dist'));
    if (dist === 0 || src > dist) stale.push(name);
  }
  return stale;
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

export interface LiveRunMeasurement extends RunMeasurement {
  rep: number;
  /** total_cost_usd from the claude CLI's own result event, when present. */
  reportedCostUsd?: number;
}

export interface NotRunRecord {
  taskId: string;
  variant: Variant;
  rep: number;
  reason: string;
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

const median = (xs: number[]): number => {
  const sorted = [...xs].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor((sorted.length - 1) / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid] as number) + (sorted[mid + 1] as number)) / 2;
};

/** Tokens excluding cache-read: per-turn cache-read is re-billed every turn
 * and priced at a tenth of input, so it can dominate the raw total without
 * reflecting genuine work avoided (a task with more agentic turns pays
 * cache-read N times over even when each turn is otherwise cheap). */
export const nonCacheReadTokens = (m: RunMeasurement): number => m.totalTokens - m.ledger.totals.cacheRead;

export interface LiveResultsOptions {
  model: string;
  n: number;
  machine?: string;
  /** false for an in-progress checkpoint write, true for the final report. */
  done: boolean;
}

export interface LiveResultsSummary {
  markdown: string;
  medianTokenRatio: number;
  medianUsdRatio: number;
  medianNonCacheReadRatio: number;
  parity: number;
  spend: number;
}

/**
 * Live-mode RESULTS.md generator (replay's counterpart is generateResults).
 * Reports token reduction (the definition-of-done metric) alongside USD and
 * non-cache-read token reduction as separate, explicitly non-gating context
 * columns, since cache-read dominance can otherwise make the raw total look
 * like it moved for reasons unrelated to genuine token avoidance.
 */
export function generateLiveResults(
  measurements: LiveRunMeasurement[],
  notRun: NotRunRecord[],
  options: LiveResultsOptions,
): LiveResultsSummary {
  const machine = options.machine ?? `${os.platform()}-${os.arch()}, node ${process.version}`;
  const lines: string[] = [
    '# Bench results (live)',
    '',
    `model: ${options.model}`,
    `date: ${new Date().toISOString().slice(0, 10)}`,
    `repetitions: ${options.n}`,
    `machine: ${machine}`,
    '',
    options.done
      ? 'Live-mode figures measure fresh headless claude CLI runs in isolated copies of the pinned repos. Energy and carbon are estimates with bands, never measurements.'
      : `CHECKPOINT: matrix in progress, ${measurements.length} runs measured so far. Live-mode figures measure fresh headless claude CLI runs in isolated copies of the pinned repos. Energy and carbon are estimates with bands, never measurements.`,
    '',
    '| task | tier | variant | rep | input | output | cache read | cache write | thinking | total | USD | Wh (band) | gCO2e (band) | wall ms | grade | success |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: | --- | --- |',
  ];
  for (const m of measurements) {
    const t = m.ledger.totals;
    const e = m.energy;
    lines.push(
      `| ${m.taskId} | ${m.tier} | ${m.variant} | ${m.rep} | ${fmt(t.input)} | ${fmt(t.output)} | ${fmt(t.cacheRead)} | ${fmt(t.cacheWrite)} | ${fmt(t.thinking)} | ${fmt(m.totalTokens)} | ${m.costUsd.toFixed(4)} | ${e.wh.base.toFixed(2)} (${e.wh.low.toFixed(2)} to ${e.wh.high.toFixed(2)}) | ${e.gCo2e.base.toFixed(2)} (${e.gCo2e.low.toFixed(2)} to ${e.gCo2e.high.toFixed(2)}) | ${m.wallMs} | ${m.scores.composite?.grade ?? 'n/a'} | ${m.success ? 'pass' : 'FAIL'} |`,
    );
  }

  lines.push('', '## Medians per task (across repetitions)', '');
  lines.push(
    '| task | vanilla tokens | redutok tokens | token reduction | vanilla USD | redutok USD | USD reduction | vanilla non-cache-read tokens | redutok non-cache-read tokens | non-cache-read reduction | vanilla success | redutok success |',
  );
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |');
  const byTask = new Map<string, LiveRunMeasurement[]>();
  for (const m of measurements) byTask.set(m.taskId, [...(byTask.get(m.taskId) ?? []), m]);
  const ratios: number[] = [];
  const usdRatios: number[] = [];
  const ncrRatios: number[] = [];
  const failures: string[] = [];
  let vanillaPass = 0;
  let vanillaTotal = 0;
  let redutokPass = 0;
  let redutokTotal = 0;
  for (const [taskId, runs] of byTask) {
    const vans = runs.filter((r) => r.variant === 'vanilla');
    const reds = runs.filter((r) => r.variant === 'redutok');
    vanillaTotal += vans.length;
    redutokTotal += reds.length;
    vanillaPass += vans.filter((r) => r.success).length;
    redutokPass += reds.filter((r) => r.success).length;
    if (vans.length === 0 || reds.length === 0) continue;
    const mv = median(vans.map((r) => r.totalTokens));
    const mr = median(reds.map((r) => r.totalTokens));
    const ratio = mr === 0 ? 0 : mv / mr;
    ratios.push(ratio);
    const mvUsd = median(vans.map((r) => r.costUsd));
    const mrUsd = median(reds.map((r) => r.costUsd));
    const usdRatio = mrUsd === 0 ? 0 : mvUsd / mrUsd;
    usdRatios.push(usdRatio);
    const mvNcr = median(vans.map(nonCacheReadTokens));
    const mrNcr = median(reds.map(nonCacheReadTokens));
    const ncrRatio = mrNcr === 0 ? 0 : mvNcr / mrNcr;
    ncrRatios.push(ncrRatio);
    lines.push(
      `| ${taskId} | ${fmt(mv)} | ${fmt(mr)} | ${ratio.toFixed(1)}x | ${mvUsd.toFixed(4)} | ${mrUsd.toFixed(4)} | ${usdRatio.toFixed(1)}x | ${fmt(mvNcr)} | ${fmt(mrNcr)} | ${ncrRatio.toFixed(1)}x | ${vans.filter((r) => r.success).length}/${vans.length} | ${reds.filter((r) => r.success).length}/${reds.length} |`,
    );
    for (const r of reds) {
      if (!r.success && ratio > 1 && vans.some((v) => v.rep === r.rep && v.success)) {
        failures.push(
          `- ${taskId} rep ${r.rep}: ${ratio.toFixed(1)}x savings but the redutok run failed its success checks (${r.successDetail.join('; ')}). Savings without success are failures.`,
        );
      }
    }
  }
  const medianTokenRatio = median(ratios);
  const medianUsdRatio = median(usdRatios);
  const medianNonCacheReadRatio = median(ncrRatios);
  const vanillaRate = vanillaTotal === 0 ? 0 : vanillaPass / vanillaTotal;
  const redutokRate = redutokTotal === 0 ? 0 : redutokPass / redutokTotal;
  const parity = vanillaRate === 0 ? 1 : redutokRate / vanillaRate;
  const spend = measurements.reduce((n, m) => n + m.costUsd, 0);
  const reported = measurements.reduce((n, m) => n + (m.reportedCostUsd ?? 0), 0);
  lines.push(
    '',
    '## Definition of done',
    '',
    `- median token reduction across tasks: ${medianTokenRatio.toFixed(1)}x (threshold: at least 10x, applies to this metric, the raw total-token median) ${medianTokenRatio >= 10 ? 'MET' : 'NOT MET'}`,
    `- median USD reduction across tasks: ${medianUsdRatio.toFixed(1)}x (context only, no threshold)`,
    `- median non-cache-read token reduction across tasks: ${medianNonCacheReadRatio.toFixed(1)}x (context only, no threshold; input plus output plus cache-write plus thinking, excludes the per-turn re-billed cache-read)`,
    `- success parity: redutok ${(redutokRate * 100).toFixed(0)}% vs vanilla ${(vanillaRate * 100).toFixed(0)}%, parity ${(parity * 100).toFixed(0)}% (threshold: at least 95%) ${parity >= 0.95 ? 'MET' : 'NOT MET'}`,
    `- cumulative spend: ${spend.toFixed(4)} USD (meter, prices.yaml)${reported > 0 ? `, ${reported.toFixed(4)} USD (claude CLI reported)` : ''}`,
  );
  lines.push('', '## Failures (savings with success degradation)', '');
  lines.push(...(failures.length > 0 ? failures : ['None in this run set.']));
  if (notRun.length > 0) {
    lines.push('', '## Not run', '');
    for (const nr of notRun) lines.push(`- ${nr.taskId} ${nr.variant} rep ${nr.rep}: ${nr.reason}`);
  }
  lines.push('');
  return {
    markdown: lines.join('\n'),
    medianTokenRatio,
    medianUsdRatio,
    medianNonCacheReadRatio,
    parity,
    spend,
  };
}
