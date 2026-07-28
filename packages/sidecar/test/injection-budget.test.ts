import { describe, expect, it } from 'vitest';
import { CodexFileSchema, LIMITS } from '@redutok/shared';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { buildCodexInjection, DEGRADE_ORDER } from '../src/codex.js';
import { estimateTokens } from '../src/distill.js';

function codexWithLearned(count: number): ReturnType<typeof CodexFileSchema.parse> {
  return CodexFileSchema.parse({
    version: '1',
    project: 'budget-test',
    generatedAt: '2026-07-29T00:00:00.000Z',
    learned: Array.from({ length: count }, (_, i) => ({
      kind: 'skeleton-enrichment',
      candidate: `cand-${String(i).padStart(4, '0')}`,
      path: `packages/example/src/very/long/module/path/number-${i}/index.ts`,
      symbols: ['createStyler', 'createBuilder', 'applyOptions', 'levelMapping', `symbol${i}`],
      confidence: (i + 1) / (count + 1),
      source: 'graduated',
      addedAt: '2026-07-29T00:00:00.000Z',
    })),
  });
}

describe('learned section budget guard (docs/GRADUATION.md)', () => {
  it('keeps the learned section within its hard token budget, excluding lowest-confidence first', () => {
    const codex = codexWithLearned(40);
    const injection = buildCodexInjection(codex, 100_000);
    const parsed = parseYaml(injection.split('\n\n').slice(1).join('\n\n').split('\n[')[0] ?? '') as {
      learned?: { candidate: string; confidence: number }[];
    };
    const kept = parsed.learned ?? [];
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(40);
    expect(
      estimateTokens(stringifyYaml({ learned: kept })),
    ).toBeLessThanOrEqual(LIMITS.GRADUATION.LEARNED_SECTION_MAX_TOKENS);
    // The highest-confidence entries survive.
    const minKept = Math.min(...kept.map((e) => e.confidence));
    expect(minKept).toBeGreaterThan(0.5);
    expect(injection).toContain('learned entries excluded to fit the learned budget');
  });

  it('a small learned section passes through untouched, no note', () => {
    const codex = codexWithLearned(2);
    const injection = buildCodexInjection(codex, 100_000);
    expect(injection).toContain('cand-0000');
    expect(injection).toContain('cand-0001');
    expect(injection).not.toContain('excluded to fit the learned budget');
  });

  it('the degradation order gains learned between importGraph and interfaces', () => {
    expect([...DEGRADE_ORDER]).toEqual([
      'glossary',
      'conventions',
      'importGraph',
      'learned',
      'interfaces',
      'keySymbols',
    ]);
  });

  it('under overall pressure the whole learned section degrades before interfaces', () => {
    const codex = codexWithLearned(10);
    codex.interfaces = Array.from({ length: 30 }, (_, i) => ({
      name: `iface${i}`,
      signature: `export function iface${i}(a: string, b: number): Promise<void>`,
      file: `src/i${i}.ts`,
    }));
    const injection = buildCodexInjection(codex, 300);
    expect(injection).toContain('[codex sections dropped to fit the budget:');
    const note = /\[codex sections dropped to fit the budget: ([^\]]+)\]/.exec(injection)?.[1] ?? '';
    if (note.includes('interfaces')) expect(note).toContain('learned');
  });
});
