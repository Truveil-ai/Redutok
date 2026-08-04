import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assemblePasteMessage } from './paste.js';
import type { CallSpec, ChatbenchConfig, CorpusEntry, QuestionSet } from './types.js';

/**
 * Static token estimator: bytes/4 approximation. This mirrors the
 * docs/METHODOLOGY.md convention used throughout Redutok. Live usage
 * numbers (from response.usage) replace these post-run in the harness.
 */
const bytesToTokens = (bytes: number): number => Math.ceil(bytes / 4);

/** Path to the emitted vault_codex + Redutok Skill text used by the VAULT
 * arm's system prompt. The codex is not available at matrix-enumeration
 * time (it requires a mounted corpus), so we estimate it from the pinned
 * upper bound in @redutok/shared (VAULT_CODEX.MAX_TOKENS = 2000 tokens),
 * plus the Skill markdown on disk. */
const VAULT_CODEX_MAX_TOKENS = 2000;
const SKILL_PATH_FROM_ROOT = 'skills/redutok/SKILL.md';

export function enumerateMatrix(
  cfg: ChatbenchConfig,
  questionSetsById: Map<string, QuestionSet>,
  repoRoot: string,
): CallSpec[] {
  const skillTokens = estimateSkillTokens(repoRoot);
  const vaultSystemTokens = VAULT_CODEX_MAX_TOKENS + skillTokens;
  const rows: CallSpec[] = [];
  for (const corpus of cfg.corpora) {
    const set = questionSetsById.get(corpus.id);
    if (set === undefined) throw new Error(`enumerateMatrix: no question set for corpus ${corpus.id}`);
    const paste = assemblePasteMessage(corpus, repoRoot);
    const pasteTokens = bytesToTokens(paste.totalBytes);
    for (let rep = 1; rep <= cfg.replications; rep += 1) {
      for (const q of set.questions) {
        rows.push(makeRow('paste', corpus, q.id, rep, pasteTokens, vaultSystemTokens, cfg, q.prompt));
        rows.push(makeRow('vault', corpus, q.id, rep, pasteTokens, vaultSystemTokens, cfg, q.prompt));
      }
    }
  }
  return rows;
}

function makeRow(
  arm: 'paste' | 'vault',
  corpus: CorpusEntry,
  questionId: string,
  rep: number,
  pasteTokens: number,
  vaultSystemTokens: number,
  cfg: ChatbenchConfig,
  prompt: string,
): CallSpec {
  const qTokens = bytesToTokens(Buffer.byteLength(prompt, 'utf8'));
  // For a single question in isolation (no prior turns). The dry-run
  // summariser folds in per-conversation growth via the row's max bound.
  const promptTokens = qTokens;
  if (arm === 'paste') {
    // Paste always carries the whole corpus on every turn.
    const min = pasteTokens + promptTokens;
    // Upper bound conservatively adds one full turn of prior conversation.
    const max = min + cfg.maxTokensPerTurn;
    return {
      arm,
      corpusId: corpus.id,
      questionId,
      rep,
      minInputTokens: min,
      maxInputTokens: max,
      maxOutputTokens: cfg.maxTokensPerTurn,
    };
  }
  // Vault: system + Q; tool loop may add a second turn where system and
  // messages are re-sent alongside a tool_result. Upper bound assumes 2
  // turns for a single question.
  const min = vaultSystemTokens + promptTokens;
  const max = 2 * (vaultSystemTokens + promptTokens) + cfg.maxTokensPerTurn;
  return {
    arm,
    corpusId: corpus.id,
    questionId,
    rep,
    minInputTokens: min,
    maxInputTokens: max,
    maxOutputTokens: cfg.maxTokensPerTurn,
  };
}

function estimateSkillTokens(repoRoot: string): number {
  try {
    const raw = readFileSync(join(repoRoot, SKILL_PATH_FROM_ROOT), 'utf8');
    return bytesToTokens(Buffer.byteLength(raw, 'utf8'));
  } catch {
    // Fall back to a conservative 800 tokens if the skill file isn't
    // reachable from the given repo root. Matrix enumeration should never
    // fail because of a missing skill file — the harness surfaces this at
    // prep-check time separately.
    return 800;
  }
}

export function estimateCostBand(
  row: CallSpec,
  inputPerMTokUsd: number,
  outputPerMTokUsd: number,
): { minUsd: number; maxUsd: number } {
  const minInputCost = (row.minInputTokens / 1_000_000) * inputPerMTokUsd;
  const maxInputCost = (row.maxInputTokens / 1_000_000) * inputPerMTokUsd;
  const maxOutputCost = (row.maxOutputTokens / 1_000_000) * outputPerMTokUsd;
  return {
    minUsd: minInputCost,
    maxUsd: maxInputCost + maxOutputCost,
  };
}
