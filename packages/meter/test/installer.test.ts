import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractDcpBlock, initRepo, removeRepo, shippedProtocolBlock } from '../src/installer.js';

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
      path.join(dir, '.claude', 'settings.local.json'),
      JSON.stringify(
        { hooks: { PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'echo mine' }] }] } },
        null,
        2,
      ) + '\n',
    );
  }
  return dir;
}

/**
 * init refuses to write launchers it knows cannot resolve, so these temp
 * repos have to model a real install. REDUTOK_HOME is the supported way to
 * point the launchers at one, and this repository is a resolvable install of
 * redutok, so it stands in for `npm install --save-dev redutok` in the target.
 */
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
let priorHome: string | undefined;
beforeEach(() => {
  priorHome = process.env['REDUTOK_HOME'];
  process.env['REDUTOK_HOME'] = repoRoot;
});
afterEach(() => {
  if (priorHome === undefined) delete process.env['REDUTOK_HOME'];
  else process.env['REDUTOK_HOME'] = priorHome;
});

describe('initRepo resolvability precondition', () => {
  it('refuses, and writes nothing, when redutok is not installed in the target', () => {
    delete process.env['REDUTOK_HOME'];
    const repo = makeRepo(false);
    const before = snapshot(repo);

    expect(() => initRepo(repo)).toThrow(/npm install --save-dev redutok/);

    // A half-written setup is worse than none: the launchers would be present
    // and broken, and doctor would have something to report as registered.
    expect(snapshot(repo)).toEqual(before);
    expect(existsSync(path.join(repo, '.claude', 'redutok', 'hook.mjs'))).toBe(false);
    expect(existsSync(path.join(repo, '.dcp'))).toBe(false);
  });

  it('names the npx cache as the reason, not a generic missing module', () => {
    delete process.env['REDUTOK_HOME'];
    const repo = makeRepo(false);
    let message = '';
    try {
      initRepo(repo);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('npx');
    expect(message).toContain('REDUTOK_HOME');
  });

  it('proceeds when REDUTOK_HOME points at a resolvable install', () => {
    process.env['REDUTOK_HOME'] = repoRoot;
    const repo = makeRepo(false);
    expect(() => initRepo(repo)).not.toThrow();
    expect(existsSync(path.join(repo, '.claude', 'redutok', 'hook.mjs'))).toBe(true);
  });
});

describe('initRepo', () => {
  it('demotes the protocol block fully: reads and commands govern themselves (v3 pillar B)', () => {
    const repo = makeRepo(false);
    initRepo(repo);
    const claudeMd = readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8');
    const block = /<!-- dcp:start[\s\S]*?dcp:end -->/.exec(claudeMd)?.[0] ?? '';
    // The pipe covers commands invisibly (pillar A) and the mirror covers
    // large reads (pillar B): no tool-preference guidance remains for either.
    expect(block).not.toContain('dcp__run');
    expect(block).not.toContain('dcp__read');
    expect(block).not.toContain('dcp__search');
    // \r?\n: a CRLF checkout (Windows CI leg) wraps the block accordingly.
    expect(block).toMatch(/distilled in\r?\n {3}place/);
    expect(block).toContain('need no special handling');
    // What stays: zoom guidance, and explore/scout as optional equipment.
    expect(block).toContain('dcp__zoom');
    expect(block).toContain('optional equipment');
    expect(block).toContain('scout subagent');
  });

  it('installs hooks, mcp registration, protocol block, and .dcp scaffold', () => {
    const repo = makeRepo(true);
    initRepo(repo);
    const settings = JSON.parse(
      readFileSync(path.join(repo, '.claude', 'settings.local.json'), 'utf8'),
    );
    expect(JSON.stringify(settings)).toContain('echo mine');
    expect(JSON.stringify(settings.hooks.PreToolUse)).toContain('.claude/redutok/hook.mjs');
    // PowerShell is matched alongside Bash (rep-1 bypass, 2026-07-30).
    expect(JSON.stringify(settings.hooks.PreToolUse)).toContain('PowerShell');
    expect(settings.hooks.SessionStart).toBeDefined();
    const mcp = JSON.parse(readFileSync(path.join(repo, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.redutok.command).toBe('node');
    // Port isolation: no hardcoded port in .mcp.json; the MCP entry resolves
    // it from this repo's .dcp/config.json so temp copies hit their own daemon.
    expect(mcp.mcpServers.redutok.env.REDUTOK_PORT).toBeUndefined();
    expect(mcp.mcpServers.redutok.env.REDUTOK_DCP_DIR).toBe('.dcp');
    expect(existsSync(path.join(repo, '.claude', 'redutok', 'hook.mjs'))).toBe(true);
    expect(existsSync(path.join(repo, '.claude', 'redutok', 'mcp.mjs'))).toBe(true);
    expect(existsSync(path.join(repo, '.claude', 'redutok', 'pipe.mjs'))).toBe(true);
    expect(existsSync(path.join(repo, '.dcp', 'config.json'))).toBe(true);
    const scout = readFileSync(path.join(repo, '.claude', 'agents', 'scout.md'), 'utf8');
    expect(scout).toContain('name: scout');
    expect(scout).toContain('tools: mcp__redutok__dcp__explore');
    expect(scout).toContain('mcp__redutok__dcp__zoom');
    expect(scout).not.toContain('Read, Bash, Grep,');
    const claudeMd = readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('Existing instructions.');
    expect(claudeMd).toContain('<!-- dcp:start v1 -->');
    expect(claudeMd).toContain('<!-- dcp:end -->');
    expect(existsSync(path.join(repo, '.dcp', 'protocol.md'))).toBe(true);
  });

  it('writes the current shipped protocol into both CLAUDE.md and .dcp/protocol.md (harness hygiene)', () => {
    // The bench prep-check asserts exactly this equality on the temp copy, so
    // a stale checkout or dogfood block can never masquerade as the shipped
    // protocol in a bench run.
    const dir = makeRepo(false);
    initRepo(dir);
    const shipped = shippedProtocolBlock().replace(/\r\n/g, '\n');
    const claudeBlock = extractDcpBlock(readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'));
    expect(claudeBlock?.replace(/\r\n/g, '\n')).toBe(shipped);
    const protocolMd = readFileSync(path.join(dir, '.dcp', 'protocol.md'), 'utf8');
    expect(extractDcpBlock(protocolMd)?.replace(/\r\n/g, '\n')).toBe(shipped);
    rmSync(dir, { recursive: true, force: true });
  });

  it('is idempotent: a second init changes nothing', () => {
    const repo = makeRepo(true);
    initRepo(repo);
    const after1 = snapshot(repo);
    initRepo(repo);
    expect(snapshot(repo)).toEqual(after1);
  });

  it('re-init recreates .claude/agents/scout.md on a repo installed before the scout subagent existed', () => {
    const repo = makeRepo(true);
    initRepo(repo);
    // Simulate an install that predates the scout subagent: the manifest
    // (and so the "already installed" fast path) stays, but the directory
    // scout.md lives in is gone, same as a repo that never had it.
    rmSync(path.join(repo, '.claude', 'agents'), { recursive: true, force: true });
    expect(() => initRepo(repo)).not.toThrow();
    expect(existsSync(path.join(repo, '.claude', 'agents', 'scout.md'))).toBe(true);
  });
});

describe('portability', () => {
  it('writes no machine-absolute path into any managed file', () => {
    const repo = makeRepo(true);
    initRepo(repo);
    const managed = [
      '.claude/settings.local.json',
      '.claude/redutok/hook.mjs',
      '.claude/redutok/mcp.mjs',
      '.claude/redutok/pipe.mjs',
      '.claude/agents/scout.md',
      '.mcp.json',
      'CLAUDE.md',
    ];
    for (const rel of managed) {
      const content = readFileSync(path.join(repo, rel), 'utf8');
      expect(content, `${rel} contains a drive-absolute path`).not.toMatch(/[A-Za-z]:[\\/][^\s"']/);
      expect(content, `${rel} leaks this machine's temp dir`).not.toContain(os.tmpdir());
    }
  });
});

describe('launcher resolution', () => {
  const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

  // Regression for ERR_PACKAGE_PATH_NOT_EXPORTED: the launchers resolve
  // 'redutok/package.json' (and init resolves '@redutok/sidecar/package.json'),
  // which requires each package's exports map to expose "./package.json".
  it('resolves the exact chain the generated launchers use', () => {
    const repoRequire = createRequire(pathToFileURL(path.join(repoRoot, 'package.json')));
    const meterPkg = repoRequire.resolve('redutok/package.json');
    const fromMeter = createRequire(meterPkg);
    expect(existsSync(fromMeter.resolve('@redutok/mcp/main'))).toBe(true);
    expect(existsSync(fromMeter.resolve('@redutok/hooks/hook-main'))).toBe(true);
    expect(existsSync(fromMeter.resolve('@redutok/sidecar/package.json'))).toBe(true);
    // The pipe launcher's chain (self-referencing 'redutok/pipe' export).
    expect(existsSync(fromMeter.resolve('redutok/pipe'))).toBe(true);
  });

  it('generated mcp.mjs starts and answers an initialize handshake', async () => {
    const repo = makeRepo(false);
    initRepo(repo);
    const child = spawn(
      process.execPath,
      [path.join(repo, '.claude', 'redutok', 'mcp.mjs')],
      {
        cwd: repo,
        env: { ...process.env, REDUTOK_HOME: repoRoot, REDUTOK_PORT: '48642', REDUTOK_DCP_DIR: '.dcp' },
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
      }) + '\n',
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`no initialize response; stderr: ${stderr}`)),
          10000,
        );
        child.stdout.on('data', () => {
          if (stdout.includes('"serverInfo"')) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.on('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`launcher exited with ${code} before responding; stderr: ${stderr}`));
        });
      });
    } finally {
      child.kill();
    }
    const response = JSON.parse(stdout.split('\n')[0] ?? '');
    expect(response.result.serverInfo.name).toBe('redutok-dcp');
  }, 15000);
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

describe('per-repo sidecar port', () => {
  it('derives a stable port from the repo path, inside the reserved range', async () => {
    const { portForRepo } = await import('../src/installer.js');
    const a = portForRepo('/home/user/repo-a');
    const b = portForRepo('/home/user/repo-b');
    expect(portForRepo('/home/user/repo-a')).toBe(a);
    expect(a).not.toBe(b);
    for (const port of [a, b]) {
      expect(port).toBeGreaterThanOrEqual(42000);
      expect(port).toBeLessThan(50000);
    }
    // Windows and POSIX spellings of one path agree, like the daemon's own
    // normalizedRoot comparison.
    expect(portForRepo('E:\\repo\\')).toBe(portForRepo('E:/repo'));
  });

  it('init writes the per-repo port, not one shared default, into .dcp/config.json', async () => {
    const { portForRepo } = await import('../src/installer.js');
    const repo = makeRepo(false);
    initRepo(repo);
    const config = JSON.parse(readFileSync(path.join(repo, '.dcp', 'config.json'), 'utf8')) as {
      port?: number;
    };
    expect(config.port).toBe(portForRepo(repo));
  });
});
