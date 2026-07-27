import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DistillProfile } from '@redutok/shared';
import { AuditWriter } from '../src/audit.js';
import { distillArtifact, loadProfiles, zoom } from '../src/distill.js';
import { openStore, type Store } from '../src/store.js';

/**
 * The build-log profile's secondary verdict extractor must agree with the
 * primary on real-world failure vocabulary. The observed gap: a log ending in
 * "BUILD FAILED" whose only error text is "SyntaxError: ..." reads fail from
 * the primary extractor but pass from a secondary that only knows the bare
 * word "error" (no word boundary exists inside compound identifiers like
 * SyntaxError), so verdict-fidelity fails and the raw log is served. The
 * broadened deterministic patterns live in profiles/build-log.yaml.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..', '..');
const profiles = loadProfiles(path.join(repoRoot, 'profiles'));

interface Rig {
  store: Store;
  audit: AuditWriter;
}

function rig(): Rig {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'redutok-buildlog-'));
  return { store: openStore(path.join(dir, 'state.db')), audit: new AuditWriter(path.join(dir, 'audit.jsonl')) };
}

function buildLog(): DistillProfile {
  const p = profiles.get('build-log');
  if (p === undefined) throw new Error('build-log profile not loaded');
  return p;
}

async function distill(r: Rig, raw: string) {
  return distillArtifact(r.store, r.audit, {
    raw,
    profile: buildLog(),
    sessionId: 's-buildlog-verdict',
    tool: 'Bash',
  });
}

// Padding that mimics healthy compiler chatter so the size-sanity gate is
// exercised realistically (a distillate must be well under 0.4x of raw).
const CHATTER = Array.from({ length: 40 }, (_, i) => `[compile] emitted assets/chunk-${i}.js (${1000 + i} bytes)`).join('\n');

describe('secondary verdict extractor agrees on real-world failure vocabulary', () => {
  it('chalk-heavy-build regression: the real fixture log now serves distilled with gates passing', async () => {
    const fixture = path.join(repoRoot, 'fixtures', 'repos', 'chalk-heavy-build');
    const run = spawnSync(process.execPath, ['scripts/verbose-build.mjs'], { cwd: fixture });
    expect(run.status).toBe(1);
    const raw = run.stdout.toString('utf8') + run.stderr.toString('utf8');
    expect(raw).toContain('SyntaxError');
    expect(raw).toContain('BUILD FAILED');

    const r = rig();
    const outcome = await distill(r, raw);
    expect(outcome.gateReport.results.every((g) => g.passed)).toBe(true);
    expect(outcome.served).toBe('distilled');
    expect(outcome.text).toContain('VERDICT: fail');
    expect(outcome.text).toContain('SyntaxError');
    expect(outcome.text.length).toBeLessThan(raw.length * 0.4);
    // Zoom still recovers the raw log byte-for-byte.
    expect(zoom(r.store, r.audit, outcome.artifactId).text).toBe(raw);
  });

  it('reads fail from npm ERR! vocabulary', async () => {
    const raw = [
      '> myapp@1.0.0 build',
      '> webpack --mode production',
      '',
      CHATTER,
      '',
      'npm ERR! code ELIFECYCLE',
      'npm ERR! errno 1',
      'npm ERR! myapp@1.0.0 build: `webpack --mode production`',
      'npm ERR! Exit status 1',
      'npm ERR! Failed at the myapp@1.0.0 build script.',
    ].join('\n');
    const outcome = await distill(rig(), raw);
    expect(outcome.served).toBe('distilled');
    expect(outcome.gateReport.passed).toBe(true);
    expect(outcome.text).toContain('VERDICT: fail');
  });

  it('reads fail from a bare BUILD FAILED banner with compound-Error diagnostics', async () => {
    const raw = [
      'build: checking 24 source files',
      CHATTER,
      "TypeError: Cannot read properties of undefined (reading 'concat')",
      'BUILD FAILED: 1 of 24 files failed the transform',
    ].join('\n');
    const outcome = await distill(rig(), raw);
    expect(outcome.served).toBe('distilled');
    expect(outcome.gateReport.passed).toBe(true);
    expect(outcome.text).toContain('VERDICT: fail');
  });

  it('still reads pass on a clean build log, no false-fail from the broadened vocabulary', async () => {
    const raw = ['> tsc --build tsconfig.json', CHATTER, 'build: Done in 3.21s.'].join('\n');
    const outcome = await distill(rig(), raw);
    expect(outcome.served).toBe('distilled');
    expect(outcome.gateReport.passed).toBe(true);
    expect(outcome.text).toContain('VERDICT: pass');
  });
});
