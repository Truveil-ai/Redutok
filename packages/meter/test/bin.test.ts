import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pkgRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('redutok bin wiring', () => {
  it('maps the redutok and rtk bins to a built entry with a node shebang', () => {
    const pkg = JSON.parse(readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')) as {
      bin: Record<string, string>;
    };
    expect(pkg.bin['redutok']).toBe('./dist/cli.js');
    expect(pkg.bin['rtk']).toBe('./dist/cli.js');
    const entry = path.join(pkgRoot, 'dist', 'cli.js');
    expect(existsSync(entry), 'build the meter before running tests').toBe(true);
    expect(readFileSync(entry, 'utf8').startsWith('#!/usr/bin/env node')).toBe(true);
  });

  it('executes --help through the bin entry with exit code 0 on this platform', () => {
    const entry = path.join(pkgRoot, 'dist', 'cli.js');
    const result = spawnSync(process.execPath, [entry, '--help'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: redutok');
    expect(result.stdout).toContain('report');
    expect(result.stdout).toContain('init');
  });
});
