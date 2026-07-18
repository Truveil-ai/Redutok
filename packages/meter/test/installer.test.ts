import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { initRepo, removeRepo } from '../src/installer.js';

function snapshot(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const full = path.join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.set(path.relative(dir, full).replace(/\\/g, '/'), readFileSync(full, 'utf8'));
    }
  };
  walk(dir);
  return files;
}

function makeRepo(withExisting: boolean): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'redutok-install-'));
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const x = 1;\n');
  if (withExisting) {
    writeFileSync(path.join(dir, 'CLAUDE.md'), '# My project\n\nExisting instructions.\n');
    mkdirSync(path.join(dir, '.claude'));
    writeFileSync(
      path.join(dir, '.claude', 'settings.json'),
      JSON.stringify(
        { hooks: { PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'echo mine' }] }] } },
        null,
        2,
      ) + '\n',
    );
  }
  return dir;
}

describe('initRepo', () => {
  it('installs hooks, mcp registration, protocol block, and .dcp scaffold', () => {
    const repo = makeRepo(true);
    initRepo(repo);
    const settings = JSON.parse(readFileSync(path.join(repo, '.claude', 'settings.json'), 'utf8'));
    expect(JSON.stringify(settings)).toContain('echo mine');
    expect(JSON.stringify(settings.hooks.PreToolUse)).toContain('hook-main.js');
    expect(settings.hooks.SessionStart).toBeDefined();
    const mcp = JSON.parse(readFileSync(path.join(repo, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.redutok.command).toBe('node');
    const claudeMd = readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('Existing instructions.');
    expect(claudeMd).toContain('<!-- dcp:start v1 -->');
    expect(claudeMd).toContain('<!-- dcp:end -->');
    expect(existsSync(path.join(repo, '.dcp', 'protocol.md'))).toBe(true);
  });

  it('is idempotent: a second init changes nothing', () => {
    const repo = makeRepo(true);
    initRepo(repo);
    const after1 = snapshot(repo);
    initRepo(repo);
    expect(snapshot(repo)).toEqual(after1);
  });
});

describe('removeRepo reverts byte-identical', () => {
  it('restores a repo with existing config to the exact pre-init tree', () => {
    const repo = makeRepo(true);
    const before = snapshot(repo);
    initRepo(repo);
    expect(snapshot(repo)).not.toEqual(before);
    removeRepo(repo);
    expect(snapshot(repo)).toEqual(before);
    expect(existsSync(path.join(repo, '.dcp'))).toBe(false);
  });

  it('restores a bare repo by deleting everything init created', () => {
    const repo = makeRepo(false);
    const before = snapshot(repo);
    initRepo(repo);
    removeRepo(repo);
    expect(snapshot(repo)).toEqual(before);
    expect(existsSync(path.join(repo, '.claude'))).toBe(false);
    expect(existsSync(path.join(repo, '.mcp.json'))).toBe(false);
    expect(existsSync(path.join(repo, 'CLAUDE.md'))).toBe(false);
  });
});
