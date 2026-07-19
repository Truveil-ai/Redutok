import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sidecarRequest } from '../src/client.js';
import { startDaemon } from '../src/daemon.js';

const tmpDir = () => mkdtempSync(path.join(os.tmpdir(), 'redutok-daemon-'));
const pkgRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('daemon over localhost http', () => {
  it('serves /health, writes a pidfile, and cleans up on close', async () => {
    const dcpDir = tmpDir();
    const daemon = await startDaemon({ port: 0, dcpDir });
    try {
      const pidfile = path.join(dcpDir, 'sidecar.pid.json');
      expect(existsSync(pidfile)).toBe(true);
      const res = await sidecarRequest(
        { port: daemon.port },
        'GET',
        '/health',
        undefined,
        { timeoutMs: 2000 },
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect((res.body as { ok: boolean }).ok).toBe(true);
        expect((res.body as { pid: number }).pid).toBe(process.pid);
      }
      await daemon.close();
      expect(existsSync(pidfile)).toBe(false);
    } finally {
      await daemon.close();
    }
  });

  it('writes structured jsonl logs', async () => {
    const dcpDir = tmpDir();
    const daemon = await startDaemon({ port: 0, dcpDir });
    await sidecarRequest({ port: daemon.port }, 'GET', '/health', undefined, { timeoutMs: 2000 });
    await daemon.close();
    const logFile = path.join(dcpDir, 'sidecar.log.jsonl');
    expect(existsSync(logFile)).toBe(true);
    const { readFileSync } = await import('node:fs');
    const lines = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.some((l) => l.msg === 'daemon started')).toBe(true);
    for (const line of lines) {
      expect(typeof line.ts).toBe('string');
      expect(['info', 'warn', 'error']).toContain(line.level);
    }
  });
});

// The named-pipe transport only exists on Windows (\\.\pipe\ namespace), so
// this suite is platform-gated rather than skipped silently; on other
// platforms the daemon is exercised over localhost HTTP above.
describe.runIf(process.platform === 'win32')('daemon over windows named pipe', () => {
  it('serves /health over the pipe transport', async () => {
    const daemon = await startDaemon({ port: 0, dcpDir: tmpDir(), pipeName: `redutok-test-${process.pid}` });
    try {
      expect(daemon.pipePath).toContain('\\\\.\\pipe\\');
      const res = await sidecarRequest(
        { pipePath: daemon.pipePath },
        'GET',
        '/health',
        undefined,
        { timeoutMs: 2000 },
      );
      expect(res.ok).toBe(true);
    } finally {
      await daemon.close();
    }
  });
});

describe('graceful degradation', () => {
  it('sidecarRequest fails open fast when nothing is listening, never throws', async () => {
    const started = Date.now();
    const res = await sidecarRequest({ port: 1 }, 'GET', '/health', undefined, { timeoutMs: 500 });
    expect(res.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a request in flight when the daemon is killed fails cleanly', async () => {
    const entry = path.join(pkgRoot, 'dist', 'daemon-main.js');
    expect(existsSync(entry), 'build the sidecar before running tests').toBe(true);
    const dcpDir = tmpDir();
    const child = spawn(process.execPath, [entry], {
      env: { ...process.env, REDUTOK_DCP_DIR: dcpDir, REDUTOK_PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('daemon did not report a port')), 10_000);
      child.stdout.on('data', (chunk: Buffer) => {
        const m = /listening on port (\d+)/.exec(chunk.toString());
        if (m) {
          clearTimeout(timer);
          resolve(Number(m[1]));
        }
      });
    });
    const health = await sidecarRequest({ port }, 'GET', '/health', undefined, { timeoutMs: 2000 });
    expect(health.ok).toBe(true);

    const slow = sidecarRequest({ port }, 'GET', '/debug/slow?ms=5000', undefined, {
      timeoutMs: 10_000,
    });
    await new Promise((r) => setTimeout(r, 300));
    child.kill();
    const result = await slow;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
  });
});
