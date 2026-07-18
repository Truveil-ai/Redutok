import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { LIMITS } from '@redutok/shared';
import { buildLedger, grandTotal, parseSessionFile } from '@redutok/meter';
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

export function handleSessionStart(
  input: { source?: string },
  deps: HookDeps,
): HookOutput {
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
  input: { tool_name?: string; tool_input?: Record<string, unknown> },
  deps: HookDeps,
): Promise<HookOutput> {
  const tool = input.tool_name ?? '';
  const kind = tool === 'Edit' || tool === 'Write' ? 'file-change' : 'tool-use';
  await sidecarRequest(
    deps.target,
    'POST',
    '/notify',
    { kind, tool, path: input.tool_input?.['file_path'] },
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

export async function handleStop(
  input: { transcript_path?: string },
  _deps: HookDeps,
): Promise<HookOutput> {
  const transcript = input.transcript_path;
  if (transcript === undefined || !existsSync(transcript)) return {};
  try {
    const ledger = buildLedger(await parseSessionFile(transcript));
    const total = grandTotal(ledger.totals).toLocaleString('en-US');
    return {
      summaryLine: `Redutok: ${total} tokens across ${ledger.entries.length} turns this session. Run redutok report --last for detail. Redutok by Truveil`,
    };
  } catch {
    return {};
  }
}
