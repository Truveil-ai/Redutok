import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readAuditFile } from '@redutok/shared';
import { startDaemon } from '@redutok/sidecar';
import { handlePreToolUse, handleSessionStart, handleStop } from '@redutok/hooks';
import { handleMcpRequest, type McpDeps } from '@redutok/mcp';
import { initRepo, removeRepo } from '../src/installer.js';
import { readPidfile } from '../src/sidecar-cli.js';

/**
 * Phase 4 acceptance gate, BUILD.md: scripted headless session on a sample
 * repo. Offline by design (guardrail 8): the session loop is driven directly
 * through the same handler entry points the live hooks and MCP server use.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..', '..');

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

describe('phase 4 end-to-end smoke', () => {
  it('init, distilled read, zoom, fail-open, byte-identical remove', async () => {
    // Sample repo with one large source file (well past the redirect threshold).
    const repo = mkdtempSync(path.join(os.tmpdir(), 'redutok-e2e-'));
    mkdirSync(path.join(repo, 'src'));
    const bigSource = readFileSync(path.join(repoRoot, 'fixtures', 'artifacts', 'large-source.ts'), 'utf8')
      .split('export')
      .join('\n// section\nexport')
      .repeat(15);
    const bigPath = path.join(repo, 'src', 'big-module.ts');
    writeFileSync(bigPath, bigSource);
    expect(statSync(bigPath).size).toBeGreaterThan(65_536);
    const before = snapshot(repo);

    initRepo(repo);
    const dcpDir = path.join(repo, '.dcp');
    const daemon = await startDaemon({ port: 0, dcpDir, profilesDir: path.join(repoRoot, 'profiles') });
    try {
      // Hook target discovery exactly as the installed hook binary does it.
      const pidfile = readPidfile(dcpDir);
      expect(pidfile?.port).toBe(daemon.port);
      const hookDeps = { target: { port: pidfile?.port ?? 0 }, dcpDir, timeoutMs: 1000 };

      // 1. SessionStart injects the protocol block.
      const start = handleSessionStart({ source: 'startup' }, hookDeps);
      expect(start.hookSpecificOutput?.additionalContext).toContain('Delta Context Protocol');

      // 2. The raw Read of the large file is redirected to the dcp tool.
      const pre = await handlePreToolUse(
        { tool_name: 'Read', tool_input: { file_path: bigPath } },
        hookDeps,
      );
      expect(pre.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(pre.hookSpecificOutput?.permissionDecisionReason).toContain('dcp__read');

      // 3. The distilled path is taken through the MCP tool and audited.
      const mcpDeps: McpDeps = { target: { port: daemon.port }, timeoutMs: 10_000, sessionId: 's-e2e' };
      const readRes = await handleMcpRequest(
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'dcp__read', arguments: { file_path: bigPath } } },
        mcpDeps,
      );
      const distilled = (readRes?.result as { content: { text: string }[] }).content[0]?.text ?? '';
      expect(distilled).not.toContain('[dcp notice: sidecar unavailable');
      expect(distilled.length).toBeLessThan(bigSource.length * 0.4);
      const artifactId = /dcp__zoom\("(a[0-9a-f]+)"/.exec(distilled)?.[1];
      expect(artifactId).toBeDefined();
      const audit = readAuditFile(path.join(dcpDir, 'audit.jsonl'), 's-e2e');
      expect(audit.events.some((e) => e.action === 'distill')).toBe(true);

      // 4. Zoom recovers the raw artifact from the store, no re-execution.
      const zoomRes = await handleMcpRequest(
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dcp__zoom', arguments: { id: artifactId } } },
        mcpDeps,
      );
      const zoomed = (zoomRes?.result as { content: { text: string }[] }).content[0]?.text ?? '';
      expect(zoomed).toBe(bigSource);

      // 5. Stop hook produces the one-line session summary from a transcript.
      const stop = await handleStop(
        { transcript_path: path.join(repoRoot, 'fixtures', 'sessions', 'small.jsonl') },
        hookDeps,
      );
      expect(stop.summaryLine).toContain('Redutok by Truveil');
    } finally {
      await daemon.close();
    }

    // 6. Fail-open: with the sidecar stopped the same hook allows the raw Read.
    const preDown = await handlePreToolUse(
      { tool_name: 'Read', tool_input: { file_path: bigPath } },
      { target: { port: daemon.port }, dcpDir, timeoutMs: 100 },
    );
    expect(preDown).toEqual({});

    // 7. Remove reverts the sample repo byte-identical.
    removeRepo(repo);
    expect(snapshot(repo)).toEqual(before);
    expect(existsSync(path.join(repo, '.dcp'))).toBe(false);
  }, 60_000);
});
