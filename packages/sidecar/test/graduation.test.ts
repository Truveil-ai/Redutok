import childProcess from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readCandidatesFile, type AuditEvent, type CandidateRecord } from '@redutok/shared';
import {
  mineSessionCandidates,
  runGraduationMiner,
  type ArtifactLookup,
} from '../src/graduation.js';
import type { LlmPass } from '../src/llm.js';

const tmpDcp = (): string => mkdtempSync(path.join(os.tmpdir(), 'redutok-grad-'));

function at(minute: number): string {
  return new Date(Date.UTC(2026, 6, 19, 12, minute, 0)).toISOString();
}

function verdictEvent(
  id: string,
  minute: number,
  verdict: 'pass' | 'fail',
  opts: { profile?: string; sessionId?: string; agreed?: boolean } = {},
): AuditEvent {
  const profile = opts.profile ?? 'build-log';
  const agreed = opts.agreed ?? true;
  return {
    id,
    timestamp: at(minute),
    sessionId: opts.sessionId ?? 's1',
    module: 'sidecar.distill',
    action: agreed ? 'distill' : 'serve-raw',
    reason: `profile ${profile} served`,
    inputRef: id.replace(/^[a-z-]+-/, ''),
    details: {
      profile,
      gates: [
        { gate: 'entity-preservation', passed: true, detail: 'no entities in relevant region' },
        {
          gate: 'verdict-fidelity',
          passed: agreed,
          detail: agreed
            ? `verdict ${verdict} agreed by both extractions and the distillate`
            : 'extractions disagree or are inconclusive on raw: primary=unknown, secondary=pass',
        },
      ],
    },
  };
}

function zoomEvent(
  id: string,
  minute: number,
  artifactId: string,
  query: string | null,
  sessionId = 's1',
): AuditEvent {
  return {
    id,
    timestamp: at(minute),
    sessionId,
    module: 'sidecar.zoom',
    action: 'zoom',
    reason: query === null ? `raw artifact ${artifactId} served` : `query slice of ${artifactId} for "${query}"`,
    inputRef: artifactId,
    details: { query },
  };
}

function diffServeEvent(id: string, minute: number, relPath: string, sessionId = 's1'): AuditEvent {
  return {
    id,
    timestamp: at(minute),
    sessionId,
    module: 'sidecar.serve',
    action: 'distill',
    reason: `${relPath} served as unified diff aaaa to bbbb`,
    inputRef: 'Fdead@beef',
    details: { mode: 'diff' },
  };
}

function rewriteEvent(id: string, minute: number, command: string, sessionId = 's1'): AuditEvent {
  return {
    id,
    timestamp: at(minute),
    sessionId,
    module: 'hooks.pretooluse',
    action: 'rewrite',
    reason: 'command rewritten through redutok-pipe, matched allowlist rule build',
    details: { rule: 'build', command },
  };
}

const failRaw =
  'src/a.ts(10,5): error TS2304: Cannot find name \'frobnicate\'.\nbuild failed\n';
const failDistilled =
  'VERDICT: fail\nfirst error: src/a.ts(10,5): error TS2304: Cannot find name \'frobnicate\'.\nerrors: 1 lines across 1 files';

function lookupWith(map: Record<string, { raw: string; distilled?: string; filePath?: string }>): ArtifactLookup {
  return (id) => {
    const hit = map[id];
    if (hit === undefined) return undefined;
    return { raw: hit.raw, distilled: hit.distilled, filePath: hit.filePath };
  };
}

describe('mineSessionCandidates: error-fix pairs', () => {
  it('pairs a failing verdict with a later passing one on the same target', () => {
    const events = [
      rewriteEvent('rw1', 0, 'pnpm build'),
      verdictEvent('raw-af1', 1, 'fail'),
      diffServeEvent('serve1', 2, 'src/a.ts'),
      verdictEvent('distilled-ap1', 3, 'pass'),
    ];
    const mined = mineSessionCandidates(events, {
      priorRecords: [],
      resolveArtifact: lookupWith({ af1: { raw: failRaw, distilled: failDistilled } }),
    });
    const fix = mined.filter((c) => c.type === 'error-fix');
    expect(fix).toHaveLength(1);
    expect(fix[0]?.signature).toContain('error TS2304');
    expect(fix[0]?.signature).not.toContain('(10,5)');
    expect(fix[0]?.evidence).toEqual(['raw-af1', 'distilled-ap1']);
    expect(fix[0]?.details['changedFiles']).toEqual(['src/a.ts']);
    expect(fix[0]?.details['command']).toBe('pnpm build');
    expect(fix[0]?.details['profile']).toBe('build-log');
  });

  it('mines nothing from a fail without a later pass, or a pass alone', () => {
    const failOnly = mineSessionCandidates([verdictEvent('f1', 0, 'fail')], { priorRecords: [] });
    const passOnly = mineSessionCandidates([verdictEvent('p1', 0, 'pass')], { priorRecords: [] });
    expect(failOnly.filter((c) => c.type === 'error-fix')).toHaveLength(0);
    expect(passOnly.filter((c) => c.type === 'error-fix')).toHaveLength(0);
  });

  it('does not pair across different profiles and ignores inconclusive verdicts', () => {
    const events = [
      verdictEvent('f1', 0, 'fail', { profile: 'build-log' }),
      verdictEvent('p1', 1, 'pass', { profile: 'test-output' }),
      verdictEvent('x1', 2, 'pass', { profile: 'build-log', agreed: false }),
    ];
    const mined = mineSessionCandidates(events, { priorRecords: [] });
    expect(mined.filter((c) => c.type === 'error-fix')).toHaveLength(0);
  });

  it('falls back to a profile-level signature when no artifact is resolvable', () => {
    const events = [verdictEvent('f1', 0, 'fail'), verdictEvent('p1', 1, 'pass')];
    const mined = mineSessionCandidates(events, { priorRecords: [] });
    const fix = mined.filter((c) => c.type === 'error-fix');
    expect(fix).toHaveLength(1);
    expect(fix[0]?.signature).toContain('build-log');
  });
});

describe('mineSessionCandidates: zoom-back hotspots', () => {
  it('groups zooms by resolved file path and captures queried symbols', () => {
    const events = [
      zoomEvent('z1', 0, 'a111', 'createStyler'),
      zoomEvent('z2', 1, 'a111', 'applyOptions'),
      zoomEvent('z3', 2, 'a111', null),
    ];
    const mined = mineSessionCandidates(events, {
      priorRecords: [],
      resolveArtifact: lookupWith({ a111: { raw: 'x', filePath: 'source/index.ts' } }),
    });
    const hot = mined.filter((c) => c.type === 'zoom-hotspot');
    expect(hot).toHaveLength(1);
    expect(hot[0]?.key).toBe('zoom-hotspot:source/index.ts');
    expect(hot[0]?.details['zoomCount']).toBe(3);
    expect(hot[0]?.details['queries']).toEqual(['createStyler', 'applyOptions']);
    expect(hot[0]?.evidence).toEqual(['z1', 'z2', 'z3']);
  });

  it('falls back to the artifact class from the matching distill event when no file is known', () => {
    const distill = verdictEvent('distilled-abc1', 0, 'fail');
    const events = [distill, zoomEvent('z1', 1, 'abc1', null)];
    const mined = mineSessionCandidates(events, { priorRecords: [] });
    const hot = mined.filter((c) => c.type === 'zoom-hotspot');
    expect(hot).toHaveLength(1);
    expect(hot[0]?.key).toBe('zoom-hotspot:build-log');
    expect(hot[0]?.details['targetKind']).toBe('artifact-class');
  });
});

describe('mineSessionCandidates: recurrence signals', () => {
  const prior: CandidateRecord = {
    id: 'cand-old',
    type: 'error-fix',
    key: "error-fix:build-log:src/a.ts(#): error TS2304: Cannot find name 'frobnicate'.",
    signature: "src/a.ts(#): error TS2304: Cannot find name 'frobnicate'.",
    evidence: [],
    firstSeen: at(0),
    lastSeen: at(0),
    occurrences: 1,
    contradiction: null,
    details: { command: 'pnpm build', changedFiles: ['src/a.ts'] },
  };

  it('flags a command, path, or error signature already present in prior records', () => {
    const events = [
      rewriteEvent('rw1', 0, 'pnpm build'),
      verdictEvent('f1', 1, 'fail'),
      diffServeEvent('s1', 2, 'src/a.ts'),
    ];
    const mined = mineSessionCandidates(events, {
      priorRecords: [prior],
      resolveArtifact: lookupWith({ f1: { raw: failRaw, distilled: failDistilled } }),
    });
    const rec = mined.filter((c) => c.type === 'recurrence');
    const kinds = rec.map((c) => c.details['signalKind']).sort();
    expect(kinds).toEqual(['command', 'error-signature', 'path']);
    expect(rec.every((c) => c.evidence.length > 0)).toBe(true);
  });

  it('mines no recurrence when prior records do not mention the signals', () => {
    const events = [rewriteEvent('rw1', 0, 'cargo test'), diffServeEvent('s1', 1, 'src/other.rs')];
    const mined = mineSessionCandidates(events, { priorRecords: [] });
    expect(mined.filter((c) => c.type === 'recurrence')).toHaveLength(0);
  });
});

describe('runGraduationMiner', () => {
  function writeAudit(dcpDir: string, events: AuditEvent[]): void {
    writeFileSync(
      path.join(dcpDir, 'audit.jsonl'),
      events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    );
  }

  it('persists schema-valid candidates and writes a mining audit event with counts', async () => {
    const dcpDir = tmpDcp();
    writeAudit(dcpDir, [verdictEvent('f1', 0, 'fail'), verdictEvent('p1', 1, 'pass')]);
    const result = await runGraduationMiner({ dcpDir, sessionId: 's1' });
    expect(result.mined).toBe(1);
    expect(result.merged).toBe(0);
    expect(result.skipped).toBe(0);

    const file = readCandidatesFile(path.join(dcpDir, 'candidates.jsonl'));
    expect(file.records).toHaveLength(1);
    expect(file.records[0]?.occurrences).toBe(1);
    expect(file.records[0]?.contradiction).toBeNull();

    const auditLines = readFileSync(path.join(dcpDir, 'audit.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as AuditEvent);
    const miningEvent = auditLines.find((e) => e.module === 'sidecar.graduation');
    expect(miningEvent?.action).toBe('summarize');
    expect(miningEvent?.details?.['mined']).toBe(1);
    expect(miningEvent?.details?.['merged']).toBe(0);
    expect(miningEvent?.details?.['skipped']).toBe(0);
  });

  it('increments occurrences on re-observation in a later session, not on a same-session re-run', async () => {
    const dcpDir = tmpDcp();
    writeAudit(dcpDir, [verdictEvent('f1', 0, 'fail'), verdictEvent('p1', 1, 'pass')]);
    await runGraduationMiner({ dcpDir, sessionId: 's1' });

    // Same session mined again (a second Stop): merged into place, no double count.
    const rerun = await runGraduationMiner({ dcpDir, sessionId: 's1' });
    expect(rerun.skipped).toBe(1);
    let file = readCandidatesFile(path.join(dcpDir, 'candidates.jsonl'));
    expect(file.records[0]?.occurrences).toBe(1);

    // The same pair observed in a fresh session increments and updates lastSeen.
    writeAudit(dcpDir, [
      verdictEvent('f1', 0, 'fail'),
      verdictEvent('p1', 1, 'pass'),
      verdictEvent('f2', 10, 'fail', { sessionId: 's2' }),
      verdictEvent('p2', 11, 'pass', { sessionId: 's2' }),
    ]);
    const second = await runGraduationMiner({ dcpDir, sessionId: 's2' });
    expect(second.merged).toBe(1);
    file = readCandidatesFile(path.join(dcpDir, 'candidates.jsonl'));
    expect(file.records).toHaveLength(1);
    expect(file.records[0]?.occurrences).toBe(2);
    expect(file.records[0]?.firstSeen < file.records[0]!.lastSeen).toBe(true);
  });

  it('mines every session in history order when no session id is given', async () => {
    const dcpDir = tmpDcp();
    writeAudit(dcpDir, [
      verdictEvent('f1', 0, 'fail', { sessionId: 'sA' }),
      verdictEvent('p1', 1, 'pass', { sessionId: 'sA' }),
      verdictEvent('f2', 10, 'fail', { sessionId: 'sB' }),
      verdictEvent('p2', 11, 'pass', { sessionId: 'sB' }),
    ]);
    const result = await runGraduationMiner({ dcpDir });
    expect(result.mined).toBe(2);
    expect(result.merged).toBe(1);
    const file = readCandidatesFile(path.join(dcpDir, 'candidates.jsonl'));
    expect(file.records).toHaveLength(1);
    expect(file.records[0]?.occurrences).toBe(2);
  });

  it('drafts a one-sentence lesson through the LlmPass and falls back to the signature on null', async () => {
    const dcpDir = tmpDcp();
    writeAudit(dcpDir, [verdictEvent('f1', 0, 'fail'), verdictEvent('p1', 1, 'pass')]);
    const drafting: LlmPass = {
      name: 'fake',
      summarize: ({ timeoutMs }) => {
        expect(timeoutMs).toBeGreaterThan(0);
        return Promise.resolve('Re-run the build after fixing the missing import.');
      },
    };
    await runGraduationMiner({ dcpDir, sessionId: 's1', llm: drafting });
    const withLesson = readCandidatesFile(path.join(dcpDir, 'candidates.jsonl'));
    expect(withLesson.records[0]?.lesson).toBe('Re-run the build after fixing the missing import.');

    const dcpDir2 = tmpDcp();
    writeAudit(dcpDir2, [verdictEvent('f1', 0, 'fail'), verdictEvent('p1', 1, 'pass')]);
    await runGraduationMiner({ dcpDir: dcpDir2, sessionId: 's1' });
    const noLesson = readCandidatesFile(path.join(dcpDir2, 'candidates.jsonl'));
    expect(noLesson.records[0]?.lesson).toBeUndefined();
    expect(noLesson.records[0]?.signature.length).toBeGreaterThan(0);
  });

  it('runs with zero tokens: no model call and no network by any transport', async () => {
    const dcpDir = tmpDcp();
    writeAudit(dcpDir, [
      rewriteEvent('rw1', 0, 'pnpm build'),
      verdictEvent('f1', 1, 'fail'),
      diffServeEvent('s1', 2, 'src/a.ts'),
      verdictEvent('p1', 3, 'pass'),
      zoomEvent('z1', 4, 'f1', 'frobnicate'),
    ]);
    const httpSpy = vi.spyOn(http, 'request');
    const httpsSpy = vi.spyOn(https, 'request');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const spawnSpy = vi.spyOn(childProcess, 'spawn');
    const execSpy = vi.spyOn(childProcess, 'exec');
    try {
      const result = await runGraduationMiner({ dcpDir, sessionId: 's1' });
      expect(result.mined).toBeGreaterThan(0);
      expect(httpSpy).not.toHaveBeenCalled();
      expect(httpsSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(spawnSpy).not.toHaveBeenCalled();
      expect(execSpy).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('reports an empty run against an empty or missing audit file without throwing', async () => {
    const dcpDir = tmpDcp();
    const result = await runGraduationMiner({ dcpDir, sessionId: 's1' });
    expect(result).toMatchObject({ mined: 0, merged: 0, skipped: 0 });
  });
});
