import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
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

export async function sidecarStatus(dir: string = dcpDir()): Promise<string> {
  const pidfile = readPidfile(dir);
  if (pidfile === undefined) return 'Sidecar: not running (no pidfile).';
  const res = await sidecarRequest({ port: pidfile.port }, 'GET', '/health', undefined, {
    timeoutMs: 1500,
  });
  if (!res.ok) {
    return `Sidecar: not responding on port ${pidfile.port} (stale pidfile for pid ${pidfile.pid}). Run redutok up.`;
  }
  const body = res.body as { pid: number; uptimeMs: number };
  return `Sidecar: running, pid ${body.pid}, port ${pidfile.port}, uptime ${Math.round(body.uptimeMs / 1000)}s.`;
}

export async function sidecarUp(dir: string = dcpDir()): Promise<string> {
  const existing = readPidfile(dir);
  if (existing !== undefined) {
    const res = await sidecarRequest({ port: existing.port }, 'GET', '/health', undefined, {
      timeoutMs: 1000,
    });
    if (res.ok) return `Sidecar already running on port ${existing.port}.`;
  }
  mkdirSync(dir, { recursive: true });
  const require = createRequire(import.meta.url);
  const entry = require.resolve('@redutok/sidecar/daemon-main');
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, REDUTOK_DCP_DIR: dir, REDUTOK_PORT: '0' },
  });
  child.unref();
  for (let i = 0; i < 50; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    const pidfile = readPidfile(dir);
    if (pidfile !== undefined) {
      const res = await sidecarRequest({ port: pidfile.port }, 'GET', '/health', undefined, {
        timeoutMs: 1000,
      });
      if (res.ok) return `Sidecar started, pid ${pidfile.pid}, port ${pidfile.port}.`;
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
