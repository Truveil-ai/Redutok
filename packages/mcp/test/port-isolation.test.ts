import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { startDaemon, type DaemonHandle } from '@redutok/sidecar';
import { resolveSidecarPort } from '../src/config.js';
import { handleMcpRequest, type McpDeps } from '../src/server.js';

/**
 * Regression for the bench contamination scenario: a temp-copy repo whose
 * .mcp.json used to hardcode port 48642 would talk to the dogfood repo's
 * daemon. Two daemons on different ports; the MCP server resolves its own
 * repo's port from .dcp/config.json and provably hits its own daemon, and the
 * wrong daemon refuses the cross-repo call outright.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.join(here, '..', '..', '..');
const profilesDir = path.join(monorepoRoot, 'profiles');

const dirs: string[] = [];
const daemons: DaemonHandle[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function makeRepoWithDaemon(prefix: string): Promise<{ repo: string; daemon: DaemonHandle }> {
  const repo = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(repo);
  mkdirSync(path.join(repo, '.dcp'), { recursive: true });
  const daemon = await startDaemon({ port: 0, dcpDir: path.join(repo, '.dcp'), profilesDir });
  daemons.push(daemon);
  writeFileSync(
    path.join(repo, '.dcp', 'config.json'),
    JSON.stringify({ port: daemon.port }, null, 2) + '\n',
    'utf8',
  );
  return { repo, daemon };
}

async function callTool(deps: McpDeps, name: string, args: unknown): Promise<string> {
  const res = await handleMcpRequest(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    deps,
  );
  const content = (res?.result as { content: { type: string; text: string }[] }).content;
  return content.map((c) => c.text).join('\n');
}

const auditText = (repo: string): string => {
  const file = path.join(repo, '.dcp', 'audit.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
};

describe('two daemons, two repos: each MCP server hits its own daemon', () => {
  it('resolves the port per repo and keeps serve traffic inside the right daemon', async () => {
    const a = await makeRepoWithDaemon('redutok-iso-a-');
    const b = await makeRepoWithDaemon('redutok-iso-b-');
    expect(a.daemon.port).not.toBe(b.daemon.port);

    // The MCP entry's resolution: no REDUTOK_PORT in the environment, so the
    // repo's own .dcp/config.json decides — each repo gets its own daemon.
    expect(resolveSidecarPort({}, a.repo)).toBe(a.daemon.port);
    expect(resolveSidecarPort({}, b.repo)).toBe(b.daemon.port);

    const sourcePath = path.join(a.repo, 'big.ts');
    writeFileSync(sourcePath, readFileSync(path.join(monorepoRoot, 'fixtures', 'artifacts', 'large-source.ts')), 'utf8');
    const depsA: McpDeps = {
      target: { port: resolveSidecarPort({}, a.repo) },
      repoRoot: a.repo,
      sessionId: 'iso-a',
      timeoutMs: 10_000,
    };
    const text = await callTool(depsA, 'dcp__read', { file_path: sourcePath });
    expect(text).not.toContain('sidecar unavailable');
    // Proof the serve landed in repo A's daemon and nowhere near repo B's.
    expect(auditText(a.repo)).toContain('big.ts');
    expect(auditText(b.repo)).toBe('');
  });

  it('a misdirected MCP server is refused by the foreign daemon and falls back to raw passthrough', async () => {
    const a = await makeRepoWithDaemon('redutok-iso-a-');
    const b = await makeRepoWithDaemon('redutok-iso-b-');
    const sourcePath = path.join(a.repo, 'big.ts');
    writeFileSync(sourcePath, readFileSync(path.join(monorepoRoot, 'fixtures', 'artifacts', 'large-source.ts')), 'utf8');

    // The old bug: repo A's MCP server pointed at repo B's daemon.
    const misdirected: McpDeps = {
      target: { port: b.daemon.port },
      repoRoot: a.repo,
      sessionId: 'iso-a',
      timeoutMs: 10_000,
    };
    const text = await callTool(misdirected, 'dcp__read', { file_path: sourcePath });
    // Fail-open: full fidelity raw, no cross-repo artifact in daemon B.
    expect(text).toContain('[dcp notice: sidecar unavailable, raw passthrough]');
    expect(auditText(b.repo)).toContain('"action":"refuse"');
    expect(auditText(b.repo)).not.toContain('sidecar.serve');

    const zoomText = await callTool(misdirected, 'dcp__zoom', { id: 'a123456' });
    expect(zoomText).toContain('cross-repo');
  });
});
