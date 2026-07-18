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
