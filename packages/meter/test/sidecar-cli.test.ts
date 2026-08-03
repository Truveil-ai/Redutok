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

describe('repo identity in the lifecycle commands', () => {
  it('up does not mistake a foreign daemon on the recorded port for its own, and starts one for this repo', async () => {
    const { sidecarUp } = await import('../src/sidecar-cli.js');
    const { sidecarRequest } = await import('@redutok/sidecar/client');
    const { fileURLToPath } = await import('node:url');
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const { mkdirSync } = await import('node:fs');

    // The field shape: another repo's daemon holds the port this repo's
    // stale pidfile and config both point at.
    const foreignRepo = mkdtempSync(path.join(os.tmpdir(), 'redutok-cli-foreign-'));
    mkdirSync(path.join(foreignRepo, '.dcp'));
    const foreign = await startDaemon({ port: 0, dcpDir: path.join(foreignRepo, '.dcp') });

    const ownRepo = mkdtempSync(path.join(os.tmpdir(), 'redutok-cli-own-'));
    const dir = path.join(ownRepo, '.dcp');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'sidecar.pid.json'), JSON.stringify({ pid: 99999, port: foreign.port }));
    writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ port: foreign.port, profilesDir: path.join(repoRoot, 'profiles') }),
    );
    try {
      const msg = await sidecarUp(dir);
      expect(msg, msg).not.toContain('already running');
      expect(msg).toContain('started');
      const pidfile = readPidfile(dir);
      expect(pidfile).toBeDefined();
      expect(pidfile?.port).not.toBe(foreign.port);
      const health = await sidecarRequest({ port: pidfile?.port }, 'GET', '/health', undefined, {
        timeoutMs: 2000,
      });
      expect(health.ok && health.status === 200).toBe(true);
      const body = (health.ok ? health.body : {}) as { repoRoot?: string };
      expect(path.resolve(body.repoRoot ?? '')).toBe(path.resolve(ownRepo));
    } finally {
      await sidecarDown(dir);
      await foreign.close();
    }
  }, 30_000);

  it('status names a foreign daemon instead of calling it running', async () => {
    const { mkdirSync } = await import('node:fs');
    const foreignRepo = mkdtempSync(path.join(os.tmpdir(), 'redutok-cli-forstat-'));
    mkdirSync(path.join(foreignRepo, '.dcp'));
    const foreign = await startDaemon({ port: 0, dcpDir: path.join(foreignRepo, '.dcp') });
    const ownRepo = mkdtempSync(path.join(os.tmpdir(), 'redutok-cli-ownstat-'));
    const dir = path.join(ownRepo, '.dcp');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'sidecar.pid.json'), JSON.stringify({ pid: 99999, port: foreign.port }));
    try {
      const status = await sidecarStatus(dir);
      expect(status).toContain('different repo');
      expect(status).not.toMatch(/^Sidecar: running/);
    } finally {
      await foreign.close();
    }
  });
});
