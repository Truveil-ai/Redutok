import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { startDaemon, type DaemonHandle } from '@redutok/sidecar';
import { handleMcpRequest, type McpDeps } from '../src/server.js';

/**
 * Replay of the exact h02 bench dead-end: after dcp__read handed out a
 * [dcp:file F...@...] reference, the model called
 *   dcp__zoom({ handle: "F88a9@a7345746a7b269eb",
 *               query: "applyStyle openAll closeAll function context" })
 * and got "no artifact ... in the store" — `handle` instead of `id`, and an
 * F-ref the zoom endpoint could not resolve. Both must work now.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..', '..');
const chalkIndex = path.join(repoRoot, 'fixtures', 'repos', 'chalk', 'source', 'index.js');

const dirs: string[] = [];
const daemons: DaemonHandle[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function callTool(deps: McpDeps, name: string, args: unknown): Promise<string> {
  const res = await handleMcpRequest(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    deps,
  );
  const content = (res?.result as { content: { type: string; text: string }[] }).content;
  return content.map((c) => c.text).join('\n');
}

describe('dcp__zoom accepts every reference the system hands out', () => {
  it('recovers an F-ref passed as `handle`, sliced by the h02 query', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'redutok-h02-'));
    dirs.push(dir);
    const daemon = await startDaemon({
      port: 0,
      dcpDir: path.join(dir, '.dcp'),
      profilesDir: path.join(repoRoot, 'profiles'),
    });
    daemons.push(daemon);
    const deps: McpDeps = { target: { port: daemon.port }, sessionId: 's-h02', timeoutMs: 10_000 };

    await callTool(deps, 'dcp__read', { file_path: chalkIndex });
    // Second read serves the unchanged reference — the F-ref the h02 model saw.
    const secondRead = await callTool(deps, 'dcp__read', { file_path: chalkIndex });
    const ref = /\[dcp:file (F[0-9a-f]{4}@[0-9a-f]{16})/.exec(secondRead)?.[1];
    expect(ref).toBeDefined();

    const zoomed = await callTool(deps, 'dcp__zoom', {
      handle: ref,
      query: 'applyStyle openAll closeAll function context',
    });
    expect(zoomed).not.toContain('no artifact');
    expect(zoomed).toContain('applyStyle');
  });

  it('names the missing argument when neither id nor handle is given', async () => {
    const deps: McpDeps = { target: { port: 1 }, timeoutMs: 300 };
    const text = await callTool(deps, 'dcp__zoom', { query: 'anything' });
    expect(text).toContain('missing required argument id');
    expect(text).toContain('handle');
  });
});
