import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  describeCondition,
  LIMITS,
  sameRepoRoot,
  type GovernanceCondition,
  type GovernanceStatus,
} from '@redutok/shared';
import { sidecarRequest, type SidecarTarget } from '@redutok/sidecar/client';

/**
 * Is governance actually engaged? Fail-open keeps a dead sidecar from
 * breaking a session; this module keeps a dead sidecar from being invisible.
 * It classifies the condition once, at SessionStart, and offers one bounded
 * auto-restart for the single condition that is unambiguously a crash: a
 * pidfile whose process is gone.
 */

export interface LivenessDeps {
  target: SidecarTarget;
  dcpDir: string;
  /** Sidecar probe budget; defaults to the 50ms fail-open limit. */
  timeoutMs?: number;
}

export interface SidecarPidfile {
  pid: number;
  port: number;
}

/** The repo these hooks govern: the parent of the .dcp state directory. */
function repoRootOf(dcpDir: string): string {
  return path.dirname(path.resolve(dcpDir));
}

export function readSidecarPidfile(dcpDir: string): SidecarPidfile | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(path.join(dcpDir, 'sidecar.pid.json'), 'utf8'),
    ) as SidecarPidfile;
    return typeof parsed.pid === 'number' && typeof parsed.port === 'number' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Signal 0 asks the OS whether the pid exists without touching it. EPERM
 * means it exists and belongs to someone else, which is still alive: only
 * ESRCH (and a nonsense pid) is a corpse.
 */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

interface Probe {
  healthy: boolean;
  /** The repo root the answering daemon says it serves, when it says one. */
  foreignRoot?: string;
}

/** One /health probe, resolved against this repo's identity. A daemon that
 * answers for another repo is not this repo's governance (the 0.1.1 field
 * install shared one default port across every repo on the machine). */
async function probeOwnDaemon(
  target: SidecarTarget,
  dcpDir: string,
  timeoutMs: number,
): Promise<Probe> {
  const res = await sidecarRequest(target, 'GET', '/health', undefined, { timeoutMs });
  if (!res.ok || res.status !== 200) return { healthy: false };
  const root = (res.body as { repoRoot?: unknown }).repoRoot;
  // A body without repoRoot is a pre-0.1.2 daemon and is trusted (legacy).
  if (typeof root !== 'string' || root === '') return { healthy: true };
  if (sameRepoRoot(root, repoRootOf(dcpDir))) return { healthy: true };
  return { healthy: false, foreignRoot: root };
}

function status(condition: GovernanceCondition, facts: Parameters<typeof describeCondition>[1]): GovernanceStatus {
  return { condition, active: condition === 'ok', detail: describeCondition(condition, facts) };
}

/**
 * Classifies whether governance is engaged for this session. Never throws:
 * an assessment that cannot be made reports the condition it observed, and
 * the caller's behaviour is unchanged either way — this decides what is
 * *said*, never what is allowed.
 */
export async function assessGovernance(deps: LivenessDeps): Promise<GovernanceStatus> {
  try {
    const pidfile = readSidecarPidfile(deps.dcpDir);
    // The pidfile is authoritative for the port; deps.target only carries a
    // default when there is no pidfile to read one from.
    const port = pidfile?.port ?? deps.target.port;
    const probe = await probeOwnDaemon(
      { ...deps.target, port },
      deps.dcpDir,
      deps.timeoutMs ?? LIMITS.HOOK_FAIL_OPEN_MS,
    );
    const facts = { pid: pidfile?.pid, port, foreignRoot: probe.foreignRoot };
    if (probe.healthy) return status('ok', facts);
    if (probe.foreignRoot !== undefined) return status('foreign-daemon', facts);
    if (pidfile === undefined) return status('no-pidfile', facts);
    return status(pidAlive(pidfile.pid) ? 'unreachable' : 'stale-pidfile', facts);
  } catch {
    // An unclassifiable failure is still a failure to reach the sidecar, and
    // the notice has to err toward telling the user governance may be off.
    return status('no-pidfile', {});
  }
}

const RESTART_MARKER = 'sidecar-restart.json';

/**
 * Claims the one auto-restart allowed for this particular dead sidecar,
 * returning false when it has already been claimed. Keying the marker on the
 * dead (pid, port) is what makes the restart idempotent: reopening a session
 * against the same corpse spawns nothing, and a daemon that dies during
 * startup cannot drive a restart loop, while a genuinely new crash later in
 * the day still earns its own single attempt.
 */
export function claimRestartAttempt(dcpDir: string, pidfile: SidecarPidfile): boolean {
  const marker = path.join(dcpDir, RESTART_MARKER);
  try {
    const prior = JSON.parse(readFileSync(marker, 'utf8')) as Partial<SidecarPidfile>;
    if (prior.pid === pidfile.pid && prior.port === pidfile.port) return false;
  } catch {
    // No marker, or an unreadable one: this attempt is unclaimed.
  }
  try {
    writeFileSync(
      marker,
      JSON.stringify({ ...pidfile, attemptedAt: new Date().toISOString() }) + '\n',
    );
  } catch {
    // An unwritable .dcp cannot record the claim. Refuse the attempt rather
    // than spawn one that would repeat on every session.
    return false;
  }
  return true;
}

/** The sidecar's own config, for the port and profiles a restart must reuse. */
function readPort(dcpDir: string): { port: number; profilesDir?: string } {
  try {
    const config = JSON.parse(readFileSync(path.join(dcpDir, 'config.json'), 'utf8')) as {
      port?: number;
      profilesDir?: string;
    };
    return { port: typeof config.port === 'number' ? config.port : 0, profilesDir: config.profilesDir };
  } catch {
    // No config: 0 asks the daemon for an ephemeral port, as redutok up does.
    return { port: 0 };
  }
}

/**
 * Spawns the daemon exactly as `redutok up` does and waits, bounded, for it
 * to answer for this repo. Returns false on any failure; the caller then
 * reports governance off, which is what the session actually gets.
 */
export async function restartSidecar(dcpDir: string): Promise<boolean> {
  try {
    const config = readPort(dcpDir);
    const require = createRequire(import.meta.url);
    // @redutok/sidecar is private and inlined into the published package's
    // dist/, so the daemon is spawned from that bundled entry point.
    const entry = require.resolve('redutok/daemon-main');
    const env: Record<string, string | undefined> = {
      ...process.env,
      REDUTOK_DCP_DIR: dcpDir,
      REDUTOK_PORT: String(config.port),
    };
    if (config.profilesDir !== undefined) env['REDUTOK_PROFILES'] = config.profilesDir;
    const child = spawn(process.execPath, [entry], { detached: true, stdio: 'ignore', env });
    child.unref();
    const deadline = Date.now() + LIMITS.SIDECAR_AUTOSTART_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      const pidfile = readSidecarPidfile(dcpDir);
      // The stale pidfile keeps answering nothing until the spawned daemon
      // overwrites it, so only a fresh pid that is alive is worth probing.
      if (pidfile === undefined || !pidAlive(pidfile.pid)) continue;
      const probe = await probeOwnDaemon({ port: pidfile.port }, dcpDir, 500);
      if (probe.healthy) return true;
    }
    return false;
  } catch {
    return false;
  }
}
