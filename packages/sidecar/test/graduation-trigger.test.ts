import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readCandidatesFile, type AuditEvent } from '@redutok/shared';
import { sidecarRequest } from '../src/client.js';
import { startDaemon } from '../src/daemon.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const profilesDir = path.join(repoRoot, 'profiles');
const tmpDcp = (): string => mkdtempSync(path.join(os.tmpdir(), 'redutok-gradtrig-'));

function verdictEvent(id: string, minute: number, verdict: 'pass' | 'fail'): AuditEvent {
  return {
    id,
    timestamp: new Date(Date.UTC(2026, 6, 19, 12, minute)).toISOString(),
    sessionId: 's-ended',
    module: 'sidecar.distill',
    action: 'distill',
    reason: 'profile build-log served',
    inputRef: id,
    details: {
      profile: 'build-log',
      gates: [
        {
          gate: 'verdict-fidelity',
          passed: true,
          detail: `verdict ${verdict} agreed by both extractions and the distillate`,
        },
      ],
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}

describe('session-end notify triggers the graduation miner', () => {
  it('mines the ended session asynchronously and audits the run', async () => {
    const dcpDir = tmpDcp();
    writeFileSync(
      path.join(dcpDir, 'audit.jsonl'),
      [verdictEvent('f1', 0, 'fail'), verdictEvent('p1', 1, 'pass')]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n',
    );
    const daemon = await startDaemon({ port: 0, dcpDir, profilesDir });
    try {
      const res = await sidecarRequest(
        { port: daemon.port },
        'POST',
        '/notify',
        { kind: 'session-end', sessionId: 's-ended' },
        { timeoutMs: 5000 },
      );
      expect(res.ok).toBe(true);

      const candidatesPath = path.join(dcpDir, 'candidates.jsonl');
      expect(await waitFor(() => existsSync(candidatesPath))).toBe(true);
      const candidates = readCandidatesFile(candidatesPath);
      expect(candidates.records).toHaveLength(1);
      expect(candidates.records[0]?.type).toBe('error-fix');

      const miningEvent = await waitFor(() =>
        readFileSync(path.join(dcpDir, 'audit.jsonl'), 'utf8').includes('sidecar.graduation'),
      );
      expect(miningEvent).toBe(true);
    } finally {
      await daemon.close();
    }
  });

  it('a session-end on a daemon without engines answers ok and mines nothing', async () => {
    const dcpDir = tmpDcp();
    const daemon = await startDaemon({ port: 0, dcpDir });
    try {
      const res = await sidecarRequest(
        { port: daemon.port },
        'POST',
        '/notify',
        { kind: 'session-end', sessionId: 's-none' },
        { timeoutMs: 5000 },
      );
      expect(res.ok).toBe(true);
      await new Promise((r) => setTimeout(r, 200));
      expect(existsSync(path.join(dcpDir, 'candidates.jsonl'))).toBe(false);
    } finally {
      await daemon.close();
    }
  });
});
