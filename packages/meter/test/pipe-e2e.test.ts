import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readAuditFile } from '@redutok/shared';
import { startDaemon } from '@redutok/sidecar';
import { sidecarRequest } from '@redutok/sidecar/client';
import { handlePreToolUse, type HookDeps } from '@redutok/hooks';

/**
 * Component 4 (v3 pillar A): zero-API-cost end-to-end verification of the pipe
 * distiller. A scripted session drives an allowlisted failing build through the
 * real PreToolUse rewrite and the real sidecar distill/store/audit pipeline —
 * no frontier model call anywhere. It proves, against the same profiles and
 * gates production uses:
 *   - the rewrite fires for the build command,
 *   - the tool result carries the distilled verdict and a zoom handle, not the
 *     raw log,
 *   - the exit code matches a vanilla run exactly,
 *   - zoom recovers the full log byte-for-byte,
 *   - audit events (rewrite + distill) exist under the session id,
 *   - and with the sidecar stopped the pipe's output is identical to vanilla.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..', '..');
const profilesDir = path.join(repoRoot, 'profiles');
const pipeJs = path.join(here, '..', 'dist', 'pipe.js');
const fixtureDir = path.join(repoRoot, 'fixtures', 'repos', 'failing-tsc-build');
const BUILD_CMD = 'node scripts/build.mjs';
const SESSION = 's-e2e-pipe';

interface RunResult {
  stdout: Buffer;
  stderr: Buffer;
  status: number | null;
}

// Async spawn, not spawnSync: the sidecar daemon runs in this same test process,
// so a synchronous child would block the event loop that must serve the pipe's
// /distill request, deadlocking it into a timeout. In production the daemon is a
// separate process and this constraint does not exist.
function runNode(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', args, { cwd: fixtureDir, env: { ...process.env, ...env } });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', reject);
    child.on('close', (status) =>
      resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err), status }),
    );
  });
}

describe('pipe distiller end-to-end (zero API cost)', () => {
  it('rewrites, distills, preserves exit, zooms byte-equal, audits, and fails open', async () => {
    const dcpDir = mkdtempSync(path.join(os.tmpdir(), 'redutok-pipe-e2e-'));
    writeFileSync(path.join(dcpDir, 'protocol.md'), '## Delta Context Protocol (Redutok)\nrules');
    const daemon = await startDaemon({ port: 0, dcpDir, profilesDir });
    const target = { port: daemon.port };

    try {
      // Register the transcript session so the sidecar attributes artifacts and
      // audit events to it (as the SessionStart/PostToolUse hooks do live).
      await sidecarRequest(target, 'POST', '/notify', { kind: 'session-start', sessionId: SESSION });

      // 1. The rewrite fires for the allowlisted build command.
      const deps: HookDeps = { target, dcpDir, timeoutMs: 2000 };
      const pre = await handlePreToolUse(
        { tool_name: 'Bash', tool_input: { command: BUILD_CMD }, session_id: SESSION },
        deps,
      );
      expect(pre.hookSpecificOutput?.permissionDecision).toBe('allow');
      expect((pre.hookSpecificOutput?.updatedInput as { command: string }).command).toBe(
        `redutok-pipe -c '${BUILD_CMD}'`,
      );

      // Reference: a vanilla run of the same command.
      const vanilla = await runNode(['scripts/build.mjs']);
      const rawText = vanilla.stdout.toString('utf8') + vanilla.stderr.toString('utf8');
      expect(vanilla.status).toBe(1);

      // 2. Run the rewritten command (its post-shell-parse form: `-c <cmd>`).
      const piped = await runNode([pipeJs, '-c', BUILD_CMD], {
        REDUTOK_DCP_DIR: dcpDir,
        REDUTOK_PORT: String(daemon.port),
        REDUTOK_SESSION_ID: SESSION,
      });
      const toolResult = piped.stdout.toString('utf8');

      // The tool result is the distilled verdict plus a zoom handle, not the log.
      expect(toolResult).toContain('VERDICT: fail');
      expect(toolResult).toContain('dcp__zoom(');
      expect(toolResult).not.toContain('[compile] src/'); // raw noise is gone
      expect(toolResult.length).toBeLessThan(rawText.length);

      // 3. Exit code matches the vanilla run exactly.
      expect(piped.status).toBe(vanilla.status);
      expect(piped.status).toBe(1);

      // 4. Zoom recovers the full log byte-for-byte, no re-execution.
      const artifactId = /\[dcp:artifact (a[0-9a-f]+),/.exec(toolResult)?.[1];
      expect(artifactId).toBeDefined();
      const zoom = await sidecarRequest(target, 'POST', '/zoom', { id: artifactId });
      expect(zoom.ok).toBe(true);
      const zoomed = (zoom.ok ? (zoom.body as { text: string }).text : '');
      expect(zoomed).toBe(rawText);

      // 5. Audit events exist under the session id: the rewrite decision and the
      //    distillation, both attributed to the registered session.
      const audit = readAuditFile(path.join(dcpDir, 'audit.jsonl'), SESSION);
      expect(audit.events.some((e) => e.action === 'rewrite' && e.details?.['rule'] === 'build')).toBe(true);
      expect(audit.events.some((e) => e.action === 'distill')).toBe(true);

      // Measured distillation figures for the closing summary.
      const rawBytes = Buffer.byteLength(rawText, 'utf8');
      const resultBytes = Buffer.byteLength(toolResult, 'utf8');
      console.log(
        `[pipe-e2e] raw ${rawBytes}B -> tool result ${resultBytes}B ` +
          `(${(rawBytes / resultBytes).toFixed(2)}x smaller); exit ${piped.status}; zoom byte-equal`,
      );
    } finally {
      await daemon.close();
    }

    // 6. Fail-open: with the sidecar stopped, the pipe's output is identical to
    //    vanilla. REDUTOK_PORT=1 forces a dead target (the pidfile is gone) so
    //    the pipe cannot reach any other sidecar on the default port.
    const vanilla = await runNode(['scripts/build.mjs']);
    const down = await runNode([pipeJs, '-c', BUILD_CMD], {
      REDUTOK_DCP_DIR: dcpDir,
      REDUTOK_PORT: '1',
    });
    expect(down.stdout.toString('utf8')).toBe(vanilla.stdout.toString('utf8'));
    expect(down.stderr.toString('utf8')).toBe(vanilla.stderr.toString('utf8'));
    expect(down.status).toBe(vanilla.status);
  }, 30_000);
});
