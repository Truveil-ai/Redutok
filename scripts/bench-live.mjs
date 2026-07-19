#!/usr/bin/env node
/**
 * Live bench runner (operator command, architecture section 8).
 *
 * Executes the dry-run matrix for real: every bench task, vanilla vs redutok,
 * N repetitions, strictly sequential, each run in a fresh isolated copy of the
 * pinned repo so runs never mutate the working tree or each other. JSONL logs
 * land in bench/runs/ (the Claude Code transcript as <id>.jsonl, the raw
 * stream-json capture as <id>.stream.jsonl). RESULTS.md is regenerated after
 * every completed task so an interruption loses nothing; a task that cannot
 * execute for environmental reasons is recorded as not-run with the reason and
 * the matrix continues.
 *
 * Usage:
 *   node scripts/bench-live.mjs --model claude-sonnet-5 --n 3
 *     [--tasks t01,t02] [--timeout-min 15] [--prep-check]
 *
 * --prep-check does everything for one task except invoking claude (copy,
 * strip or init, sidecar up, health, down, cleanup) and never writes
 * RESULTS.md. Requires a prior pnpm build; runs claude with
 * --dangerously-skip-permissions inside the throwaway copies only.
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const meter = await import(
  new URL('file:///' + path.join(root, 'packages', 'meter', 'dist', 'index.js').replace(/\\/g, '/')).href
);
const {
  buildLedger,
  computeSessionCost,
  computeSessionEnergy,
  grandTotal,
  loadBenchTasks,
  parseSessionFile,
  scoreSession,
  transcriptRoot,
} = meter;
const shared = await import(
  new URL(
    'file:///' + path.join(root, 'packages', 'shared', 'dist', 'index.js').replace(/\\/g, '/'),
  ).href
);
const { loadEnergyFactors, loadGridIntensity, loadPrices } = shared;

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const MODEL = argValue('--model', 'claude-sonnet-5');
const N = Number(argValue('--n', '3'));
const TIMEOUT_MS = Number(argValue('--timeout-min', '15')) * 60_000;
const ONLY = argValue('--tasks', '').split(',').filter(Boolean);
const PREP_CHECK = argv.includes('--prep-check');
if (!Number.isInteger(N) || N < 1) throw new Error(`--n must be a positive integer, got ${N}`);

const runsDir = path.join(root, 'bench', 'runs');
const resultsPath = path.join(root, 'bench', 'RESULTS.md');
mkdirSync(runsDir, { recursive: true });

const cli = path.join(root, 'packages', 'meter', 'dist', 'cli.js');
const prices = loadPrices();
const factors = loadEnergyFactors();
const grid = loadGridIntensity();

// Windows keeps sqlite and log handles open briefly after the daemon exits;
// retry removal instead of failing the run.
function removeDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
  } catch (err) {
    // A leftover temp copy must never fail a run; report and move on.
    console.warn(`  cleanup: could not remove ${dir} (${err instanceof Error ? err.message : err})`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Wait for the daemon recorded in the pidfile to fully exit; its open cwd
 * and sqlite handles block directory removal on Windows until then. */
async function waitForDaemonExit(workDir) {
  const pidfile = path.join(workDir, '.dcp', 'sidecar.pid.json');
  let pid;
  try {
    pid = JSON.parse(readFileSync(pidfile, 'utf8')).pid;
  } catch {
    return;
  }
  for (let i = 0; i < 40 && pidAlive(pid); i += 1) await sleep(250);
}

// ------------------------------------------------------------ repo isolation
function copyRepo(task, workDir) {
  removeDir(workDir);
  mkdirSync(workDir, { recursive: true });
  if (task.repo.localPath === '.') {
    // Tracked files only: settings.local.json (hook wiring) is untracked by
    // design, so the copy starts with no redutok hooks either way.
    execFileSync('git', ['checkout-index', '-a', `--prefix=${workDir}${path.sep}`], { cwd: root });
  } else {
    cpSync(path.join(root, task.repo.localPath), workDir, { recursive: true });
  }
}

function stripRedutok(workDir) {
  for (const p of ['.mcp.json', '.dcp', path.join('.claude', 'redutok')]) {
    rmSync(path.join(workDir, p), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
  const claudeMd = path.join(workDir, 'CLAUDE.md');
  if (existsSync(claudeMd)) {
    const stripped = readFileSync(claudeMd, 'utf8').replace(
      /<!-- dcp:start[\s\S]*?<!-- dcp:end -->\n?/g,
      '',
    );
    writeFileSync(claudeMd, stripped);
  }
}

let nextPort = 49100;
function initRedutok(workDir) {
  const port = nextPort++;
  execFileSync('node', [cli, 'init', workDir], { cwd: workDir });
  const configPath = path.join(workDir, '.dcp', 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.port = port;
  config.profilesDir = path.join(root, 'profiles');
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  execFileSync('node', [cli, 'up'], { cwd: workDir, env: { ...process.env, REDUTOK_HOME: root } });
  execFileSync('node', [cli, 'codex', 'refresh'], {
    cwd: workDir,
    env: { ...process.env, REDUTOK_HOME: root },
  });
  return port;
}

function health(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 2000 }, (res) =>
      resolve(res.statusCode === 200),
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function downRedutok(workDir) {
  try {
    execFileSync('node', [cli, 'down'], { cwd: workDir });
  } catch {
    // A daemon that already exited is fine; the pidfile is authoritative.
  }
  await waitForDaemonExit(workDir);
}

// ------------------------------------------------------------- claude driver
function runClaude(prompt, workDir, streamPath) {
  return new Promise((resolve) => {
    const args = [
      '-p',
      prompt,
      '--model',
      MODEL,
      '--output-format',
      'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
    ];
    const child = spawn('claude', args, {
      cwd: workDir,
      env: { ...process.env, REDUTOK_HOME: root },
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    const chunks = [];
    const errChunks = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => errChunks.push(c));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, TIMEOUT_MS);
    const started = Date.now();
    child.on('close', (code) => {
      clearTimeout(timer);
      const stream = Buffer.concat(chunks).toString('utf8');
      writeFileSync(streamPath, stream);
      const wallMs = Date.now() - started;
      let result;
      for (const line of stream.split('\n')) {
        if (line.trim() === '') continue;
        try {
          const rec = JSON.parse(line);
          if (rec.type === 'result') result = rec;
        } catch {
          // Non-JSON noise in the stream is ignored; the transcript is the
          // measurement source of truth.
        }
      }
      resolve({
        code,
        wallMs,
        result,
        timedOut: wallMs >= TIMEOUT_MS,
        stderr: Buffer.concat(errChunks).toString('utf8').slice(0, 2000),
      });
    });
  });
}

function findTranscript(sessionId) {
  const roots = [transcriptRoot()];
  for (const dir of roots) {
    const stack = [dir];
    while (stack.length > 0) {
      const current = stack.pop();
      let names;
      try {
        names = readdirSync(current);
      } catch {
        continue;
      }
      for (const name of names) {
        const full = path.join(current, name);
        if (name === `${sessionId}.jsonl`) return full;
        try {
          if (statSync(full).isDirectory()) stack.push(full);
        } catch {
          // Ignore races; a vanished directory cannot hold the transcript.
        }
      }
    }
  }
  return undefined;
}

// ------------------------------------------------------------ success checks
function runChecksLive(task, variant, workDir) {
  const detail = [];
  let passed = true;
  for (const check of task.success) {
    if (check.variant !== undefined && check.variant !== 'both' && check.variant !== variant) continue;
    let ok = false;
    const target = check.path === undefined ? '' : path.join(workDir, check.path);
    if (check.kind === 'file-exists') ok = existsSync(target);
    else if (check.kind === 'file-contains') {
      ok = existsSync(target) && readFileSync(target, 'utf8').includes(check.needle ?? '');
    } else if (check.kind === 'command-succeeds') {
      try {
        execFileSync(check.command ?? 'false', { cwd: workDir, shell: true, stdio: 'pipe' });
        ok = true;
      } catch {
        ok = false;
      }
    }
    passed = passed && ok;
    detail.push(`${check.kind} ${check.path ?? check.command ?? ''}: ${ok ? 'pass' : 'FAIL'}`);
  }
  return { passed, detail };
}

// ----------------------------------------------------------------- reporting
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s.length % 2 === 1 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const fmt = (n) => Math.round(n).toLocaleString('en-US');

function writeResults(measurements, notRun, done) {
  const lines = [
    '# Bench results (live)',
    '',
    `model: ${MODEL}`,
    `date: ${new Date().toISOString().slice(0, 10)}`,
    `repetitions: ${N}`,
    `machine: ${os.platform()}-${os.arch()}, node ${process.version}`,
    '',
    done
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
  lines.push('| task | vanilla median total | redutok median total | reduction | vanilla success | redutok success |');
  lines.push('| --- | ---: | ---: | ---: | --- | --- |');
  const byTask = new Map();
  for (const m of measurements) byTask.set(m.taskId, [...(byTask.get(m.taskId) ?? []), m]);
  const ratios = [];
  const failures = [];
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
    lines.push(
      `| ${taskId} | ${fmt(mv)} | ${fmt(mr)} | ${ratio.toFixed(1)}x | ${vans.filter((r) => r.success).length}/${vans.length} | ${reds.filter((r) => r.success).length}/${reds.length} |`,
    );
    for (const r of reds) {
      if (!r.success && ratio > 1 && vans.some((v) => v.rep === r.rep && v.success)) {
        failures.push(
          `- ${taskId} rep ${r.rep}: ${ratio.toFixed(1)}x savings but the redutok run failed its success checks (${r.successDetail.join('; ')}). Savings without success are failures.`,
        );
      }
    }
  }
  const medianRatio = median(ratios);
  const vanillaRate = vanillaTotal === 0 ? 0 : vanillaPass / vanillaTotal;
  const redutokRate = redutokTotal === 0 ? 0 : redutokPass / redutokTotal;
  const parity = vanillaRate === 0 ? 1 : redutokRate / vanillaRate;
  const spend = measurements.reduce((n, m) => n + m.costUsd, 0);
  const reported = measurements.reduce((n, m) => n + (m.reportedCostUsd ?? 0), 0);
  lines.push(
    '',
    '## Definition of done',
    '',
    `- median token reduction across tasks: ${medianRatio.toFixed(1)}x (threshold: at least 10x) ${medianRatio >= 10 ? 'MET' : 'NOT MET'}`,
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
  writeFileSync(resultsPath, lines.join('\n'));
  return { medianRatio, parity, spend };
}

// -------------------------------------------------------------------- matrix
const allTasks = loadBenchTasks(path.join(root, 'bench', 'tasks'));
const tasks = ONLY.length > 0 ? allTasks.filter((t) => ONLY.includes(t.id)) : allTasks;
if (tasks.length === 0) throw new Error('no tasks selected');

if (PREP_CHECK) {
  const task = tasks[0];
  for (const variant of ['vanilla', 'redutok']) {
    const workDir = path.join(os.tmpdir(), `redutok-bench-prep-${task.id}-${variant}`);
    copyRepo(task, workDir);
    if (variant === 'vanilla') {
      stripRedutok(workDir);
      const leftovers = ['.mcp.json', '.dcp'].filter((p) => existsSync(path.join(workDir, p)));
      console.log(`prep ${task.id} ${variant}: copy ok, stripped (leftovers: ${leftovers.length === 0 ? 'none' : leftovers.join(',')})`);
    } else {
      const port = initRedutok(workDir);
      const up = await health(port);
      await downRedutok(workDir);
      const downAgain = !(await health(port));
      console.log(`prep ${task.id} ${variant}: init ok, sidecar up on ${port}: ${up}, down again: ${downAgain}`);
    }
    const checks = runChecksLive(task, variant, workDir);
    console.log(`prep ${task.id} ${variant}: pre-run success checks (baseline): ${checks.detail.join('; ')}`);
    removeDir(workDir);
  }
  process.exit(0);
}

const measurements = [];
const notRun = [];
for (const task of tasks) {
  for (let rep = 1; rep <= N; rep += 1) {
    for (const variant of ['vanilla', 'redutok']) {
      const id = `${task.id}-${variant}-${rep}`;
      const transcriptOut = path.join(runsDir, `${id}.jsonl`);
      if (existsSync(transcriptOut)) {
        console.log(`skip ${id}: transcript already captured`);
        const parsed = await parseSessionFile(transcriptOut);
        const ledger = buildLedger(parsed, id);
        const energy = computeSessionEnergy(ledger, factors, grid);
        measurements.push({
          taskId: task.id,
          tier: task.tier,
          variant,
          rep,
          ledger,
          totalTokens: grandTotal(ledger.totals),
          costUsd: computeSessionCost(ledger, prices).totalUsd,
          energy,
          scores: scoreSession(ledger, energy, []),
          wallMs: 0,
          success: true,
          successDetail: ['recovered from existing log; checks not re-run'],
          model: ledger.entries[0]?.model ?? 'unknown',
        });
        continue;
      }
      const workDir = path.join(os.tmpdir(), `redutok-bench-${id}`);
      let port;
      try {
        copyRepo(task, workDir);
        if (variant === 'vanilla') stripRedutok(workDir);
        else port = initRedutok(workDir);
        const streamPath = path.join(runsDir, `${id}.stream.jsonl`);
        console.log(`run ${id} (cwd ${workDir}${port === undefined ? '' : `, sidecar :${port}`})`);
        const run = await runClaude(task.prompt, workDir, streamPath);
        if (run.timedOut) throw new Error(`timed out after ${TIMEOUT_MS / 60000} minutes`);
        if (run.result === undefined) {
          throw new Error(`no result event (exit ${run.code}); stderr: ${run.stderr.slice(0, 300)}`);
        }
        if (run.result.is_error) throw new Error(`claude error result: ${String(run.result.result ?? run.result.subtype).slice(0, 300)}`);
        const transcript = findTranscript(run.result.session_id);
        if (transcript === undefined) throw new Error(`transcript for session ${run.result.session_id} not found`);
        cpSync(transcript, transcriptOut);
        const checks = runChecksLive(task, variant, workDir);
        const parsed = await parseSessionFile(transcriptOut);
        const ledger = buildLedger(parsed, id);
        const energy = computeSessionEnergy(ledger, factors, grid);
        measurements.push({
          taskId: task.id,
          tier: task.tier,
          variant,
          rep,
          ledger,
          totalTokens: grandTotal(ledger.totals),
          costUsd: computeSessionCost(ledger, prices).totalUsd,
          reportedCostUsd: typeof run.result.total_cost_usd === 'number' ? run.result.total_cost_usd : undefined,
          energy,
          scores: scoreSession(ledger, energy, []),
          wallMs: run.wallMs,
          success: checks.passed,
          successDetail: checks.detail,
          model: ledger.entries[0]?.model ?? 'unknown',
        });
        console.log(`  ${id}: ${fmt(grandTotal(ledger.totals))} tokens, success ${checks.passed}`);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`  ${id}: NOT RUN (${reason})`);
        notRun.push({ taskId: task.id, variant, rep, reason });
      } finally {
        if (variant === 'redutok') await downRedutok(workDir);
        removeDir(workDir);
      }
    }
  }
  const { medianRatio, parity, spend } = writeResults(measurements, notRun, false);
  console.log(
    `checkpoint after ${task.id}: ${measurements.length} runs, median reduction ${medianRatio.toFixed(1)}x, parity ${(parity * 100).toFixed(0)}%, cumulative spend ${spend.toFixed(4)} USD`,
  );
}
if (measurements.length > 0 || notRun.length > 0) {
  writeResults(measurements, notRun, true);
  console.log(`final RESULTS.md written (${measurements.length} runs, ${notRun.length} not-run)`);
} else {
  console.log('no runs executed and none recorded; RESULTS.md left untouched');
}
