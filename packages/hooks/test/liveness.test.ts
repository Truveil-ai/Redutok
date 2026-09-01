import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { governanceNotice, governanceReceiptReason } from '@redutok/shared';
import { startDaemon } from '@redutok/sidecar';
import { assessGovernance, claimRestartAttempt } from '../src/liveness.js';

/**
 * Stale-pidfile detection and the words it produces. The field failure this
 * guards: a 392-turn session ran entirely ungoverned because the sidecar had
 * died and left its pidfile behind, and nothing surfaced it until doctor was
 * run manually afterwards.
 */

function repoWithDcp(): { root: string; dcpDir: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redutok-liveness-'));
  const dcpDir = path.join(root, '.dcp');
  mkdirSync(dcpDir);
  return { root, dcpDir };
}

function writePidfile(dcpDir: string, pid: number, port: number): void {
  writeFileSync(path.join(dcpDir, 'sidecar.pid.json'), JSON.stringify({ pid, port }) + '\n');
}

/** A pid that is certain not to be running: allocated, then reaped. */
const DEAD_PID = 0x7ffffffe;

describe('assessGovernance', () => {
  it('reports no-pidfile when the sidecar was never started for this repo', async () => {
    const { dcpDir } = repoWithDcp();
    const status = await assessGovernance({ target: { port: 1 }, dcpDir, timeoutMs: 200 });
    expect(status.condition).toBe('no-pidfile');
    expect(status.active).toBe(false);
    expect(status.detail).toContain('never started');
  });

  it('reports stale-pidfile when the pidfile names a pid that no longer exists', async () => {
    const { dcpDir } = repoWithDcp();
    writePidfile(dcpDir, DEAD_PID, 1);
    const status = await assessGovernance({ target: { port: 1 }, dcpDir, timeoutMs: 200 });
    expect(status.condition).toBe('stale-pidfile');
    expect(status.active).toBe(false);
    expect(status.detail).toContain(String(DEAD_PID));
  });

  it('reports unreachable when the pid is alive but nothing answers on its port', async () => {
    const { dcpDir } = repoWithDcp();
    // This test process is alive by definition, so the pid check passes and
    // only the health probe fails: hung daemon, not a dead one.
    writePidfile(dcpDir, process.pid, 1);
    const status = await assessGovernance({ target: { port: 1 }, dcpDir, timeoutMs: 200 });
    expect(status.condition).toBe('unreachable');
    expect(status.active).toBe(false);
  });

  it('reports ok when this repo’s own daemon answers', async () => {
    const { dcpDir } = repoWithDcp();
    const daemon = await startDaemon({ port: 0, dcpDir });
    try {
      const status = await assessGovernance({
        target: { port: daemon.port },
        dcpDir,
        timeoutMs: 2000,
      });
      expect(status.condition).toBe('ok');
      expect(status.active).toBe(true);
    } finally {
      await daemon.close();
    }
  });

  it('reports foreign-daemon when a healthy daemon is serving a different repo', async () => {
    // One daemon, two repos: the second repo's pidfile points at the first
    // repo's live port, which is exactly the 0.1.1 shared-default-port shape.
    const owner = repoWithDcp();
    const other = repoWithDcp();
    const daemon = await startDaemon({ port: 0, dcpDir: owner.dcpDir });
    try {
      writePidfile(other.dcpDir, process.pid, daemon.port);
      const status = await assessGovernance({
        target: { port: daemon.port },
        dcpDir: other.dcpDir,
        timeoutMs: 2000,
      });
      expect(status.condition).toBe('foreign-daemon');
      expect(status.active).toBe(false);
    } finally {
      await daemon.close();
    }
  });
});

describe('claimRestartAttempt', () => {
  it('claims once for a given stale pidfile and refuses every retry', () => {
    const { dcpDir } = repoWithDcp();
    const stale = { pid: DEAD_PID, port: 48642 };
    expect(claimRestartAttempt(dcpDir, stale)).toBe(true);
    // Idempotent: a session that reopens against the same corpse does not
    // spawn a second daemon, and a daemon that dies at startup cannot loop.
    expect(claimRestartAttempt(dcpDir, stale)).toBe(false);
    expect(claimRestartAttempt(dcpDir, stale)).toBe(false);
  });

  it('claims again once the stale pidfile names a different process', () => {
    const { dcpDir } = repoWithDcp();
    expect(claimRestartAttempt(dcpDir, { pid: DEAD_PID, port: 48642 })).toBe(true);
    // A different corpse is a different failure and earns its own attempt.
    expect(claimRestartAttempt(dcpDir, { pid: DEAD_PID - 1, port: 48642 })).toBe(true);
    expect(claimRestartAttempt(dcpDir, { pid: DEAD_PID - 1, port: 48642 })).toBe(false);
  });

  it('records the claim on disk without disturbing the pidfile', () => {
    const { dcpDir } = repoWithDcp();
    writePidfile(dcpDir, DEAD_PID, 48642);
    claimRestartAttempt(dcpDir, { pid: DEAD_PID, port: 48642 });
    const marker = JSON.parse(
      readFileSync(path.join(dcpDir, 'sidecar-restart.json'), 'utf8'),
    ) as { pid: number; port: number; attemptedAt: string };
    expect(marker.pid).toBe(DEAD_PID);
    expect(marker.port).toBe(48642);
    expect(Date.parse(marker.attemptedAt)).not.toBeNaN();
    const pidfile = JSON.parse(
      readFileSync(path.join(dcpDir, 'sidecar.pid.json'), 'utf8'),
    ) as { pid: number };
    expect(pidfile.pid).toBe(DEAD_PID);
  });

  it('claims rather than throwing when the marker file is corrupt', () => {
    const { dcpDir } = repoWithDcp();
    writeFileSync(path.join(dcpDir, 'sidecar-restart.json'), 'not json');
    expect(claimRestartAttempt(dcpDir, { pid: DEAD_PID, port: 48642 })).toBe(true);
  });
});

describe('the words the condition produces', () => {
  it('says governance is off, why, and how to restart it', () => {
    const notice = governanceNotice({
      condition: 'stale-pidfile',
      active: false,
      detail: 'the sidecar died and left a stale pidfile behind (pid 4242 no longer exists)',
    });
    expect(notice).toContain('governance is OFF');
    expect(notice).toContain('stale pidfile');
    expect(notice).toContain('redutok up');
  });

  it('stays silent on a healthy session so a working session pays no tokens', () => {
    expect(
      governanceNotice({ condition: 'ok', active: true, detail: 'the sidecar is running on port 5' }),
    ).toBeUndefined();
  });

  it('still speaks once when an auto-restart revived a dead sidecar', () => {
    const notice = governanceNotice({
      condition: 'stale-pidfile',
      active: true,
      detail: 'the sidecar died and left a stale pidfile behind (pid 4242 no longer exists)',
      restart: 'succeeded',
    });
    expect(notice).toContain('restarted automatically');
    expect(notice).not.toContain('governance is OFF');
  });

  it('names a failed and a skipped restart attempt in the off notice', () => {
    const base = { condition: 'stale-pidfile' as const, active: false, detail: 'the sidecar died' };
    expect(governanceNotice({ ...base, restart: 'failed' })).toContain('did not come up');
    expect(governanceNotice({ ...base, restart: 'skipped' })).toContain('already attempted once');
  });

  it('gives the receipt a reason only when governance was actually off', () => {
    expect(
      governanceReceiptReason({ condition: 'no-pidfile', active: false, detail: 'never started' }),
    ).toContain('governance was off for the whole session');
    expect(
      governanceReceiptReason({ condition: 'ok', active: true, detail: 'running' }),
    ).toBeUndefined();
  });
});
