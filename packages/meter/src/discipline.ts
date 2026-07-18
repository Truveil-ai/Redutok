import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LIMITS } from '@redutok/shared';
import type { SessionLedger } from './ledger.js';

/**
 * Output discipline measurements and the session-splitting advisor,
 * architecture 5.4 and 6. All thresholds live in limits.ts.
 */

export interface VerbosityReport {
  avgOutputTokensPerTurn: number;
  verboseTurns: number;
  totalTurns: number;
  adherent: boolean;
}

export function verbosityReport(ledger: SessionLedger): VerbosityReport {
  const turns = ledger.entries.length;
  const totalOutput = ledger.totals.output + ledger.totals.thinking;
  const avg = turns === 0 ? 0 : totalOutput / turns;
  const verboseTurns = ledger.entries.filter(
    (e) => e.tokens.output + e.tokens.thinking > LIMITS.VERBOSE_OUTPUT_TOKENS_PER_TURN,
  ).length;
  return {
    avgOutputTokensPerTurn: Math.round(avg),
    verboseTurns,
    totalTurns: turns,
    adherent: avg <= LIMITS.VERBOSE_OUTPUT_TOKENS_PER_TURN,
  };
}

/** Split advisor: fires when the last turn's context crossed the threshold. */
export function shouldSuggestSplit(ledger: SessionLedger): boolean {
  const last = ledger.entries[ledger.entries.length - 1];
  if (last === undefined) return false;
  return last.tokens.input + last.tokens.cacheRead > LIMITS.SPLIT_ADVISOR_CONTEXT_TOKENS;
}

export const SPLIT_SUGGESTION =
  'Split point detected. redutok handoff will open a fresh session pre-loaded with codex plus state instead of carrying the full transcript.';

/** redutok handoff, architecture 5.4: handoff file plus printed resume command. */
export function writeHandoff(repoRoot: string): { file: string; resumeCommand: string } {
  const dcpDir = path.join(repoRoot, '.dcp');
  const statePath = path.join(dcpDir, 'session-state.md');
  const lockPath = path.join(dcpDir, 'codex.lock');
  const state = existsSync(statePath)
    ? readFileSync(statePath, 'utf8')
    : 'No rolling state recorded this session.';
  let codexRef = 'No codex generated yet; run redutok codex refresh.';
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      repoFingerprint: string;
      files: Record<string, string>;
    };
    codexRef = `Codex .dcp/codex.yaml at fingerprint ${lock.repoFingerprint}, ${Object.keys(lock.files).length} files indexed. Trust it; do not re-explore.`;
  }
  const file = path.join(dcpDir, 'handoff.md');
  const content = [
    '# Redutok session handoff',
    '',
    'Start the new session from this file instead of carrying the old transcript.',
    '',
    '## Codex',
    codexRef,
    '',
    '## Rolling state',
    state.trimEnd(),
    '',
  ].join('\n');
  writeFileSync(file, content, 'utf8');
  return {
    file,
    resumeCommand: 'claude "Read .dcp/handoff.md, then continue the task it describes."',
  };
}
