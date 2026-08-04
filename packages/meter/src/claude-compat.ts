import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

/**
 * The single module that owns every assumption about Claude Code's
 * integration surface. When Claude Code changes, this file is the blast
 * radius; the CI canary probes it against the latest CLI on a schedule.
 *
 * Degradation path for an unknown version: hooks fail open (sessions run
 * vanilla), the transcript parser skips unknown record types with counters,
 * and the MCP server speaks standard JSON-RPC; nothing hard-fails. The
 * canary exists so we learn before users notice savings quietly stopping.
 */

/** Transcript record types the parser treats as known. */
export const KNOWN_TRANSCRIPT_RECORD_TYPES = ['user', 'assistant', 'summary', 'system'] as const;

/** Hook lifecycle events redutok registers. */
export const HOOK_EVENT_NAMES = [
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'PreCompact',
  'Stop',
  'SessionEnd',
] as const;

/** Where Claude Code keeps transcripts on this OS. */
export function transcriptRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Claude Code's per-project transcript directory name for a working
 * directory: every character outside [A-Za-z0-9] becomes a dash, so
 * `E:\Redutok - Token Optimisation` is stored as
 * `E--Redutok---Token-Optimisation`.
 *
 * Verified against a real transcript root of 64 project directories, none of
 * which carried a character outside that set. Like everything else in this
 * module it is an assumption about Claude Code rather than a contract: if the
 * naming changes, `--last` finds no session for the project and says so,
 * which is the safe direction. It never reports another project's session.
 */
export function projectDirName(cwd: string): string {
  return path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

/** The transcript directory holding this project's sessions. */
export function projectTranscriptDir(cwd: string = process.cwd(), root: string = transcriptRoot()): string {
  return path.join(root, projectDirName(cwd));
}

/** Repo-relative settings files redutok touches. */
export const SETTINGS_PATHS = {
  personal: '.claude/settings.local.json',
  mcp: '.mcp.json',
} as const;

/** Claude CLI major versions this integration surface was built against. */
export const KNOWN_CLI_MAJORS = [1, 2];

export interface VersionAssessment {
  version: string | undefined;
  known: boolean;
  degradation: string;
}

export function probeClaudeVersion(): string | undefined {
  const result = spawnSync('claude --version', { encoding: 'utf8', shell: true, timeout: 15_000 });
  if (result.status !== 0) return undefined;
  return /(\d+\.\d+\.\d+)/.exec(result.stdout)?.[1];
}

export function assessVersion(version: string | undefined): VersionAssessment {
  if (version === undefined) {
    return {
      version,
      known: false,
      degradation: 'claude CLI not found; the meter still works on existing transcripts, hooks and MCP are inert',
    };
  }
  const major = Number(version.split('.')[0]);
  const known = KNOWN_CLI_MAJORS.includes(major);
  return {
    version,
    known,
    degradation: known
      ? 'none needed'
      : `claude ${version} is newer than this redutok build was tested against; hooks fail open, the parser tolerates unknown records, but distillation coverage may silently shrink. Update redutok.`,
  };
}
