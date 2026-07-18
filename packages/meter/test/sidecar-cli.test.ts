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
