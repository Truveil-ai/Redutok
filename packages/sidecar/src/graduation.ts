import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  CandidateRecordSchema,
  LIMITS,
  readAuditFile,
  readCandidatesFile,
  type AuditEvent,
  type CandidateRecord,
  type CandidateType,
} from '@redutok/shared';
import { AuditWriter } from './audit.js';
import { NoopLlmPass, type LlmPass } from './llm.js';

/**
 * Graduation miner, v4 (Compounding Codex) phase 1: extraction only.
 * Triggered asynchronously by the session-end notify path, it mines the
 * just-ended session's attributed audit events for candidate learnings and
 * persists them to .dcp/candidates.jsonl. Rules-first and fully local: with
 * the default NoopLlmPass no model is called and no byte leaves the machine.
 * Nothing here writes to the codex yet.
 */

/** Minimal artifact view the miner needs; the store's getArtifact satisfies it. */
export type ArtifactLookup = (
  id: string,
) => { raw: string; distilled?: string; filePath?: unknown } | undefined;

export interface MinedCandidate {
  type: CandidateType;
  key: string;
  signature: string;
  evidence: string[];
  details: Record<string, unknown>;
}

export interface MineOptions {
  priorRecords: CandidateRecord[];
  resolveArtifact?: ArtifactLookup;
}

const EVIDENCE_CAP = 20;

/** Line and column coordinates collapse so the same error at a new location
 * still merges: `a.ts(10,5)` and `a.ts:10:5` both become `a.ts(#)` / `a.ts:#`. */
export function normalizeSignature(line: string): string {
  return line
    .replace(/\(\d+,\d+\)/g, '(#)')
    .replace(/:\d+(?::\d+)?/g, ':#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** Verdict extracted from the verdict-fidelity gate detail a distill event
 * carries; undefined when the extractions were inconclusive. */
function verdictOf(event: AuditEvent): 'pass' | 'fail' | undefined {
  if (event.module !== 'sidecar.distill') return undefined;
  const gates = event.details?.['gates'];
  if (!Array.isArray(gates)) return undefined;
  const verdictGate = gates.find(
    (g): g is { gate: string; detail: string } =>
      typeof g === 'object' && g !== null && (g as { gate?: unknown }).gate === 'verdict-fidelity',
  );
  if (verdictGate === undefined) return undefined;
  const agreed = /verdict (pass|fail) agreed/.exec(verdictGate.detail);
  if (agreed !== null) return agreed[1] as 'pass' | 'fail';
  const raw = /raw verdict (pass|fail) but/.exec(verdictGate.detail);
  return raw === null ? undefined : (raw[1] as 'pass' | 'fail');
}

/** First error-shaped line of the failing artifact, normalized; undefined
 * when no artifact is resolvable (the caller falls back to the profile). */
function errorSignatureFor(event: AuditEvent, resolve?: ArtifactLookup): string | undefined {
  if (resolve === undefined || event.inputRef === undefined) return undefined;
  const artifact = resolve(event.inputRef);
  if (artifact === undefined) return undefined;
  for (const text of [artifact.distilled, artifact.raw]) {
    if (text === undefined) continue;
    const line = text.split(/\r?\n/).find((l) => /error|fail/i.test(l) && !/^VERDICT:/.test(l));
    if (line !== undefined) return normalizeSignature(line.replace(/^first error:\s*/, ''));
  }
  return undefined;
}

const DIFF_SERVE = /^(.+) served as unified diff /;

/** Repo paths that changed mid-session: files re-served as a diff. */
function changedPathOf(event: AuditEvent): string | undefined {
  if (event.module !== 'sidecar.serve' || event.details?.['mode'] !== 'diff') return undefined;
  return DIFF_SERVE.exec(event.reason)?.[1];
}

function commandOf(event: AuditEvent): string | undefined {
  if (event.module !== 'hooks.pretooluse' || event.action !== 'rewrite') return undefined;
  const command = event.details?.['command'];
  return typeof command === 'string' && command !== '' ? command : undefined;
}

interface Signal {
  kind: 'command' | 'path' | 'error-signature';
  value: string;
  evidence: string[];
}

function mineErrorFixPairs(events: AuditEvent[], opts: MineOptions): MinedCandidate[] {
  const candidates: MinedCandidate[] = [];
  const pendingFail = new Map<string, { event: AuditEvent; signature?: string }>();
  let lastCommand: string | undefined;
  for (const event of events) {
    lastCommand = commandOf(event) ?? lastCommand;
    const verdict = verdictOf(event);
    if (verdict === undefined) continue;
    const profile = String(event.details?.['profile'] ?? 'unknown');
    if (verdict === 'fail') {
      pendingFail.set(profile, {
        event,
        signature: errorSignatureFor(event, opts.resolveArtifact),
      });
      continue;
    }
    const fail = pendingFail.get(profile);
    if (fail === undefined) continue;
    pendingFail.delete(profile);
    const changedFiles = [
      ...new Set(
        events
          .filter((e) => e.timestamp >= fail.event.timestamp && e.timestamp <= event.timestamp)
          .map(changedPathOf)
          .filter((p): p is string => p !== undefined),
      ),
    ];
    const signature = fail.signature ?? `${profile} verdict fail then pass`;
    candidates.push({
      type: 'error-fix',
      key: `error-fix:${profile}:${signature}`,
      signature,
      evidence: [fail.event.id, event.id],
      details: {
        profile,
        errorSignature: signature,
        changedFiles,
        ...(lastCommand === undefined ? {} : { command: lastCommand }),
        failedAt: fail.event.timestamp,
        fixedAt: event.timestamp,
      },
    });
  }
  return candidates;
}

function mineZoomHotspots(events: AuditEvent[], opts: MineOptions): MinedCandidate[] {
  interface Hotspot {
    target: string;
    targetKind: 'file' | 'artifact-class' | 'unknown';
    queries: string[];
    evidence: string[];
  }
  const hotspots = new Map<string, Hotspot>();
  for (const event of events) {
    if (event.module !== 'sidecar.zoom' || event.inputRef === undefined) continue;
    const filePath = opts.resolveArtifact?.(event.inputRef)?.filePath;
    let target: string;
    let targetKind: Hotspot['targetKind'];
    if (typeof filePath === 'string' && filePath !== '') {
      target = filePath.replace(/\\/g, '/');
      targetKind = 'file';
    } else {
      const distill = events.find(
        (e) => e.module === 'sidecar.distill' && e.inputRef === event.inputRef,
      );
      const profile = distill?.details?.['profile'];
      target = typeof profile === 'string' ? profile : 'unknown-artifact';
      targetKind = typeof profile === 'string' ? 'artifact-class' : 'unknown';
    }
    const hotspot = hotspots.get(target) ?? { target, targetKind, queries: [], evidence: [] };
    const query = event.details?.['query'];
    if (typeof query === 'string' && query !== '' && !hotspot.queries.includes(query)) {
      hotspot.queries.push(query);
    }
    hotspot.evidence.push(event.id);
    hotspots.set(target, hotspot);
  }
  return [...hotspots.values()].map((h) => ({
    type: 'zoom-hotspot',
    key: `zoom-hotspot:${h.target}`,
    signature: `distillate of ${h.target} required zooming back to raw`,
    evidence: h.evidence.slice(0, EVIDENCE_CAP),
    details: {
      target: h.target,
      targetKind: h.targetKind,
      zoomCount: h.evidence.length,
      queries: h.queries,
    },
  }));
}

function sessionSignals(events: AuditEvent[], opts: MineOptions): Signal[] {
  const byValue = new Map<string, Signal>();
  const add = (kind: Signal['kind'], value: string | undefined, eventId: string): void => {
    if (value === undefined || value === '') return;
    const signal = byValue.get(`${kind}:${value}`) ?? { kind, value, evidence: [] };
    signal.evidence.push(eventId);
    byValue.set(`${kind}:${value}`, signal);
  };
  for (const event of events) {
    add('command', commandOf(event), event.id);
    add('path', changedPathOf(event), event.id);
    if (verdictOf(event) === 'fail') {
      add('error-signature', errorSignatureFor(event, opts.resolveArtifact), event.id);
    }
  }
  return [...byValue.values()];
}

function mineRecurrence(events: AuditEvent[], opts: MineOptions): MinedCandidate[] {
  if (opts.priorRecords.length === 0) return [];
  const haystacks = opts.priorRecords.map((r) => ({
    id: r.id,
    text: `${r.key}\n${r.signature}\n${JSON.stringify(r.details)}`,
  }));
  const candidates: MinedCandidate[] = [];
  for (const signal of sessionSignals(events, opts)) {
    const matched = haystacks.filter((h) => h.text.includes(signal.value)).map((h) => h.id);
    if (matched.length === 0) continue;
    candidates.push({
      type: 'recurrence',
      key: `recurrence:${signal.kind}:${signal.value}`,
      signature: `recurring ${signal.kind}: ${signal.value}`,
      evidence: signal.evidence.slice(0, EVIDENCE_CAP),
      details: { signalKind: signal.kind, signal: signal.value, matchedRecords: matched.slice(0, 5) },
    });
  }
  return candidates;
}

/** Rules-first extraction over one session's attributed audit events. */
export function mineSessionCandidates(events: AuditEvent[], opts: MineOptions): MinedCandidate[] {
  const ordered = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return [
    ...mineErrorFixPairs(ordered, opts),
    ...mineZoomHotspots(ordered, opts),
    ...mineRecurrence(ordered, opts),
  ];
}

export interface MergeCounts {
  mined: number;
  merged: number;
  skipped: number;
}

function candidateId(type: string, key: string): string {
  return `cand-${createHash('sha256').update(`${type}\n${key}`).digest('hex').slice(0, 8)}`;
}

/**
 * Merges one session's mined candidates into the persistent record list.
 * Occurrences increment once per session that re-observes a candidate; a
 * re-run over the same session (Stop fires more than once) refreshes the
 * record without inflating the count and is reported as skipped.
 */
export function mergeCandidates(
  records: CandidateRecord[],
  mined: MinedCandidate[],
  sessionId: string,
  now: string,
): MergeCounts {
  let merged = 0;
  let skipped = 0;
  for (const candidate of mined) {
    const existing = records.find((r) => r.type === candidate.type && r.key === candidate.key);
    if (existing === undefined) {
      records.push(
        CandidateRecordSchema.parse({
          id: candidateId(candidate.type, candidate.key),
          type: candidate.type,
          key: candidate.key,
          signature: candidate.signature,
          evidence: candidate.evidence.slice(0, EVIDENCE_CAP),
          firstSeen: now,
          lastSeen: now,
          occurrences: 1,
          details: { ...candidate.details, lastMinedSession: sessionId },
        }),
      );
      continue;
    }
    const sameSession = existing.details['lastMinedSession'] === sessionId;
    existing.evidence = [...new Set([...existing.evidence, ...candidate.evidence])].slice(
      0,
      EVIDENCE_CAP,
    );
    existing.details = { ...candidate.details, lastMinedSession: sessionId };
    existing.lastSeen = now;
    if (sameSession) {
      skipped += 1;
    } else {
      existing.occurrences += 1;
      merged += 1;
    }
  }
  return { mined: mined.length, merged, skipped };
}

export interface GraduationOptions {
  dcpDir: string;
  /** Mine only this session; omitted, every session in the audit history is mined in order. */
  sessionId?: string;
  /** Local-model lesson drafting seam; NoopLlmPass (rule fallback only) by default. */
  llm?: LlmPass;
  resolveArtifact?: ArtifactLookup;
  /** Mirror for the mining audit event (the daemon also inserts into its store). */
  onAuditEvent?: (event: AuditEvent) => void;
  now?: () => string;
}

export interface GraduationResult extends MergeCounts {
  records: CandidateRecord[];
  candidatesPath: string;
}

const LESSON_PROMPT =
  'Write exactly one short sentence stating the practical lesson a future coding session should ' +
  'take from this observation. No preamble, no list.';
/** Per-run ceiling on lesson drafts so a large first mine cannot stall the daemon. */
const LESSON_DRAFT_CAP = 20;

/**
 * The mining run: read the audit history, extract candidates, merge them into
 * .dcp/candidates.jsonl, and audit the run itself with its counts. Entirely
 * local; with the default NoopLlmPass nothing on this path touches the
 * network or spawns a process.
 */
export async function runGraduationMiner(opts: GraduationOptions): Promise<GraduationResult> {
  const auditPath = path.join(opts.dcpDir, 'audit.jsonl');
  const candidatesPath = path.join(opts.dcpDir, 'candidates.jsonl');
  const now = opts.now ?? ((): string => new Date().toISOString());
  const llm = opts.llm ?? new NoopLlmPass();

  const events = readAuditFile(auditPath).events.filter((e) => e.module !== 'sidecar.graduation');
  const prior = readCandidatesFile(candidatesPath);
  const records = prior.records;

  const sessionIds =
    opts.sessionId !== undefined
      ? [opts.sessionId]
      : [...new Set(events.map((e) => e.sessionId ?? 'unknown'))];
  const counts: MergeCounts = { mined: 0, merged: 0, skipped: prior.malformed };
  const knownKeys = new Set(records.map((r) => `${r.type}\n${r.key}`));
  for (const sessionId of sessionIds) {
    const sessionEvents = events.filter((e) => (e.sessionId ?? 'unknown') === sessionId);
    const mined = mineSessionCandidates(sessionEvents, {
      priorRecords: records,
      resolveArtifact: opts.resolveArtifact,
    });
    const merge = mergeCandidates(records, mined, sessionId, now());
    counts.mined += merge.mined;
    counts.merged += merge.merged;
    counts.skipped += merge.skipped;
  }

  // Optional local-model pass over the records this run created. Timeout-
  // governed per call; a null draft leaves the raw signature as the lesson.
  let drafted = 0;
  for (const record of records) {
    if (knownKeys.has(`${record.type}\n${record.key}`) || record.lesson !== undefined) continue;
    if (drafted >= LESSON_DRAFT_CAP) break;
    drafted += 1;
    const lesson = await llm.summarize({
      text: JSON.stringify({ signature: record.signature, details: record.details }),
      prompt: LESSON_PROMPT,
      timeoutMs: LIMITS.LOCAL_LLM_TIMEOUT_MS,
    });
    if (lesson !== null && lesson.trim() !== '') record.lesson = lesson.trim();
  }

  writeFileSync(
    candidatesPath,
    records.map((r) => JSON.stringify(CandidateRecordSchema.parse(r))).join('\n') +
      (records.length > 0 ? '\n' : ''),
    'utf8',
  );

  const event: AuditEvent = {
    id: `graduation-${randomBytes(3).toString('hex')}`,
    timestamp: now(),
    sessionId: opts.sessionId ?? 'graduation',
    module: 'sidecar.graduation',
    action: 'summarize',
    reason: `graduation mining run: ${counts.mined} mined, ${counts.merged} merged, ${counts.skipped} skipped across ${sessionIds.length} session(s)`,
    details: { ...counts, sessions: sessionIds.length, candidatesTotal: records.length },
  };
  new AuditWriter(auditPath).write(event);
  opts.onAuditEvent?.(event);

  return { ...counts, records, candidatesPath };
}
