import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '@redutok/shared';
import { startDaemon } from '@redutok/sidecar';
import { handleSessionEnd, type HookDeps } from '../src/handlers.js';

/**
 * Contract test for the session-end seam, both real components: the payload
 * handleSessionEnd actually sends, against the daemon handler that actually
 * reads it. The 0.1.1 field install showed graduation mining receiving
 * nothing — the notify landed on a foreign repo's daemon — so this pins the
 * whole path: hook fires, daemon reads the same field names, and the miner
 * runs attributed to the ended session's id. The assertions read the audit
 * trail the miner itself writes, not a mock.
 */

const monorepoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const profilesDir = path.join(monorepoRoot, 'profiles');

function repo(prefix: string): { root: string; dcpDir: string } {
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

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}

describe('session-end notify contract, hook payload against daemon handler', () => {
  it('the miner runs for exactly the session the hook named', async () => {
    const { dcpDir } = repo('redutok-sec-own-');
    const daemon = await startDaemon({ port: 0, dcpDir, profilesDir });
    try {
      const deps: HookDeps = { target: { port: daemon.port }, dcpDir, timeoutMs: 2000 };
      const out = await handleSessionEnd({ session_id: 's-contract-end' }, deps);
      expect(out).toEqual({});
      const summarize = await waitFor(() =>
        auditEvents(dcpDir).some(
          (e) =>
            e.module === 'sidecar.graduation' &&
            e.action === 'summarize' &&
            e.sessionId === 's-contract-end',
        ),
      );
      expect(summarize, 'graduation must mine the session id the hook sent').toBe(true);
    } finally {
      await daemon.close();
    }
  });

  it('a hook whose repo is not the daemon\'s reaches no miner at all', async () => {
    const { dcpDir: foreignDcp } = repo('redutok-sec-foreign-');
    const own = repo('redutok-sec-caller-');
    const daemon = await startDaemon({ port: 0, dcpDir: foreignDcp, profilesDir });
    try {
      // The hook runs for `own` but, through the shared-port default, its
      // notify reaches the foreign daemon. Fail-open on the hook side, a 403
      // on the daemon side, and no mining anywhere.
      const deps: HookDeps = { target: { port: daemon.port }, dcpDir: own.dcpDir, timeoutMs: 2000 };
      const out = await handleSessionEnd({ session_id: 's-misdirected' }, deps);
      expect(out).toEqual({});
      await new Promise((r) => setTimeout(r, 300));
      expect(auditEvents(foreignDcp).some((e) => e.module === 'sidecar.graduation')).toBe(false);
      expect(existsSync(path.join(foreignDcp, 'candidates.jsonl'))).toBe(false);
    } finally {
      await daemon.close();
    }
  });
});
