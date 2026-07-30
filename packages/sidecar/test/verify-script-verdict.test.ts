import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DistillProfile } from '@redutok/shared';
import { AuditWriter } from '../src/audit.js';
import { distillArtifact, loadProfiles } from '../src/distill.js';
import { mineSessionCandidates } from '../src/graduation.js';
import { openStore, type Store } from '../src/store.js';

/**
 * The s02 starvation regression (2026-07-30 N=3): even had the pipe rewrite
 * fired, `node scripts/verify-url-assembly.mjs` output produced no conclusive
 * verdict — the test-output verdict patterns knew `N failed` and
 * `Tests  N passed (N)` but not the fail-fast verify-script convention
 * (`FAIL: <case>` lines, a terminal `... verified` line) — so the error-fix
 * miner had nothing to mine in the one task shaped for it. These are the
 * exact outputs from the s02-redutok transcripts, asserted end to end:
 * distill events with conclusive verdicts, then a mineable error-fix pair.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..', '..');
const profiles = loadProfiles(path.join(repoRoot, 'profiles'));

const FAIL_RAW = [
  'FAIL: combineURLs strips the duplicate slash at the joint',
  '  expected: https://api.example.com/v1/users/list',
  '  got:      https://api.example.com/v1//users/list',
  '',
].join('\n');

const PASS_RAW = [
  'ok: combineURLs strips the duplicate slash at the joint',
  'ok: combineURLs inserts a slash when neither side has one',
  'ok: combineURLs returns baseURL untouched for an empty relative URL',
  'ok: buildFullPath combines a relative url onto baseURL',
  'ok: buildFullPath leaves an absolute url untouched',
  'ok: buildFullPath treats a protocol-relative url as absolute',
  'url assembly verified',
  '',
].join('\n');

interface Rig {
  store: Store;
  audit: AuditWriter;
  auditPath: string;
}

function rig(): Rig {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'redutok-verify-verdict-'));
  const auditPath = path.join(dir, 'audit.jsonl');
  return { store: openStore(path.join(dir, 'state.db')), audit: new AuditWriter(auditPath), auditPath };
}

function testOutput(): DistillProfile {
  const p = profiles.get('test-output');
  if (p === undefined) throw new Error('test-output profile not loaded');
  return p;
}

function verdictDetail(outcome: Awaited<ReturnType<typeof distillArtifact>>): string {
  const gate = outcome.gateReport.results.find((r) => r.gate === 'verdict-fidelity');
  return gate?.detail ?? '';
}

describe('verify-script outputs produce conclusive verdicts under test-output', () => {
  it('extracts fail from the exact s02 failing output and pass from the exact passing output', async () => {
    const r = rig();
    const fail = await distillArtifact(r.store, r.audit, {
      raw: FAIL_RAW,
      profile: testOutput(),
      sessionId: 's02-verdict',
      tool: 'redutok-pipe',
    });
    // Conclusive fail, agreed by both extractions; whether the tiny artifact
    // serves distilled or raw is the size gate's business, not the verdict's.
    expect(verdictDetail(fail)).toMatch(/verdict fail agreed|raw verdict fail but/);

    const pass = await distillArtifact(r.store, r.audit, {
      raw: PASS_RAW,
      profile: testOutput(),
      sessionId: 's02-verdict',
      tool: 'redutok-pipe',
    });
    expect(verdictDetail(pass)).toMatch(/verdict pass agreed|raw verdict pass but/);
  });

  it('mines the fail-then-pass pair into an error-fix candidate with the FAIL-line signature', async () => {
    const r = rig();
    await distillArtifact(r.store, r.audit, {
      raw: FAIL_RAW,
      profile: testOutput(),
      sessionId: 's02-mine',
      tool: 'redutok-pipe',
    });
    await distillArtifact(r.store, r.audit, {
      raw: PASS_RAW,
      profile: testOutput(),
      sessionId: 's02-mine',
      tool: 'redutok-pipe',
    });
    const { readAuditFile } = await import('@redutok/shared');
    const events = readAuditFile(r.auditPath).events;
    const mined = mineSessionCandidates(events, {
      priorRecords: [],
      resolveArtifact: (id) => r.store.getArtifact(id),
    });
    const errorFix = mined.filter((c) => c.type === 'error-fix');
    expect(errorFix).toHaveLength(1);
    expect(errorFix[0]?.signature).toBe('FAIL: combineURLs strips the duplicate slash at the joint');
    expect(errorFix[0]?.key).toContain('test-output');
  });
});
