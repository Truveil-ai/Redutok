import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readAuditFile } from '@redutok/shared';
import { mirrorEntryPath, startDaemon, writeCodex } from '@redutok/sidecar';
import { sidecarRequest } from '@redutok/sidecar/client';
import { handlePreToolUse, type HookDeps } from '@redutok/hooks';
import { initRepo, removeRepo } from '../src/installer.js';

/**
 * Component 4 (v3 pillar B): zero-API-cost end-to-end verification of the
 * skeleton mirror. A scripted session drives the real PreToolUse handler,
 * the real codex/mirror engine, and the real daemon — no frontier model call
 * anywhere. It proves:
 *   - a Read of a large source is rewritten to the mirror entry, and the
 *     tool result (the mirror file) is the skeleton with the header line,
 *   - a Read of a small file passes untouched,
 *   - a stale mirror serves raw until the file-change notify refreshes it,
 *   - audit events land under the session id with the rule and both paths,
 *   - and redutok remove restores the repo byte-identical.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..', '..');
const SESSION = 's-e2e-mirror';

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

describe('skeleton mirror end-to-end (zero API cost)', () => {
  it('rewrites large reads to the mirror, passes small and stale raw, audits, removes clean', async () => {
    // Sample repo: one large source (past the mirror threshold), one small.
    const repo = mkdtempSync(path.join(os.tmpdir(), 'redutok-mirror-e2e-'));
    mkdirSync(path.join(repo, 'src'));
    const bigSource = readFileSync(path.join(repoRoot, 'fixtures', 'artifacts', 'large-source.ts'), 'utf8')
      .split('export')
      .join('\n// section\nexport')
      .repeat(15);
    const bigPath = path.join(repo, 'src', 'big-module.ts');
    writeFileSync(bigPath, bigSource);
    expect(statSync(bigPath).size).toBeGreaterThan(65_536);
    const smallPath = path.join(repo, 'src', 'tiny.ts');
    writeFileSync(smallPath, 'export const tiny = true;\n');
    const before = snapshot(repo);

    initRepo(repo);
    const dcpDir = path.join(repo, '.dcp');
    // The codex build persists the mirror; in production this is
    // redutok codex refresh or the daemon's file-change notify.
    await writeCodex(repo);
    const daemon = await startDaemon({ port: 0, dcpDir, profilesDir: path.join(repoRoot, 'profiles') });
    try {
      const hookDeps: HookDeps = { target: { port: daemon.port }, dcpDir, timeoutMs: 2000 };
      await sidecarRequest({ port: daemon.port }, 'POST', '/notify', { kind: 'session-start', sessionId: SESSION });

      // 1. The large Read is rewritten to the mirror entry; the tool result
      //    (what the model receives through that same Read) is the skeleton
      //    with the mandatory header line.
      const pre = await handlePreToolUse(
        { tool_name: 'Read', tool_input: { file_path: bigPath }, session_id: SESSION },
        hookDeps,
      );
      expect(pre.hookSpecificOutput?.permissionDecision).toBe('allow');
      const servedPath = (pre.hookSpecificOutput?.updatedInput as { file_path: string }).file_path;
      expect(servedPath).toBe(mirrorEntryPath(repo, 'src/big-module.ts'));
      const served = readFileSync(servedPath, 'utf8');
      const header = served.split('\n', 1)[0] ?? '';
      expect(header).toContain('[dcp:mirror of ');
      expect(header).toContain(bigPath);
      expect(header).toContain(`raw ${Buffer.byteLength(bigSource, 'utf8')} bytes`);
      expect(header).toMatch(/full fidelity: (dcp__zoom\(|Read\()/);
      // It is the skeleton, not the raw file.
      expect(served.length).toBeLessThan(bigSource.length * 0.4);

      // 2. A small file passes untouched.
      const small = await handlePreToolUse(
        { tool_name: 'Read', tool_input: { file_path: smallPath }, session_id: SESSION },
        hookDeps,
      );
      expect(small).toEqual({});

      // 3. Stale mirror: the source changes and, until the file-change
      //    notify refreshes the mirror, the Read passes through raw.
      appendFileSync(bigPath, '\nexport const EDITED = true;\n');
      const stale = await handlePreToolUse(
        { tool_name: 'Read', tool_input: { file_path: bigPath }, session_id: SESSION },
        hookDeps,
      );
      expect(stale).toEqual({});
      await sidecarRequest(
        { port: daemon.port },
        'POST',
        '/notify',
        { kind: 'file-change', tool: 'Edit', path: 'src/big-module.ts', sessionId: SESSION },
        { timeoutMs: 10_000 },
      );
      const fresh = await handlePreToolUse(
        { tool_name: 'Read', tool_input: { file_path: bigPath }, session_id: SESSION },
        hookDeps,
      );
      expect(fresh.hookSpecificOutput?.permissionDecision).toBe('allow');
      expect(readFileSync(servedPath, 'utf8')).toContain('EDITED');

      // 4. Audit events land under the session id, with the rule and both paths.
      const audit = readAuditFile(path.join(dcpDir, 'audit.jsonl'), SESSION);
      const rewrites = audit.events.filter(
        (e) => e.action === 'rewrite' && e.details?.['rule'] === 'read-mirror',
      );
      expect(rewrites.length).toBeGreaterThanOrEqual(2);
      expect(rewrites[0]?.details?.['realPath']).toBe(bigPath);
      expect(rewrites[0]?.details?.['mirrorPath']).toBe(servedPath);

      // Measured skeleton figures for the closing summary.
      const rawBytes = Buffer.byteLength(bigSource, 'utf8');
      const servedBytes = Buffer.byteLength(served, 'utf8');
      console.log(
        `[mirror-e2e] raw ${rawBytes}B -> skeleton ${servedBytes}B ` +
          `(${(rawBytes / servedBytes).toFixed(2)}x smaller), served through the same Read`,
      );
    } finally {
      await daemon.close();
    }

    // 5. Remove restores everything byte-identical. The scripted edit is user
    //    work, not managed state, so the script undoes it first.
    writeFileSync(bigPath, bigSource);
    removeRepo(repo);
    expect(snapshot(repo)).toEqual(before);
    expect(existsSync(path.join(repo, '.dcp'))).toBe(false);
  }, 60_000);
});
