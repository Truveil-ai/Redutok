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
 *
 * Slope tier (bench/tiers/slope.yaml): its tasks never enter the flat matrix.
 * Both variants run the sequence in order in fresh sessions per task; vanilla
 * starts cold each task, while redutok keeps one persistent copy per
 * repetition whose .dcp state (candidates, codex, mirror) carries forward,
 * with the post-session graduation pass required to complete between tasks.
 * --prep-check additionally asserts that persistence and that a session-end
 * produces a completed graduation pass. Naming any sequence task in --tasks
 * selects the whole sequence.
 */
import { execFileSync } from 'node:child_process';
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

// Build-freshness gate: the h03 incident (4.36M tokens) measured a temp copy
// initialized from a stale dist whose installer still hardcoded the sidecar
// port. The harness now rebuilds unconditionally before importing anything
// from dist, and staleDistPackages re-verifies below; either failing aborts.
console.log('build gate: pnpm -r build (the harness never measures a stale dist)');
// One whole literal command string with shell:true (the same intentional
// single-string form runLiveChecks uses): no args array, so no DEP0190.
execFileSync('pnpm -r build', { cwd: root, stdio: 'inherit', shell: true });

const meter = await import(
  new URL('file:///' + path.join(root, 'packages', 'meter', 'dist', 'index.js').replace(/\\/g, '/')).href
);
const {
  buildLedger,
  buildLivePrompt,
  captureBaselines,
  computeSessionCost,
  computeSessionEnergy,
  countSlopeAttribution,
  extractDcpBlock,
  generateLiveResults,
  grandTotal,
  hasGraduationEvent,
  loadBenchTasks,
  loadSlopeTier,
  parseSessionFile,
  runLiveChecks,
  scoreSession,
  shippedProtocolBlock,
  spawnSafely,
  staleDistPackages,
  transcriptRoot,
} = meter;
{
  const stale = staleDistPackages(root);
  if (stale.length > 0) {
    throw new Error(
      `build gate: dist is still stale after rebuild for: ${stale.join(', ')}. ` +
        'A bench run against a stale build measures the wrong code; fix the build before running.',
    );
  }
  console.log('build gate: all package dists are at least as new as their sources');
}
const mcp = await import(
  new URL('file:///' + path.join(root, 'packages', 'mcp', 'dist', 'index.js').replace(/\\/g, '/')).href
);
const { resolveSidecarPort } = mcp;
const shared = await import(
  new URL(
    'file:///' + path.join(root, 'packages', 'shared', 'dist', 'index.js').replace(/\\/g, '/'),
  ).href
);
const { loadEnergyFactors, loadGridIntensity, loadPrices, readAuditFile } = shared;

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
// Every cli invocation pins REDUTOK_HOME to this checkout, so an operator
// shell exporting the dogfooded main checkout's home can never leak stale
// packages, hooks, or protocol into the temp copy (harness hygiene, h02).
const cliEnv = { ...process.env, REDUTOK_HOME: root };
function initRedutok(workDir) {
  const port = nextPort++;
  execFileSync('node', [cli, 'init', workDir], { cwd: workDir, env: cliEnv });
  const configPath = path.join(workDir, '.dcp', 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.port = port;
  config.profilesDir = path.join(root, 'profiles');
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  execFileSync('node', [cli, 'up'], { cwd: workDir, env: cliEnv });
  execFileSync('node', [cli, 'codex', 'refresh'], { cwd: workDir, env: cliEnv });
  assertPortWiring(workDir, port);
  return port;
}

/**
 * Port-wiring gate, run for every redutok temp copy: the h03 incident's temp
 * copy carried a stale-installer .mcp.json with REDUTOK_PORT=48642, an
 * explicit override that outranks .dcp/config.json and pointed the MCP server
 * at the (dead) dogfood daemon — every dcp read failed open to raw. Asserts
 * the shipped .mcp.json hardcodes no port and that the MCP entry's own
 * resolution (resolveSidecarPort) lands on this copy's configured port.
 */
function assertPortWiring(workDir, port) {
  const mcpJson = JSON.parse(readFileSync(path.join(workDir, '.mcp.json'), 'utf8'));
  const env = mcpJson.mcpServers?.redutok?.env ?? {};
  if (env.REDUTOK_PORT !== undefined) {
    throw new Error(
      `port gate: ${workDir}\\.mcp.json hardcodes REDUTOK_PORT=${env.REDUTOK_PORT}; ` +
        'the installer in dist is stale (pre port-isolation). Rebuild and re-run.',
    );
  }
  const resolved = resolveSidecarPort(env, workDir);
  if (resolved !== port) {
    throw new Error(
      `port gate: MCP resolution yields ${resolved} but this copy's configured sidecar port is ${port}. ` +
        'The temp copy would talk to the wrong daemon.',
    );
  }
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
    execFileSync('node', [cli, 'down'], { cwd: workDir, env: cliEnv });
  } catch {
    // A daemon that already exited is fine; the pidfile is authoritative.
  }
  await waitForDaemonExit(workDir);
}

// ------------------------------------------------------- slope tier helpers
/**
 * The inter-task boundary of a redutok slope sequence. Deliberately minimal:
 * .dcp (candidates, codex, mirror, audit, sqlite) and the working tree carry
 * forward untouched — that persistence is the product claim under test — but
 * the previous task's graded ANSWER.md deliverable must not leak into the
 * next task's grading.
 */
function betweenSlopeTasks(workDir) {
  rmSync(path.join(workDir, 'ANSWER.md'), { force: true });
}

/** POST a session-end notify to a copy's daemon, the same call the
 * SessionEnd hook makes; fires the graduation miner. */
function notifySessionEnd(port, sessionId) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/notify', method: 'POST', timeout: 5000 },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode === 200));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('notify timed out'));
    });
    req.end(JSON.stringify({ kind: 'session-end', sessionId }));
  });
}

/**
 * The graduation gate between slope tasks: mining runs post-session and
 * asynchronously, so the runner must not start the next task (or tear the
 * copy down) until the miner has audited a completed run for this session.
 * Timing out is a hard failure — a sequence without the graduation pass
 * between tasks does not measure the product claim.
 */
async function waitForGraduation(workDir, sessionId, timeoutMs = 90_000) {
  const auditPath = path.join(workDir, '.dcp', 'audit.jsonl');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasGraduationEvent(readAuditFile(auditPath).events, sessionId)) return;
    await sleep(500);
  }
  throw new Error(`graduation pass did not run for session ${sessionId} within ${timeoutMs / 1000}s`);
}

/** Zoom-back and enrichment-serve counts for one session from the copy's
 * audit trail, captured before the copy is torn down. */
function readAttribution(workDir, sessionId) {
  return countSlopeAttribution(readAuditFile(path.join(workDir, '.dcp', 'audit.jsonl')).events, sessionId);
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
    // spawnSafely resolves 'claude' to a directly-executable target and never
    // uses shell:true, so a multi-word prompt arrives at the child intact
    // instead of being word-split by cmd.exe (see packages/meter/src/safe-spawn.ts).
    // REDUTOK_PORT is scrubbed: it is an explicit override that outranks the
    // temp copy's .dcp/config.json, so an operator shell exporting it would
    // point every temp copy's MCP server at the same foreign daemon.
    const claudeEnv = { ...process.env, REDUTOK_HOME: root };
    delete claudeEnv.REDUTOK_PORT;
    const child = spawnSafely('claude', args, {
      cwd: workDir,
      env: claudeEnv,
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

/** Reads the claude CLI's own total_cost_usd from a committed .stream.jsonl
 * capture, the same field the live-run path reads off run.result. Lets a
 * recompute-from-existing-logs pass (the skip branch below) keep the
 * meter-vs-CLI comparison instead of silently dropping it. */
function reportedCostFromStream(streamPath) {
  if (!existsSync(streamPath)) return undefined;
  let content;
  try {
    content = readFileSync(streamPath, 'utf8');
  } catch {
    return undefined;
  }
  for (const line of content.split('\n')) {
    if (line.trim() === '') continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type === 'result' && typeof rec.total_cost_usd === 'number') return rec.total_cost_usd;
  }
  return undefined;
}

// Success-check evaluation (captureBaselines, runLiveChecks) now lives in
// packages/meter/src/bench.ts, tested there; this script only orchestrates
// process spawning and filesystem isolation, which needs a real live claude
// CLI and a real filesystem to exercise meaningfully.

// ----------------------------------------------------------------- reporting
// The report itself (medians, USD and non-cache-read reduction columns, the
// definition-of-done verdict) is generateLiveResults in
// packages/meter/src/bench.ts, tested there; this wrapper just writes it out.
const fmt = (n) => Math.round(n).toLocaleString('en-US');

function writeResults(measurements, notRun, done) {
  const summary = generateLiveResults(measurements, notRun, {
    model: MODEL,
    n: N,
    done,
    ...(slopeSelected ? { slope: slopeTier } : {}),
  });
  writeFileSync(resultsPath, summary.markdown);
  return summary;
}

// -------------------------------------------------------------------- matrix
const allTasks = loadBenchTasks(path.join(root, 'bench', 'tasks'));
const slopeTierPath = path.join(root, 'bench', 'tiers', 'slope.yaml');
const slopeTier = existsSync(slopeTierPath) ? loadSlopeTier(slopeTierPath, allTasks) : undefined;
// Slope tasks never enter the flat matrix: they only mean anything run in
// sequence with carried .dcp state. Naming any of them in --tasks selects
// the whole sequence — it is atomic by construction.
const flatTasks = allTasks.filter((t) => t.tier !== 'slope');
const tasks = ONLY.length > 0 ? flatTasks.filter((t) => ONLY.includes(t.id)) : flatTasks;
const slopeSelected =
  slopeTier !== undefined && (ONLY.length === 0 || ONLY.some((id) => slopeTier.sequence.includes(id)));
const sequenceTasks = slopeSelected
  ? slopeTier.sequence.map((id) => allTasks.find((t) => t.id === id))
  : [];
if (tasks.length === 0 && !slopeSelected) throw new Error('no tasks selected');

if (PREP_CHECK) {
  const task = tasks[0] ?? sequenceTasks[0];
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
      // Harness hygiene (h02): the temp copy must carry the protocol this
      // checkout ships, in both the CLAUDE.md block and the SessionStart
      // injection source, or the bench measures a stale protocol.
      const shipped = shippedProtocolBlock().replace(/\r\n/g, '\n');
      const blockOf = (file) => {
        try {
          return extractDcpBlock(readFileSync(path.join(workDir, file), 'utf8'))?.replace(/\r\n/g, '\n');
        } catch {
          return undefined;
        }
      };
      const claudeOk = blockOf('CLAUDE.md') === shipped;
      const protocolOk = blockOf(path.join('.dcp', 'protocol.md')) === shipped;
      if (!claudeOk || !protocolOk) process.exitCode = 1;
      await downRedutok(workDir);
      const downAgain = !(await health(port));
      console.log(`prep ${task.id} ${variant}: init ok, sidecar up on ${port}: ${up}, down again: ${downAgain}`);
      console.log(
        `prep ${task.id} ${variant}: port gate: .mcp.json hardcodes no REDUTOK_PORT, MCP resolves configured port ${port}: ok`,
      );
      console.log(
        `prep ${task.id} ${variant}: protocol block matches shipped: CLAUDE.md ${claudeOk ? 'ok' : 'STALE'}, .dcp/protocol.md ${protocolOk ? 'ok' : 'STALE'}`,
      );
    }
    const checks = runLiveChecks(task, variant, workDir, captureBaselines(task, workDir));
    console.log(`prep ${task.id} ${variant}: pre-run success checks (baseline): ${checks.detail.join('; ')}`);
    removeDir(workDir);
  }
  if (slopeSelected) {
    // Slope-tier prep: prove the two properties the sequence depends on
    // before any live run — the persistent copy carries .dcp across the
    // inter-task boundary, and a session-end actually produces a completed
    // graduation pass (audit event plus a fresh candidates file).
    const first = sequenceTasks[0];
    const workDir = path.join(os.tmpdir(), `redutok-bench-prep-slope-${slopeTier.id}`);
    copyRepo(first, workDir);
    const port = initRedutok(workDir);
    const up = await health(port);
    const pidOf = () => {
      try {
        return JSON.parse(readFileSync(path.join(workDir, '.dcp', 'sidecar.pid.json'), 'utf8')).pid;
      } catch {
        return undefined;
      }
    };
    const pidBefore = pidOf();
    writeFileSync(path.join(workDir, 'ANSWER.md'), 'previous task deliverable');
    betweenSlopeTasks(workDir);
    const dcpSurvives = ['config.json', 'state.db', 'audit.jsonl'].filter(
      (f) => !existsSync(path.join(workDir, '.dcp', f)),
    );
    const answerGone = !existsSync(path.join(workDir, 'ANSWER.md'));
    const sameDaemon = pidBefore !== undefined && pidOf() === pidBefore && (await health(port));
    const persistOk = up && dcpSurvives.length === 0 && answerGone && sameDaemon;
    if (!persistOk) process.exitCode = 1;
    console.log(
      `prep slope ${slopeTier.id}: persistent copy carries .dcp across the boundary: ${persistOk ? 'ok' : `FAIL (missing: ${dcpSurvives.join(',') || 'none'}, answer removed: ${answerGone}, daemon survived: ${sameDaemon})`}`,
    );
    const before = Date.now();
    let graduationOk = false;
    let graduationDetail = '';
    try {
      await notifySessionEnd(port, 'prep-check-slope');
      await waitForGraduation(workDir, 'prep-check-slope', 30_000);
      const candidates = path.join(workDir, '.dcp', 'candidates.jsonl');
      const fresh = existsSync(candidates) && statSync(candidates).mtimeMs >= before - 1000;
      graduationOk = fresh;
      graduationDetail = fresh
        ? 'audit event present, candidates.jsonl mtime fresh'
        : 'audit event present but candidates.jsonl missing or stale';
    } catch (err) {
      graduationDetail = err instanceof Error ? err.message : String(err);
    }
    if (!graduationOk) process.exitCode = 1;
    console.log(`prep slope ${slopeTier.id}: graduation pass runs on session-end: ${graduationOk ? 'ok' : 'FAIL'} (${graduationDetail})`);
    await downRedutok(workDir);
    removeDir(workDir);
  }
  // An explicit exit(0) would override a failed assertion's exitCode.
  process.exit(process.exitCode ?? 0);
}

const measurements = [];
const notRun = [];

/** One flat-matrix run in a fresh isolated copy: strip or init, one claude
 * session, checks, measurement. Also serves the vanilla side of the slope
 * sequence, which is by design exactly this cold-start path in order. */
async function runSingle(task, variant, rep) {
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
      reportedCostUsd: reportedCostFromStream(path.join(runsDir, `${id}.stream.jsonl`)),
      energy,
      scores: scoreSession(ledger, energy, []),
      wallMs: 0,
      success: true,
      successDetail: ['recovered from existing log; checks not re-run'],
      model: ledger.entries[0]?.model ?? 'unknown',
    });
    return;
  }
  const workDir = path.join(os.tmpdir(), `redutok-bench-${id}`);
  let port;
  try {
    copyRepo(task, workDir);
    if (variant === 'vanilla') stripRedutok(workDir);
    else port = initRedutok(workDir);
    // Baselines are captured after the repo is copied (and, for redutok,
    // after init) but strictly before claude can touch anything, so
    // file-changed checks compare against the true pre-run state.
    const baselines = captureBaselines(task, workDir);
    const streamPath = path.join(runsDir, `${id}.stream.jsonl`);
    console.log(`run ${id} (cwd ${workDir}${port === undefined ? '' : `, sidecar :${port}`})`);
    const run = await runClaude(buildLivePrompt(task), workDir, streamPath);
    if (run.timedOut) throw new Error(`timed out after ${TIMEOUT_MS / 60000} minutes`);
    if (run.result === undefined) {
      throw new Error(`no result event (exit ${run.code}); stderr: ${run.stderr.slice(0, 300)}`);
    }
    if (run.result.is_error) throw new Error(`claude error result: ${String(run.result.result ?? run.result.subtype).slice(0, 300)}`);
    const transcript = findTranscript(run.result.session_id);
    if (transcript === undefined) throw new Error(`transcript for session ${run.result.session_id} not found`);
    cpSync(transcript, transcriptOut);
    const checks = runLiveChecks(task, variant, workDir, baselines);
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

function logCheckpoint(label) {
  const { medianTokenRatio, medianUsdRatio, medianNonCacheReadRatio, parity, spend } = writeResults(
    measurements,
    notRun,
    false,
  );
  console.log(
    `checkpoint after ${label}: ${measurements.length} runs, median token reduction ${medianTokenRatio.toFixed(1)}x (USD ${medianUsdRatio.toFixed(1)}x, non-cache-read ${medianNonCacheReadRatio.toFixed(1)}x), parity ${(parity * 100).toFixed(0)}%, cumulative spend ${spend.toFixed(4)} USD`,
  );
}

for (const task of tasks) {
  for (let rep = 1; rep <= N; rep += 1) {
    for (const variant of ['vanilla', 'redutok']) {
      await runSingle(task, variant, rep);
    }
  }
  logCheckpoint(task.id);
}

/**
 * The redutok side of the slope sequence (bench/tiers/slope.yaml): one
 * persistent copy per repetition. Each task is a fresh claude session, but
 * .dcp state (candidates, codex, mirror, audit, sqlite) carries forward, and
 * the post-session graduation pass must complete before the next task starts
 * — that asymmetry against vanilla's cold starts is the claim under test.
 */
async function runRedutokSequence(rep) {
  const ids = sequenceTasks.map((t) => `${t.id}-redutok-${rep}`);
  const captured = ids.filter((id) => existsSync(path.join(runsDir, `${id}.jsonl`)));
  if (captured.length === ids.length) {
    for (const [index, task] of sequenceTasks.entries()) {
      const id = ids[index];
      console.log(`skip ${id}: transcript already captured (sequence recovery; audit attribution unavailable)`);
      const parsed = await parseSessionFile(path.join(runsDir, `${id}.jsonl`));
      const ledger = buildLedger(parsed, id);
      const energy = computeSessionEnergy(ledger, factors, grid);
      measurements.push({
        taskId: task.id,
        tier: task.tier,
        variant: 'redutok',
        rep,
        ledger,
        totalTokens: grandTotal(ledger.totals),
        costUsd: computeSessionCost(ledger, prices).totalUsd,
        reportedCostUsd: reportedCostFromStream(path.join(runsDir, `${id}.stream.jsonl`)),
        energy,
        scores: scoreSession(ledger, energy, []),
        wallMs: 0,
        success: true,
        successDetail: ['recovered from existing log; checks not re-run'],
        model: ledger.entries[0]?.model ?? 'unknown',
      });
    }
    return;
  }
  if (captured.length > 0) {
    // A partial capture cannot be resumed: the temp copy that held the
    // carried .dcp state is gone, so rerunning only the missing tasks would
    // measure cold starts labeled as warm ones. The whole rep sits out.
    const reason = `sequence rep partially captured (${captured.join(', ')}); clear those files under bench/runs to rerun the whole rep`;
    for (const task of sequenceTasks) notRun.push({ taskId: task.id, variant: 'redutok', rep, reason });
    console.error(`  slope redutok rep ${rep}: NOT RUN (${reason})`);
    return;
  }
  const workDir = path.join(os.tmpdir(), `redutok-bench-slope-${slopeTier.id}-redutok-${rep}`);
  let brokenAt;
  try {
    copyRepo(sequenceTasks[0], workDir);
    const port = initRedutok(workDir);
    for (const task of sequenceTasks) {
      const id = `${task.id}-redutok-${rep}`;
      brokenAt = task.id;
      const transcriptOut = path.join(runsDir, `${id}.jsonl`);
      const baselines = captureBaselines(task, workDir);
      const streamPath = path.join(runsDir, `${id}.stream.jsonl`);
      console.log(`run ${id} (sequence ${slopeTier.id}, cwd ${workDir}, sidecar :${port})`);
      const run = await runClaude(buildLivePrompt(task), workDir, streamPath);
      if (run.timedOut) throw new Error(`timed out after ${TIMEOUT_MS / 60000} minutes`);
      if (run.result === undefined) {
        throw new Error(`no result event (exit ${run.code}); stderr: ${run.stderr.slice(0, 300)}`);
      }
      if (run.result.is_error) throw new Error(`claude error result: ${String(run.result.result ?? run.result.subtype).slice(0, 300)}`);
      const transcript = findTranscript(run.result.session_id);
      if (transcript === undefined) throw new Error(`transcript for session ${run.result.session_id} not found`);
      cpSync(transcript, transcriptOut);
      const checks = runLiveChecks(task, 'redutok', workDir, baselines);
      // The claim needs the pass, not just the carry: block until the miner
      // has audited a completed graduation run for this session.
      await waitForGraduation(workDir, run.result.session_id);
      const attribution = readAttribution(workDir, run.result.session_id);
      const parsed = await parseSessionFile(transcriptOut);
      const ledger = buildLedger(parsed, id);
      const energy = computeSessionEnergy(ledger, factors, grid);
      measurements.push({
        taskId: task.id,
        tier: task.tier,
        variant: 'redutok',
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
        attribution,
      });
      console.log(
        `  ${id}: ${fmt(grandTotal(ledger.totals))} tokens, success ${checks.passed}, zoom-backs ${attribution.zoomBacks}, enrichment serves ${attribution.enrichmentServes}`,
      );
      betweenSlopeTasks(workDir);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // The sequence is atomic: a failure at any position invalidates every
    // task of the rep that has not already been measured.
    for (const task of sequenceTasks) {
      const done = measurements.some((m) => m.taskId === task.id && m.variant === 'redutok' && m.rep === rep);
      if (!done) {
        notRun.push({
          taskId: task.id,
          variant: 'redutok',
          rep,
          reason: task.id === brokenAt ? reason : `sequence rep broken at ${brokenAt}: ${reason}`,
        });
      }
    }
    console.error(`  slope redutok rep ${rep}: NOT RUN from ${brokenAt} (${reason})`);
  } finally {
    await downRedutok(workDir);
    removeDir(workDir);
  }
}

if (slopeSelected) {
  for (let rep = 1; rep <= N; rep += 1) {
    // Both variants run the sequence in order in fresh sessions per task;
    // only redutok carries state between them.
    for (const task of sequenceTasks) await runSingle(task, 'vanilla', rep);
    await runRedutokSequence(rep);
    logCheckpoint(`slope ${slopeTier.id} rep ${rep}`);
  }
}
if (measurements.length > 0 || notRun.length > 0) {
  writeResults(measurements, notRun, true);
  console.log(`final RESULTS.md written (${measurements.length} runs, ${notRun.length} not-run)`);
} else {
  console.log('no runs executed and none recorded; RESULTS.md left untouched');
}
