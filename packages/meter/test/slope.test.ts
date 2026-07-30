import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  countSlopeAttribution,
  dryRunMatrix,
  evaluateSlope,
  generateLiveResults,
  hasGraduationEvent,
  loadBenchTasks,
  loadSlopeTier,
  turnsOf,
  type BenchTask,
  type LiveRunMeasurement,
  type SlopeTier,
} from '../src/bench.js';
import { computeSessionEnergy } from '../src/energy.js';
import { scoreSession } from '../src/scoring.js';
import { loadEnergyFactors, loadGridIntensity } from '@redutok/shared';
import type { SessionLedger } from '../src/ledger.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..', '..');

// ------------------------------------------------------------ test fixtures

const CHALK_PIN = {
  url: 'https://github.com/chalk/chalk',
  commit: 'aa06bb5ac3f14df9fda8cfb54274dfc165ddfdef',
  localPath: 'fixtures/repos/chalk',
};

function slopeTask(id: string, overrides: Partial<BenchTask> = {}): BenchTask {
  return {
    id,
    tier: 'slope',
    repo: { ...CHALK_PIN },
    prompt: `question ${id}`,
    success: [{ kind: 'answer-contains', needle: 'createStyler' }],
    fixtureLogs: { vanilla: 'fixtures/sessions/long-agentic.jsonl', redutok: 'fixtures/sessions/medium.jsonl' },
    ...overrides,
  };
}

const TIER_YAML = [
  'tier: slope',
  'id: slope-axios',
  'sequence: [s01, s02, s03]',
  'criteria:',
  '  - id: slope-exists',
  '    description: redutok s3 fewer tokens and fewer turns than redutok s1',
  '  - id: learning-pays',
  '    description: redutok s3 fewer tokens than vanilla s3 at success parity',
  '  - id: mechanism-engaged',
  '    description: at least one enrichment serve or learned injection by s3',
].join('\n');

function writeTierFile(content: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'redutok-slope-tier-'));
  const file = path.join(dir, 'slope.yaml');
  writeFileSync(file, content);
  return file;
}

const threeTasks = (): BenchTask[] => [slopeTask('s01'), slopeTask('s02'), slopeTask('s03')];

// A hand-rolled measurement whose token total and turn count are exact, so
// slope arithmetic is asserted against known numbers instead of fixture noise.
function synthMeasurement(
  taskId: string,
  variant: 'vanilla' | 'redutok',
  rep: number,
  tokens: number,
  turns: number,
  overrides: Partial<LiveRunMeasurement> = {},
): LiveRunMeasurement {
  const sessionId = `${taskId}-${variant}-${rep}`;
  const entries = Array.from({ length: turns }, (_, i) => ({
    sessionId,
    turn: i + 1,
    timestamp: '2026-07-30T00:00:00.000Z',
    model: 'claude-sonnet-5',
    tools: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
  }));
  const totals = { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 };
  const ledger: SessionLedger = { sessionId, entries, totals, byTool: {} };
  const energy = computeSessionEnergy(ledger, loadEnergyFactors(), loadGridIntensity());
  return {
    taskId,
    tier: 'slope',
    variant,
    rep,
    ledger,
    totalTokens: tokens,
    costUsd: 0.01,
    energy,
    scores: scoreSession(ledger, energy, []),
    wallMs: 1000,
    success: true,
    successDetail: [],
    model: 'claude-sonnet-5',
    ...overrides,
  };
}

const tier: SlopeTier = {
  tier: 'slope',
  id: 'slope-axios',
  sequence: ['s01', 's02', 's03'],
  criteria: [
    { id: 'slope-exists', description: 'redutok s3 fewer tokens and fewer turns than redutok s1' },
    { id: 'learning-pays', description: 'redutok s3 fewer tokens than vanilla s3 at success parity' },
    { id: 'mechanism-engaged', description: 'at least one enrichment serve or learned injection by s3' },
  ],
};

/** A full sequence run set for one rep with a clean learning slope. */
function learningRun(rep: number): LiveRunMeasurement[] {
  return [
    synthMeasurement('s01', 'vanilla', rep, 100_000, 20),
    synthMeasurement('s02', 'vanilla', rep, 98_000, 19),
    synthMeasurement('s03', 'vanilla', rep, 96_000, 20),
    synthMeasurement('s01', 'redutok', rep, 50_000, 15, { attribution: { zoomBacks: 4, enrichmentServes: 0, learnedInjected: 0, pitfallsInjected: 0 } }),
    synthMeasurement('s02', 'redutok', rep, 40_000, 12, { attribution: { zoomBacks: 2, enrichmentServes: 3, learnedInjected: 2, pitfallsInjected: 0 } }),
    synthMeasurement('s03', 'redutok', rep, 30_000, 9, { attribution: { zoomBacks: 1, enrichmentServes: 5, learnedInjected: 4, pitfallsInjected: 1 } }),
  ];
}

// ----------------------------------------------------------------- loaders

describe('loadSlopeTier', () => {
  it('loads a valid tier file with sequence order and the three pre-registered criteria', () => {
    const loaded = loadSlopeTier(writeTierFile(TIER_YAML), threeTasks());
    expect(loaded.id).toBe('slope-axios');
    expect(loaded.sequence).toEqual(['s01', 's02', 's03']);
    expect(loaded.criteria.map((c) => c.id)).toEqual(['slope-exists', 'learning-pays', 'mechanism-engaged']);
    for (const criterion of loaded.criteria) expect(criterion.description.length).toBeGreaterThan(0);
  });

  it('rejects a sequence entry that names no known task', () => {
    const tasks = [slopeTask('s01'), slopeTask('s02')];
    expect(() => loadSlopeTier(writeTierFile(TIER_YAML), tasks)).toThrow(/s03/);
  });

  it('rejects a sequence task that is not tier slope', () => {
    const tasks = [slopeTask('s01'), slopeTask('s02'), slopeTask('s03', { tier: 'medium' })];
    expect(() => loadSlopeTier(writeTierFile(TIER_YAML), tasks)).toThrow(/tier/);
  });

  it('rejects sequence tasks with mismatched repo pins: knowledge cannot carry across repos', () => {
    const tasks = [
      slopeTask('s01'),
      slopeTask('s02'),
      slopeTask('s03', { repo: { ...CHALK_PIN, localPath: 'fixtures/repos/chalk-heavy-build' } }),
    ];
    expect(() => loadSlopeTier(writeTierFile(TIER_YAML), tasks)).toThrow(/repo/);
  });

  it('rejects a slope-tier task that no sequence position claims: nothing runs silently outside the sequence', () => {
    const tasks = [...threeTasks(), slopeTask('s04')];
    expect(() => loadSlopeTier(writeTierFile(TIER_YAML), tasks)).toThrow(/s04/);
  });

  it('rejects a criterion id that is not pre-registered in code: no bar movement by yaml edit', () => {
    const yaml = TIER_YAML.replace('learning-pays', 'vibes-based');
    expect(() => loadSlopeTier(writeTierFile(yaml), threeTasks())).toThrow(/vibes-based/);
  });

  it('rejects a tier file missing a criterion: every pre-registered bar must be present', () => {
    const yaml = TIER_YAML.split('\n').slice(0, 9).join('\n');
    expect(() => loadSlopeTier(writeTierFile(yaml), threeTasks())).toThrow(/mechanism-engaged/);
  });
});

// ------------------------------------------------------------- attribution

describe('countSlopeAttribution', () => {
  const events = [
    { action: 'zoom', sessionId: 'a', module: 'sidecar.distill' },
    { action: 'zoom', sessionId: 'a', module: 'sidecar.distill' },
    { action: 'zoom', sessionId: 'b', module: 'sidecar.distill' },
    { action: 'distill', sessionId: 'a', module: 'sidecar.distill', details: { enrichmentCandidate: 'cand-1' } },
    { action: 'rewrite', sessionId: 'a', module: 'hooks.pretooluse', details: { enrichmentCandidate: 'cand-2' } },
    { action: 'rewrite', sessionId: 'b', module: 'hooks.pretooluse', details: { enrichmentCandidate: 'cand-2' } },
    { action: 'rewrite', sessionId: 'a', module: 'hooks.pretooluse', details: { rule: 'read-mirror' } },
    { action: 'posture', sessionId: 'a', module: 'hooks.session-start', details: { injectedLearned: ['cand-1', 'cand-3'], excludedLearned: ['cand-9'], injectedPitfalls: ['cand-7'] } },
    { action: 'posture', sessionId: 'b', module: 'hooks.session-start', details: { injectedLearned: [] } },
  ];

  it('counts zoom-backs, enrichment serves, and learned and pitfall injections attributed to the session, ignoring other sessions', () => {
    expect(countSlopeAttribution(events, 'a')).toEqual({ zoomBacks: 2, enrichmentServes: 2, learnedInjected: 2, pitfallsInjected: 1 });
    expect(countSlopeAttribution(events, 'b')).toEqual({ zoomBacks: 1, enrichmentServes: 1, learnedInjected: 0, pitfallsInjected: 0 });
    expect(countSlopeAttribution(events, 'c')).toEqual({ zoomBacks: 0, enrichmentServes: 0, learnedInjected: 0, pitfallsInjected: 0 });
  });

  it('does not count an empty or missing enrichmentCandidate as a serve, nor excluded refs as injections', () => {
    const noise = [
      { action: 'distill', sessionId: 'a', details: { enrichmentCandidate: '' } },
      { action: 'distill', sessionId: 'a', details: {} },
      { action: 'posture', sessionId: 'a', details: { excludedLearned: ['cand-1'] } },
    ];
    expect(countSlopeAttribution(noise, 'a')).toEqual({ zoomBacks: 0, enrichmentServes: 0, learnedInjected: 0, pitfallsInjected: 0 });
  });
});

describe('hasGraduationEvent', () => {
  it('finds the graduation mining event for the ended session and no other', () => {
    const events = [
      { action: 'summarize', module: 'sidecar.graduation', sessionId: 'sess-1' },
      { action: 'summarize', module: 'sidecar.codex', sessionId: 'sess-2' },
    ];
    expect(hasGraduationEvent(events, 'sess-1')).toBe(true);
    expect(hasGraduationEvent(events, 'sess-2')).toBe(false);
  });
});

describe('turnsOf', () => {
  it('is the highest turn number in the ledger, 0 for an empty session', () => {
    const m = synthMeasurement('s01', 'redutok', 1, 1000, 7);
    expect(turnsOf(m.ledger)).toBe(7);
    expect(turnsOf({ ...m.ledger, entries: [] })).toBe(0);
  });
});

// -------------------------------------------------------------- evaluation

describe('evaluateSlope', () => {
  it('computes s3-versus-s1 slopes per variant and the headline redutok-s3-versus-vanilla-s3 ratio from medians', () => {
    const report = evaluateSlope(tier, [...learningRun(1), ...learningRun(2)]);
    const redutok = report.variants.find((v) => v.variant === 'redutok');
    const vanilla = report.variants.find((v) => v.variant === 'vanilla');
    expect(redutok?.tokenRatio).toBeCloseTo(30_000 / 50_000, 5);
    expect(redutok?.turnRatio).toBeCloseTo(9 / 15, 5);
    expect(vanilla?.tokenRatio).toBeCloseTo(96_000 / 100_000, 5);
    expect(vanilla?.turnRatio).toBeCloseTo(20 / 20, 5);
    // Headline follows the repo's reduction convention: vanilla over redutok.
    expect(report.headlineTokenRatio).toBeCloseTo(96_000 / 30_000, 5);
  });

  it('passes all three pre-registered criteria on a clean attributed learning slope', () => {
    const report = evaluateSlope(tier, learningRun(1));
    const byId = new Map(report.criteria.map((c) => [c.id, c]));
    expect(byId.get('slope-exists')?.pass).toBe(true);
    expect(byId.get('learning-pays')?.pass).toBe(true);
    expect(byId.get('mechanism-engaged')?.pass).toBe(true);
    expect(report.mechanismEngaged).toBe(true);
  });

  it('fails mechanism-engaged when every redutok attribution counter is zero: the slope came from nowhere', () => {
    const runs = learningRun(1).map((m) =>
      m.variant === 'redutok' ? { ...m, attribution: { zoomBacks: 3, enrichmentServes: 0, learnedInjected: 0, pitfallsInjected: 0 } } : m,
    );
    const report = evaluateSlope(tier, runs);
    const verdict = report.criteria.find((c) => c.id === 'mechanism-engaged');
    expect(verdict?.pass).toBe(false);
    expect(report.mechanismEngaged).toBe(false);
    // Zoom-backs alone are usage, not learning attribution: they must not
    // count as engagement.
    expect(verdict?.detail).toMatch(/0 enrichment serves/);
  });

  it('passes mechanism-engaged on pitfall injections alone: an error-fix lesson graduates into pitfalls, not learned', () => {
    // The N=3 diagnosis (2026-07-30): the deterministic graduation path for
    // the slope sequence is an error-fix, which lands in the codex pitfalls
    // section and is recorded under injectedPitfalls. A counter blind to it
    // would demote a genuinely earned injection to MET-UNATTRIBUTED.
    const runs = learningRun(1).map((m) =>
      m.variant === 'redutok'
        ? { ...m, attribution: { zoomBacks: 0, enrichmentServes: 0, learnedInjected: 0, pitfallsInjected: m.taskId === 's03' ? 1 : 0 } }
        : m,
    );
    const report = evaluateSlope(tier, runs);
    const verdict = report.criteria.find((c) => c.id === 'mechanism-engaged');
    expect(verdict?.pass).toBe(true);
    expect(report.mechanismEngaged).toBe(true);
    expect(verdict?.detail).toMatch(/1 pitfall injection/);
  });

  it('fails mechanism-engaged when attribution is unavailable (recovered runs) rather than passing silently', () => {
    const runs = learningRun(1).map((m) => {
      const { attribution: _attribution, ...rest } = m;
      return rest as typeof m;
    });
    const report = evaluateSlope(tier, runs);
    const verdict = report.criteria.find((c) => c.id === 'mechanism-engaged');
    expect(verdict?.pass).toBe(false);
    expect(verdict?.detail).toMatch(/unavailable/i);
  });

  it('fails slope-exists when s3 tokens drop but turns do not: both must fall', () => {
    const runs = learningRun(1).map((m) =>
      m.taskId === 's03' && m.variant === 'redutok' ? { ...m, ledger: synthMeasurement('s03', 'redutok', 1, 30_000, 15).ledger } : m,
    );
    const report = evaluateSlope(tier, runs);
    expect(report.criteria.find((c) => c.id === 'slope-exists')?.pass).toBe(false);
  });

  it('fails learning-pays when redutok s3 wins tokens but loses success parity against vanilla s3', () => {
    const runs = learningRun(1).map((m) =>
      m.taskId === 's03' && m.variant === 'redutok' ? { ...m, success: false } : m,
    );
    const report = evaluateSlope(tier, runs);
    const verdict = report.criteria.find((c) => c.id === 'learning-pays');
    expect(verdict?.pass).toBe(false);
    expect(verdict?.detail).toMatch(/parity/i);
  });

  it('fails learning-pays when redutok s3 does not beat vanilla s3 on tokens', () => {
    const runs = learningRun(1).map((m) =>
      m.taskId === 's03' && m.variant === 'redutok'
        ? { ...m, totalTokens: 200_000, ledger: synthMeasurement('s03', 'redutok', 1, 200_000, 9).ledger }
        : m,
    );
    const report = evaluateSlope(tier, runs);
    expect(report.criteria.find((c) => c.id === 'learning-pays')?.pass).toBe(false);
  });

  it('fails every criterion instead of passing on missing positions, with insufficient-data details on the slope bars', () => {
    const report = evaluateSlope(tier, [synthMeasurement('s01', 'redutok', 1, 50_000, 15)]);
    for (const criterion of report.criteria) expect(criterion.pass).toBe(false);
    expect(report.criteria.find((c) => c.id === 'slope-exists')?.detail).toMatch(/insufficient data/i);
    expect(report.criteria.find((c) => c.id === 'learning-pays')?.detail).toMatch(/insufficient data/i);
  });
});

// --------------------------------------------------------------- reporting

describe('generateLiveResults slope section', () => {
  it('reports per-task attribution, slopes, the headline, and the pre-registered verdicts', () => {
    const summary = generateLiveResults(learningRun(1), [], {
      model: 'claude-sonnet-5',
      n: 1,
      done: true,
      slope: tier,
    });
    expect(summary.markdown).toContain('## Slope (sequence slope-axios)');
    expect(summary.markdown).toContain('| task | position | variant | tokens (median) | turns (median) | zoom-backs | enrichment serves | learned injected | pitfalls injected | success |');
    // s02 redutok row carries its attribution counts.
    expect(summary.markdown).toMatch(/\| s02 \| 2 \| redutok \|[^|]+\|[^|]+\| 2 \| 3 \| 2 \| 0 \|/);
    // Vanilla rows have no .dcp, so attribution renders as an em dash.
    expect(summary.markdown).toMatch(/\| s02 \| 2 \| vanilla \|[^|]+\|[^|]+\| — \| — \| — \| — \|/);
    expect(summary.markdown).toContain('redutok slope (s3/s1): tokens 0.60x, turns 0.60x');
    expect(summary.markdown).toContain('headline: vanilla s3 over redutok s3: 3.2x tokens');
    expect(summary.markdown).toContain('### Pre-registered criteria');
    expect(summary.markdown).toMatch(/slope-exists: .+ MET/);
    expect(summary.markdown).toMatch(/learning-pays: .+ MET/);
    expect(summary.markdown).toMatch(/mechanism-engaged: .+ MET/);
    expect(summary.markdown).not.toContain('MET-UNATTRIBUTED');
    expect(summary.slope?.criteria.every((c) => c.pass)).toBe(true);
  });

  it('renders MET-UNATTRIBUTED and marks the result not citable when the bars pass with zero attribution', () => {
    const runs = learningRun(1).map((m) =>
      m.variant === 'redutok' ? { ...m, attribution: { zoomBacks: 0, enrichmentServes: 0, learnedInjected: 0, pitfallsInjected: 0 } } : m,
    );
    const summary = generateLiveResults(runs, [], { model: 'claude-sonnet-5', n: 1, done: true, slope: tier });
    // The numeric bars still pass, but without mechanism they are demoted.
    expect(summary.markdown).toMatch(/slope-exists: .+ MET-UNATTRIBUTED/);
    expect(summary.markdown).toMatch(/learning-pays: .+ MET-UNATTRIBUTED/);
    expect(summary.markdown).toMatch(/mechanism-engaged: .+ NOT MET/);
    expect(summary.markdown).toContain('not citable');
    expect(summary.slope?.mechanismEngaged).toBe(false);
    // The demoted label must never read as a plain MET.
    expect(summary.markdown).not.toMatch(/slope-exists: .+ — MET \(/);
  });

  it('omits the slope section when no slope tier is passed', () => {
    const summary = generateLiveResults(learningRun(1), [], { model: 'claude-sonnet-5', n: 1, done: true });
    expect(summary.markdown).not.toContain('## Slope');
  });
});

// ----------------------------------------------------------------- dry run

describe('dryRunMatrix with a slope tier', () => {
  it('prints the slope sequence in order with persistence and graduation notes, and keeps slope tasks out of the flat matrix', () => {
    const flatTask = slopeTask('t99', { tier: 'medium' });
    const lines = dryRunMatrix([flatTask, ...threeTasks()], 2, 'claude-sonnet-5', tier);
    const text = lines.join('\n');
    // Flat matrix still lists the ordinary task, once per rep and variant.
    expect(text).toContain('# t99 rep 1 vanilla');
    // Slope tasks appear only inside the sequence blocks.
    expect(lines.filter((l) => l.startsWith('# s01 rep 1 '))).toHaveLength(2);
    expect(text).toContain('# slope sequence slope-axios rep 1 redutok');
    expect(text).toContain('# slope sequence slope-axios rep 2 redutok');
    expect(text).toMatch(/persistent copy/);
    expect(text).toMatch(/graduation/);
    expect(text).toMatch(/cold copy/);
    // Sequence order is preserved within the redutok block.
    const s1 = text.indexOf('# s01 rep 1 redutok');
    const s2 = text.indexOf('# s02 rep 1 redutok');
    const s3 = text.indexOf('# s03 rep 1 redutok');
    expect(s1).toBeGreaterThan(-1);
    expect(s2).toBeGreaterThan(s1);
    expect(s3).toBeGreaterThan(s2);
  });

  it('runs unchanged with no slope tier', () => {
    const lines = dryRunMatrix([slopeTask('t99', { tier: 'medium' })], 1, 'claude-sonnet-5');
    expect(lines.some((l) => l.startsWith('# t99 rep 1 vanilla'))).toBe(true);
  });
});

// -------------------------------------------------- repo tier file (data)

describe('the pre-registered tier file in bench/tiers', () => {
  it('loads against the real task set: three axios tasks on a full-posture fixture, all criteria pinned before any run', () => {
    const tasks = loadBenchTasks(path.join(repoRoot, 'bench', 'tasks'));
    const loaded = loadSlopeTier(path.join(repoRoot, 'bench', 'tiers', 'slope.yaml'), tasks);
    expect(loaded.sequence).toEqual(['s01', 's02', 's03']);
    expect(loaded.criteria.map((c) => c.id)).toEqual(['slope-exists', 'learning-pays', 'mechanism-engaged']);
    const sequenceTasks = loaded.sequence.map((id) => tasks.find((t) => t.id === id));
    for (const task of sequenceTasks) {
      expect(task?.tier).toBe('slope');
      expect(task?.repo.localPath).toBe('fixtures/repos/axios');
    }
    // Related but distinct: the three prompts must not repeat each other.
    expect(new Set(sequenceTasks.map((t) => t?.prompt)).size).toBe(3);
    // Mixed read-and-fix shapes: at least one answer-graded task and at
    // least one command-graded fix, so error-fix candidates can arise.
    const kinds = sequenceTasks.flatMap((t) => t?.success.map((c) => c.kind) ?? []);
    expect(kinds).toContain('answer-contains');
    expect(kinds).toContain('command-succeeds');
    expect(kinds).toContain('file-changed');
  });
});
