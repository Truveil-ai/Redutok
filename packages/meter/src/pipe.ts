#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LIMITS } from '@redutok/shared';
import { sidecarRequest, type SidecarTarget } from '@redutok/sidecar/client';

/**
 * redutok-pipe: v3 pillar A, the pipe distiller. Design law: never add a turn,
 * only transform a turn that already exists. A build or test command the model
 * was going to run anyway is wrapped in place (by the PreToolUse rewrite) so it
 * runs through this binary instead of raw. The pipe executes the command,
 * captures its output, distills it through the sidecar's existing /distill
 * profiles and quality gates, retains the raw artifact behind a zoom handle,
 * and emits the distilled verdict plus that handle as its own stdout while
 * preserving the wrapped command's exit code exactly.
 *
 * Fail-open is the law at every stage: a dead sidecar, a gate failure, a
 * timeout, or an unrecognized output class all replay the raw output untouched.
 * The wrapped command's exit code is never altered.
 */

/** Mirrors the MCP dcp__run profile selection (packages/mcp/src/server.ts).
 * verify/check cover the test-or-verify-shaped node scripts the allowlist's
 * node-script rule rewrites (s02 regression): their output is a test verdict,
 * and generic-stdout has no verdict gate for the miner to read. */
export function selectProfile(command: string): string {
  if (/\b(tsc|build)\b/.test(command)) return 'build-log';
  if (/\b(vitest|jest|test|verify|check)\b/.test(command)) return 'test-output';
  return 'generic-stdout';
}

export interface PipeOptions {
  target: SidecarTarget;
  /** Fallback attribution; the sidecar prefers its hook-registered activeId. */
  sessionId?: string;
  /** Repo this pipe runs for; a daemon rooted elsewhere refuses the distill
   * and the refusal fails open to raw output — no handle is ever minted into
   * a store this repo's zoom would then be refused against. */
  repoRoot?: string;
  cwd?: string;
  /** Shell used to run the wrapped command; defaults to the platform shell. */
  shell?: string | boolean;
  timeoutMs?: number;
}

export interface PipeResult {
  served: 'distilled' | 'raw';
  /** The wrapped command's exit code, preserved exactly. */
  exitCode: number;
  /** Raw captured streams, replayed byte-for-byte on the fail-open path. */
  stdout: Buffer;
  stderr: Buffer;
  /** Combined text handed to /distill and retained for zoom. */
  raw: string;
  profile: string;
  distilledText?: string;
  handle?: string;
  artifactId?: string;
}

/**
 * Runs `command`, captures its output, and distills it through the sidecar.
 * Never throws: every failure mode resolves to a `served: 'raw'` result whose
 * captured streams and exit code reproduce a vanilla run.
 */
export async function runPipe(command: string, opts: PipeOptions): Promise<PipeResult> {
  const spawned = spawnSync(command, {
    shell: opts.shell ?? true,
    cwd: opts.cwd,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  const stdout = spawned.stdout ?? Buffer.alloc(0);
  const stderr = spawned.stderr ?? Buffer.alloc(0);
  // A non-zero exit throws no error here (spawnSync reports it in status); a
  // spawn-level failure (command not runnable) has a null status and folds to
  // a conventional 1 so the caller still sees a failure.
  const exitCode = typeof spawned.status === 'number' ? spawned.status : 1;
  const raw = stdout.toString('utf8') + stderr.toString('utf8');
  const profile = selectProfile(command);

  const rawResult: PipeResult = { served: 'raw', exitCode, stdout, stderr, raw, profile };

  const response = await sidecarRequest(
    opts.target,
    'POST',
    '/distill',
    { raw, profile, sessionId: opts.sessionId, tool: 'redutok-pipe', repoRoot: opts.repoRoot },
    { timeoutMs: opts.timeoutMs ?? LIMITS.PIPE_SIDECAR_TIMEOUT_MS },
  );
  if (!response.ok || response.status !== 200) return rawResult;
  const body = response.body as {
    served?: string;
    text?: string;
    handle?: string;
    artifactId?: string;
  };
  // Only a fully distilled outcome replaces the raw output. served==='raw'
  // (a gate failed inside the sidecar) is itself a fail-open signal: emit raw.
  if (body.served === 'distilled' && typeof body.text === 'string' && typeof body.handle === 'string') {
    return {
      ...rawResult,
      served: 'distilled',
      distilledText: body.text,
      handle: body.handle,
      artifactId: body.artifactId,
    };
  }
  return rawResult;
}

/** Port discovery mirrors the hook launcher: config.json, then pidfile wins. */
export function discoverPort(dcpDir: string): number {
  let port = Number(process.env['REDUTOK_PORT'] ?? '48642');
  const configFile = path.join(dcpDir, 'config.json');
  if (existsSync(configFile)) {
    try {
      const config = JSON.parse(readFileSync(configFile, 'utf8')) as { port?: number };
      if (typeof config.port === 'number' && config.port > 0) port = config.port;
    } catch {
      // A bad config must not break the pipe; the pidfile below is authoritative.
    }
  }
  const pidfile = path.join(dcpDir, 'sidecar.pid.json');
  if (existsSync(pidfile)) {
    try {
      port = (JSON.parse(readFileSync(pidfile, 'utf8')) as { port: number }).port;
    } catch {
      // Fall through to the config/default port.
    }
  }
  return port;
}

function parseCommand(argv: string[]): string | undefined {
  for (const flag of ['-c', '--command']) {
    const i = argv.indexOf(flag);
    if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1];
  }
  return undefined;
}

export async function main(argv: string[]): Promise<number> {
  const command = parseCommand(argv);
  if (command === undefined) {
    process.stderr.write('Usage: redutok-pipe -c "<command>"\n');
    return 2;
  }
  const dcpDir = process.env['REDUTOK_DCP_DIR'] ?? path.join(process.cwd(), '.dcp');
  const shellEnv = process.env['REDUTOK_PIPE_SHELL'];
  const result = await runPipe(command, {
    target: { port: discoverPort(dcpDir) },
    sessionId: process.env['REDUTOK_SESSION_ID'],
    repoRoot: path.dirname(path.resolve(dcpDir)),
    cwd: process.cwd(),
    shell: shellEnv !== undefined && shellEnv !== '' ? shellEnv : true,
  });
  if (result.served === 'distilled') {
    process.stdout.write(`${result.distilledText}\n${result.handle}\n`);
  } else {
    if (result.stdout.length > 0) process.stdout.write(result.stdout);
    if (result.stderr.length > 0) process.stderr.write(result.stderr);
  }
  return result.exitCode;
}

// Resolve argv[1] through symlinks: the pnpm bin shim invokes the node_modules
// path while import.meta.url reflects the real workspace path (see cli.ts).
const isDirectRun = ((): boolean => {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
})();
if (isDirectRun) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
