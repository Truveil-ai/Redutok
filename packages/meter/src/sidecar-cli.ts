import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { sameRepoRoot } from '@redutok/shared';
import { sidecarRequest } from '@redutok/sidecar/client';

/** redutok up, down, status: lifecycle commands for the sidecar daemon. */

export interface Pidfile {
  pid: number;
  port: number;
  pipePath?: string;
}

export function dcpDir(cwd: string = process.cwd()): string {
  return path.join(cwd, '.dcp');
}

export interface DcpConfig {
  port?: number;
  profilesDir?: string;
}

/** Per-repo sidecar config written by redutok init; tolerant of absence. */
export function readDcpConfig(dir: string = dcpDir()): DcpConfig {
  const file = path.join(dir, 'config.json');
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as DcpConfig;
  } catch {
    return {};
  }
}

export function readPidfile(dir: string = dcpDir()): Pidfile | undefined {
  const file = path.join(dir, 'sidecar.pid.json');
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Pidfile;
    return typeof parsed.pid === 'number' && typeof parsed.port === 'number' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** True when the health answer comes from this repo's own daemon. A body
 * without repoRoot is a pre-0.1.2 daemon and is trusted (legacy). */
function ownDaemon(dir: string, body: { repoRoot?: unknown }): boolean {
  if (typeof body.repoRoot !== 'string' || body.repoRoot === '') return true;
  return sameRepoRoot(body.repoRoot, path.dirname(path.resolve(dir)));
}

export async function sidecarStatus(dir: string = dcpDir()): Promise<string> {
  const pidfile = readPidfile(dir);
  if (pidfile === undefined) return 'Sidecar: not running (no pidfile).';
  const res = await sidecarRequest({ port: pidfile.port }, 'GET', '/health', undefined, {
    timeoutMs: 1500,
  });
  if (!res.ok) {
    return `Sidecar: not responding on port ${pidfile.port} (stale pidfile for pid ${pidfile.pid}). Run redutok up.`;
  }
  const body = res.body as { pid: number; uptimeMs: number; repoRoot?: string };
  if (!ownDaemon(dir, body)) {
    return `Sidecar: port ${pidfile.port} is held by a daemon serving a different repo (${body.repoRoot ?? 'unknown'}). Run redutok up to start this repo's own.`;
  }
  return `Sidecar: running, pid ${body.pid}, port ${pidfile.port}, uptime ${Math.round(body.uptimeMs / 1000)}s.`;
}

export async function sidecarUp(dir: string = dcpDir()): Promise<string> {
  const existing = readPidfile(dir);
  if (existing !== undefined) {
    const res = await sidecarRequest({ port: existing.port }, 'GET', '/health', undefined, {
      timeoutMs: 1000,
    });
    // Identity, not just liveness: a stale pidfile can point at a port now
    // held by another repo's daemon (every 0.1.1 install shared one default
    // port). That daemon answering healthy is not this repo running.
    if (res.ok && res.status === 200 && ownDaemon(dir, res.body as { repoRoot?: unknown })) {
      return `Sidecar already running on port ${existing.port}.`;
    }
  }
  mkdirSync(dir, { recursive: true });
  const config = readDcpConfig(dir);
  const require = createRequire(import.meta.url);
  // redutok/daemon-main: @redutok/sidecar is private and inlined into this
  // package's dist/, so the daemon is spawned from the bundled entry point.
  const entry = require.resolve('redutok/daemon-main');
  const env: Record<string, string | undefined> = {
    ...process.env,
    REDUTOK_DCP_DIR: dir,
    REDUTOK_PORT: String(config.port ?? 0),
  };
  if (config.profilesDir !== undefined) env['REDUTOK_PROFILES'] = config.profilesDir;
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: 'ignore',
    env,
  });
  child.unref();
  for (let i = 0; i < 50; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    const pidfile = readPidfile(dir);
    if (pidfile !== undefined) {
      const res = await sidecarRequest({ port: pidfile.port }, 'GET', '/health', undefined, {
        timeoutMs: 1000,
      });
      // The stale pidfile may keep answering (it can point at a foreign
      // daemon) until the spawned daemon overwrites it; only this repo's own
      // health counts as started.
      if (res.ok && res.status === 200 && ownDaemon(dir, res.body as { repoRoot?: unknown })) {
        return `Sidecar started, pid ${pidfile.pid}, port ${pidfile.port}.`;
      }
    }
  }
  return 'Sidecar did not become healthy within 5s. Check .dcp/sidecar.log.jsonl.';
}

export async function sidecarDown(dir: string = dcpDir()): Promise<string> {
  const pidfile = readPidfile(dir);
  if (pidfile === undefined) return 'Sidecar: not running (no pidfile).';
  const res = await sidecarRequest({ port: pidfile.port }, 'POST', '/shutdown', undefined, {
    timeoutMs: 2000,
  });
  if (!res.ok) {
    try {
      process.kill(pidfile.pid);
      return `Sidecar was unresponsive; sent kill to pid ${pidfile.pid}.`;
    } catch {
      return `Sidecar not responding and pid ${pidfile.pid} not found; treating as stopped.`;
    }
  }
  return `Sidecar on port ${pidfile.port} asked to shut down.`;
}
