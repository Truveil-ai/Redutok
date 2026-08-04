import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '@redutok/shared';
import { sidecarRequest } from '../src/client.js';
import { startDaemon } from '../src/daemon.js';

/**
 * The repo-identity contract, from the 0.1.1 field install: every packaged
 * repo wrote the same sidecar port, so the first daemon up served every repo
 * on the machine. /serve-file and /zoom already refused cross-repo callers,
 * but /distill minted handles the caller could never zoom, and /notify let a
 * foreign repo's hooks steal session attribution and swallow session-end —
 * the field audit trail of one repo held another repo's distill events.
 * These tests pin the closed contract: identity is reported on /health and
 * enforced on every governed endpoint, and a busy port never blocks a repo
 * from getting its own daemon.
 */

const monorepoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const profilesDir = path.join(monorepoRoot, 'profiles');

function tmpRepo(prefix: string): { root: string; dcpDir: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  const dcpDir = path.join(root, '.dcp');
  mkdirSync(dcpDir);
  return { root, dcpDir };
}

function auditEvents(dcpDir: string): AuditEvent[] {
  const file = path.join(dcpDir, 'audit.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as AuditEvent);
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}

const BIG_RAW = 'line of build output that repeats\n'.repeat(400);

describe('repo identity on the daemon', () => {
  it('/health reports the repo the daemon serves', async () => {
    const { root, dcpDir } = tmpRepo('redutok-ident-health-');
    const daemon = await startDaemon({ port: 0, dcpDir, profilesDir });
    try {
      const res = await sidecarRequest({ port: daemon.port }, 'GET', '/health');
      expect(res.ok && res.status === 200).toBe(true);
      const body = (res.ok ? res.body : {}) as { repoRoot?: string };
      expect(path.resolve(body.repoRoot ?? '')).toBe(path.resolve(root));
    } finally {
      await daemon.close();
    }
  });

  it('/distill from a foreign repo is refused and mints no handle', async () => {
    const { dcpDir } = tmpRepo('redutok-ident-distill-');
    const foreign = tmpRepo('redutok-ident-foreign-');
    const daemon = await startDaemon({ port: 0, dcpDir, profilesDir });
    try {
      const res = await sidecarRequest({ port: daemon.port }, 'POST', '/distill', {
        raw: BIG_RAW,
        profile: 'generic-stdout',
        sessionId: 's-foreign',
        repoRoot: foreign.root,
      });
      expect(res.ok).toBe(true);
      expect(res.ok && res.status).toBe(403);
      const events = auditEvents(dcpDir);
      expect(events.some((e) => e.action === 'refuse' && e.details?.['path'] === '/distill')).toBe(true);
      expect(events.some((e) => e.action === 'distill' || e.action === 'serve-raw')).toBe(false);
    } finally {
      await daemon.close();
    }
  });

  it('/distill from the daemon\'s own repo still serves', async () => {
    const { root, dcpDir } = tmpRepo('redutok-ident-own-');
    const daemon = await startDaemon({ port: 0, dcpDir, profilesDir });
    try {
      const res = await sidecarRequest({ port: daemon.port }, 'POST', '/distill', {
        raw: BIG_RAW,
        profile: 'generic-stdout',
        sessionId: 's-own',
        repoRoot: root,
      });
      expect(res.ok && res.status === 200).toBe(true);
    } finally {
      await daemon.close();
    }
  });

  it('/notify from a foreign repo is refused: no attribution steal, no session-end mining', async () => {
    const { dcpDir } = tmpRepo('redutok-ident-notify-');
    const foreign = tmpRepo('redutok-ident-notify-foreign-');
    // A prior distill-shaped event so a mining run, if one fired, would have
    // something to summarize into candidates.jsonl.
    writeFileSync(
      path.join(dcpDir, 'audit.jsonl'),
      JSON.stringify({
        id: 'f1',
        timestamp: '2026-08-03T12:00:00.000Z',
        sessionId: 's-foreign-end',
        module: 'sidecar.distill',
        action: 'distill',
        reason: 'profile build-log served',
        inputRef: 'f1',
        details: {
          profile: 'build-log',
          gates: [{ gate: 'verdict-fidelity', passed: true, detail: 'verdict fail agreed by both extractions and the distillate' }],
        },
      }) + '\n',
    );
    const daemon = await startDaemon({ port: 0, dcpDir, profilesDir });
    try {
      const register = await sidecarRequest({ port: daemon.port }, 'POST', '/notify', {
        kind: 'session-start',
        sessionId: 's-foreign-active',
        repoRoot: foreign.root,
      });
      expect(register.ok && register.status).toBe(403);
      const health = await sidecarRequest({ port: daemon.port }, 'GET', '/health');
      expect((health.ok ? (health.body as { activeSessionId: string | null }) : { activeSessionId: 'x' }).activeSessionId).toBeNull();

      const ended = await sidecarRequest({ port: daemon.port }, 'POST', '/notify', {
        kind: 'session-end',
        sessionId: 's-foreign-end',
        repoRoot: foreign.root,
      });
      expect(ended.ok && ended.status).toBe(403);
      await new Promise((r) => setTimeout(r, 300));
      expect(existsSync(path.join(dcpDir, 'candidates.jsonl'))).toBe(false);
      expect(auditEvents(dcpDir).some((e) => e.module === 'sidecar.graduation')).toBe(false);
    } finally {
      await daemon.close();
    }
  });

  it('a same-root session-end still fires the miner, and a legacy notify without repoRoot is accepted', async () => {
    const { root, dcpDir } = tmpRepo('redutok-ident-legacy-');
    const daemon = await startDaemon({ port: 0, dcpDir, profilesDir });
    try {
      // Legacy 0.1.1 launchers send no repoRoot: fail-open, never refused.
      const legacy = await sidecarRequest({ port: daemon.port }, 'POST', '/notify', {
        kind: 'session-start',
        sessionId: 's-legacy',
      });
      expect(legacy.ok && legacy.status).toBe(200);

      const ended = await sidecarRequest({ port: daemon.port }, 'POST', '/notify', {
        kind: 'session-end',
        sessionId: 's-legacy',
        repoRoot: root,
      });
      expect(ended.ok && ended.status).toBe(200);
      // The miner audits every run, even an empty one, under sidecar.graduation.
      expect(
        await waitFor(() => auditEvents(dcpDir).some((e) => e.module === 'sidecar.graduation')),
      ).toBe(true);
    } finally {
      await daemon.close();
    }
  });

  it('/explore from a foreign repo is refused', async () => {
    const { dcpDir } = tmpRepo('redutok-ident-explore-');
    const foreign = tmpRepo('redutok-ident-explore-foreign-');
    const daemon = await startDaemon({ port: 0, dcpDir, profilesDir });
    try {
      const res = await sidecarRequest(
        { port: daemon.port },
        'POST',
        '/explore',
        { goal: 'anything', sessionId: 's-x', repoRoot: foreign.root },
        { timeoutMs: 5000 },
      );
      expect(res.ok && res.status).toBe(403);
    } finally {
      await daemon.close();
    }
  });

  it('a busy configured port falls back to an ephemeral port instead of failing', async () => {
    const first = tmpRepo('redutok-ident-porta-');
    const second = tmpRepo('redutok-ident-portb-');
    const daemonA = await startDaemon({ port: 0, dcpDir: first.dcpDir, profilesDir });
    try {
      // The field shape: repo B's config pins the port repo A's daemon holds.
      const daemonB = await startDaemon({ port: daemonA.port, dcpDir: second.dcpDir, profilesDir });
      try {
        expect(daemonB.port).not.toBe(daemonA.port);
        const pidfile = JSON.parse(
          readFileSync(path.join(second.dcpDir, 'sidecar.pid.json'), 'utf8'),
        ) as { port: number };
        expect(pidfile.port).toBe(daemonB.port);
        const health = await sidecarRequest({ port: daemonB.port }, 'GET', '/health');
        expect(path.resolve((health.ok ? (health.body as { repoRoot?: string }) : {}).repoRoot ?? '')).toBe(
          path.resolve(second.root),
        );
      } finally {
        await daemonB.close();
      }
    } finally {
      await daemonA.close();
    }
  });
});
