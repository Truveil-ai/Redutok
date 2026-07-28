import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LIMITS } from '@redutok/shared';
import {
  buildLedger,
  buildSessionReceipt,
  grandTotal,
  parseSessionFile,
  renderReceiptBlock,
} from 'redutok';
import { sidecarRequest, type SidecarTarget } from '@redutok/sidecar/client';
import {
  assessSessionPosture,
  buildInjection,
  mirrorEntryPath,
  mirrorHash,
  readCodex,
  readMirrorIndex,
  type CodexInjection,
  type PostureDecision,
} from '@redutok/sidecar';
import type { SessionPostureRecord } from '@redutok/shared';
import { decideRewrite, loadAllowlist } from './pipe-allowlist.js';

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
  /** Multi-line session receipt printed under the summary line on Stop. */
  receiptBlock?: string;
}

/** Reads below this pass untouched without even probing the sidecar. */
export const SMALL_READ_BYTES = 16_384;
/** Reads above this serve the skeleton mirror; between, updatedInput caps the read. */
export const LARGE_READ_BYTES = 65_536;

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

/** The session's posture record, written by SessionStart and read by every
 * per-turn hook and by Stop. Missing, stale, or mismatched records mean full
 * engagement: the failure direction is never a wrongly idle session. */
function readPostureRecord(deps: HookDeps): SessionPostureRecord | undefined {
  try {
    return JSON.parse(
      readFileSync(path.join(deps.dcpDir, 'session-posture.json'), 'utf8'),
    ) as SessionPostureRecord;
  } catch {
    return undefined;
  }
}

function idleFor(deps: HookDeps, sessionId: string | undefined): boolean {
  const record = readPostureRecord(deps);
  if (record === undefined || record.posture !== 'idle') return false;
  return sessionId === undefined || sessionId === '' || record.sessionId === sessionId;
}

export async function handleSessionStart(
  input: { source?: string; session_id?: string },
  deps: HookDeps,
): Promise<HookOutput> {
  await registerSession(input.session_id, deps);
  const protocolPath = path.join(deps.dcpDir, 'protocol.md');
  if (!existsSync(protocolPath)) return {};
  const root = path.dirname(path.resolve(deps.dcpDir));

  // v4 pillar 4 (docs/POSTURE.md): governance engages proportionally to what
  // it can earn. Any assessment failure engages full governance: the
  // fail-open direction here is the current, fully-engaged behavior.
  let decision: PostureDecision = {
    posture: 'full',
    assessment: { files: 0, sourceBytes: 0, learnedEntries: 0, pitfallEntries: 0, capped: false },
    pinned: false,
  };
  try {
    decision = assessSessionPosture(root, deps.dcpDir);
  } catch {
    // Assessed as full above.
  }

  let injection: CodexInjection | undefined;
  if (decision.posture !== 'idle') {
    try {
      const { codex } = readCodex(root);
      if (codex !== undefined) {
        injection = buildInjection(codex, {
          posture: decision.posture === 'light' ? 'light' : 'full',
        });
      }
    } catch {
      injection = undefined;
    }
  }

  const record: SessionPostureRecord = {
    sessionId: input.session_id ?? '',
    posture: decision.posture,
    pinned: decision.pinned,
    ...decision.assessment,
    decidedAt: new Date().toISOString(),
  };
  try {
    writeFileSync(
      path.join(deps.dcpDir, 'session-posture.json'),
      JSON.stringify(record, null, 2) + '\n',
    );
  } catch {
    // Best-effort: a missing record means per-turn hooks stay fully engaged.
  }
  // The decision is audited through the sidecar (fail-open like every hook
  // path); the audit event also carries the injected/excluded candidate refs
  // for per-lesson attribution (docs/POSTURE.md).
  await sidecarRequest(
    deps.target,
    'POST',
    '/notify',
    {
      kind: 'session-posture',
      sessionId: input.session_id,
      posture: decision.posture,
      pinned: decision.pinned,
      ...decision.assessment,
      injectedLearned: injection?.injectedLearned ?? [],
      excludedLearned: injection?.excludedLearned ?? [],
      injectedPitfalls: injection?.injectedPitfalls ?? [],
      droppedSections: injection?.droppedSections ?? [],
    },
    { timeoutMs: deps.timeoutMs ?? LIMITS.HOOK_FAIL_OPEN_MS },
  );

  if (decision.posture === 'idle') {
    const kb = Math.round(decision.assessment.sourceBytes / 1024);
    return {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `Redutok idle posture: this repo is below the governance thresholds (${decision.assessment.files} source files, ~${kb} KB), so hooks pass everything through and no codex is injected; the meter still records. Redutok by Truveil`,
      },
    };
  }

  const block = readFileSync(protocolPath, 'utf8');
  const source = input.source ?? 'startup';
  const prefix =
    source === 'compact' || source === 'resume'
      ? `Redutok protocol re-injected after ${source}.\n\n`
      : '';
  const codexInjection = injection === undefined ? '' : '\n\n' + injection.text;
  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: prefix + block + codexInjection,
    },
  };
}

export async function handlePreToolUse(
  input: { tool_name?: string; tool_input?: Record<string, unknown>; session_id?: string },
  deps: HookDeps,
): Promise<HookOutput> {
  // Idle gear (docs/POSTURE.md): everything passes through untouched, no
  // sidecar probe, no rewrite, no deny — zero per-turn overhead.
  if (idleFor(deps, input.session_id)) return {};
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
      if (size > LARGE_READ_BYTES) {
        // v3 pillar B, same design law as the pipe: never add a turn, only
        // transform one that already exists. A large Read is rewritten to the
        // file's skeleton mirror entry, so the model receives the skeleton
        // (header line first: real path, raw size, recovery path) through the
        // Read it already made. An explicit offset/limit is a deliberate
        // slice — the mirror header itself recommends one — and passes raw.
        // Stale or missing mirror, sidecar down, or any doubt: raw, fail-open.
        if (args['offset'] !== undefined || args['limit'] !== undefined) return {};
        const root = path.dirname(path.resolve(deps.dcpDir));
        const rel = path.relative(root, path.resolve(filePath)).replace(/\\/g, '/');
        if (rel.startsWith('..') || path.isAbsolute(rel)) return {};
        const entry = readMirrorIndex(root)?.files[rel];
        if (entry === undefined) return {};
        const mirrorPath = mirrorEntryPath(root, rel);
        if (!existsSync(mirrorPath)) return {};
        if (entry.hash !== mirrorHash(readFileSync(filePath, 'utf8'))) return {};
        if (!(await sidecarUp(deps))) return {};
        await sidecarRequest(
          deps.target,
          'POST',
          '/notify',
          {
            kind: 'read-mirror-rewrite',
            rule: 'read-mirror',
            realPath: filePath,
            mirrorPath,
            sessionId: input.session_id,
          },
          { timeoutMs: deps.timeoutMs ?? LIMITS.HOOK_FAIL_OPEN_MS },
        );
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            updatedInput: { ...args, file_path: mirrorPath },
          },
        };
      }
      if (!(await sidecarUp(deps))) return {};
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
      // v3 pillar A, the design law "never add a turn, only transform a turn
      // that already exists": an allowlisted read-only, log-producing command
      // is rewritten in place to run through redutok-pipe, which distills its
      // output. The model sees the distilled verdict plus a zoom handle in the
      // same tool result, without a second turn. Side-effecting, composed, or
      // non-allowlisted commands are left untouched, and nothing is rewritten
      // when the sidecar is down.
      const command = String(args['command'] ?? '');
      if (command === '') return {};
      const decision = decideRewrite(command, loadAllowlist(deps.dcpDir));
      if (decision === undefined) return {};
      if (!(await sidecarUp(deps))) return {};
      // Record the rewrite decision (with the matched rule) in the audit trail,
      // attributed to the active session, before handing back the rewrite.
      await sidecarRequest(
        deps.target,
        'POST',
        '/notify',
        { kind: 'command-rewrite', rule: decision.rule, command, sessionId: input.session_id },
        { timeoutMs: deps.timeoutMs ?? LIMITS.HOOK_FAIL_OPEN_MS },
      );
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { ...args, command: decision.command },
        },
      };
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
  // Idle gear: no per-turn notify at all (docs/POSTURE.md). Rolling state
  // and incremental reindexing sleep with it; the next engaged session or an
  // explicit codex refresh catches the repo up.
  if (idleFor(deps, input.session_id)) return {};
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

export function handlePreCompact(
  input: { session_id?: string },
  deps: HookDeps,
): HookOutput {
  // Idle gear: nothing was governed, so nothing needs preserving.
  if (idleFor(deps, input?.session_id)) return {};
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
export function handleUserPromptSubmit(
  input: { prompt?: string; session_id?: string },
  deps: HookDeps,
): HookOutput {
  const prompt = input.prompt ?? '';
  if (prompt === '') return {};
  // Idle gear: even the advisory hint stays silent — zero per-turn tokens.
  if (idleFor(deps, input.session_id)) return {};
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

/**
 * Fires the graduation miner (v4 phase 1): one session-end notify so the
 * sidecar mines the ended session's audit trail asynchronously, off the
 * hook's path. Fail-open like every hook: a dead sidecar costs one timed-out
 * probe and the session ends vanilla.
 */
export async function handleSessionEnd(
  input: { session_id?: string },
  deps: HookDeps,
): Promise<HookOutput> {
  await sidecarRequest(
    deps.target,
    'POST',
    '/notify',
    { kind: 'session-end', sessionId: input.session_id },
    { timeoutMs: deps.timeoutMs ?? LIMITS.HOOK_FAIL_OPEN_MS },
  );
  return {};
}

export async function handleStop(
  input: { transcript_path?: string },
  deps: HookDeps,
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
    const summaryLine = `Redutok: ${total} tokens across ${ledger.entries.length} turns this session.${advisor} Run redutok report --last for detail. Redutok by Truveil`;
    // The receipt is assembled from local files only (ledger plus the
    // session-attributed audit trail): no model call, no network. A receipt
    // failure must never cost the summary line.
    let receiptBlock: string | undefined;
    try {
      const receipt = buildSessionReceipt(ledger, {
        auditPath: path.join(deps.dcpDir, 'audit.jsonl'),
        posturePath: path.join(deps.dcpDir, 'session-posture.json'),
      });
      receiptBlock = renderReceiptBlock(receipt);
      if (existsSync(deps.dcpDir)) {
        writeFileSync(
          path.join(deps.dcpDir, 'last-receipt.txt'),
          summaryLine + '\n' + receiptBlock + '\n',
        );
      }
    } catch {
      receiptBlock = undefined;
    }
    return { summaryLine, receiptBlock };
  } catch {
    return {};
  }
}
