import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sidecarRequest } from '../src/client.js';
import { startDaemon } from '../src/daemon.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..', '..');
const chalkRoot = path.join(repoRoot, 'fixtures', 'repos', 'chalk');

interface DossierBody {
  verdict: string;
  evidence: { file: string; line: number; snippet: string; why: string }[];
  zoomHandles: string[];
  stepsTaken: number;
  distillationRatio: number;
  incomplete?: { reason: string; continuationHint: string };
}

describe('daemon /explore endpoint', () => {
  it('runs a bounded hunt over http and returns a dossier with a working zoom handle', async () => {
    const dcpDir = mkdtempSync(path.join(os.tmpdir(), 'redutok-daemon-explore-'));
    const daemon = await startDaemon({ port: 0, dcpDir, profilesDir: path.join(repoRoot, 'profiles') });
    try {
      const res = await sidecarRequest(
        { port: daemon.port },
        'POST',
        '/explore',
        {
          goal: 'how does levelMapping pick between ansi ansi256 and ansi16m color models',
          scope: [path.join(chalkRoot, 'source')],
          budget: 'thorough',
          sessionId: 's-daemon-explore',
        },
        { timeoutMs: 15_000 },
      );
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const body = res.body as DossierBody;
      expect(body.evidence.length).toBeGreaterThan(0);
      expect(body.zoomHandles.length).toBeGreaterThan(0);
      expect(body.stepsTaken).toBeGreaterThan(0);

      const zoomRes = await sidecarRequest(
        { port: daemon.port },
        'POST',
        '/zoom',
        { id: body.zoomHandles[0] },
        { timeoutMs: 5000 },
      );
      expect(zoomRes.ok).toBe(true);
      if (zoomRes.ok) expect((zoomRes.body as { found: boolean }).found).toBe(true);
    } finally {
      await daemon.close();
    }
  });

  it('answers 503 without a profiles directory', async () => {
    const dcpDir = mkdtempSync(path.join(os.tmpdir(), 'redutok-daemon-explore-503-'));
    const daemon = await startDaemon({ port: 0, dcpDir });
    try {
      const res = await sidecarRequest(
        { port: daemon.port },
        'POST',
        '/explore',
        { goal: 'anything', sessionId: 's' },
        { timeoutMs: 5000 },
      );
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.status).toBe(503);
    } finally {
      await daemon.close();
    }
  });
});
