import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readAuditFile } from '@redutok/shared';
import { startDaemon } from '@redutok/sidecar';
import { decideRewrite, loadAllowlist } from '@redutok/hooks';
import { initRepo } from '../src/installer.js';

/**
 * The rep-1 127 regression (2026-07-30): the shipped allowlist invoked the
 * pipe as a bare `redutok-pipe` bin, which resolves in no freshly-initialized
 * repo — the rewritten s02 command died at the shell (`command not found`),
 * no distill event was ever produced, and the error-fix miner starved one
 * level below the allowlist. This test runs the exact s02 command through the
 * real rewrite in a bare temp repo straight out of `redutok init`, executes
 * the rewritten form in a real POSIX shell (the same shell the live session
 * used), and asserts the pipe ran: exit code preserved, no 127, and a
 * sidecar.distill audit event with a conclusive fail verdict on the failing
 * verify output.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..', '..');
const profilesDir = path.join(repoRoot, 'profiles');
const fixture = path.join(repoRoot, 'fixtures', 'repos', 'axios');

function bareRepo(): string {
  // Not 'redutok-pipe-…': that substring in the repo path would trip the
  // legacy double-wrap guard and mask the very rewrite under test.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'redutok-launcher-'));
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  mkdirSync(path.join(dir, 'lib', 'core'), { recursive: true });
  mkdirSync(path.join(dir, 'lib', 'helpers'), { recursive: true });
  for (const rel of [
    'package.json',
    path.join('scripts', 'verify-url-assembly.mjs'),
    path.join('lib', 'core', 'buildFullPath.js'),
    path.join('lib', 'helpers', 'combineURLs.js'),
    path.join('lib', 'helpers', 'isAbsoluteURL.js'),
  ]) {
    writeFileSync(path.join(dir, rel), readFileSync(path.join(fixture, rel)));
  }
  return dir;
}

interface ShellResult {
  status: number | null;
  text: string;
}

// Async spawn: the daemon runs in this test process; a sync child would block
// the event loop that must serve /distill. bash is the shell the live Bash
// tool used (git-bash on Windows, where it handles Windows-style cd paths).
function runBash(command: string, env: Record<string, string>): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', command], { env: { ...process.env, ...env } });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, text: Buffer.concat(chunks).toString('utf8') }));
  });
}

describe('pipe launcher end-to-end in a bare initialized repo', () => {
  it('the exact s02 command rewrites, executes the pipe (no 127), and produces a distill event', async () => {
    const repo = bareRepo();
    initRepo(repo);
    const dcpDir = path.join(repo, '.dcp');
    const daemon = await startDaemon({ port: 0, dcpDir, profilesDir });
    try {
      // The exact command shape from the s02-redutok transcripts, against
      // this bare repo's own path.
      const command = `cd "${repo}" && node scripts/verify-url-assembly.mjs`;
      const decision = decideRewrite(command, loadAllowlist(dcpDir));
      expect(decision?.rule).toBe('node-script');
      expect(decision?.command).toContain('node .claude/redutok/pipe.mjs -c');

      // REDUTOK_HOME mirrors the bench runner (runClaude): the bare repo has
      // no node_modules, so the launcher resolves through this checkout.
      const run = await runBash(decision?.command ?? '', { REDUTOK_HOME: repoRoot });
      expect(run.text).not.toContain('command not found');
      expect(run.status).toBe(1); // the seeded verify failure, exit preserved
      expect(run.text).toContain('FAIL: combineURLs strips the duplicate slash at the joint');

      // The starved link of the chain: a distill event now exists, routed to
      // test-output, with a conclusive fail verdict for the error-fix miner.
      const events = readAuditFile(path.join(dcpDir, 'audit.jsonl')).events;
      const distill = events.find((e) => e.module === 'sidecar.distill');
      expect(distill).toBeDefined();
      expect(distill?.details?.['profile']).toBe('test-output');
      const gates = distill?.details?.['gates'] as { gate: string; detail: string }[];
      const verdict = gates.find((g) => g.gate === 'verdict-fidelity');
      expect(verdict?.detail).toMatch(/verdict fail agreed|raw verdict fail but/);
    } finally {
      await daemon.close();
    }

    // Fail-open leg: with no resolvable install at all, the launcher still
    // runs the wrapped command raw with the exit code preserved — never 127,
    // never a swallowed command.
    const cold = await runBash(
      `cd "${repo}" && node .claude/redutok/pipe.mjs -c 'node scripts/verify-url-assembly.mjs'`,
      { REDUTOK_HOME: mkdtempSync(path.join(os.tmpdir(), 'redutok-nohome-')) },
    );
    expect(cold.status).toBe(1);
    expect(cold.text).toContain('FAIL: combineURLs strips the duplicate slash at the joint');
  }, 40_000);
});
