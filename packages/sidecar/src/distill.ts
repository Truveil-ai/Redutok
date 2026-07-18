import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import {
  DistillProfileSchema,
  loadYamlFile,
  type AuditEvent,
  type DistillProfile,
} from '@redutok/shared';
import type { AuditWriter } from './audit.js';
import { runGates, type GateConfig, type GateReport } from './gates.js';
import { fileSkeleton, languageForPath, type SkeletonLanguage } from './skeleton.js';
import { storeRedactedArtifact } from './redact.js';
import type { Store } from './store.js';

/**
 * Rule-engine distillation, architecture 4.2. Profiles are yaml specs in
 * profiles/; every distillation decision is audited; a gate failure serves
 * raw. No LLM anywhere in this phase (see llm.ts for the Phase 5 hook).
 */

export function loadProfiles(dir: string): Map<string, DistillProfile> {
  const profiles = new Map<string, DistillProfile>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.yaml'))) {
    const profile = loadYamlFile(path.join(dir, file), DistillProfileSchema);
    profiles.set(profile.name, profile);
  }
  return profiles;
}

function ruleConfig(profile: DistillProfile, kind: string): Record<string, unknown> {
  return profile.rules.find((r) => r.kind === kind)?.config ?? {};
}

function verdictLine(raw: string, profile: DistillProfile): string {
  const v = profile.gates.verdict;
  if (v === undefined) return '';
  const hit = (patterns: string[]): boolean => patterns.some((p) => new RegExp(p, 'im').test(raw));
  const verdict = hit(v.primaryFail) ? 'fail' : hit(v.primaryPass) ? 'pass' : 'unknown';
  return `VERDICT: ${verdict}`;
}

function dedupe(lines: string[]): string[] {
  return [...new Set(lines)];
}

function relevantLines(raw: string, profile: DistillProfile): string[] {
  const config = ruleConfig(profile, 'relevant-lines');
  const pattern = new RegExp(String(config['pattern'] ?? 'error|fail'), 'i');
  const maxLines = Number(config['maxLines'] ?? 40);
  return dedupe(raw.split(/\r?\n/).filter((l) => pattern.test(l))).slice(0, maxLines);
}

function buildLogDistill(raw: string, profile: DistillProfile, context: DistillContext): string {
  // Verdict contract only: status, first error with file:line and cause,
  // error count, recovery handle. Everything else is reachable via zoom.
  const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== '');
  const relevant = new RegExp(profile.gates.relevantLinePattern ?? 'error|failed', 'i');
  const errorLines = lines.filter((l) => relevant.test(l));
  const verdict = verdictLine(raw, profile);
  if (errorLines.length === 0) {
    return dedupe([verdict, lines[lines.length - 1] ?? '', `[full log elided, ${zoomRef(context)}]`]).join(
      '\n',
    );
  }
  const files = new Set(
    errorLines.map((l) => /^([^\s(:]+)[(:]/.exec(l.trim())?.[1]).filter((f) => f !== undefined),
  );
  return [
    verdict,
    `first error: ${errorLines[0]?.trim()}`,
    `errors: ${errorLines.length} lines across ${files.size} files`,
    `[full log elided, ${zoomRef(context)}]`,
  ].join('\n');
}

function testOutputDistill(raw: string, profile: DistillProfile): string {
  const summaryPattern = new RegExp(
    String(ruleConfig(profile, 'summary-lines')['pattern'] ?? 'Tests|Duration'),
  );
  const summary = raw.split(/\r?\n/).filter((l) => summaryPattern.test(l));
  const parts = [verdictLine(raw, profile), ...relevantLines(raw, profile), ...summary];
  return dedupe(parts.filter((p) => p !== '')).join('\n');
}

async function fileSkeletonDistill(
  raw: string,
  profile: DistillProfile,
  context: DistillContext,
): Promise<string> {
  const lang: SkeletonLanguage =
    (context.filePath !== undefined ? languageForPath(context.filePath) : undefined) ?? 'ts';
  const allowed = (ruleConfig(profile, 'skeleton')['languages'] as string[] | undefined) ?? ['ts'];
  if (!allowed.includes(lang)) return '';
  const header = context.filePath === undefined ? [] : [`skeleton of ${context.filePath}`];
  const skeleton = await fileSkeleton(raw, lang);
  const withZoom = skeleton.replace(
    /^\[(\d+ import lines omitted)\]/,
    (_m, inner: string) => `[${inner}, ${zoomRef(context)}]`,
  );
  return [
    ...header,
    `[bodies elided, ${zoomRef(context)}]`,
    withZoom,
  ].join('\n');
}

function searchResultsDistill(raw: string, profile: DistillProfile, context: DistillContext): string {
  const config = ruleConfig(profile, 'ranked-hits');
  const maxFiles = Number(config['maxFiles'] ?? 10);
  const maxHitsPerFile = Number(config['maxHitsPerFile'] ?? 3);
  const byFile = new Map<string, string[]>();
  let total = 0;
  for (const line of raw.split(/\r?\n/)) {
    const m = /^(.+?):(\d+):(.*)$/.exec(line);
    if (m === null) continue;
    total += 1;
    const hits = byFile.get(m[1] as string) ?? [];
    hits.push(`${m[1]}:${m[2]}: ${(m[3] as string).trim()}`);
    byFile.set(m[1] as string, hits);
  }
  if (total === 0) return '';
  const ranked = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length);
  const shown = ranked.slice(0, maxFiles);
  const out = [
    `${total} hits in ${byFile.size} files (showing top ${shown.length} files, ${maxHitsPerFile} hits each; full set: ${zoomRef(context)})`,
  ];
  for (const [, hits] of shown) out.push(...hits.slice(0, maxHitsPerFile));
  return out.join('\n');
}

function genericStdoutDistill(raw: string, profile: DistillProfile, context: DistillContext): string {
  const config = ruleConfig(profile, 'head-tail');
  const head = Number(config['headLines'] ?? 15);
  const tail = Number(config['tailLines'] ?? 10);
  const lines = raw.split(/\r?\n/);
  if (lines.length <= head + tail) return raw;
  const omitted = lines.length - head - tail;
  // Phase 5 hook: an LlmPass may summarize the omitted middle here.
  return [
    ...lines.slice(0, head),
    `[dcp: omitted ${omitted} middle lines, ${zoomRef(context)}]`,
    ...lines.slice(-tail),
  ].join('\n');
}

export interface DistillContext {
  filePath?: string;
  /**
   * Artifact id the output will be stored under. Elision markers embed a
   * dcp__zoom reference to it so no content is dropped without a recovery
   * path. Absent only when a distiller is exercised outside distillArtifact.
   */
  artifactId?: string;
}

function zoomRef(context: DistillContext): string {
  return context.artifactId === undefined
    ? 'zoom: dcp__zoom(handle, query?)'
    : `zoom: dcp__zoom("${context.artifactId}", query?)`;
}

export async function runProfile(
  profile: DistillProfile,
  raw: string,
  context: DistillContext = {},
): Promise<string> {
  switch (profile.name) {
    case 'build-log':
      return buildLogDistill(raw, profile, context);
    case 'test-output':
      return testOutputDistill(raw, profile);
    case 'file-skeleton':
      return fileSkeletonDistill(raw, profile, context);
    case 'search-results':
      return searchResultsDistill(raw, profile, context);
    case 'generic-stdout':
      return genericStdoutDistill(raw, profile, context);
    default:
      throw new Error(`no distiller implemented for profile "${profile.name}"`);
  }
}

export function profileGateConfig(profile: DistillProfile): GateConfig {
  const g = profile.gates;
  return {
    entity:
      g.relevantLinePattern === undefined
        ? undefined
        : {
            relevantLinePattern: g.relevantLinePattern,
            minRatio: g.entityPreservationMinRatio,
            limit: g.relevantLineLimit,
          },
    verdict: g.verdict,
    size: { maxRatio: g.sizeMaxRatio, minBytes: g.minOutputBytes },
  };
}

export function estimateTokens(text: string): number {
  // Heuristic: about 4 characters per token. An estimate for handle display
  // only; the meter's ledger is the source of truth for real counts.
  return Math.ceil(text.length / 4);
}

export function makeHandle(id: string, raw: string, distilled: string): string {
  return `[dcp:artifact ${id}, raw ${estimateTokens(raw)} tok to ${estimateTokens(distilled)} tok, zoom: dcp__zoom("${id}", query?)]`;
}

export interface DistillOutcome {
  served: 'distilled' | 'raw';
  text: string;
  handle: string;
  artifactId: string;
  gateReport: GateReport;
}

export interface DistillRequest {
  raw: string;
  profile: DistillProfile;
  sessionId: string;
  tool?: string;
  context?: DistillContext;
}

export async function distillArtifact(
  store: Store,
  audit: AuditWriter,
  request: DistillRequest,
): Promise<DistillOutcome> {
  const artifactId = `a${randomBytes(3).toString('hex')}`;
  const distilled = await runProfile(request.profile, request.raw, {
    ...request.context,
    artifactId,
  });
  const gateConfig = profileGateConfig(request.profile);
  const gateReport = runGates(request.raw, distilled, gateConfig);
  const served = gateReport.passed ? 'distilled' : 'raw';
  const stored = storeRedactedArtifact(store, audit, {
    id: artifactId,
    sessionId: request.sessionId,
    artifactClass: request.profile.name,
    tool: request.tool,
    createdAt: new Date().toISOString(),
    raw: request.raw,
    distilled: gateReport.passed ? distilled : undefined,
    profile: request.profile.name,
    gatesPassed: gateReport.passed,
    meta: { gates: gateReport.results },
  });
  const bytesIn = Buffer.byteLength(request.raw, 'utf8');
  const bytesOut = Buffer.byteLength(gateReport.passed ? distilled : request.raw, 'utf8');
  const event: AuditEvent = {
    id: `${served}-${artifactId}`,
    timestamp: new Date().toISOString(),
    sessionId: request.sessionId,
    module: 'sidecar.distill',
    action: served === 'distilled' ? 'distill' : 'serve-raw',
    reason:
      served === 'distilled'
        ? `profile ${request.profile.name} served ${bytesOut}B for ${bytesIn}B raw`
        : `profile ${request.profile.name} gate failure, raw served: ${gateReport.results
            .filter((r) => !r.passed)
            .map((r) => `${r.gate} (${r.detail})`)
            .join('; ')}`,
    inputRef: artifactId,
    bytesIn,
    bytesOut,
    // Founder review 2026-07-19: the exact gate configuration rides along with
    // every event so any gate softening is visible in the trail.
    details: { profile: request.profile.name, gates: gateReport.results, gateConfig },
  };
  audit.write(event);
  store.insertAuditEvent(event);
  const handle = makeHandle(artifactId, request.raw, gateReport.passed ? distilled : request.raw);
  return {
    served,
    text: served === 'distilled' ? (stored.distilled ?? distilled) : stored.raw,
    handle,
    artifactId,
    gateReport,
  };
}

export interface ZoomResult {
  found: boolean;
  text: string;
}

export function zoom(store: Store, audit: AuditWriter, id: string, query?: string): ZoomResult {
  const artifact = store.getArtifact(id);
  if (artifact === undefined) return { found: false, text: `no artifact ${id} in the store` };
  let text = artifact.raw;
  if (query !== undefined && query !== '') {
    const lines = artifact.raw.split(/\r?\n/);
    const matcher = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const keep = new Set<number>();
    lines.forEach((line, i) => {
      if (matcher.test(line)) {
        for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j += 1) keep.add(j);
      }
    });
    const slice = [...keep].sort((a, b) => a - b).slice(0, 200);
    text =
      slice.length === 0
        ? `no lines matching "${query}" in artifact ${id}; zoom without a query for the full raw artifact`
        : slice.map((i) => lines[i]).join('\n');
  }
  const event: AuditEvent = {
    id: `zoom-${id}-${randomBytes(2).toString('hex')}`,
    timestamp: new Date().toISOString(),
    sessionId: artifact.sessionId,
    module: 'sidecar.zoom',
    action: 'zoom',
    reason: query === undefined || query === '' ? `raw artifact ${id} served` : `query slice of ${id} for "${query}"`,
    inputRef: id,
    details: { query: query ?? null },
  };
  audit.write(event);
  store.insertAuditEvent(event);
  return { found: true, text };
}
