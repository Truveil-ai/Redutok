import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function run(cmd: string, args: string[], cwd: string) {
  // Joined command string: args arrays with shell true are deprecated (DEP0190).
  return spawnSync([cmd, ...args].join(' '), { cwd, encoding: 'utf8', shell: true, timeout: 300_000 });
}

const q = (p: string) => JSON.stringify(p.replace(/\\/g, '/'));

/**
 * Registry semantics, deliberately.
 *
 * The previous version of this test packed all five workspace packages and
 * wired the four private ones into the consumer via
 * `overrides: { "@redutok/shared": "file:..." }`. That kept the test green
 * while `npm i redutok` was broken for every real user: the four @redutok/*
 * packages are private and unpublished, so a consumer resolving them from the
 * registry gets E404. The overrides hid precisely the failure this test
 * exists to catch.
 *
 * So: pack ONLY redutok, install it with no overrides and no file: links, and
 * drive the CLI as a user would. If the published surface ever again needs a
 * package that is not on the public registry, this test fails.
 */
describe('packed tarball, registry semantics', () => {
  it('installs standalone and runs --help and init', () => {
    const stage = mkdtempSync(path.join(os.tmpdir(), 'redutok-pack-'));
    const meterDir = path.join(repoRoot, 'packages', 'meter');

    const packed = run('pnpm', ['pack', '--pack-destination', q(stage)], meterDir);
    expect(packed.status, `pack redutok: ${packed.stderr}`).toBe(0);

    const tarballs = readdirSync(stage).filter((f) => f.endsWith('.tgz'));
    expect(tarballs, 'redutok packs alone').toHaveLength(1);
    const tarball = path.join(stage, tarballs[0] as string);

    // A bare consumer: no overrides, no resolutions, no workspace context.
    const app = mkdtempSync(path.join(os.tmpdir(), 'redutok-app-'));
    writeFileSync(
      path.join(app, 'package.json'),
      JSON.stringify({ name: 'pack-consumer', private: true, version: '0.0.0' }, null, 2),
    );

    const install = run('npm', ['install', q(tarball), '--no-audit', '--no-fund', '--loglevel=error'], app);
    expect(install.status, `npm install: ${install.stderr}`).toBe(0);

    // Nothing from the private scope may reach a consumer's tree.
    const published = JSON.parse(
      readFileSync(path.join(app, 'node_modules', 'redutok', 'package.json'), 'utf8'),
    );
    const scoped = Object.keys(published.dependencies ?? {}).filter((d) => d.startsWith('@redutok/'));
    expect(scoped, 'published package.json must not depend on the private scope').toEqual([]);
    expect(existsSync(path.join(app, 'node_modules', '@redutok'))).toBe(false);

    const help = run('npx', ['--no-install', 'redutok', '--help'], app);
    expect(help.status, `npx redutok --help: ${help.stderr}`).toBe(0);
    expect(help.stdout).toContain('Usage: redutok');

    // init in an empty project exercises the launcher entry points and the
    // packaged docs (PROTOCOL.md / SCOUT.md) that --help never touches. This
    // is where monorepo-relative paths surface.
    const project = mkdtempSync(path.join(os.tmpdir(), 'redutok-init-'));
    writeFileSync(
      path.join(project, 'package.json'),
      JSON.stringify({ name: 'init-target', private: true, version: '0.0.0' }, null, 2),
    );
    const init = run('npx', ['--no-install', 'redutok', 'init', q(project)], app);
    expect(init.status, `redutok init: ${init.stderr}`).toBe(0);

    for (const rel of [
      '.dcp/config.json',
      '.claude/redutok/hook.mjs',
      '.claude/redutok/mcp.mjs',
      '.claude/redutok/pipe.mjs',
      '.claude/agents/scout.md',
      '.mcp.json',
      'CLAUDE.md',
    ]) {
      expect(existsSync(path.join(project, rel)), `init should write ${rel}`).toBe(true);
    }

    // The generated launchers resolve their entry point at runtime, through
    // the repo -> redutok chain. Executing hook.mjs would prove nothing (it is
    // fail-open and exits 0 even when resolution fails), so probe the same
    // chain directly: this is the assertion the fail-open path swallows.
    const probe = path.join(app, 'probe.mjs');
    writeFileSync(
      probe,
      `import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const repoRequire = createRequire(pathToFileURL(path.join(process.cwd(), 'package.json')));
const meterPkg = repoRequire.resolve('redutok/package.json');
const req = createRequire(meterPkg);
for (const spec of ['redutok/hook-main', 'redutok/mcp-main', 'redutok/pipe']) {
  console.log(spec + ' -> ' + req.resolve(spec));
}
`,
    );
    const resolved = run('node', [q(probe)], app);
    expect(resolved.status, `launcher entry resolution: ${resolved.stderr}`).toBe(0);
    expect(resolved.stdout).toContain('redutok/hook-main ->');
    expect(resolved.stdout).toContain('redutok/mcp-main ->');
  }, 600_000);
});
