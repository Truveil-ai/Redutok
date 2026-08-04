import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '@redutok/shared';
import { sidecarRequest } from '../src/client.js';
import { startDaemon } from '../src/daemon.js';

/**
 * A first serve that the daemon immediately distils is not a raw serve. It
 * used to be recorded as one, which booked the full text as though it had
 * reached the model and counted the artifact's raw twice: once on the phantom
 * serve, once on the distill event that actually served it. Context
 * efficiency then read the session as half redundant, and the report's raw
 * touched was double what the session touched.
 */

const monorepoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const profilesDir = path.join(monorepoRoot, 'profiles');

function auditEvents(dcpDir: string): AuditEvent[] {
  const file = path.join(dcpDir, 'audit.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as AuditEvent);
}

const SOURCE = readFileSync(
  path.join(monorepoRoot, 'fixtures', 'artifacts', 'large-source.ts'),
  'utf8',
).repeat(6);

describe('a distilled first serve is booked once', () => {
  it('records the distill and no phantom raw serve of the same bytes', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'redutok-serveacct-'));
    const dcpDir = path.join(root, '.dcp');
    mkdirSync(dcpDir);
    writeFileSync(path.join(root, 'big.ts'), SOURCE);
    const daemon = await startDaemon({ port: 0, dcpDir, profilesDir });
    try {
      const res = await sidecarRequest(
        { port: daemon.port },
        'POST',
        '/serve-file',
        { raw: SOURCE, path: 'big.ts', sessionId: 's-acct', repoRoot: root },
        { timeoutMs: 20_000 },
      );
      expect(res.ok && res.status === 200).toBe(true);

      const serves = auditEvents(dcpDir).filter(
        (e) => e.action === 'distill' || e.action === 'serve-raw',
      );
      expect(serves).toHaveLength(1);
      const only = serves[0] as AuditEvent;
      expect(only.module).toBe('sidecar.distill');
      // The raw is booked once, and the served bytes are the distillate's.
      expect(only.bytesIn).toBe(Buffer.byteLength(SOURCE, 'utf8'));
      expect(only.bytesOut).toBeLessThan(only.bytesIn ?? 0);
    } finally {
      await daemon.close();
    }
  });

  it('still records a delta serve, which is what actually reaches the model', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'redutok-serveacct-delta-'));
    const dcpDir = path.join(root, '.dcp');
    mkdirSync(dcpDir);
    const daemon = await startDaemon({ port: 0, dcpDir, profilesDir });
    try {
      const target = { port: daemon.port };
      const body = (raw: string) => ({ raw, path: 'big.ts', sessionId: 's-delta', repoRoot: root });
      await sidecarRequest(target, 'POST', '/serve-file', body(SOURCE), { timeoutMs: 20_000 });
      const second = await sidecarRequest(
        target,
        'POST',
        '/serve-file',
        body(`${SOURCE}\nexport const EDITED = true;\n`),
        { timeoutMs: 20_000 },
      );
      expect(second.ok && (second.body as { mode: string }).mode).toBe('diff');
      const serveEvents = auditEvents(dcpDir).filter((e) => e.module === 'sidecar.serve');
      expect(serveEvents).toHaveLength(1);
      expect(serveEvents[0]?.action).toBe('distill');
    } finally {
      await daemon.close();
    }
  });
});
