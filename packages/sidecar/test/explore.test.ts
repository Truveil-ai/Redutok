import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LIMITS } from '@redutok/shared';
import { AuditWriter } from '../src/audit.js';
import { exploreGoal } from '../src/explore.js';
import { loadProfiles, zoom } from '../src/distill.js';
import { NoopLlmPass, type LlmPass } from '../src/llm.js';
import { openStore, type Store } from '../src/store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..', '..');
const profiles = loadProfiles(path.join(repoRoot, 'profiles'));
const chalkRoot = path.join(repoRoot, 'fixtures', 'repos', 'chalk');

interface Rig {
  store: Store;
  audit: AuditWriter;
}

function rig(): Rig {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'redutok-explore-'));
  return { store: openStore(path.join(dir, 'state.db')), audit: new AuditWriter(path.join(dir, 'audit.jsonl')) };
}

const noop: LlmPass = new NoopLlmPass();

describe('exploreGoal against the real h03 fixture (fixtures/repos/chalk)', () => {
  it('returns a dossier whose evidence and zoom handles trace back to real source lines', async () => {
    const r = rig();
    const dossier = await exploreGoal(r.store, r.audit, profiles, noop, {
      goal: 'how does levelMapping pick between ansi ansi256 and ansi16m color models',
      scope: ['source'],
      budget: 'thorough',
      sessionId: 's-explore-chalk',
      repoRoot: chalkRoot,
    });

    expect(dossier.evidence.length).toBeGreaterThan(0);
    expect(dossier.evidence.some((e) => e.file.includes('index.js'))).toBe(true);
    expect(dossier.stepsTaken).toBeGreaterThan(0);
    expect(dossier.stepsTaken).toBeLessThanOrEqual(LIMITS.EXPLORE_STEP_CAP.thorough);
    expect(dossier.distillationRatio).toBeGreaterThan(1);
    expect(dossier.verdict.length).toBeGreaterThan(0);
    expect(dossier.zoomHandles.length).toBeGreaterThan(0);

    // Every zoom handle resolves without re-executing anything: the internal
    // steps stored their raw artifacts exactly as any dcp__read/dcp__search
    // call would, so the escape hatch works without a model-visible turn.
    for (const id of dossier.zoomHandles) {
      const resolved = zoom(r.store, r.audit, id);
      expect(resolved.found).toBe(true);
    }

    // One summary event closes the call; internal read/search steps are
    // audited too (via distillArtifact), same as any other distillation.
    const events = r.store.listAuditEvents('s-explore-chalk');
    expect(events.some((e) => e.module === 'sidecar.explore' && e.action === 'summarize')).toBe(true);
    expect(events.some((e) => e.module === 'sidecar.distill')).toBe(true);
  });

  it('is read-only: a goal phrased as a mutation returns incomplete with a continuation hint, no steps taken', async () => {
    const r = rig();
    const dossier = await exploreGoal(r.store, r.audit, profiles, noop, {
      goal: 'Fix the bug in source/index.js',
      budget: 'standard',
      sessionId: 's-explore-mutation',
      repoRoot: chalkRoot,
    });
    expect(dossier.incomplete?.reason).toMatch(/mutation/i);
    expect(dossier.stepsTaken).toBe(0);
    expect(dossier.evidence).toEqual([]);
  });

  it('reports incomplete with a reason when no keywords match anything', async () => {
    const r = rig();
    const dossier = await exploreGoal(r.store, r.audit, profiles, noop, {
      goal: 'zzzqqqnonexistentxyzsymbol',
      budget: 'standard',
      sessionId: 's-explore-nohits',
      repoRoot: chalkRoot,
    });
    expect(dossier.incomplete?.reason).toMatch(/no hits/i);
  });

  it('reports incomplete when the goal has no searchable keywords at all', async () => {
    const r = rig();
    const dossier = await exploreGoal(r.store, r.audit, profiles, noop, {
      goal: 'the a of to',
      budget: 'standard',
      sessionId: 's-explore-vague',
      repoRoot: chalkRoot,
    });
    expect(dossier.incomplete?.reason).toMatch(/vague/i);
  });

  it('respects the quick step cap: more matching files than the budget allows produces incomplete', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'redutok-explore-manyfiles-'));
    for (let i = 0; i < 6; i += 1) {
      writeFileSync(path.join(dir, `widget${i}.ts`), `export function widgetFactory${i}() { return ${i}; }\n`);
    }
    const r = rig();
    const dossier = await exploreGoal(r.store, r.audit, profiles, noop, {
      goal: 'widgetFactory implementation',
      budget: 'quick',
      sessionId: 's-explore-cap',
      repoRoot: dir,
    });
    expect(dossier.stepsTaken).toBeLessThanOrEqual(LIMITS.EXPLORE_STEP_CAP.quick);
    expect(dossier.incomplete?.reason).toMatch(/step cap/i);
    expect(dossier.incomplete?.continuationHint.length).toBeGreaterThan(0);
  });
});
