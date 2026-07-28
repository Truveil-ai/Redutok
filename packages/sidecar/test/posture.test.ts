import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LIMITS, type AuditEvent } from '@redutok/shared';
import { buildInjection, writeCodex } from '../src/codex.js';
import { startDaemon } from '../src/daemon.js';
import { assessSessionPosture } from '../src/posture.js';
import { sidecarRequest } from '../src/client.js';

const profilesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', 'profiles',
);

function tempRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'redutok-posture-'));
}

describe('assessSessionPosture', () => {
  it('a tiny repo with no codex idles', () => {
    const root = tempRoot();
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(path.join(root, 'src', 'b.ts'), 'export const b = 2;\n');
    const decision = assessSessionPosture(root);
    expect(decision.posture).toBe('idle');
    expect(decision.pinned).toBe(false);
    expect(decision.assessment.files).toBe(2);
    expect(decision.assessment.sourceBytes).toBeGreaterThan(0);
  });

  it('graduated knowledge in the codex lifts a tiny repo to light', async () => {
    const root = tempRoot();
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    await writeCodex(root);
    const codexPath = path.join(root, '.dcp', 'codex.yaml');
    const { parse, stringify } = await import('yaml');
    const doc = parse(readFileSync(codexPath, 'utf8')) as { learned?: unknown };
    doc.learned = [
      {
        kind: 'skeleton-enrichment',
        candidate: 'cand-tiny',
        path: 'src/a.ts',
        symbols: ['a'],
        confidence: 0.6,
        source: 'graduated',
        addedAt: '2026-07-29T00:00:00.000Z',
      },
    ];
    writeFileSync(codexPath, stringify(doc));
    const decision = assessSessionPosture(root);
    expect(decision.posture).toBe('light');
    expect(decision.assessment.learnedEntries).toBe(1);
  });

  it('a repo over the file threshold engages full governance, with the walk capped', () => {
    const root = tempRoot();
    mkdirSync(path.join(root, 'src'));
    for (let i = 0; i < LIMITS.POSTURE.LIGHT_MAX_FILES + 5; i += 1) {
      writeFileSync(path.join(root, 'src', `f${i}.ts`), `export const f${i} = ${i};\n`);
    }
    const decision = assessSessionPosture(root);
    expect(decision.posture).toBe('full');
    expect(decision.assessment.capped).toBe(true);
  });

  it('config.json can pin the posture, skipping assessment', () => {
    const root = tempRoot();
    mkdirSync(path.join(root, '.dcp'));
    writeFileSync(path.join(root, '.dcp', 'config.json'), JSON.stringify({ posture: 'full' }));
    const decision = assessSessionPosture(root);
    expect(decision.posture).toBe('full');
    expect(decision.pinned).toBe(true);
  });

  it('this repository assesses full', () => {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const decision = assessSessionPosture(repoRoot);
    expect(decision.posture).toBe('full');
  });
});

describe('the posture decision is audited (docs/POSTURE.md)', () => {
  it('a session-posture notify writes a posture audit event carrying the exclusion refs', async () => {
    const root = tempRoot();
    const dcpDir = path.join(root, '.dcp');
    mkdirSync(dcpDir);
    const daemon = await startDaemon({ port: 0, dcpDir, profilesDir });
    try {
      const res = await sidecarRequest({ port: daemon.port }, 'POST', '/notify', {
        kind: 'session-posture',
        sessionId: 's-posture',
        posture: 'full',
        pinned: false,
        files: 156,
        sourceBytes: 2_900_000,
        learnedEntries: 19,
        pitfallEntries: 0,
        injectedLearned: ['cand-a', 'cand-b'],
        excludedLearned: ['cand-lowest', 'cand-low'],
        injectedPitfalls: [],
        droppedSections: ['importGraph', 'interfaces'],
      }, { timeoutMs: 2000 });
      expect(res.ok).toBe(true);
      const events = readFileSync(path.join(dcpDir, 'audit.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as AuditEvent);
      const posture = events.find((e) => e.action === 'posture');
      expect(posture).toBeDefined();
      expect(posture?.sessionId).toBe('s-posture');
      expect(posture?.module).toBe('hooks.session-start');
      expect(posture?.reason).toContain('session posture full');
      expect(posture?.details?.['excludedLearned']).toEqual(['cand-lowest', 'cand-low']);
      expect(posture?.details?.['injectedLearned']).toEqual(['cand-a', 'cand-b']);
      expect(posture?.details?.['droppedSections']).toEqual(['importGraph', 'interfaces']);
    } finally {
      await daemon.close();
    }
  });

  it('over-filled learned excludes lowest-confidence refs that the audit event then carries', async () => {
    // End-to-end shape of the degradation story: buildInjection computes the
    // exclusions, the notify carries them, the daemon audits them verbatim.
    const { CodexFileSchema } = await import('@redutok/shared');
    const codex = CodexFileSchema.parse({
      version: '1',
      project: 'overfill',
      generatedAt: '2026-07-29T00:00:00.000Z',
      learned: Array.from({ length: 40 }, (_, i) => ({
        kind: 'skeleton-enrichment',
        candidate: `cand-${String(i).padStart(4, '0')}`,
        path: `packages/example/src/very/long/module/path/number-${i}/index.ts`,
        symbols: ['alpha', 'beta', 'gamma', 'delta', `symbol${i}`],
        confidence: (i + 1) / 41,
        source: 'graduated',
        addedAt: '2026-07-29T00:00:00.000Z',
      })),
    });
    const injection = buildInjection(codex, { maxTokens: 100_000 });
    expect(injection.excludedLearned[0]).toBe('cand-0000');

    const root = tempRoot();
    const dcpDir = path.join(root, '.dcp');
    mkdirSync(dcpDir);
    const daemon = await startDaemon({ port: 0, dcpDir, profilesDir });
    try {
      await sidecarRequest({ port: daemon.port }, 'POST', '/notify', {
        kind: 'session-posture',
        sessionId: 's-overfill',
        posture: 'full',
        excludedLearned: injection.excludedLearned,
        injectedLearned: injection.injectedLearned,
      }, { timeoutMs: 2000 });
      const events = readFileSync(path.join(dcpDir, 'audit.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as AuditEvent);
      const posture = events.find((e) => e.action === 'posture');
      expect(posture?.details?.['excludedLearned']).toEqual(injection.excludedLearned);
      expect((posture?.details?.['excludedLearned'] as string[])[0]).toBe('cand-0000');
    } finally {
      await daemon.close();
    }
  });
});
