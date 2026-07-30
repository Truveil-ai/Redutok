import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CodexFileSchema, LIMITS } from '@redutok/shared';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { buildCodexInjection, buildInjection, DEGRADE_ORDER, readCodex } from '../src/codex.js';
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

describe('injection metadata and the restore pass', () => {
  it('restores learned when dropping a later, larger section alone frees the budget', () => {
    // interfaces is far over budget by itself; the in-order degrade loop
    // drops learned before reaching it, then the restore pass must bring
    // learned back because the final budget has room for it.
    const codex = codexWithLearned(3);
    codex.interfaces = Array.from({ length: 200 }, (_, i) => ({
      name: `iface${i}`,
      signature: `export function iface${i}(argumentOne: string, argumentTwo: number): Promise<void>`,
      file: `packages/example/src/i${i}.ts`,
    }));
    const injection = buildInjection(codex, { maxTokens: 1500 });
    expect(injection.droppedSections).toContain('interfaces');
    expect(injection.droppedSections).not.toContain('learned');
    expect(injection.injectedLearned).toEqual(['cand-0002', 'cand-0001', 'cand-0000']);
    expect(injection.text).toContain('cand-0002');
    expect(estimateTokens(injection.text)).toBeLessThanOrEqual(1500);
    // The dropped note reflects the final state, not the intermediate drops.
    const note = /\[codex sections dropped to fit the budget: ([^\]]+)\]/.exec(injection.text)?.[1] ?? '';
    expect(note).not.toContain('learned');
  });

  it('excludedLearned names the lowest-confidence candidates, lowest first, and none of them are injected', () => {
    const codex = codexWithLearned(40);
    const injection = buildInjection(codex, { maxTokens: 100_000 });
    expect(injection.excludedLearned.length).toBeGreaterThan(0);
    // codexWithLearned assigns confidence (i+1)/(count+1): cand-0000 is lowest.
    expect(injection.excludedLearned[0]).toBe('cand-0000');
    for (const ref of injection.excludedLearned) {
      expect(injection.injectedLearned).not.toContain(ref);
      expect(injection.text).not.toContain(ref);
    }
    expect(injection.injectedLearned.length + injection.excludedLearned.length).toBe(40);
  });

  it('buildCodexInjection remains the text view of buildInjection', () => {
    const codex = codexWithLearned(5);
    expect(buildCodexInjection(codex, 1000)).toBe(buildInjection(codex, { maxTokens: 1000 }).text);
  });
});

describe('light posture injection', () => {
  function lightCodex(): ReturnType<typeof CodexFileSchema.parse> {
    const codex = codexWithLearned(2);
    codex.summary = 'A repository for exercising light injection.';
    codex.pitfalls = [
      { text: 'Never call the flux capacitor twice.', locked: false, source: 'graduated', candidate: 'cand-pit1', confidence: 0.7 },
      { text: 'Human-written pitfall without a candidate ref.', locked: false, source: 'human' },
    ];
    codex.map = [{ path: 'src', role: 'implementation', roleSource: 'rules', keySymbols: ['a'], locked: false }];
    codex.interfaces = [{ name: 'x', signature: 'export function x(): void', file: 'src/x.ts' }];
    return codex;
  }

  it('carries summary, pitfalls, and learned only', () => {
    const injection = buildInjection(lightCodex(), { posture: 'light' });
    expect(injection.posture).toBe('light');
    expect(injection.text).toContain('summary:');
    expect(injection.text).toContain('pitfalls:');
    expect(injection.text).toContain('cand-0000');
    expect(injection.text).not.toContain('interfaces:');
    expect(injection.text).not.toContain('map:');
    expect(injection.text).not.toContain('importGraph:');
    // Confidence-descending, matching the injected order.
    expect(injection.injectedLearned).toEqual(['cand-0001', 'cand-0000']);
  });

  it('reports graduated pitfalls candidate refs as injected', () => {
    const injection = buildInjection(lightCodex(), { posture: 'light' });
    expect(injection.injectedPitfalls).toEqual(['cand-pit1']);
    // Full posture reports them too: pitfalls are never dropped.
    const full = buildInjection(lightCodex(), { maxTokens: 100_000 });
    expect(full.injectedPitfalls).toEqual(['cand-pit1']);
  });
});

describe('whole-injection budget on this repository (docs/POSTURE.md)', () => {
  const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

  it('protocol block plus codex plus learned fits the documented total budget with graduated entries live', () => {
    const { codex } = readCodex(repoRoot);
    expect(codex).toBeDefined();
    if (codex === undefined) return;
    // The dogfood mirror carries the graduated learned section (v4).
    expect(codex.learned.length).toBeGreaterThanOrEqual(1);
    const injection = buildInjection(codex);
    // Graduated knowledge must survive injection on the repo that earned it.
    expect(injection.injectedLearned.length).toBeGreaterThan(0);
    expect(estimateTokens(injection.text)).toBeLessThanOrEqual(LIMITS.INJECTION.CODEX_MAX_TOKENS);
    const protocol = /<!-- dcp:start v1 -->[\s\S]*?<!-- dcp:end -->/.exec(
      readFileSync(path.join(repoRoot, 'docs', 'PROTOCOL.md'), 'utf8'),
    )?.[0];
    expect(protocol).toBeDefined();
    expect(estimateTokens(`${protocol ?? ''}\n\n${injection.text}`)).toBeLessThanOrEqual(
      LIMITS.INJECTION.TOTAL_MAX_TOKENS,
    );
  });
});
