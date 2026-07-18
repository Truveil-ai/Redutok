import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sidecarRequest } from '../src/client.js';
import { startDaemon } from '../src/daemon.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..', '..');

describe('daemon distill and zoom endpoints', () => {
  it('distills over http, then zooms the stored raw without re-execution', async () => {
    const dcpDir = mkdtempSync(path.join(os.tmpdir(), 'redutok-daemon-distill-'));
    const daemon = await startDaemon({
      port: 0,
      dcpDir,
      profilesDir: path.join(repoRoot, 'profiles'),
    });
    try {
      const raw = readFileSync(path.join(repoRoot, 'fixtures', 'artifacts', 'build-log-fail.txt'), 'utf8');
      const distillRes = await sidecarRequest(
        { port: daemon.port },
        'POST',
        '/distill',
        { raw, profile: 'build-log', sessionId: 's-http', tool: 'Bash' },
        { timeoutMs: 10_000 },
      );
      expect(distillRes.ok).toBe(true);
      if (!distillRes.ok) return;
      const body = distillRes.body as {
        served: string;
        text: string;
        handle: string;
        artifactId: string;
      };
      expect(body.served).toBe('distilled');
      expect(body.text).toContain('VERDICT: fail');
      expect(body.handle).toContain(`dcp__zoom("${body.artifactId}"`);

      const zoomRes = await sidecarRequest(
        { port: daemon.port },
        'POST',
        '/zoom',
        { id: body.artifactId },
        { timeoutMs: 5000 },
      );
      expect(zoomRes.ok).toBe(true);
      if (zoomRes.ok) expect((zoomRes.body as { text: string }).text).toBe(raw);
    } finally {
      await daemon.close();
    }
  });

  it('answers 400 for a distill request with an unknown profile', async () => {
    const dcpDir = mkdtempSync(path.join(os.tmpdir(), 'redutok-daemon-distill-'));
    const daemon = await startDaemon({
      port: 0,
      dcpDir,
      profilesDir: path.join(repoRoot, 'profiles'),
    });
    try {
      const res = await sidecarRequest(
        { port: daemon.port },
        'POST',
        '/distill',
        { raw: 'x', profile: 'nope', sessionId: 's' },
        { timeoutMs: 5000 },
      );
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.status).toBe(400);
    } finally {
      await daemon.close();
    }
  });
});
