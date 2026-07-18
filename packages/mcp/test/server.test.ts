import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { startDaemon } from '@redutok/sidecar';
import { handleMcpRequest, type McpDeps } from '../src/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..', '..');

const req = (id: number, method: string, params?: unknown) => ({
  jsonrpc: '2.0' as const,
  id,
  method,
  params,
});

async function callTool(deps: McpDeps, name: string, args: unknown) {
  const res = await handleMcpRequest(req(1, 'tools/call', { name, arguments: args }), deps);
  const content = (res?.result as { content: { type: string; text: string }[] }).content;
  return content.map((c) => c.text).join('\n');
}

const DOWN: McpDeps = { target: { port: 1 }, timeoutMs: 300 };

describe('mcp handshake and tool list', () => {
  it('answers initialize and lists the five dcp tools', async () => {
    const init = await handleMcpRequest(req(1, 'initialize', {}), DOWN);
    expect((init?.result as { serverInfo: { name: string } }).serverInfo.name).toBe('redutok-dcp');
    const list = await handleMcpRequest(req(2, 'tools/list'), DOWN);
    const names = (list?.result as { tools: { name: string }[] }).tools.map((t) => t.name).sort();
    expect(names).toEqual(['dcp__read', 'dcp__run', 'dcp__search', 'dcp__state', 'dcp__zoom']);
  });

  it('returns null for notifications and an error for unknown methods', async () => {
    expect(await handleMcpRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }, DOWN)).toBeNull();
    const bad = await handleMcpRequest(req(3, 'no/such'), DOWN);
    expect(bad?.error?.code).toBe(-32601);
  });
});

describe('fail-open behaviour with the sidecar down', () => {
  it('dcp__read serves the raw file with a passthrough notice', async () => {
    const text = await callTool(DOWN, 'dcp__read', {
      file_path: path.join(repoRoot, 'fixtures', 'artifacts', 'sample.py'),
    });
    expect(text).toContain('def load_ledger');
    expect(text).toContain('[dcp notice: sidecar unavailable, raw passthrough]');
  });

  it('dcp__zoom and dcp__state report the sidecar as unavailable without throwing', async () => {
    expect(await callTool(DOWN, 'dcp__zoom', { id: 'aXXXX' })).toContain('sidecar unavailable');
    expect(await callTool(DOWN, 'dcp__state', {})).toContain('not running');
  });
});

describe('distilled path with a live sidecar', () => {
  it('dcp__read returns a skeleton with a zoom handle, and dcp__zoom recovers the raw', async () => {
    const daemon = await startDaemon({
      port: 0,
      dcpDir: mkdtempSync(path.join(os.tmpdir(), 'redutok-mcp-')),
      profilesDir: path.join(repoRoot, 'profiles'),
    });
    const deps: McpDeps = { target: { port: daemon.port }, timeoutMs: 10_000 };
    try {
      const filePath = path.join(repoRoot, 'fixtures', 'artifacts', 'large-source.ts');
      const text = await callTool(deps, 'dcp__read', { file_path: filePath });
      expect(text).toContain('export async function buildReport');
      expect(text).not.toContain('lines.push');
      const idMatch = /dcp__zoom\("(a[0-9a-f]+)"/.exec(text);
      expect(idMatch).not.toBeNull();
      const zoomText = await callTool(deps, 'dcp__zoom', { id: idMatch?.[1] });
      expect(zoomText).toContain('lines.push');
      expect(await callTool(deps, 'dcp__state', {})).toContain('running');
    } finally {
      await daemon.close();
    }
  });
});
