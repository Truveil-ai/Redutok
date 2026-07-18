import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LIMITS } from '@redutok/shared';
import { startDaemon } from '@redutok/sidecar';
import {
  handlePreCompact,
  handlePreToolUse,
  handlePostToolUse,
  handleSessionStart,
  handleStop,
  type HookDeps,
} from '../src/handlers.js';

const fixtureSession = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'fixtures',
  'sessions',
  'small.jsonl',
);

function tempDcp(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'redutok-hooks-'));
  writeFileSync(path.join(dir, 'protocol.md'), '## Delta Context Protocol (Redutok)\nrules here');
  return dir;
}

const DEAD: HookDeps = { target: { port: 1 }, dcpDir: tempDcp() };

describe('handleSessionStart', () => {
  it('injects the protocol block on startup and a re-injection note on compact', () => {
    const dcpDir = tempDcp();
    const startup = handleSessionStart({ source: 'startup' }, { ...DEAD, dcpDir });
    const ctx = startup.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain('Delta Context Protocol');
    const compact = handleSessionStart({ source: 'compact' }, { ...DEAD, dcpDir });
    expect(compact.hookSpecificOutput?.additionalContext).toContain('re-injected after compact');
  });

  it('returns empty output when no protocol file exists, never throwing', () => {
    const empty = handleSessionStart({ source: 'startup' }, { ...DEAD, dcpDir: mkdtempSync(path.join(os.tmpdir(), 'redutok-none-')) });
    expect(empty).toEqual({});
  });
});

describe('handlePreToolUse fail-open budget', () => {
  it('allows a large Read untouched within the 50ms budget when the sidecar is dead', async () => {
    const bigFile = path.join(tempDcp(), 'big.txt');
    writeFileSync(bigFile, 'x'.repeat(200_000));
    const started = Date.now();
    const result = await handlePreToolUse(
      { tool_name: 'Read', tool_input: { file_path: bigFile } },
      DEAD,
    );
    const elapsed = Date.now() - started;
    expect(result).toEqual({});
    // Generous CI margin; the contract is LIMITS.HOOK_FAIL_OPEN_MS for the
    // sidecar probe itself, asserted by construction below.
    expect(elapsed).toBeLessThan(LIMITS.HOOK_FAIL_OPEN_MS * 10);
  });

  it('always allows small reads without probing the sidecar at all', async () => {
    const smallFile = path.join(tempDcp(), 'small.txt');
    writeFileSync(smallFile, 'tiny');
    const result = await handlePreToolUse(
      { tool_name: 'Read', tool_input: { file_path: smallFile } },
      DEAD,
    );
    expect(result).toEqual({});
  });
});

describe('handlePreToolUse with a live sidecar', () => {
  it('redirects large reads and expensive bash to dcp tools, rewrites moderate reads', async () => {
    const dcpDir = tempDcp();
    const daemon = await startDaemon({ port: 0, dcpDir });
    const deps: HookDeps = { target: { port: daemon.port }, dcpDir, timeoutMs: 1000 };
    try {
      const bigFile = path.join(dcpDir, 'big.txt');
      writeFileSync(bigFile, 'x'.repeat(200_000));
      const big = await handlePreToolUse({ tool_name: 'Read', tool_input: { file_path: bigFile } }, deps);
      expect(big.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(big.hookSpecificOutput?.permissionDecisionReason).toContain('dcp__read');

      const midFile = path.join(dcpDir, 'mid.txt');
      writeFileSync(midFile, 'y'.repeat(30_000));
      const mid = await handlePreToolUse({ tool_name: 'Read', tool_input: { file_path: midFile } }, deps);
      expect(mid.hookSpecificOutput?.permissionDecision).toBe('allow');
      expect((mid.hookSpecificOutput?.updatedInput as { limit: number }).limit).toBeGreaterThan(0);

      const bash = await handlePreToolUse(
        { tool_name: 'Bash', tool_input: { command: 'pnpm vitest run' } },
        deps,
      );
      expect(bash.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(bash.hookSpecificOutput?.permissionDecisionReason).toContain('dcp__run');

      const cheapBash = await handlePreToolUse(
        { tool_name: 'Bash', tool_input: { command: 'git status' } },
        deps,
      );
      expect(cheapBash).toEqual({});
    } finally {
      await daemon.close();
    }
  });
});

describe('handlePostToolUse and handlePreCompact', () => {
  it('post notify never throws on a dead sidecar, precompact injects rolling state', async () => {
    await expect(
      handlePostToolUse({ tool_name: 'Edit', tool_input: { file_path: 'x.ts' } }, DEAD),
    ).resolves.toEqual({});
    const dcpDir = tempDcp();
    mkdirSync(dcpDir, { recursive: true });
    writeFileSync(path.join(dcpDir, 'session-state.md'), 'task: finish phase 4');
    const out = handlePreCompact({}, { ...DEAD, dcpDir });
    expect(out.hookSpecificOutput?.additionalContext).toContain('task: finish phase 4');
  });
});

describe('handleStop', () => {
  it('produces a one-line summary from the transcript ledger', async () => {
    const result = await handleStop({ transcript_path: fixtureSession }, DEAD);
    expect(result.summaryLine).toContain('20,100 tokens');
    expect(result.summaryLine).toContain('3 turns');
    expect(result.summaryLine?.includes('\n')).toBe(false);
  });

  it('degrades to empty output when the transcript is missing', async () => {
    const result = await handleStop({ transcript_path: 'C:/nope/missing.jsonl' }, DEAD);
    expect(result).toEqual({});
  });
});
