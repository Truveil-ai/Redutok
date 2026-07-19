import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { LIMITS } from '@redutok/shared';
import { buildLedger, grandTotal, parseSessionFile } from 'redutok';
import { sidecarRequest, type SidecarTarget } from '@redutok/sidecar/client';
import { buildCodexInjection, readCodex } from '@redutok/sidecar';

/**
 * Pure hook handlers for every Claude Code lifecycle event Redutok uses.
 * Fail-open is the law here: a dead sidecar means the hook answers allow (or
 * empty) within LIMITS.HOOK_FAIL_OPEN_MS and the session runs vanilla.
 */

export interface HookDeps {
  target: SidecarTarget;
  dcpDir: string;
  /** Sidecar probe budget; defaults to the 50ms fail-open limit. */
  timeoutMs?: number;
}

export interface HookOutput {
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext?: string;
    permissionDecision?: 'allow' | 'deny';
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
  };
  summaryLine?: string;
}

/** Reads below this pass untouched without even probing the sidecar. */
export const SMALL_READ_BYTES = 16_384;
/** Reads above this are redirected to dcp__read; between, updatedInput caps the read. */
export const LARGE_READ_BYTES = 65_536;

const EXPENSIVE_BASH = /\b(tsc|vitest|jest|pytest|cargo (?:build|test)|go (?:build|test)|(?:pnpm|npm|yarn) (?:run )?(?:build|test|lint))\b/;

async function sidecarUp(deps: HookDeps): Promise<boolean> {
  const res = await sidecarRequest(deps.target, 'GET', '/health', undefined, {
    timeoutMs: deps.timeoutMs ?? LIMITS.HOOK_FAIL_OPEN_MS,
  });
  return res.ok && res.status === 200;
}

/**
 * Registers the transcript session id with the sidecar so artifacts and audit
 * events are attributed to it (the MCP server never learns the transcript id).
 * Fail-open like every hook path; a dead sidecar costs one timed-out probe.
 */
async function registerSession(sessionId: string | undefined, deps: HookDeps): Promise<void> {
  if (sessionId === undefined || sessionId === '') return;
  await sidecarRequest(
    deps.target,
    'POST',
    '/notify',
    { kind: 'session-start', sessionId },
    { timeoutMs: deps.timeoutMs ?? LIMITS.HOOK_FAIL_OPEN_MS },
  );
}

export async function handleSessionStart(
  input: { source?: string; session_id?: string },
  deps: HookDeps,
): Promise<HookOutput> {
  await registerSession(input.session_id, deps);
  const protocolPath = path.join(deps.dcpDir, 'protocol.md');
  if (!existsSync(protocolPath)) return {};
  const block = readFileSync(protocolPath, 'utf8');
  const source = input.source ?? 'startup';
  const prefix =
    source === 'compact' || source === 'resume'
      ? `Redutok protocol re-injected after ${source}.\n\n`
      : '';
  let codexInjection = '';
  try {
    const root = path.dirname(path.resolve(deps.dcpDir));
    const { codex } = readCodex(root);
    if (codex !== undefined) codexInjection = '\n\n' + buildCodexInjection(codex);
  } catch {
    codexInjection = '';
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: prefix + block + codexInjection,
    },
  };
}

export async function handlePreToolUse(
  input: { tool_name?: string; tool_input?: Record<string, unknown> },
  deps: HookDeps,
): Promise<HookOutput> {
  const tool = input.tool_name ?? '';
  const args = input.tool_input ?? {};
  const deny = (reason: string): HookOutput => ({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });

  try {
    if (tool === 'Read') {
      const filePath = String(args['file_path'] ?? '');
      if (filePath === '' || !existsSync(filePath)) return {};
      const size = statSync(filePath).size;
      if (size <= SMALL_READ_BYTES) return {};
      if (!(await sidecarUp(deps))) return {};
      if (size > LARGE_READ_BYTES) {
        return deny(
          `File is ${Math.round(size / 1024)}KB. Call dcp__read("${filePath}") for a distilled skeleton with a zoom handle instead of reading it raw.`,
        );
      }
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { ...args, limit: 400 },
        },
      };
    }
    if (tool === 'Write') {
      // Output discipline, architecture 6.1: full rewrites of large existing
      // files draw emit-a-patch guidance; new files always pass.
      const filePath = String(args['file_path'] ?? '');
      const content = String(args['content'] ?? '');
      if (
        filePath !== '' &&
        existsSync(filePath) &&
        Buffer.byteLength(content, 'utf8') > LIMITS.FULL_REWRITE_MAX_BYTES
      ) {
        return deny(
          `Rewriting ${Math.round(Buffer.byteLength(content, 'utf8') / 1024)}KB of an existing file wholesale. Emit a patch instead: use Edit with targeted old and new strings, or split the change.`,
        );
      }
      return {};
    }
    if (tool === 'Bash') {
      const command = String(args['command'] ?? '');
      if (!EXPENSIVE_BASH.test(command)) return {};
      if (!(await sidecarUp(deps))) return {};
      return deny(
        `This command produces bulky output. Call dcp__run(${JSON.stringify(command)}) for a distilled verdict with a zoom handle.`,
      );
    }
    if (tool === 'Grep' || tool === 'Glob') {
      const scoped = args['path'] !== undefined && String(args['path']) !== '.';
      if (scoped) return {};
      if (!(await sidecarUp(deps))) return {};
      return deny(
        `Broad ${tool} over the whole tree is bulky. Call dcp__search("${String(args['pattern'] ?? args['glob'] ?? '')}") for ranked, capped hits with a zoom handle.`,
      );
    }
    return {};
  } catch {
    return {};
  }
}

export async function handlePostToolUse(
  input: { tool_name?: string; tool_input?: Record<string, unknown>; session_id?: string },
  deps: HookDeps,
): Promise<HookOutput> {
  const tool = input.tool_name ?? '';
  const kind = tool === 'Edit' || tool === 'Write' ? 'file-change' : 'tool-use';
  // sessionId re-registers the transcript session on every notify, so a
  // sidecar restarted mid-session regains attribution on the next tool use.
  await sidecarRequest(
    deps.target,
    'POST',
    '/notify',
    { kind, tool, path: input.tool_input?.['file_path'], sessionId: input.session_id },
    { timeoutMs: deps.timeoutMs ?? LIMITS.HOOK_FAIL_OPEN_MS },
  );
  return {};
}

export function handlePreCompact(_input: unknown, deps: HookDeps): HookOutput {
  const statePath = path.join(deps.dcpDir, 'session-state.md');
  const state = existsSync(statePath)
    ? readFileSync(statePath, 'utf8')
    : 'No rolling state recorded yet.';
  return {
    hookSpecificOutput: {
      hookEventName: 'PreCompact',
      additionalContext: `Redutok rolling session state, preserve through compaction:\n${state}`,
    },
  };
}

const HARD_PROMPT = /\b(refactor|architect|design|migrate|debug|rewrite|overhaul|end.to.end|across the (?:repo|codebase))\b/i;

/**
 * Rules-first complexity classifier, architecture 6.3. Advisory only in v1:
 * it injects a thinking-budget hint, never a constraint.
 */
export function handleUserPromptSubmit(input: { prompt?: string }, _deps: HookDeps): HookOutput {
  const prompt = input.prompt ?? '';
  if (prompt === '') return {};
  let tier: 'trivial' | 'standard' | 'hard' = 'standard';
  if (HARD_PROMPT.test(prompt)) tier = 'hard';
  else if (prompt.length <= LIMITS.TRIVIAL_PROMPT_MAX_CHARS && !prompt.includes('\n')) tier = 'trivial';
  const hints = {
    trivial: 'Advisory: this looks like a trivial request. Minimal thinking should suffice; answer directly.',
    standard: '',
    hard: 'Advisory: this looks like a hard, multi-step task. Plan before acting; extended thinking is warranted.',
  } as const;
  if (hints[tier] === '') return {};
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: hints[tier],
    },
  };
}

export async function handleStop(
  input: { transcript_path?: string },
  _deps: HookDeps,
): Promise<HookOutput> {
  const transcript = input.transcript_path;
  if (transcript === undefined || !existsSync(transcript)) return {};
  try {
    const ledger = buildLedger(await parseSessionFile(transcript));
    const total = grandTotal(ledger.totals).toLocaleString('en-US');
    // Split advisor inlined (not imported from the meter) to keep the
    // hooks-before-meter build order acyclic; the meter's discipline module
    // carries the same threshold from limits.ts for reports.
    const last = ledger.entries[ledger.entries.length - 1];
    const split =
      last !== undefined &&
      last.tokens.input + last.tokens.cacheRead > LIMITS.SPLIT_ADVISOR_CONTEXT_TOKENS;
    const advisor = split
      ? ' Split point detected. redutok handoff will open a fresh session pre-loaded with codex plus state instead of carrying the full transcript.'
      : '';
    return {
      summaryLine: `Redutok: ${total} tokens across ${ledger.entries.length} turns this session.${advisor} Run redutok report --last for detail. Redutok by Truveil`,
    };
  } catch {
    return {};
  }
}
