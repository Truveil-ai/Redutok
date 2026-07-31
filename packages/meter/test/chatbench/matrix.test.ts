import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  enumerateMatrix,
  estimateCostBand,
  loadChatbenchConfig,
  loadQuestionSet,
  renderDryRun,
} from '../../src/chatbench/index.js';
import type { QuestionSet } from '../../src/chatbench/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..', '..', '..');
const configPath = path.join(repoRoot, 'bench', 'chatbench.yaml');

function loadAll(): { cfg: ReturnType<typeof loadChatbenchConfig>; sets: Map<string, QuestionSet> } {
  const cfg = loadChatbenchConfig(configPath);
  const sets = new Map<string, QuestionSet>();
  for (const c of cfg.corpora) {
    sets.set(c.id, loadQuestionSet(path.join(repoRoot, c.questions)));
  }
  return { cfg, sets };
}

describe('enumerateMatrix', () => {
  it('emits (arm × corpus × question × rep) rows', () => {
    const { cfg, sets } = loadAll();
    const rows = enumerateMatrix(cfg, sets, repoRoot);
    // 2 arms × 2 corpora × 10 questions each × 3 reps = 120.
    expect(rows).toHaveLength(120);
    const arms = new Set(rows.map((r) => r.arm));
    expect(arms).toEqual(new Set(['paste', 'vault']));
    const corpora = new Set(rows.map((r) => r.corpusId));
    expect(corpora).toEqual(new Set(['docs', 'code']));
    const reps = new Set(rows.map((r) => r.rep));
    expect(reps).toEqual(new Set([1, 2, 3]));
  });

  it('paste input estimate on the docs corpus exceeds vault input by ≥10x', () => {
    const { cfg, sets } = loadAll();
    const rows = enumerateMatrix(cfg, sets, repoRoot);
    const docsQ1 = rows.filter((r) => r.corpusId === 'docs' && r.questionId === 'q1' && r.rep === 1);
    const paste = docsQ1.find((r) => r.arm === 'paste')!;
    const vault = docsQ1.find((r) => r.arm === 'vault')!;
    // The paste arm carries the entire corpus; the vault arm carries the
    // codex + skill + one question.
    expect(paste.minInputTokens).toBeGreaterThanOrEqual(vault.maxInputTokens * 10);
  });

  it('max output tokens is capped at maxTokensPerTurn', () => {
    const { cfg, sets } = loadAll();
    const rows = enumerateMatrix(cfg, sets, repoRoot);
    for (const r of rows) expect(r.maxOutputTokens).toBeLessThanOrEqual(cfg.maxTokensPerTurn);
  });
});

describe('estimateCostBand', () => {
  it('costs input at the input rate and output at the output rate', () => {
    const band = estimateCostBand(
      { arm: 'paste', corpusId: 'docs', questionId: 'q1', rep: 1, minInputTokens: 1_000_000, maxInputTokens: 1_000_000, maxOutputTokens: 500_000 },
      3,
      15,
    );
    expect(band.minUsd).toBeCloseTo(1 * 3 + 0 * 15, 6);
    expect(band.maxUsd).toBeCloseTo(1 * 3 + 0.5 * 15, 6);
  });
});

describe('renderDryRun', () => {
  it('summarises the matrix and totals a cost band', () => {
    const { cfg, sets } = loadAll();
    const rows = enumerateMatrix(cfg, sets, repoRoot);
    const out = renderDryRun(cfg, rows, { inputPerMTokUsd: 3, outputPerMTokUsd: 15 });
    expect(out).toContain('chatbench dry-run');
    expect(out).toContain('120');
    expect(out).toMatch(/paste/);
    expect(out).toMatch(/vault/);
    expect(out).toMatch(/\$\d/);
    expect(out).toContain('claude-sonnet-5');
  });
});
