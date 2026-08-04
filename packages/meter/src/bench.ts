import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadEnergyFactors, loadGridIntensity, loadPrices } from '@redutok/shared';
import { computeSessionCost } from './cost.js';
import { computeSessionEnergy, type SessionEnergy } from './energy.js';
import { buildLedger, grandTotal, type SessionLedger } from './ledger.js';
import { parseSessionFile } from './parser.js';
import { compositeCell, scoreSession, type SessionScores } from './scoring.js';

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

/**
 * A harness-applied edit to the task's working copy, applied after the copy
 * (and, for a slope sequence, after the inter-task boundary) but before the
 * session starts and before baselines are captured. This is how a slope task
 * can re-introduce a defect into the persistent working tree — the only way
 * the same failure signature can legitimately recur across sessions, which
 * is what the error-fix miner's occurrence count measures. Applied
 * identically in both variants. Two modes, exactly one per edit:
 * - `write`: deterministic content-write of the whole target file. The mode
 *   for seeds landing on a carried tree: the 2026-07-30 rep-1 abort showed a
 *   find string cannot survive a prior session rewriting the region (the s02
 *   fix touched both halves of the joint line and find matched 0 times).
 * - `find`/`replace`: surgical edit; `find` must occur exactly once or the
 *   run aborts as not-run rather than measuring a mis-seeded task. Only safe
 *   where no earlier task can have touched the region.
 * Either mode requires the target to exist: a seed reintroduces, never
 * introduces.
 */
export interface TaskSeedEdit {
  path: string;
  find?: string;
  replace?: string;
  write?: string;
}

export interface BenchTask {
  id: string;
  tier: 'small' | 'medium' | 'large' | 'heavy' | 'slope';
  repo: { url: string; commit: string; localPath: string };
  prompt: string;
  success: SuccessCheck[];
  fixtureLogs: Record<Variant, string>;
  seed?: TaskSeedEdit[];
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
    if (raw.seed !== undefined) {
      if (!Array.isArray(raw.seed)) throw new Error(`${file}: seed must be a list of edits`);
      for (const edit of raw.seed) {
        if (typeof edit?.path !== 'string' || edit.path === '') {
          throw new Error(`${file}: every seed edit needs a path`);
        }
        const hasWrite = typeof edit.write === 'string' && edit.write !== '';
        const hasFindReplace =
          typeof edit.find === 'string' && edit.find !== '' && typeof edit.replace === 'string';
        if (hasWrite === hasFindReplace) {
          throw new Error(
            `${file}: seed edit for ${edit.path} needs exactly one mode: write, or find plus replace`,
          );
        }
      }
    }
    tasks.push(raw);
  }
  return tasks;
}

/**
 * Applies a task's seed edits to its working copy. A `write` edit overwrites
 * the whole target file with canonical seeded content, deterministic against
 * whatever a prior session left there. A `find`/`replace` edit must match
 * exactly once — zero means the tree drifted from what the seed was authored
 * against, more than one means the edit is ambiguous; either way the run
 * must abort rather than measure a mis-seeded task. Both modes require the
 * target to exist. Returns one description per applied edit for the log.
 */
export function applyTaskSeed(task: BenchTask, workDir: string): string[] {
  const applied: string[] = [];
  for (const edit of task.seed ?? []) {
    const file = path.join(workDir, edit.path);
    if (!existsSync(file)) throw new Error(`seed for ${task.id}: ${edit.path} does not exist in the copy`);
    if (typeof edit.write === 'string' && edit.write !== '') {
      writeFileSync(file, edit.write, 'utf8');
      applied.push(`${edit.path}: seeded by content-write (${edit.write.length}B)`);
      continue;
    }
    const find = edit.find ?? '';
    const content = readFileSync(file, 'utf8');
    const occurrences = content.split(find).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `seed for ${task.id}: find string occurs ${occurrences} times in ${edit.path}, expected exactly 1`,
      );
    }
    writeFileSync(file, content.replace(find, edit.replace ?? ''), 'utf8');
    applied.push(`${edit.path}: seeded (${find.length}B find -> ${(edit.replace ?? '').length}B replace)`);
  }
  return applied;
}

/**
 * Slope tier (v4 session 4): a sequence of related-but-distinct tasks on one
 * fixture repo, measuring whether carried .dcp state (candidates, codex,
 * mirror) makes later tasks cheaper. The criteria below are the only ones the
 * harness knows how to evaluate; the tier yaml must name exactly this set, so
 * the pre-registered bar can neither be moved nor extended by a yaml edit
 * after runs exist (house rule: no bar movement after the fact).
 */
export const SLOPE_CRITERION_IDS = ['slope-exists', 'learning-pays', 'mechanism-engaged'] as const;
export type SlopeCriterionId = (typeof SLOPE_CRITERION_IDS)[number];

export interface SlopeCriterion {
  id: SlopeCriterionId;
  description: string;
}

export interface SlopeTier {
  tier: 'slope';
  id: string;
  /** Task ids in execution order (s1 first). */
  sequence: string[];
  criteria: SlopeCriterion[];
}

export function loadSlopeTier(file: string, tasks: BenchTask[]): SlopeTier {
  const raw = parseYaml(readFileSync(file, 'utf8')) as SlopeTier;
  const name = path.basename(file);
  if (raw.tier !== 'slope') throw new Error(`${name}: tier must be "slope", got ${String(raw.tier)}`);
  if (typeof raw.id !== 'string' || raw.id === '') throw new Error(`${name}: missing tier id`);
  if (!Array.isArray(raw.sequence) || raw.sequence.length < 2) {
    throw new Error(`${name}: sequence must list at least two task ids in order`);
  }
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const first = byId.get(raw.sequence[0] ?? '');
  for (const id of raw.sequence) {
    const task = byId.get(id);
    if (task === undefined) throw new Error(`${name}: sequence names unknown task ${id}`);
    if (task.tier !== 'slope') throw new Error(`${name}: sequence task ${id} has tier ${task.tier}, expected slope`);
    if (
      first !== undefined &&
      (task.repo.url !== first.repo.url || task.repo.commit !== first.repo.commit || task.repo.localPath !== first.repo.localPath)
    ) {
      throw new Error(`${name}: sequence task ${id} pins a different repo; knowledge cannot carry across repos`);
    }
  }
  for (const task of tasks) {
    if (task.tier === 'slope' && !raw.sequence.includes(task.id)) {
      throw new Error(`${name}: slope task ${task.id} is not claimed by the sequence; nothing may run outside it`);
    }
  }
  if (!Array.isArray(raw.criteria)) throw new Error(`${name}: missing criteria`);
  for (const criterion of raw.criteria) {
    if (!(SLOPE_CRITERION_IDS as readonly string[]).includes(criterion.id)) {
      throw new Error(`${name}: criterion ${String(criterion.id)} is not pre-registered in the harness`);
    }
    if (typeof criterion.description !== 'string' || criterion.description === '') {
      throw new Error(`${name}: criterion ${criterion.id} needs a description`);
    }
  }
  for (const id of SLOPE_CRITERION_IDS) {
    if (!raw.criteria.some((c) => c.id === id)) {
      throw new Error(`${name}: pre-registered criterion ${id} is missing from the tier file`);
    }
  }
  return { tier: 'slope', id: raw.id, sequence: [...raw.sequence], criteria: raw.criteria.map((c) => ({ ...c })) };
}

/** The subset of an audit event the slope attribution counters read; matches
 * @redutok/shared's AuditEvent without importing its zod machinery here. */
export interface AuditEventLike {
  action?: string;
  module?: string;
  sessionId?: string;
  details?: Record<string, unknown>;
}

export interface SlopeAttribution {
  zoomBacks: number;
  enrichmentServes: number;
  /** Graduated learned entries actually injected at this session's
   * SessionStart, from the posture audit event's injectedLearned refs. */
  learnedInjected: number;
  /** Graduated pitfalls entries injected at SessionStart (injectedPitfalls
   * refs). An error-fix lesson graduates into pitfalls, not learned, so a
   * counter blind to these demotes the sequence's deterministic graduation
   * path to MET-UNATTRIBUTED (N=3 diagnosis, 2026-07-30). */
  pitfallsInjected: number;
}

/**
 * Per-task attribution counts from a redutok copy's .dcp/audit.jsonl:
 * zoom-backs (the model went back for elided detail), enrichment serves (a
 * served artifact carried a graduated lesson's candidate ref), and learned
 * injections (graduated entries the posture pass put into this session's
 * context). Together they show the mechanism behind a slope, not just the
 * outcome.
 */
export function countSlopeAttribution(events: readonly AuditEventLike[], sessionId: string): SlopeAttribution {
  const mine = events.filter((e) => e.sessionId === sessionId);
  const zoomBacks = mine.filter((e) => e.action === 'zoom').length;
  const enrichmentServes = mine.filter((e) => {
    const candidate = e.details?.['enrichmentCandidate'];
    return typeof candidate === 'string' && candidate !== '';
  }).length;
  const injectedCount = (key: string): number =>
    mine.reduce((n, e) => {
      const injected = e.details?.[key];
      return n + (Array.isArray(injected) ? injected.length : 0);
    }, 0);
  return {
    zoomBacks,
    enrichmentServes,
    learnedInjected: injectedCount('injectedLearned'),
    pitfallsInjected: injectedCount('injectedPitfalls'),
  };
}

/** True when the graduation miner has audited a completed mining run for the
 * given session (module sidecar.graduation, attributed to that session). */
export function hasGraduationEvent(events: readonly AuditEventLike[], sessionId: string): boolean {
  return events.some((e) => e.module === 'sidecar.graduation' && e.sessionId === sessionId);
}

/** Turn count of a session: the highest turn number in the ledger. */
export const turnsOf = (ledger: SessionLedger): number =>
  ledger.entries.reduce((n, e) => Math.max(n, e.turn), 0);

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
  /** Slope-tier attribution counts, read from the run's .dcp/audit.jsonl
   * before the copy is torn down. Absent for vanilla runs (no .dcp) and for
   * runs recovered from committed logs, whose audit file is gone. */
  attribution?: SlopeAttribution;
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

/**
 * Preserves an aborted slope rep's `.dcp` (audit trail, candidates, codex,
 * sqlite store) next to the run logs before the runner tears the persistent
 * copy down. The 2026-07-30 rep-1 abort removed the copy with the only
 * audit-level evidence in it, forcing a transcript-only diagnosis. Copies
 * (never renames — the temp copy usually lives on another drive) and leaves
 * the original for the normal teardown; a prior preservation under the same
 * label is replaced. Returns the destination, or undefined when the copy
 * never grew a `.dcp` (abort before init).
 */
export function preserveAbortedDcp(workDir: string, runsDir: string, label: string): string | undefined {
  const src = path.join(workDir, '.dcp');
  if (!existsSync(src)) return undefined;
  const dest = path.join(runsDir, `${label}-aborted-dcp`);
  rmSync(dest, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  cpSync(src, dest, { recursive: true });
  return dest;
}

export function dryRunMatrix(tasks: BenchTask[], n: number, model: string, slope?: SlopeTier): string[] {
  if (!Number.isInteger(n) || n < 1) throw new Error(`repetition count must be a positive integer, got ${n}`);
  if (model === '') throw new Error('model must not be empty');
  const lines: string[] = [];
  const taskLine = (task: BenchTask, rep: number, variant: Variant, note: string): void => {
    const logFile = `bench/runs/${task.id}-${variant}-${rep}.jsonl`;
    lines.push(
      `# ${task.id} rep ${rep} ${variant} (cwd ${task.repo.localPath}, pin ${task.repo.url}@${task.repo.commit})`,
      `claude -p ${JSON.stringify(buildLivePrompt(task))} --model ${model} --output-format stream-json${note} > ${logFile}`,
    );
  };
  for (const task of tasks.filter((t) => t.tier !== 'slope')) {
    for (let rep = 1; rep <= n; rep += 1) {
      for (const variant of ['vanilla', 'redutok'] as Variant[]) {
        taskLine(task, rep, variant, variant === 'redutok' ? ' # after: redutok init . and redutok up' : '');
      }
    }
  }
  if (slope !== undefined) {
    const sequenceTasks = slope.sequence.map((id) => tasks.find((t) => t.id === id)).filter((t): t is BenchTask => t !== undefined);
    for (let rep = 1; rep <= n; rep += 1) {
      lines.push(`# slope sequence ${slope.id} rep ${rep} vanilla: cold copy per task, fresh session per task, in order`);
      for (const task of sequenceTasks) taskLine(task, rep, 'vanilla', '');
      lines.push(
        `# slope sequence ${slope.id} rep ${rep} redutok: one persistent copy, .dcp (candidates, codex, mirror) carried across the sequence, fresh session per task`,
      );
      for (const task of sequenceTasks) {
        taskLine(task, rep, 'redutok', ' # persistent copy; graduation pass must complete before the next task');
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
      `| ${m.taskId} | ${m.tier} | ${m.variant} | ${fmt(t.input)} | ${fmt(t.output)} | ${fmt(t.cacheRead)} | ${fmt(t.cacheWrite)} | ${fmt(t.thinking)} | ${fmt(m.totalTokens)} | ${m.costUsd.toFixed(4)} | ${e.wh.base.toFixed(2)} (${e.wh.low.toFixed(2)} to ${e.wh.high.toFixed(2)}) | ${e.gCo2e.base.toFixed(2)} (${e.gCo2e.low.toFixed(2)} to ${e.gCo2e.high.toFixed(2)}) | ${m.wallMs} | ${compositeCell(m.scores.composite)} | ${m.success ? 'pass' : 'FAIL'} |`,
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
  // Slope tasks only mean anything run in sequence with carried .dcp state;
  // replaying them as independent fixture logs would measure nothing real.
  const tasks = loadBenchTasks(tasksDir).filter((t) => t.tier !== 'slope');
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

export interface SlopeVariantReport {
  variant: Variant;
  s1Tokens: number;
  s3Tokens: number;
  /** s3 over s1: below 1 means the last task in the sequence came in cheaper. */
  tokenRatio: number;
  s1Turns: number;
  s3Turns: number;
  turnRatio: number;
}

export interface SlopeCriterionVerdict {
  id: SlopeCriterionId;
  description: string;
  pass: boolean;
  detail: string;
}

export interface SlopeReport {
  sequenceId: string;
  variants: SlopeVariantReport[];
  /** vanilla s3 over redutok s3 (medians), the repo's reduction convention. */
  headlineTokenRatio: number;
  /** True when at least one enrichment serve or learned injection appeared
   * across the redutok sequence. Numeric bars that pass without this are
   * rendered MET-UNATTRIBUTED and are not citable. */
  mechanismEngaged: boolean;
  criteria: SlopeCriterionVerdict[];
}

/**
 * The slope tier's arithmetic: per-variant s3-versus-s1 token and turn
 * slopes from medians across repetitions, the headline redutok-s3-versus-
 * vanilla-s3 ratio, and the two pre-registered criteria verdicts. Missing
 * positions fail the criteria explicitly rather than passing vacuously.
 */
export function evaluateSlope(tier: SlopeTier, measurements: LiveRunMeasurement[]): SlopeReport {
  const last = tier.sequence.length;
  const runsAt = (variant: Variant, position: number): LiveRunMeasurement[] =>
    measurements.filter((m) => m.variant === variant && m.taskId === tier.sequence[position - 1]);
  const stats = (variant: Variant, position: number): { tokens: number; turns: number; passRate: number; count: number } => {
    const runs = runsAt(variant, position);
    return {
      tokens: median(runs.map((r) => r.totalTokens)),
      turns: median(runs.map((r) => turnsOf(r.ledger))),
      passRate: runs.length === 0 ? 0 : runs.filter((r) => r.success).length / runs.length,
      count: runs.length,
    };
  };
  const variants: SlopeVariantReport[] = (['vanilla', 'redutok'] as Variant[]).map((variant) => {
    const s1 = stats(variant, 1);
    const s3 = stats(variant, last);
    return {
      variant,
      s1Tokens: s1.tokens,
      s3Tokens: s3.tokens,
      tokenRatio: s1.tokens === 0 ? 0 : s3.tokens / s1.tokens,
      s1Turns: s1.turns,
      s3Turns: s3.turns,
      turnRatio: s1.turns === 0 ? 0 : s3.turns / s1.turns,
    };
  });
  const redS1 = stats('redutok', 1);
  const redS3 = stats('redutok', last);
  const vanS3 = stats('vanilla', last);
  const headlineTokenRatio = redS3.tokens === 0 ? 0 : vanS3.tokens / redS3.tokens;
  const descriptionOf = (id: SlopeCriterionId): string => tier.criteria.find((c) => c.id === id)?.description ?? id;
  const criteria: SlopeCriterionVerdict[] = [];
  {
    const enough = redS1.count > 0 && redS3.count > 0;
    const pass = enough && redS3.tokens < redS1.tokens && redS3.turns < redS1.turns;
    criteria.push({
      id: 'slope-exists',
      description: descriptionOf('slope-exists'),
      pass,
      detail: enough
        ? `redutok s${last} ${fmt(redS3.tokens)} tokens / ${fmt(redS3.turns)} turns vs s1 ${fmt(redS1.tokens)} tokens / ${fmt(redS1.turns)} turns`
        : `insufficient data: redutok s1 has ${redS1.count} runs, s${last} has ${redS3.count}`,
    });
  }
  {
    const enough = redS3.count > 0 && vanS3.count > 0;
    const parityOk = enough && redS3.passRate >= vanS3.passRate;
    const pass = enough && redS3.tokens < vanS3.tokens && parityOk;
    criteria.push({
      id: 'learning-pays',
      description: descriptionOf('learning-pays'),
      pass,
      detail: enough
        ? `redutok s${last} ${fmt(redS3.tokens)} tokens vs vanilla s${last} ${fmt(vanS3.tokens)}; success parity ${(redS3.passRate * 100).toFixed(0)}% vs ${(vanS3.passRate * 100).toFixed(0)}%${parityOk ? '' : ' (parity lost)'}`
        : `insufficient data: redutok s${last} has ${redS3.count} runs, vanilla s${last} has ${vanS3.count}`,
    });
  }
  // Mechanism engagement: the idle-posture incident produced a numerically
  // MET slope with zero attribution — a slope from nowhere. Zoom-backs are
  // usage, not learning, so only enrichment serves and graduated-knowledge
  // injections (learned and pitfalls sections both) count as the mechanism.
  const attributed = measurements.filter((m) => m.variant === 'redutok' && m.attribution !== undefined);
  const serves = attributed.reduce((n, m) => n + (m.attribution?.enrichmentServes ?? 0), 0);
  const injections = attributed.reduce((n, m) => n + (m.attribution?.learnedInjected ?? 0), 0);
  const pitfalls = attributed.reduce((n, m) => n + (m.attribution?.pitfallsInjected ?? 0), 0);
  const mechanismEngaged = serves + injections + pitfalls > 0;
  criteria.push({
    id: 'mechanism-engaged',
    description: descriptionOf('mechanism-engaged'),
    pass: mechanismEngaged,
    detail:
      attributed.length === 0
        ? 'attribution unavailable: no redutok run carried audit counts (recovered from logs?)'
        : `${serves} enrichment serves, ${injections} learned injections, ${pitfalls} pitfall injection(s) across the redutok sequence`,
  });
  return { sequenceId: tier.id, variants, headlineTokenRatio, mechanismEngaged, criteria };
}

/** The RESULTS.md slope section: per-task medians with the attribution
 * attribution that shows the mechanism, then the slopes and the verdicts. */
function slopeSection(tier: SlopeTier, measurements: LiveRunMeasurement[], report: SlopeReport): string[] {
  const lines: string[] = [
    '',
    `## Slope (sequence ${tier.id})`,
    '',
    'Sequenced runs on one fixture repo: the redutok variant carries its .dcp state (candidates, codex, mirror) across the sequence with a graduation pass between tasks; vanilla starts cold each task. Zoom-backs and enrichment serves come from each redutok copy’s .dcp/audit.jsonl attribution counts (vanilla has no .dcp; runs recovered from committed logs have no audit file and show —).',
    '',
    '| task | position | variant | tokens (median) | turns (median) | zoom-backs | enrichment serves | learned injected | pitfalls injected | success |',
    '| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  ];
  tier.sequence.forEach((taskId, index) => {
    for (const variant of ['vanilla', 'redutok'] as Variant[]) {
      const runs = measurements.filter((m) => m.taskId === taskId && m.variant === variant);
      if (runs.length === 0) continue;
      const withAttribution = runs.filter((r) => r.attribution !== undefined);
      const cell = (pick: (t: SlopeAttribution) => number): string =>
        withAttribution.length === 0 ? '—' : fmt(median(withAttribution.map((r) => pick(r.attribution as SlopeAttribution))));
      lines.push(
        `| ${taskId} | ${index + 1} | ${variant} | ${fmt(median(runs.map((r) => r.totalTokens)))} | ${fmt(median(runs.map((r) => turnsOf(r.ledger))))} | ${cell((t) => t.zoomBacks)} | ${cell((t) => t.enrichmentServes)} | ${cell((t) => t.learnedInjected)} | ${cell((t) => t.pitfallsInjected)} | ${runs.filter((r) => r.success).length}/${runs.length} |`,
      );
    }
  });
  lines.push('');
  for (const v of report.variants) {
    lines.push(`- ${v.variant} slope (s${tier.sequence.length}/s1): tokens ${v.tokenRatio.toFixed(2)}x, turns ${v.turnRatio.toFixed(2)}x`);
  }
  lines.push(`- headline: vanilla s${tier.sequence.length} over redutok s${tier.sequence.length}: ${report.headlineTokenRatio.toFixed(1)}x tokens`);
  lines.push('', '### Pre-registered criteria (bench/tiers/slope.yaml; no bar movement after the fact)', '');
  for (const c of report.criteria) {
    // A numeric bar that passes while the mechanism never engaged is a
    // slope from nowhere: demoted to MET-UNATTRIBUTED, explicitly not
    // citable (the idle-posture incident, 2026-07-30).
    const label =
      c.pass && c.id !== 'mechanism-engaged' && !report.mechanismEngaged
        ? 'MET-UNATTRIBUTED (mechanism not engaged; not citable)'
        : c.pass
          ? 'MET'
          : 'NOT MET';
    lines.push(`- ${c.id}: ${c.description} — ${label} (${c.detail})`);
  }
  return lines;
}

export interface LiveResultsOptions {
  model: string;
  n: number;
  machine?: string;
  /** false for an in-progress checkpoint write, true for the final report. */
  done: boolean;
  /** When set, RESULTS.md gains the slope section for this sequence. */
  slope?: SlopeTier;
}

export interface LiveResultsSummary {
  markdown: string;
  medianTokenRatio: number;
  medianUsdRatio: number;
  medianNonCacheReadRatio: number;
  parity: number;
  spend: number;
  /** Present when a slope tier was passed in the options. */
  slope?: SlopeReport;
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
      `| ${m.taskId} | ${m.tier} | ${m.variant} | ${m.rep} | ${fmt(t.input)} | ${fmt(t.output)} | ${fmt(t.cacheRead)} | ${fmt(t.cacheWrite)} | ${fmt(t.thinking)} | ${fmt(m.totalTokens)} | ${m.costUsd.toFixed(4)} | ${e.wh.base.toFixed(2)} (${e.wh.low.toFixed(2)} to ${e.wh.high.toFixed(2)}) | ${e.gCo2e.base.toFixed(2)} (${e.gCo2e.low.toFixed(2)} to ${e.gCo2e.high.toFixed(2)}) | ${m.wallMs} | ${compositeCell(m.scores.composite)} | ${m.success ? 'pass' : 'FAIL'} |`,
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
  let slope: SlopeReport | undefined;
  if (options.slope !== undefined) {
    slope = evaluateSlope(options.slope, measurements);
    lines.push(...slopeSection(options.slope, measurements, slope));
  }
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
    ...(slope === undefined ? {} : { slope }),
  };
}
