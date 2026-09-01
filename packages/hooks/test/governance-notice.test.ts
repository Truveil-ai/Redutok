import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SessionPostureRecord } from '@redutok/shared';
import { startDaemon } from '@redutok/sidecar';
import { handleSessionStart, type HookDeps } from '../src/handlers.js';

/**
 * SessionStart says, once, when governance is off.
 *
 * The field failure: a 392-turn session in an external project ran entirely
 * ungoverned because the sidecar had died, leaving a stale pidfile, and
 * nothing surfaced it until doctor was run manually afterwards. Fail-open is
 * still the law — every assertion here also checks the session still opens.
 */

const DEAD_PID = 0x7ffffffe;

function repo(): { root: string; dcpDir: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redutok-notice-'));
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  const dcpDir = path.join(root, '.dcp');
  mkdirSync(dcpDir);
  writeFileSync(path.join(dcpDir, 'protocol.md'), '## Delta Context Protocol (Redutok)\nrules');
  // Pinned full: these tests are about liveness, not the posture rules.
  writeFileSync(path.join(dcpDir, 'config.json'), JSON.stringify({ posture: 'full' }));
  return { root, dcpDir };
}

function writePidfile(dcpDir: string, pid: number, port: number): void {
  writeFileSync(path.join(dcpDir, 'sidecar.pid.json'), JSON.stringify({ pid, port }) + '\n');
}

function record(dcpDir: string): SessionPostureRecord {
  return JSON.parse(
    readFileSync(path.join(dcpDir, 'session-posture.json'), 'utf8'),
  ) as SessionPostureRecord;
}

/** Never restarts: the default for tests that are not about the restart. */
const noRestart = async (): Promise<boolean> => false;

describe('SessionStart surfaces a dead sidecar', () => {
  it('leads the injected context with one line naming the stale pidfile and the remedy', async () => {
    const { dcpDir } = repo();
    writePidfile(dcpDir, DEAD_PID, 1);
    const out = await handleSessionStart(
      { source: 'startup', session_id: 's-stale' },
      { target: { port: 1 }, dcpDir, timeoutMs: 200, restart: noRestart },
    );
    const ctx = out.hookSpecificOutput?.additionalContext ?? '';
    const first = ctx.split('\n')[0] ?? '';
    expect(first).toContain('governance is OFF');
    expect(first).toContain('stale pidfile');
    expect(first).toContain('redutok up');
    // Fail-open holds: the protocol is still injected and the session opens.
    expect(ctx).toContain('Delta Context Protocol');
  });

  it('names the no-pidfile case differently from the crashed case', async () => {
    const { dcpDir } = repo();
    const out = await handleSessionStart(
      { source: 'startup', session_id: 's-none' },
      { target: { port: 1 }, dcpDir, timeoutMs: 200, restart: noRestart },
    );
    const ctx = out.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain('never started');
    expect(ctx).not.toContain('stale pidfile');
  });

  it('says nothing at all when the sidecar is answering for this repo', async () => {
    const { dcpDir } = repo();
    const daemon = await startDaemon({ port: 0, dcpDir });
    try {
      const out = await handleSessionStart(
        { source: 'startup', session_id: 's-live' },
        { target: { port: daemon.port }, dcpDir, timeoutMs: 2000 },
      );
      const ctx = out.hookSpecificOutput?.additionalContext ?? '';
      expect(ctx).not.toContain('governance is OFF');
      expect(ctx.startsWith('## Delta Context Protocol')).toBe(true);
      expect(record(dcpDir).governance?.active).toBe(true);
    } finally {
      await daemon.close();
    }
  });

  it('warns an idle-posture session too: idle is a decision, a dead sidecar is not', async () => {
    // No posture pin and a one-file repo: assesses idle.
    const root = mkdtempSync(path.join(os.tmpdir(), 'redutok-notice-idle-'));
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    const dcpDir = path.join(root, '.dcp');
    mkdirSync(dcpDir);
    writeFileSync(path.join(dcpDir, 'protocol.md'), '## Delta Context Protocol (Redutok)\nrules');
    writePidfile(dcpDir, DEAD_PID, 1);
    const out = await handleSessionStart(
      { source: 'startup', session_id: 's-idle' },
      { target: { port: 1 }, dcpDir, timeoutMs: 200, restart: noRestart },
    );
    const ctx = out.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain('governance is OFF');
    expect(ctx).toContain('idle posture');
    expect(record(dcpDir).posture).toBe('idle');
  });

  it('stays silent in a repo Redutok was never initialised in', async () => {
    const dcpDir = mkdtempSync(path.join(os.tmpdir(), 'redutok-notice-bare-'));
    const out = await handleSessionStart(
      { source: 'startup', session_id: 's-bare' },
      { target: { port: 1 }, dcpDir, timeoutMs: 200, restart: noRestart },
    );
    expect(out).toEqual({});
  });
});

describe('SessionStart records the condition for the receipt', () => {
  it('writes the governance status into the posture record', async () => {
    const { dcpDir } = repo();
    writePidfile(dcpDir, DEAD_PID, 1);
    await handleSessionStart(
      { source: 'startup', session_id: 's-record' },
      { target: { port: 1 }, dcpDir, timeoutMs: 200, restart: noRestart },
    );
    const governance = record(dcpDir).governance;
    expect(governance?.active).toBe(false);
    expect(governance?.condition).toBe('stale-pidfile');
    expect(governance?.detail).toContain(String(DEAD_PID));
  });
});

describe('the single auto-restart on a stale pidfile', () => {
  it('attempts a restart and reports governance active when it comes up', async () => {
    const { dcpDir } = repo();
    writePidfile(dcpDir, DEAD_PID, 1);
    const restart = vi.fn(async () => true);
    const out = await handleSessionStart(
      { source: 'startup', session_id: 's-revived' },
      { target: { port: 1 }, dcpDir, timeoutMs: 200, restart },
    );
    expect(restart).toHaveBeenCalledTimes(1);
    const ctx = out.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain('restarted automatically');
    expect(ctx).not.toContain('governance is OFF');
    const governance = record(dcpDir).governance;
    expect(governance?.active).toBe(true);
    expect(governance?.restart).toBe('succeeded');
  });

  it('reports governance off, and says the attempt failed, when it does not come up', async () => {
    const { dcpDir } = repo();
    writePidfile(dcpDir, DEAD_PID, 1);
    const out = await handleSessionStart(
      { source: 'startup', session_id: 's-failed' },
      { target: { port: 1 }, dcpDir, timeoutMs: 200, restart: noRestart },
    );
    const ctx = out.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain('governance is OFF');
    expect(ctx).toContain('did not come up');
    expect(record(dcpDir).governance?.restart).toBe('failed');
  });

  it('spawns at most one restart per dead sidecar across repeated sessions', async () => {
    const { dcpDir } = repo();
    writePidfile(dcpDir, DEAD_PID, 1);
    const restart = vi.fn(async () => false);
    const deps: HookDeps = { target: { port: 1 }, dcpDir, timeoutMs: 200, restart };
    await handleSessionStart({ source: 'startup', session_id: 's-1' }, deps);
    const second = await handleSessionStart({ source: 'startup', session_id: 's-2' }, deps);
    const third = await handleSessionStart({ source: 'startup', session_id: 's-3' }, deps);
    // A daemon that dies on startup must not be respawned every session.
    expect(restart).toHaveBeenCalledTimes(1);
    expect(second.hookSpecificOutput?.additionalContext).toContain('already attempted once');
    expect(record(dcpDir).governance?.restart).toBe('skipped');
    expect(third.hookSpecificOutput?.additionalContext).toContain('governance is OFF');
  });

  it('never restarts when there is no pidfile: nobody asked for a sidecar here', async () => {
    const { dcpDir } = repo();
    const restart = vi.fn(async () => true);
    await handleSessionStart(
      { source: 'startup', session_id: 's-nopid' },
      { target: { port: 1 }, dcpDir, timeoutMs: 200, restart },
    );
    expect(restart).not.toHaveBeenCalled();
  });

  it('never restarts against a live process that is merely unreachable', async () => {
    const { dcpDir } = repo();
    // This test process is alive, so the condition is unreachable, not stale;
    // spawning a rival is how two daemons end up fighting over one .dcp.
    writePidfile(dcpDir, process.pid, 1);
    const restart = vi.fn(async () => true);
    const out = await handleSessionStart(
      { source: 'startup', session_id: 's-hung' },
      { target: { port: 1 }, dcpDir, timeoutMs: 200, restart },
    );
    expect(restart).not.toHaveBeenCalled();
    expect(out.hookSpecificOutput?.additionalContext).toContain('did not answer');
  });
});
