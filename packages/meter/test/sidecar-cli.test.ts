import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { startDaemon } from '@redutok/sidecar';
import { readPidfile, sidecarDown, sidecarStatus } from '../src/sidecar-cli.js';

const tmpDir = () => mkdtempSync(path.join(os.tmpdir(), 'redutok-cli-'));

describe('readPidfile', () => {
  it('returns undefined for missing or corrupt pidfiles', () => {
    const dir = tmpDir();
    expect(readPidfile(dir)).toBeUndefined();
    writeFileSync(path.join(dir, 'sidecar.pid.json'), '{not json');
    expect(readPidfile(dir)).toBeUndefined();
  });
});

describe('config wiring: up passes profiles and port from .dcp/config.json', () => {
  it('starts a daemon that can distill, using the configured profiles dir', async () => {
    const { sidecarUp } = await import('../src/sidecar-cli.js');
    const { sidecarRequest } = await import('@redutok/sidecar/client');
    const { fileURLToPath } = await import('node:url');
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const dir = tmpDir();
    writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ port: 0, profilesDir: path.join(repoRoot, 'profiles') }),
    );
    const upMsg = await sidecarUp(dir);
    expect(upMsg).toContain('started');
    try {
      const pidfile = readPidfile(dir);
      const res = await sidecarRequest(
        { port: pidfile?.port },
        'POST',
        '/distill',
        { raw: 'x\n'.repeat(200), profile: 'generic-stdout', sessionId: 's-cfg' },
        { timeoutMs: 10_000 },
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.status).toBe(200);
        expect((res.body as { served: string }).served).toBe('distilled');
      }
    } finally {
      await sidecarDown(dir);
    }
  }, 30_000);
});

describe('sidecarStatus', () => {
  it('reports not running without a pidfile, degrading cleanly', async () => {
    expect(await sidecarStatus(tmpDir())).toContain('not running');
  });

  it('reports a stale pidfile when nothing listens on the recorded port', async () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, 'sidecar.pid.json'), JSON.stringify({ pid: 99999, port: 1 }));
    expect(await sidecarStatus(dir)).toContain('not responding');
  });

  it('reports running against a live daemon and down stops it', async () => {
    const dir = tmpDir();
    const daemon = await startDaemon({ port: 0, dcpDir: dir });
    try {
      expect(await sidecarStatus(dir)).toContain('running');
      expect(await sidecarDown(dir)).toContain('shut down');
    } finally {
      await daemon.close();
    }
  });
});
