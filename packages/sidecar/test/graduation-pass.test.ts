import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readAuditFile, readCandidatesFile, type AuditEvent } from '@redutok/shared';
import { readCodex, writeCodex } from '../src/codex.js';
import { runGraduationMiner, mergeCandidates, type ArtifactLookup } from '../src/graduation.js';
import { mirrorEntryPath } from '../src/mirror.js';

/**
 * The graduation pass (docs/GRADUATION.md): candidates that earn enough
 * confidence graduate into the codex, contradicted entries demote, every
 * action audited. These tests drive the full runGraduationMiner so the pass
 * is exercised exactly as the session-end trigger runs it.
 */

const SOURCE = [
  'const createStyler = (open, close, parent) => {',
  '\tlet openAll;',
  '\treturn {open, close, openAll, parent};',
  '};',
  '',
  'function applyStyle(self, string) {',
  '\treturn string + self;',
  '}',
  '',
].join('\n');

async function repoWithCodex(): Promise<{ root: string; dcpDir: string }> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redutok-gradpass-'));
  mkdirSync(path.join(root, 'source'), { recursive: true });
  writeFileSync(path.join(root, 'source', 'index.js'), SOURCE);
  await writeCodex(root);
  return { root, dcpDir: path.join(root, '.dcp') };
}

function at(day: number, minute: number): string {
  return new Date(Date.UTC(2026, 6, day, 12, minute, 0)).toISOString();
}

function zoomEvent(id: string, day: number, minute: number, artifactId: string, query: string | null, sessionId: string): AuditEvent {
  return {
    id,
    timestamp: at(day, minute),
    sessionId,
    module: 'sidecar.zoom',
    action: 'zoom',
    reason: `query slice of ${artifactId}`,
    inputRef: artifactId,
    details: { query },
  };
}

function verdictEvent(id: string, day: number, minute: number, verdict: 'pass' | 'fail', sessionId: string): AuditEvent {
  return {
    id,
    timestamp: at(day, minute),
    sessionId,
    module: 'sidecar.distill',
    action: 'distill',
    reason: 'profile build-log served',
    inputRef: id.replace(/^v-/, ''),
    details: {
      profile: 'build-log',
      gates: [{ gate: 'verdict-fidelity', passed: true, detail: `verdict ${verdict} agreed by both extractions and the distillate` }],
    },
  };
}

const failRaw = "src/a.ts(10,5): error TS2304: Cannot find name 'frobnicate'.\nbuild failed\n";

function writeAudit(dcpDir: string, events: AuditEvent[]): void {
  writeFileSync(path.join(dcpDir, 'audit.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

const hotspotLookup: ArtifactLookup = (id) =>
  id.startsWith('a') ? { raw: SOURCE, filePath: 'source/index.js' } : { raw: failRaw };

describe('graduation: zoom-hotspot', () => {
  it('a two-session hotspot graduates into a learned directive, enriches the mirror, and audits', async () => {
    const { root, dcpDir } = await repoWithCodex();
    writeAudit(dcpDir, [
      zoomEvent('z1', 19, 0, 'a111', 'createStyler', 's1'),
      zoomEvent('z2', 19, 1, 'a111', 'createStyler createBuilder proto', 's1'),
      zoomEvent('z3', 20, 0, 'a222', 'applyStyle', 's2'),
    ]);
    const result = await runGraduationMiner({
      dcpDir,
      repoRoot: root,
      resolveArtifact: hotspotLookup,
      now: () => at(21, 0),
    });
    expect(result.graduated).toHaveLength(1);

    const record = readCandidatesFile(path.join(dcpDir, 'candidates.jsonl')).records.find(
      (r) => r.type === 'zoom-hotspot',
    );
    expect(record?.status).toBe('graduated');
    expect(record?.graduatedAt).toBe(at(21, 0));
    expect(record?.confidence).toBeCloseTo(0.5, 2);

    const codex = readCodex(root).codex;
    expect(codex?.learned).toHaveLength(1);
    expect(codex?.learned[0]?.path).toBe('source/index.js');
    // Symbols are the union of queried identifiers across both sessions.
    expect(codex?.learned[0]?.symbols).toEqual(
      expect.arrayContaining(['createStyler', 'createBuilder', 'proto', 'applyStyle']),
    );
    expect(codex?.learned[0]?.candidate).toBe(record?.id);

    // The actual skeleton served changes: full body in the mirror entry.
    const entry = readFileSync(mirrorEntryPath(root, 'source/index.js'), 'utf8');
    expect(entry).toContain('return {open, close, openAll, parent};');

    const graduateEvents = readAuditFile(path.join(dcpDir, 'audit.jsonl')).events.filter(
      (e) => e.action === 'graduate',
    );
    expect(graduateEvents).toHaveLength(1);
    expect(graduateEvents[0]?.details?.['candidate']).toBe(record?.id);
  });

  it('is idempotent: a re-run adds no duplicate entries and no second graduate event', async () => {
    const { root, dcpDir } = await repoWithCodex();
    writeAudit(dcpDir, [
      zoomEvent('z1', 19, 0, 'a111', 'createStyler', 's1'),
      zoomEvent('z2', 20, 0, 'a222', 'createStyler', 's2'),
    ]);
    const opts = { dcpDir, repoRoot: root, resolveArtifact: hotspotLookup, now: (): string => at(21, 0) };
    await runGraduationMiner(opts);
    const rerun = await runGraduationMiner(opts);
    expect(rerun.graduated).toHaveLength(0);
    expect(readCodex(root).codex?.learned).toHaveLength(1);
    const events = readAuditFile(path.join(dcpDir, 'audit.jsonl')).events;
    expect(events.filter((e) => e.action === 'graduate')).toHaveLength(1);
  });

  it('an artifact-class hotspot (no file target) never graduates', async () => {
    const { root, dcpDir } = await repoWithCodex();
    writeAudit(dcpDir, [
      zoomEvent('z1', 19, 0, 'x111', null, 's1'),
      zoomEvent('z2', 20, 0, 'x222', null, 's2'),
    ]);
    const result = await runGraduationMiner({ dcpDir, repoRoot: root, now: () => at(21, 0) });
    expect(result.graduated).toHaveLength(0);
    expect(readCodex(root).codex?.learned).toHaveLength(0);
  });
});

describe('graduation: error-fix and recurrence', () => {
  it('an error-fix pair graduates into a graduated pitfalls entry with signature and fix summary', async () => {
    const { root, dcpDir } = await repoWithCodex();
    writeAudit(dcpDir, [
      verdictEvent('v-f1', 19, 0, 'fail', 's1'),
      verdictEvent('v-p1', 19, 5, 'pass', 's1'),
      verdictEvent('v-f2', 20, 0, 'fail', 's2'),
      verdictEvent('v-p2', 20, 5, 'pass', 's2'),
    ]);
    const result = await runGraduationMiner({
      dcpDir,
      repoRoot: root,
      resolveArtifact: () => ({ raw: failRaw }),
      now: () => at(21, 0),
    });
    expect(result.graduated).toHaveLength(1);
    const codex = readCodex(root).codex;
    const graduatedPitfalls = codex?.pitfalls.filter((p) => p.source === 'graduated');
    expect(graduatedPitfalls).toHaveLength(1);
    expect(graduatedPitfalls?.[0]?.text).toContain('error TS2304');
    expect(graduatedPitfalls?.[0]?.candidate).toMatch(/^cand-/);
    expect(graduatedPitfalls?.[0]?.locked).toBe(false);
  });

  it('a recurrence candidate graduates into a graduated conventions entry', async () => {
    const { root, dcpDir } = await repoWithCodex();
    const records = [
      {
        id: 'cand-prior',
        type: 'recurrence' as const,
        key: 'recurrence:command:pnpm build',
        signature: 'recurring command: pnpm build',
        evidence: [],
        firstSeen: at(18, 0),
        lastSeen: at(20, 1),
        occurrences: 2,
        contradiction: null,
        contradictedSessions: [],
        status: 'candidate' as const,
        details: {},
      },
    ];
    writeFileSync(
      path.join(dcpDir, 'candidates.jsonl'),
      records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
    writeAudit(dcpDir, []);
    const result = await runGraduationMiner({ dcpDir, repoRoot: root, now: () => at(20, 1) });
    expect(result.graduated).toHaveLength(1);
    const conventions = readCodex(root).codex?.conventions.filter((c) => c.source === 'graduated');
    expect(conventions).toHaveLength(1);
    expect(conventions?.[0]?.text).toContain('pnpm build');
  });
});

describe('contradiction and demotion', () => {
  async function graduatedErrorFix(): Promise<{ root: string; dcpDir: string }> {
    const { root, dcpDir } = await repoWithCodex();
    writeAudit(dcpDir, [
      verdictEvent('v-f1', 19, 0, 'fail', 's1'),
      verdictEvent('v-p1', 19, 5, 'pass', 's1'),
      verdictEvent('v-f2', 20, 0, 'fail', 's2'),
      verdictEvent('v-p2', 20, 5, 'pass', 's2'),
    ]);
    await runGraduationMiner({
      dcpDir,
      repoRoot: root,
      resolveArtifact: () => ({ raw: failRaw }),
      now: () => at(21, 0),
    });
    return { root, dcpDir };
  }

  it('the same error signature failing after graduation contradicts and (here) withdraws, audited', async () => {
    const { root, dcpDir } = await graduatedErrorFix();
    // Session s3, after graduation: the same error fails again with no fix.
    const prior = readFileSync(path.join(dcpDir, 'audit.jsonl'), 'utf8');
    writeFileSync(
      path.join(dcpDir, 'audit.jsonl'),
      prior + JSON.stringify(verdictEvent('v-f3', 22, 0, 'fail', 's3')) + '\n',
    );
    const result = await runGraduationMiner({
      dcpDir,
      repoRoot: root,
      sessionId: 's3',
      resolveArtifact: () => ({ raw: failRaw }),
      now: () => at(22, 1),
    });
    expect(result.contradicted).toHaveLength(1);
    expect(result.withdrawn).toHaveLength(1);

    const record = readCandidatesFile(path.join(dcpDir, 'candidates.jsonl')).records.find(
      (r) => r.type === 'error-fix',
    );
    // History kept: withdrawn status, contradiction counted, record intact.
    expect(record?.status).toBe('withdrawn');
    expect(record?.contradiction).toBe(1);
    expect(record?.withdrawnAt).toBe(at(22, 1));

    expect(readCodex(root).codex?.pitfalls.filter((p) => p.source === 'graduated')).toHaveLength(0);
    const withdrawals = readAuditFile(path.join(dcpDir, 'audit.jsonl')).events.filter(
      (e) => e.action === 'withdraw',
    );
    expect(withdrawals).toHaveLength(1);
    expect(withdrawals[0]?.reason).toContain('contradiction');
  });

  it('re-running the contradicting session does not double-count', async () => {
    const { root, dcpDir } = await graduatedErrorFix();
    const prior = readFileSync(path.join(dcpDir, 'audit.jsonl'), 'utf8');
    writeFileSync(
      path.join(dcpDir, 'audit.jsonl'),
      prior + JSON.stringify(verdictEvent('v-f3', 22, 0, 'fail', 's3')) + '\n',
    );
    const opts = {
      dcpDir,
      repoRoot: root,
      sessionId: 's3',
      resolveArtifact: (): { raw: string } => ({ raw: failRaw }),
      now: (): string => at(22, 1),
    };
    await runGraduationMiner(opts);
    const rerun = await runGraduationMiner(opts);
    expect(rerun.contradicted).toHaveLength(0);
    const record = readCandidatesFile(path.join(dcpDir, 'candidates.jsonl')).records.find(
      (r) => r.type === 'error-fix',
    );
    expect(record?.contradiction).toBe(1);
  });

  it('fail events from before graduation never contradict (first full-history mine)', async () => {
    const { root, dcpDir } = await repoWithCodex();
    writeAudit(dcpDir, [
      verdictEvent('v-f1', 19, 0, 'fail', 's1'),
      verdictEvent('v-p1', 19, 5, 'pass', 's1'),
      verdictEvent('v-f2', 20, 0, 'fail', 's2'),
      verdictEvent('v-p2', 20, 5, 'pass', 's2'),
      verdictEvent('v-f3', 20, 30, 'fail', 's3'),
    ]);
    const result = await runGraduationMiner({
      dcpDir,
      repoRoot: root,
      resolveArtifact: () => ({ raw: failRaw }),
      now: () => at(21, 0),
    });
    expect(result.contradicted).toHaveLength(0);
    expect(result.withdrawn).toHaveLength(0);
  });

  it('an enriched hotspot still producing zoom-backs contradicts; a strong record survives the first', async () => {
    const { root, dcpDir } = await repoWithCodex();
    // Four observing sessions: strong support (occurrenceScore 0.75).
    writeAudit(
      dcpDir,
      [1, 2, 3, 4].map((n) => zoomEvent(`z${n}`, 18 + n, 0, `a${n}${n}${n}`, 'createStyler', `s${n}`)),
    );
    const base = { dcpDir, repoRoot: root, resolveArtifact: hotspotLookup };
    await runGraduationMiner({ ...base, now: () => at(23, 0) });

    // Session s5 zooms the enriched file again, after graduation.
    const prior = readFileSync(path.join(dcpDir, 'audit.jsonl'), 'utf8');
    writeFileSync(
      path.join(dcpDir, 'audit.jsonl'),
      prior + JSON.stringify(zoomEvent('z5', 24, 0, 'a555', 'createStyler', 's5')) + '\n',
    );
    const result = await runGraduationMiner({ ...base, sessionId: 's5', now: () => at(24, 1) });
    expect(result.contradicted).toHaveLength(1);
    expect(result.withdrawn).toHaveLength(0);
    const record = readCandidatesFile(path.join(dcpDir, 'candidates.jsonl')).records.find(
      (r) => r.type === 'zoom-hotspot',
    );
    expect(record?.status).toBe('graduated');
    expect(record?.contradiction).toBe(1);
  });

  it('withdrawal regenerates the mirror entry back to a plain skeleton', async () => {
    const { root, dcpDir } = await repoWithCodex();
    writeAudit(dcpDir, [
      zoomEvent('z1', 19, 0, 'a111', 'createStyler', 's1'),
      zoomEvent('z2', 20, 0, 'a222', 'createStyler', 's2'),
    ]);
    const base = { dcpDir, repoRoot: root, resolveArtifact: hotspotLookup };
    await runGraduationMiner({ ...base, now: () => at(21, 0) });
    expect(readFileSync(mirrorEntryPath(root, 'source/index.js'), 'utf8')).toContain('openAll, parent};');

    // Two more contradicting sessions drive a weak record below the threshold.
    let audit = readFileSync(path.join(dcpDir, 'audit.jsonl'), 'utf8');
    audit += JSON.stringify(zoomEvent('z3', 22, 0, 'a333', 'createStyler', 's3')) + '\n';
    audit += JSON.stringify(zoomEvent('z4', 23, 0, 'a444', 'createStyler', 's4')) + '\n';
    writeFileSync(path.join(dcpDir, 'audit.jsonl'), audit);
    await runGraduationMiner({ ...base, sessionId: 's3', now: () => at(22, 1) });
    const result = await runGraduationMiner({ ...base, sessionId: 's4', now: () => at(23, 1) });
    expect(result.withdrawn).toHaveLength(1);
    expect(readCodex(root).codex?.learned).toHaveLength(0);
    const entry = readFileSync(mirrorEntryPath(root, 'source/index.js'), 'utf8');
    expect(entry).not.toContain('openAll, parent};');
  });
});

describe('human and locked entries are untouchable', () => {
  it('withdrawal removes only its own graduated entry; human and locked entries survive', async () => {
    const { root, dcpDir } = await repoWithCodex();
    writeAudit(dcpDir, [
      verdictEvent('v-f1', 19, 0, 'fail', 's1'),
      verdictEvent('v-p1', 19, 5, 'pass', 's1'),
      verdictEvent('v-f2', 20, 0, 'fail', 's2'),
      verdictEvent('v-p2', 20, 5, 'pass', 's2'),
    ]);
    // A human pitfall pre-exists.
    const { stringify } = await import('yaml');
    const codex = readCodex(root).codex;
    if (codex === undefined) throw new Error('codex missing');
    codex.pitfalls.push({ text: 'human-authored pitfall', locked: false, source: 'human' });
    writeFileSync(path.join(root, '.dcp', 'codex.yaml'), stringify(codex), 'utf8');

    const base = { dcpDir, repoRoot: root, resolveArtifact: (): { raw: string } => ({ raw: failRaw }) };
    await runGraduationMiner({ ...base, now: () => at(21, 0) });
    const prior = readFileSync(path.join(dcpDir, 'audit.jsonl'), 'utf8');
    writeFileSync(
      path.join(dcpDir, 'audit.jsonl'),
      prior + JSON.stringify(verdictEvent('v-f3', 22, 0, 'fail', 's3')) + '\n',
    );
    await runGraduationMiner({ ...base, sessionId: 's3', now: () => at(22, 1) });

    const after = readCodex(root).codex;
    expect(after?.pitfalls.map((p) => p.text)).toEqual(['human-authored pitfall']);
  });
});

describe('mergeCandidates query accumulation', () => {
  it('unions zoom-hotspot queries across sessions instead of keeping only the last', () => {
    const records: Parameters<typeof mergeCandidates>[0] = [];
    mergeCandidates(
      records,
      [
        {
          type: 'zoom-hotspot',
          key: 'zoom-hotspot:source/index.js',
          signature: 'sig',
          evidence: ['z1'],
          details: { target: 'source/index.js', targetKind: 'file', zoomCount: 1, queries: ['createStyler'] },
        },
      ],
      's1',
      at(19, 0),
    );
    mergeCandidates(
      records,
      [
        {
          type: 'zoom-hotspot',
          key: 'zoom-hotspot:source/index.js',
          signature: 'sig',
          evidence: ['z2'],
          details: { target: 'source/index.js', targetKind: 'file', zoomCount: 1, queries: ['applyStyle'] },
        },
      ],
      's2',
      at(20, 0),
    );
    expect(records[0]?.details['queries']).toEqual(['createStyler', 'applyStyle']);
  });
});
