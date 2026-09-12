import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mirrorEntryPath, startDaemon, writeCodex } from '@redutok/sidecar';
import { initRepo } from '../src/installer.js';

/**
 * Field defect, ResponsibleAI on redutok 0.1.7: after the model ran
 * `cd deploy/assets/reports`, every hook failed with "Cannot find module
 * ...\deploy\assets\reports\.claude\redutok\hook.mjs" and the session ran
 * ungoverned; doctor, run from the root, reported zero fails.
 *
 * This drives the real chain as a session would: the exact hook command init
 * registered, spawned through a shell whose working directory is below the
 * project root, the committed launcher, the built hook entry, and a live
 * daemon. It then runs the rewritten shell command from that same directory,
 * which is where the Bash and PowerShell tools run it.
 */

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SESSION = 's-e2e-hook-subdir';

let priorHome: string | undefined;
beforeEach(() => {
  priorHome = process.env['REDUTOK_HOME'];
  process.env['REDUTOK_HOME'] = repoRoot;
});
afterEach(() => {
  if (priorHome === undefined) delete process.env['REDUTOK_HOME'];
  else process.env['REDUTOK_HOME'] = priorHome;
});

interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Asynchronous on purpose: the daemon lives in this test process, and a
 * spawnSync would block the event loop it answers on, so every hook would
 * time out its health probe and fail open.
 */
function run(file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; shell?: boolean; input?: string }): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: options.cwd, env: options.env, shell: options.shell ?? false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(options.input ?? '');
  });
}

async function runHook(command: string, cwd: string, payload: object, env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  const res = await run(command, [], { cwd, env, shell: true, input: JSON.stringify(payload) });
  expect(res.stderr, 'the hook command must load from a subdirectory').not.toContain('Cannot find module');
  expect(res.status).toBe(0);
  return JSON.parse(res.stdout.trim()) as Record<string, unknown>;
}

describe('hooks run from a subdirectory of the project (zero API cost)', () => {
  it('governs a large Read and a rewritten command after the shell has cd-ed below the root', async () => {
    // realpath: the daemon and the hook must agree on the root byte for byte,
    // or the cross-repo guard refuses (Windows temp paths come back 8.3-short).
    const repo = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'redutok-hook-subdir-')));
    const sources = path.join(repo, 'sources');
    mkdirSync(sources);
    const bigPath = path.join(sources, 'framework.md');
    const section = (n: number): string =>
      `## Article ${n}\n\n${'The controller shall document every processing purpose in the register. '.repeat(40)}\n\n`;
    writeFileSync(bigPath, `# Accreditation framework\n\n${Array.from({ length: 30 }, (_, i) => section(i + 1)).join('')}`);
    expect(readFileSync(bigPath).length).toBeGreaterThan(65_536);
    writeFileSync(path.join(sources, 'check-ok.mjs'), "console.log('check ok');\n");

    initRepo(repo);
    await writeCodex(repo);
    const dcpDir = path.join(repo, '.dcp');
    const daemon = await startDaemon({ port: 0, dcpDir, profilesDir: path.join(repoRoot, 'profiles') });
    try {
      const settings = JSON.parse(readFileSync(path.join(repo, '.claude', 'settings.local.json'), 'utf8')) as {
        hooks: Record<string, { hooks: { command: string }[] }[]>;
      };
      const preToolUse = settings.hooks['PreToolUse']?.[0]?.hooks[0]?.command ?? '';
      // What Claude Code gives a hook process: the project root, forward slashes.
      const hookEnv: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: repo.replace(/\\/g, '/') };
      delete hookEnv['REDUTOK_DCP_DIR'];

      // 1. The large Read, fired from sources/, is served the skeleton.
      const read = await runHook(
        preToolUse,
        sources,
        { session_id: SESSION, hook_event_name: 'PreToolUse', tool_name: 'Read', cwd: sources, tool_input: { file_path: bigPath } },
        hookEnv,
      );
      const readOut = read['hookSpecificOutput'] as { updatedInput: { file_path: string } };
      expect(readOut.updatedInput.file_path).toBe(mirrorEntryPath(repo, 'sources/framework.md'));

      // 2. An allowlisted command, fired from sources/, is rewritten; the
      //    rewrite then has to run from sources/ too. The tools' own shells
      //    carry no CLAUDE_PROJECT_DIR, so it is absent here.
      const tool = process.platform === 'win32' ? 'PowerShell' : 'Bash';
      const rewrite = await runHook(
        preToolUse,
        sources,
        { session_id: SESSION, hook_event_name: 'PreToolUse', tool_name: tool, cwd: sources, tool_input: { command: 'node check-ok.mjs' } },
        hookEnv,
      );
      const rewritten = (rewrite['hookSpecificOutput'] as { updatedInput: { command: string } }).updatedInput.command;
      expect(rewritten).toContain('redutok/pipe.mjs');
      const toolEnv: NodeJS.ProcessEnv = { ...process.env };
      delete toolEnv['CLAUDE_PROJECT_DIR'];
      const ran =
        process.platform === 'win32'
          ? await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', rewritten], { cwd: sources, env: toolEnv })
          : await run('sh', ['-c', rewritten], { cwd: sources, env: toolEnv });
      expect(ran.stderr).not.toContain('Cannot find module');
      expect(ran.status).toBe(0);
      expect(ran.stdout).toContain('check ok');
    } finally {
      await daemon.close();
    }
  }, 120_000);
});
