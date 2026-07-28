import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import {
  CandidateRecordSchema,
  candidateConfidence,
  isBelowWithdrawal,
  isEligibleForGraduation,
  readAuditFile,
  readCandidatesFile,
  LIMITS,
  type AuditEvent,
  type CandidateRecord,
  type CandidateType,
} from '@redutok/shared';
import { AuditWriter } from './audit.js';
import { codexPaths, enrichmentDirectives, readCodex } from './codex.js';
import { enrichmentFor, readMirrorIndex, refreshMirror } from './mirror.js';
import { NoopLlmPass, type LlmPass } from './llm.js';

/**
 * Graduation miner and pass, v4 (Compounding Codex) phase 2. Triggered
 * asynchronously by the session-end notify path: extraction mines the
 * just-ended session's attributed audit events into .dcp/candidates.jsonl,
 * then the graduation pass acts on the accumulated knowledge — candidates
 * that earned enough confidence graduate into the codex, contradicted
 * graduated entries demote, and every action writes its own audit event
 * (docs/GRADUATION.md). Rules-first and fully local: with the default
 * NoopLlmPass no model is called and no byte leaves the machine.
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
    const details: Record<string, unknown> = { ...candidate.details, lastMinedSession: sessionId };
    // Queried symbols accumulate across sessions: a graduated hotspot must
    // enrich every symbol any observing session asked for, not just the last.
    const priorQueries = existing.details['queries'];
    const newQueries = candidate.details['queries'];
    if (Array.isArray(priorQueries) && Array.isArray(newQueries)) {
      details['queries'] = [...new Set([...priorQueries, ...newQueries])];
    }
    existing.details = details;
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
  /** Repo root holding codex and mirror; defaults to the parent of dcpDir. */
  repoRoot?: string;
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
  /** Candidate ids graduated, contradicted, and withdrawn by this run's pass. */
  graduated: string[];
  contradicted: string[];
  withdrawn: string[];
}

/** Path equality with the /-boundary suffix rule the mirror uses (docs/GRADUATION.md). */
function pathsMatch(a: string, b: string): boolean {
  const na = a.replace(/\\/g, '/');
  const nb = b.replace(/\\/g, '/');
  return na === nb || na.endsWith(`/${nb}`) || nb.endsWith(`/${na}`);
}

/** Identifier tokens across every query a hotspot accumulated, capped. */
function queriedSymbols(record: CandidateRecord): string[] {
  const queries = record.details['queries'];
  if (!Array.isArray(queries)) return [];
  const symbols = queries
    .filter((q): q is string => typeof q === 'string')
    .flatMap((q) => q.split(/[^A-Za-z0-9_$]+/))
    .filter((s) => s !== '');
  return [...new Set(symbols)].slice(0, 12);
}

const CONTRADICTED_SESSIONS_CAP = 20;

/**
 * One contradiction per conflicting session: for a graduated error-fix, the
 * same error signature failing again after the fix was present in the codex;
 * for a graduated zoom-hotspot, the enriched file still producing zoom-backs.
 * Only events after graduatedAt count — history mined before an entry
 * existed cannot contradict it.
 */
function sessionContradicts(
  record: CandidateRecord,
  events: AuditEvent[],
  resolve?: ArtifactLookup,
): boolean {
  const graduatedAt = record.graduatedAt ?? '';
  if (record.type === 'error-fix') {
    const wanted = String(record.details['errorSignature'] ?? record.signature);
    return events.some((event) => {
      if (event.timestamp <= graduatedAt || verdictOf(event) !== 'fail') return false;
      const profile = String(event.details?.['profile'] ?? 'unknown');
      const signature =
        errorSignatureFor(event, resolve) ?? `${profile} verdict fail then pass`;
      return signature === wanted;
    });
  }
  if (record.type === 'zoom-hotspot' && record.details['targetKind'] === 'file') {
    const target = String(record.details['target'] ?? '');
    return events.some((event) => {
      if (event.timestamp <= graduatedAt) return false;
      if (event.module !== 'sidecar.zoom' || event.inputRef === undefined) return false;
      const filePath = resolve?.(event.inputRef)?.filePath;
      return typeof filePath === 'string' && filePath !== '' && pathsMatch(filePath, target);
    });
  }
  return false;
}

interface PassCounts {
  graduated: string[];
  contradicted: string[];
  withdrawn: string[];
}

/**
 * Acts on the merged candidate list: refreshes every record's confidence,
 * withdraws contradicted graduated entries that fell below the demotion
 * threshold, graduates newly eligible candidates into the codex, and keeps
 * the mirror in step with the learned directives. Idempotent by
 * construction: statuses gate re-graduation, codex entries are keyed by
 * candidate id, and contradiction counting is per-session. Human or locked
 * codex entries are never modified or removed.
 */
async function runGraduationPass(
  records: CandidateRecord[],
  root: string,
  now: () => string,
  emit: (event: AuditEvent) => void,
): Promise<PassCounts> {
  const counts: PassCounts = { graduated: [], contradicted: [], withdrawn: [] };
  const nowDate = new Date(now());
  for (const record of records) {
    record.confidence = candidateConfidence(record, nowDate);
  }
  const { codex } = readCodex(root);
  // No codex, no place to graduate into or withdraw from: confidence still
  // refreshed above, everything else waits for redutok codex refresh.
  if (codex === undefined) return counts;

  const directivePathsBefore = codex.learned.map((entry) => entry.path);
  let codexDirty = false;

  for (const record of records) {
    if (!isBelowWithdrawal(record, nowDate)) continue;
    codex.learned = codex.learned.filter((entry) => entry.candidate !== record.id);
    const lockedKept: string[] = [];
    for (const section of ['pitfalls', 'conventions'] as const) {
      codex[section] = codex[section].filter((entry) => {
        if (entry.source !== 'graduated' || entry.candidate !== record.id) return true;
        if (entry.locked) {
          lockedKept.push(section);
          return true;
        }
        return false;
      });
    }
    codexDirty = true;
    record.status = 'withdrawn';
    record.withdrawnAt = now();
    counts.withdrawn.push(record.id);
    emit({
      id: `withdraw-${randomBytes(3).toString('hex')}`,
      timestamp: now(),
      sessionId: 'graduation',
      module: 'sidecar.graduation',
      action: 'withdraw',
      reason:
        `graduated entry for ${record.id} withdrawn: confidence ${record.confidence?.toFixed(2) ?? '?'} ` +
        `below ${LIMITS.GRADUATION.WITHDRAW_BELOW_CONFIDENCE} after ${record.contradiction ?? 0} contradiction(s)` +
        (lockedKept.length > 0 ? `; locked ${lockedKept.join(', ')} entry left in place` : ''),
      details: {
        candidate: record.id,
        type: record.type,
        confidence: record.confidence,
        contradiction: record.contradiction,
      },
    });
  }

  for (const record of records) {
    if (!isEligibleForGraduation(record, nowDate)) continue;
    let section: 'learned' | 'pitfalls' | 'conventions';
    if (record.type === 'zoom-hotspot') {
      // Only file-target hotspots with queried symbols are actionable as
      // skeleton enrichment; the rest stay candidates.
      const symbols = queriedSymbols(record);
      if (record.details['targetKind'] !== 'file' || symbols.length === 0) continue;
      if (codex.learned.some((entry) => entry.candidate === record.id)) continue;
      codex.learned.push({
        kind: 'skeleton-enrichment',
        candidate: record.id,
        path: String(record.details['target']),
        symbols,
        confidence: record.confidence ?? 0,
        source: 'graduated',
        addedAt: now(),
      });
      section = 'learned';
    } else {
      section = record.type === 'error-fix' ? 'pitfalls' : 'conventions';
      if (codex[section].some((entry) => entry.candidate === record.id)) continue;
      const text =
        record.type === 'error-fix'
          ? `${String(record.details['errorSignature'] ?? record.signature)} — fix: ${errorFixSummary(record)}`
          : (record.lesson ?? record.signature);
      codex[section].push({
        text,
        locked: false,
        source: 'graduated',
        candidate: record.id,
        confidence: record.confidence,
      });
    }
    codexDirty = true;
    record.status = 'graduated';
    record.graduatedAt = now();
    counts.graduated.push(record.id);
    emit({
      id: `graduate-${randomBytes(3).toString('hex')}`,
      timestamp: now(),
      sessionId: 'graduation',
      module: 'sidecar.graduation',
      action: 'graduate',
      reason:
        `candidate ${record.id} (${record.type}, x${record.occurrences}, confidence ` +
        `${record.confidence?.toFixed(2) ?? '?'}) graduated into codex ${section}`,
      details: {
        candidate: record.id,
        type: record.type,
        section,
        confidence: record.confidence,
        occurrences: record.occurrences,
      },
    });
  }

  if (codexDirty) {
    codex.generatedAt = now();
    writeFileSync(codexPaths(root).yaml, stringifyYaml(codex), 'utf8');
    // The mirror follows the directives: entries matching an added or
    // withdrawn directive regenerate (the enrichment fingerprint makes an
    // unchanged source refresh anyway).
    const affected = [...new Set([...directivePathsBefore, ...codex.learned.map((e) => e.path)])];
    const mirrorRels = Object.keys(readMirrorIndex(root)?.files ?? {}).filter((rel) =>
      affected.some((p) => enrichmentFor(rel, [{ path: p, symbols: [] }]) !== undefined),
    );
    if (mirrorRels.length > 0) {
      await refreshMirror(root, mirrorRels, { enrichments: enrichmentDirectives(codex) });
    }
  }
  return counts;
}

function errorFixSummary(record: CandidateRecord): string {
  if (record.lesson !== undefined) return record.lesson;
  const changed = record.details['changedFiles'];
  const files = Array.isArray(changed) ? changed.filter((f): f is string => typeof f === 'string') : [];
  const command = typeof record.details['command'] === 'string' ? ` (${record.details['command']})` : '';
  return files.length > 0 ? `edit ${files.join(', ')}${command}` : `re-run until green${command}`;
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
  const contradicted: string[] = [];
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
    // Contradiction sweep (docs/GRADUATION.md): evidence in this session
    // conflicting with an entry graduated before it. Counted once per
    // session so re-running the same history stays idempotent.
    for (const record of records) {
      if (record.status !== 'graduated' || record.contradictedSessions.includes(sessionId)) {
        continue;
      }
      if (!sessionContradicts(record, sessionEvents, opts.resolveArtifact)) continue;
      record.contradiction = (record.contradiction ?? 0) + 1;
      record.contradictedSessions = [...record.contradictedSessions, sessionId].slice(
        -CONTRADICTED_SESSIONS_CAP,
      );
      contradicted.push(record.id);
    }
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

  // The pass acts on the merged knowledge before it is persisted, so status
  // changes and the candidate file land together.
  const writer = new AuditWriter(auditPath);
  const emit = (event: AuditEvent): void => {
    writer.write(event);
    opts.onAuditEvent?.(event);
  };
  const repoRoot = opts.repoRoot ?? path.dirname(opts.dcpDir);
  const pass = await runGraduationPass(records, repoRoot, now, emit);

  writeFileSync(
    candidatesPath,
    records.map((r) => JSON.stringify(CandidateRecordSchema.parse(r))).join('\n') +
      (records.length > 0 ? '\n' : ''),
    'utf8',
  );

  emit({
    id: `graduation-${randomBytes(3).toString('hex')}`,
    timestamp: now(),
    sessionId: opts.sessionId ?? 'graduation',
    module: 'sidecar.graduation',
    action: 'summarize',
    reason:
      `graduation mining run: ${counts.mined} mined, ${counts.merged} merged, ${counts.skipped} skipped ` +
      `across ${sessionIds.length} session(s); pass: ${pass.graduated.length} graduated, ` +
      `${contradicted.length} contradicted, ${pass.withdrawn.length} withdrawn`,
    details: {
      ...counts,
      sessions: sessionIds.length,
      candidatesTotal: records.length,
      graduated: pass.graduated.length,
      contradicted: contradicted.length,
      withdrawn: pass.withdrawn.length,
    },
  });

  return { ...counts, records, candidatesPath, graduated: pass.graduated, contradicted, withdrawn: pass.withdrawn };
}
