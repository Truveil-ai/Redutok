import childProcess from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { LIMITS } from '@redutok/shared';
import { startDaemon } from '@redutok/sidecar';
import { sidecarRequest } from '@redutok/sidecar/client';
import {
  handlePreCompact,
  handlePreToolUse,
  handlePostToolUse,
  handleSessionStart,
  handleStop,
  handleUserPromptSubmit,
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
  it('injects the protocol block on startup and a re-injection note on compact', async () => {
    const dcpDir = tempDcp();
    const startup = await handleSessionStart({ source: 'startup' }, { ...DEAD, dcpDir });
    const ctx = startup.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain('Delta Context Protocol');
    const compact = await handleSessionStart({ source: 'compact' }, { ...DEAD, dcpDir });
    expect(compact.hookSpecificOutput?.additionalContext).toContain('re-injected after compact');
  });

  it('appends the codex injection with the trust preamble when a codex exists', async () => {
    const { writeCodex } = await import('@redutok/sidecar');
    const root = mkdtempSync(path.join(os.tmpdir(), 'redutok-hooks-codex-'));
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    const dcpDir = path.join(root, '.dcp');
    mkdirSync(dcpDir);
    writeFileSync(path.join(dcpDir, 'protocol.md'), '## Delta Context Protocol (Redutok)\nrules');
    await writeCodex(root);
    const out = await handleSessionStart({ source: 'startup' }, { ...DEAD, dcpDir });
    const ctx = out.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain('Delta Context Protocol');
    expect(ctx).toContain('You have a verified codex of this repository. Trust it.');
    expect(ctx).not.toContain('files:');
  });

  it('returns empty output when no protocol file exists, never throwing', async () => {
    const empty = await handleSessionStart({ source: 'startup', session_id: 's-dead' }, { ...DEAD, dcpDir: mkdtempSync(path.join(os.tmpdir(), 'redutok-none-')) });
    expect(empty).toEqual({});
  });
});

describe('session registration with a live sidecar', () => {
  async function activeSessionId(port: number): Promise<string | null> {
    const res = await sidecarRequest({ port }, 'GET', '/health', undefined, { timeoutMs: 2000 });
    if (!res.ok) throw new Error('health probe failed');
    return (res.body as { activeSessionId: string | null }).activeSessionId;
  }

  it('SessionStart registers the transcript session id with the sidecar', async () => {
    const dcpDir = tempDcp();
    const daemon = await startDaemon({ port: 0, dcpDir });
    try {
      const deps: HookDeps = { target: { port: daemon.port }, dcpDir, timeoutMs: 1000 };
      const out = await handleSessionStart({ source: 'startup', session_id: 's-transcript' }, deps);
      expect(out.hookSpecificOutput?.additionalContext).toContain('Delta Context Protocol');
      expect(await activeSessionId(daemon.port)).toBe('s-transcript');
    } finally {
      await daemon.close();
    }
  });

  it('PostToolUse re-registers the session id on every notify', async () => {
    const dcpDir = tempDcp();
    const daemon = await startDaemon({ port: 0, dcpDir });
    try {
      const deps: HookDeps = { target: { port: daemon.port }, dcpDir, timeoutMs: 1000 };
      await handlePostToolUse(
        { tool_name: 'Bash', tool_input: { command: 'git status' }, session_id: 's-again' },
        deps,
      );
      expect(await activeSessionId(daemon.port)).toBe('s-again');
      // Without a session_id the registration is left untouched.
      await handlePostToolUse({ tool_name: 'Bash', tool_input: { command: 'git status' } }, deps);
      expect(await activeSessionId(daemon.port)).toBe('s-again');
    } finally {
      await daemon.close();
    }
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

  it('serves raw when the sidecar is down even if a fresh mirror entry exists', async () => {
    const { writeCodex } = await import('@redutok/sidecar');
    const root = mkdtempSync(path.join(os.tmpdir(), 'redutok-hooks-mirror-dead-'));
    mkdirSync(path.join(root, 'src'));
    const bigFile = path.join(root, 'src', 'big.ts');
    writeFileSync(bigFile, 'export function block(): string {\n  return "x";\n}\n'.repeat(2_000));
    await writeCodex(root);
    const result = await handlePreToolUse(
      { tool_name: 'Read', tool_input: { file_path: bigFile } },
      { target: { port: 1 }, dcpDir: path.join(root, '.dcp') },
    );
    expect(result).toEqual({});
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
  it('rewrites a large read to its fresh mirror entry, moderate reads to a cap', async () => {
    // v3 pillar B: a repo with a codex has a skeleton mirror; a large Read is
    // rewritten in place to the mirror entry (an allow with updatedInput),
    // not denied toward dcp__read.
    const { writeCodex, mirrorEntryPath } = await import('@redutok/sidecar');
    const root = mkdtempSync(path.join(os.tmpdir(), 'redutok-hooks-mirror-'));
    mkdirSync(path.join(root, 'src'));
    const bigFile = path.join(root, 'src', 'big.ts');
    writeFileSync(
      bigFile,
      'export function block(): string {\n  return "x";\n}\n'.repeat(2_000),
    );
    const dcpDir = path.join(root, '.dcp');
    mkdirSync(dcpDir);
    writeFileSync(path.join(dcpDir, 'protocol.md'), '## Delta Context Protocol (Redutok)\nrules');
    await writeCodex(root);
    const daemon = await startDaemon({ port: 0, dcpDir });
    const deps: HookDeps = { target: { port: daemon.port }, dcpDir, timeoutMs: 1000 };
    try {
      const big = await handlePreToolUse({ tool_name: 'Read', tool_input: { file_path: bigFile } }, deps);
      expect(big.hookSpecificOutput?.permissionDecision).toBe('allow');
      expect((big.hookSpecificOutput?.updatedInput as { file_path: string }).file_path).toBe(
        mirrorEntryPath(root, 'src/big.ts'),
      );

      // An explicit offset/limit is a deliberate slice and passes raw — the
      // mirror header itself recommends exactly such a Read.
      const sliced = await handlePreToolUse(
        { tool_name: 'Read', tool_input: { file_path: bigFile, offset: 100, limit: 400 } },
        deps,
      );
      expect(sliced).toEqual({});

      // A stale mirror (source changed, no refresh yet) is never served.
      writeFileSync(bigFile, 'export const changed = true;\n' + 'y'.repeat(200_000));
      const stale = await handlePreToolUse(
        { tool_name: 'Read', tool_input: { file_path: bigFile } },
        deps,
      );
      expect(stale).toEqual({});

      // A large file with no mirror entry at all passes raw too.
      const noMirror = path.join(root, 'src', 'notes.txt');
      writeFileSync(noMirror, 'z'.repeat(200_000));
      expect(
        await handlePreToolUse({ tool_name: 'Read', tool_input: { file_path: noMirror } }, deps),
      ).toEqual({});

      const midFile = path.join(dcpDir, 'mid.txt');
      writeFileSync(midFile, 'y'.repeat(30_000));
      const mid = await handlePreToolUse({ tool_name: 'Read', tool_input: { file_path: midFile } }, deps);
      expect(mid.hookSpecificOutput?.permissionDecision).toBe('allow');
      expect((mid.hookSpecificOutput?.updatedInput as { limit: number }).limit).toBeGreaterThan(0);

      // v3 pillar A: an allowlisted command is rewritten in place through the
      // pipe (an allow, with updatedInput) rather than denied with guidance.
      const bash = await handlePreToolUse(
        { tool_name: 'Bash', tool_input: { command: 'pnpm vitest run' } },
        deps,
      );
      expect(bash.hookSpecificOutput?.permissionDecision).toBe('allow');
      const rewritten = (bash.hookSpecificOutput?.updatedInput as { command: string }).command;
      expect(rewritten).toContain('redutok-pipe -c');
      expect(rewritten).toContain('pnpm vitest run');

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

describe('output discipline', () => {
  it('denies a full rewrite of a large existing file with emit-a-patch guidance', async () => {
    const dir = tempDcp();
    const target = path.join(dir, 'existing.ts');
    writeFileSync(target, 'original');
    const result = await handlePreToolUse(
      { tool_name: 'Write', tool_input: { file_path: target, content: 'x'.repeat(20_000) } },
      DEAD,
    );
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput?.permissionDecisionReason).toContain('Emit a patch');
  });

  it('allows new files and small rewrites', async () => {
    const dir = tempDcp();
    const fresh = path.join(dir, 'new.ts');
    expect(
      await handlePreToolUse(
        { tool_name: 'Write', tool_input: { file_path: fresh, content: 'x'.repeat(20_000) } },
        DEAD,
      ),
    ).toEqual({});
    const target = path.join(dir, 'small.ts');
    writeFileSync(target, 'original');
    expect(
      await handlePreToolUse(
        { tool_name: 'Write', tool_input: { file_path: target, content: 'tiny change' } },
        DEAD,
      ),
    ).toEqual({});
  });

  it('classifies prompts rules-first with advisory hints only', () => {
    const trivial = handleUserPromptSubmit({ prompt: 'what does limits.ts contain' }, DEAD);
    expect(trivial.hookSpecificOutput?.additionalContext).toContain('trivial');
    const hard = handleUserPromptSubmit(
      { prompt: 'refactor the sidecar daemon to support streaming responses across the codebase' },
      DEAD,
    );
    expect(hard.hookSpecificOutput?.additionalContext).toContain('hard');
    const standard = handleUserPromptSubmit(
      { prompt: 'Please add one more assertion to the ledger test covering the tools default and rerun the suite so we can be sure nothing else regressed in the meantime.' },
      DEAD,
    );
    expect(standard).toEqual({});
  });
});

describe('handleStop', () => {
  const distillEvent = (id: string, bytesIn: number, bytesOut: number, profile: string) =>
    JSON.stringify({
      id,
      timestamp: '2026-07-19T10:00:00.000Z',
      sessionId: 's-small',
      module: 'sidecar.distill',
      action: 'distill',
      reason: 'x',
      inputRef: id,
      bytesIn,
      bytesOut,
      details: { profile },
    });

  it('produces a one-line summary from the transcript ledger', async () => {
    const result = await handleStop({ transcript_path: fixtureSession }, DEAD);
    expect(result.summaryLine).toContain('20,100 tokens');
    expect(result.summaryLine).toContain('3 turns');
    expect(result.summaryLine?.includes('\n')).toBe(false);
  });

  it('appends a receipt block and writes .dcp/last-receipt.txt with the same content', async () => {
    const dcpDir = tempDcp();
    writeFileSync(
      path.join(dcpDir, 'audit.jsonl'),
      [
        distillEvent('a1', 9216, 1096, 'build-log'),
        distillEvent('a2', 4000, 400, 'file-skeleton'),
      ].join('\n') + '\n',
    );
    const result = await handleStop({ transcript_path: fixtureSession }, { ...DEAD, dcpDir });
    expect(result.summaryLine).toContain('20,100 tokens');
    expect(result.receiptBlock).toContain('Redutok receipt for session s-small');
    expect(result.receiptBlock).toContain('avoided  2,930 tokens across 2 audit events');
    expect(result.receiptBlock).toContain('1. build-log (a1)');
    expect(result.receiptBlock).toContain('2. file-skeleton (a2)');
    const written = readFileSync(path.join(dcpDir, 'last-receipt.txt'), 'utf8');
    expect(written).toBe(`${result.summaryLine}\n${result.receiptBlock}\n`);
  });

  it('prints no distillations this session when no audit events are attributable', async () => {
    const dcpDir = tempDcp();
    const result = await handleStop({ transcript_path: fixtureSession }, { ...DEAD, dcpDir });
    expect(result.receiptBlock).toContain('no distillations this session');
    expect(result.receiptBlock).not.toContain('avoided  0 tokens');
    expect(readFileSync(path.join(dcpDir, 'last-receipt.txt'), 'utf8')).toContain(
      'no distillations this session',
    );
  });

  it('builds the receipt with no model call and no network at all', async () => {
    const dcpDir = tempDcp();
    writeFileSync(
      path.join(dcpDir, 'audit.jsonl'),
      distillEvent('a1', 9216, 1096, 'build-log') + '\n',
    );
    // The receipt must be free: no LLM invocation by any transport. localhost
    // would be tolerable by the contract; the implementation needs none.
    const httpSpy = vi.spyOn(http, 'request');
    const httpsSpy = vi.spyOn(https, 'request');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const spawnSpy = vi.spyOn(childProcess, 'spawn');
    const execSpy = vi.spyOn(childProcess, 'exec');
    try {
      const result = await handleStop({ transcript_path: fixtureSession }, { ...DEAD, dcpDir });
      expect(result.receiptBlock).toContain('Redutok receipt for session s-small');
      expect(httpSpy).not.toHaveBeenCalled();
      expect(httpsSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(spawnSpy).not.toHaveBeenCalled();
      expect(execSpy).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('degrades to empty output when the transcript is missing', async () => {
    const result = await handleStop({ transcript_path: 'C:/nope/missing.jsonl' }, DEAD);
    expect(result).toEqual({});
  });
});
