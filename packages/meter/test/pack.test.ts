import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PKGS = ['shared', 'sidecar', 'mcp', 'hooks', 'meter'];

function run(cmd: string, args: string[], cwd: string) {
  // Joined command string: args arrays with shell true are deprecated (DEP0190).
  return spawnSync([cmd, ...args].join(' '), { cwd, encoding: 'utf8', shell: true, timeout: 240_000 });
}

describe('packed tarball, npx semantics', () => {
  it('packs, installs into a temp dir, and runs redutok --help with exit 0', () => {
    const stage = mkdtempSync(path.join(os.tmpdir(), 'redutok-pack-'));
    const tarballs: Record<string, string> = {};
    for (const name of PKGS) {
      const pkgDir = path.join(repoRoot, 'packages', name);
      const packed = run('pnpm', ['pack', '--pack-destination', JSON.stringify(stage)], pkgDir);
      expect(packed.status, `pack ${name}: ${packed.stderr}`).toBe(0);
    }
    for (const file of readdirSync(stage).filter((f) => f.endsWith('.tgz'))) {
      const scope = file.startsWith('redutok-shared')
        ? '@redutok/shared'
        : file.startsWith('redutok-sidecar')
          ? '@redutok/sidecar'
          : file.startsWith('redutok-mcp')
            ? '@redutok/mcp'
            : file.startsWith('redutok-hooks')
              ? '@redutok/hooks'
              : 'redutok';
      tarballs[scope] = file;
    }
    expect(Object.keys(tarballs)).toHaveLength(5);

    const app = mkdtempSync(path.join(os.tmpdir(), 'redutok-app-'));
    const overrides: Record<string, string> = {};
    for (const [scope, file] of Object.entries(tarballs)) {
      if (scope !== 'redutok') overrides[scope] = `file:${path.join(stage, file).replace(/\\/g, '/')}`;
    }
    writeFileSync(
      path.join(app, 'package.json'),
      JSON.stringify({ name: 'pack-consumer', private: true, overrides }, null, 2),
    );
    const install = run(
      'npm',
      ['install', JSON.stringify(path.join(stage, tarballs['redutok'] as string)), '--no-audit', '--no-fund', '--loglevel=error'],
      app,
    );
    expect(install.status, `npm install: ${install.stderr}`).toBe(0);

    const help = run('npx', ['--no-install', 'redutok', '--help'], app);
    expect(help.status, `npx redutok --help: ${help.stderr}`).toBe(0);
    expect(help.stdout).toContain('Usage: redutok');
  }, 300_000);
});
