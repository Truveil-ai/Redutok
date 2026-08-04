import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import {
  DistillProfileSchema,
  LIMITS,
  loadYamlFile,
  type AuditEvent,
  type CodexFile,
  type DistillProfile,
} from '@redutok/shared';
import type { AuditWriter } from './audit.js';
import {
  matchedDocSections,
  parseSectionRefs,
  renderStructureMap,
  sectionAnchor,
  sectionMatchesRef,
  sectionText,
  type DocPage,
  type DocSection,
} from './docs.js';
import { runGates, type GateConfig, type GateReport } from './gates.js';
import { fileSkeleton, languageForPath, type SkeletonLanguage } from './skeleton.js';
import { storeRedactedArtifact } from './redact.js';
import { fileIdFor } from './serve.js';
import type { ArtifactRecord, Store } from './store.js';

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
  const skeleton = await fileSkeleton(raw, lang, context.keepSymbols ?? []);
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

export interface DocDistillContext {
  sections: DocSection[];
  pages?: DocPage[];
  /** The question being served; drives which sections ride along verbatim. */
  ask?: string;
}

export interface DistillContext {
  filePath?: string;
  /**
   * Document structure for the doc-serve profile and for section/page zoom:
   * stored on the artifact's meta so a cited section stays byte-recoverable.
   */
  doc?: DocDistillContext;
  /**
   * Artifact id the output will be stored under. Elision markers embed a
   * dcp__zoom reference to it so no content is dropped without a recovery
   * path. Absent only when a distiller is exercised outside distillArtifact.
   */
  artifactId?: string;
  /**
   * Source documents behind a hits artifact (doc-search): stored on meta so
   * zoom can reach through the hit lines to the referenced document raw —
   * a handle must recover source content even when the query names lines
   * the hit list never carried.
   */
  docRefs?: { path: string; artifactId: string }[];
  /**
   * Skeleton enrichment (docs/GRADUATION.md): symbols whose full bodies the
   * file-skeleton profile keeps, from a graduated zoom-hotspot directive.
   */
  keepSymbols?: readonly string[];
  /**
   * Candidate ref of the directive that supplied keepSymbols, tagged onto
   * the serve's audit event for per-lesson attribution (docs/POSTURE.md).
   */
  enrichmentCandidate?: string;
}

function zoomRef(context: DistillContext): string {
  return context.artifactId === undefined
    ? 'zoom: dcp__zoom(handle, query?)'
    : `zoom: dcp__zoom("${context.artifactId}", query?)`;
}

/**
 * Long-document serve: the structure map (every section's citation line with
 * anchor and one-line summary), plus the ask-matched sections verbatim. The
 * verbatim inclusion is what lets the prose entity gate hold: the gate's
 * region is computed by the same matcher over the same raw.
 */
function docServeDistill(raw: string, profile: DistillProfile, context: DistillContext): string {
  const doc = context.doc;
  if (doc === undefined || doc.sections.length === 0) return '';
  const config = ruleConfig(profile, 'relevant-sections');
  const maxSections = Number(config['maxSections'] ?? 4);
  const maxSectionLines = Number(config['maxSectionLines'] ?? 120);
  const out: string[] = [
    `document ${context.filePath ?? '(unnamed)'}: ${doc.sections.length} sections${
      doc.pages === undefined ? '' : `, ${doc.pages.length} pages`
    }`,
    `[full document elided, ${zoomRef(context)}; a section id or title recovers that section byte-exact]`,
  ];
  for (const section of doc.sections) {
    out.push(`§${section.id} ${section.title} (${sectionAnchor(section)}) — ${section.summary}`);
  }
  const matched = matchedDocSections(raw, doc.sections, doc.ask, maxSections);
  for (const { section, text } of matched) {
    out.push('', `[§${section.id} ${section.title} (${sectionAnchor(section)})]`);
    const lines = text.split(/\r?\n/);
    out.push(...lines.slice(0, maxSectionLines));
    if (lines.length > maxSectionLines) {
      out.push(`[section truncated after ${maxSectionLines} lines, ${zoomRef(context)}]`);
    }
  }
  return out.join('\n');
}

/**
 * Prose document skeleton: the structure map alone. This is the repo-tool
 * counterpart of the code skeleton — a Markdown, text or PDF read arrives
 * with no ask, so there are no relevant sections to include verbatim and the
 * whole body is elided behind the zoom handle. Every section keeps its
 * citation line (id, title, anchor, one-line summary) so the reader can name
 * what to zoom to, which is exactly what a signature list does for code.
 */
function docSkeletonDistill(raw: string, profile: DistillProfile, context: DistillContext): string {
  const doc = context.doc;
  if (doc === undefined) return '';
  // The map is rendered to fit the profile's own size gate, with a small
  // margin, so a heavily sectioned document degrades to a shorter map
  // instead of failing the gate and serving the whole document raw.
  const maxRatio = profileGateConfig(profile).size?.maxRatio ?? LIMITS.SIZE_SANITY_MAX_RATIO;
  return renderStructureMap({
    filePath: context.filePath,
    sections: doc.sections,
    pages: doc.pages,
    zoomHint: zoomRef(context),
    maxSections: Number(ruleConfig(profile, 'structure-map')['maxSections'] ?? 400),
    maxBytes: Math.floor(Buffer.byteLength(raw, 'utf8') * maxRatio * 0.95),
  });
}

/**
 * Cross-document search: the hit lines arrive pre-ranked (document, section,
 * page context already inline), so the distillate is a header plus the head
 * of the list, kept verbatim for the prose entity gate.
 */
function docSearchDistill(raw: string, profile: DistillProfile, context: DistillContext): string {
  const config = ruleConfig(profile, 'ranked-hits');
  const maxHits = Number(config['maxHits'] ?? 24);
  const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return '';
  const docs = new Set(lines.map((l) => l.split(' §')[0] ?? l));
  const shown = lines.slice(0, maxHits);
  const out = [
    `${lines.length} hits across ${docs.size} documents${
      shown.length < lines.length ? ` (showing top ${shown.length}; full set: ${zoomRef(context)})` : ` (full set: ${zoomRef(context)})`
    }`,
    ...shown,
  ];
  return out.join('\n');
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
    case 'doc-serve':
      return docServeDistill(raw, profile, context);
    case 'doc-skeleton':
      return docSkeletonDistill(raw, profile, context);
    case 'doc-search':
      return docSearchDistill(raw, profile, context);
    default:
      throw new Error(`no distiller implemented for profile "${profile.name}"`);
  }
}

export function profileGateConfig(profile: DistillProfile): GateConfig {
  const g = profile.gates;
  const entityConfigured = g.relevantLinePattern !== undefined || g.entityPatterns !== undefined;
  const config: GateConfig = {
    entity: !entityConfigured
      ? undefined
      : {
          relevantLinePattern: g.relevantLinePattern,
          minRatio: g.entityPreservationMinRatio,
          limit: g.relevantLineLimit,
          patternSet: g.entityPatterns ?? 'code',
        },
    verdict: g.verdict,
    size: { maxRatio: g.sizeMaxRatio, minBytes: g.minOutputBytes },
  };
  return config;
}

/**
 * For document artifacts the conclusion-relevant region is the ask-matched
 * section set — the exact text the doc-serve distiller promises to include —
 * computed here with the same matcher and caps so gate and distiller can
 * never drift apart.
 */
function withDocRegion(config: GateConfig, request: DistillRequest): GateConfig {
  const doc = request.context?.doc;
  if (doc === undefined || config.entity === undefined || config.entity.relevantLinePattern !== undefined) {
    return config;
  }
  const maxSections = Number(
    ruleConfig(request.profile, 'relevant-sections')['maxSections'] ?? 4,
  );
  const matched = matchedDocSections(request.raw, doc.sections, doc.ask, maxSections);
  if (matched.length > 0) {
    return { ...config, entity: { ...config.entity, region: matched.map((m) => m.text).join('\n') } };
  }
  // No ask, so no conclusion-relevant region: a structure map's own promise
  // is that every section stays findable, so the region becomes the document's
  // heading lines. Without this the gate would pass on an empty region and
  // guarantee nothing about the one thing the map exists to carry.
  const lines = request.raw.split(/\r?\n/);
  const headingLines = doc.sections
    .map((s) => lines[s.startLine - 1] ?? '')
    .filter((l) => l.trim() !== '');
  return { ...config, entity: { ...config.entity, regionLines: headingLines } };
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
  const gateConfig = withDocRegion(profileGateConfig(request.profile), request);
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
    meta: {
      gates: gateReport.results,
      filePath: request.context?.filePath,
      ...(request.context?.doc === undefined
        ? {}
        : { doc: { sections: request.context.doc.sections, pages: request.context.doc.pages } }),
      ...(request.context?.docRefs === undefined ? {} : { docRefs: request.context.docRefs }),
    },
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
    details: {
      profile: request.profile.name,
      gates: gateReport.results,
      gateConfig,
      ...(request.context?.enrichmentCandidate === undefined
        ? {}
        : { enrichmentCandidate: request.context.enrichmentCandidate }),
    },
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
  /** Set when found: the resolved artifact behind the handle, its raw size,
   * and its recorded file path, so callers can account the serve. */
  artifactId?: string;
  rawBytes?: number;
  filePath?: string;
  /**
   * Set when a query was given: false means nothing matched it anywhere and
   * the full raw artifact was served as the unconditional fallback.
   */
  queryMatched?: boolean;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Codex symbols declared for the artifact's file, matched with separators
 * normalized in both directions so relative and absolute forms agree. */
function symbolsForFile(codex: CodexFile | undefined, filePath: unknown): string[] {
  if (codex === undefined || typeof filePath !== 'string' || filePath === '') return [];
  const norm = (p: string): string => p.replace(/\\/g, '/');
  const target = norm(filePath);
  return codex.interfaces
    .filter((i) => {
      if (i.file === undefined) return false;
      const file = norm(i.file);
      return file === target || target.endsWith(`/${file}`) || file.endsWith(`/${target}`);
    })
    .map((i) => i.name);
}

/**
 * The full definition block of a symbol in the raw source: from its
 * definition line through the close of its balanced braces (or the first
 * statement-ending line when no block opens). Brace counting is textual, so a
 * pathological string literal can skew it; the 400-line cap bounds the damage.
 */
function extractDefinition(raw: string, name: string): string | undefined {
  const lines = raw.split(/\r?\n/);
  const def = new RegExp(
    `^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:const|let|var|function|class)\\s+${escapeRegExp(name)}\\b`,
  );
  const start = lines.findIndex((l) => def.test(l));
  if (start === -1) return undefined;
  let depth = 0;
  let opened = false;
  for (let i = start; i < Math.min(lines.length, start + 400); i += 1) {
    for (const ch of lines[i] ?? '') {
      if (ch === '{') {
        depth += 1;
        opened = true;
      } else if (ch === '}') depth -= 1;
    }
    if (opened && depth <= 0) return lines.slice(start, i + 1).join('\n');
    if (!opened && /;\s*$/.test(lines[i] ?? '')) return lines.slice(start, i + 1).join('\n');
  }
  return lines.slice(start, Math.min(lines.length, start + 400)).join('\n');
}

/**
 * F-id@hash references from the served-file delta registry (serve.ts) resolve
 * back to content: preferably the stored artifact behind the file's first
 * full serve, else the registry's own copy of that content version. Every
 * reference the system hands out must be recoverable by zoom.
 */
/** Whether a store can serve a zoom reference — artifact id or file ref.
 * Callers holding several stores use this to route a handle to the one that
 * actually minted it instead of guessing. */
export function holdsRef(store: Store, ref: string): boolean {
  return (store.getArtifact(ref) ?? resolveFileRef(store, ref)) !== undefined;
}

function resolveFileRef(store: Store, ref: string): ArtifactRecord | undefined {
  const match = /^(F[0-9a-f]{4})@([0-9a-f]{16})$/.exec(ref);
  if (match === null) return undefined;
  const [, fileId, hash] = match;
  for (const served of store.listServedFiles()) {
    if (fileIdFor(served.path) !== fileId) continue;
    const artifactId = store.findArtifactIdByFile([served.path], hash as string);
    if (artifactId !== undefined) {
      const artifact = store.getArtifact(artifactId);
      if (artifact !== undefined) return artifact;
    }
    if (served.hash === hash && served.content !== '') {
      return {
        id: ref,
        sessionId: served.sessionId,
        artifactClass: 'served-file',
        createdAt: served.servedAt,
        raw: served.content,
        gatesPassed: false,
        meta: { filePath: served.path },
      };
    }
  }
  return undefined;
}

/** Serve bound for query windows; matches beyond it are elided WITH a marker. */
const ZOOM_WINDOW_CAP = 200;

/**
 * ±2-line windows around every raw line matching the query: whole phrase
 * first, per-word fallback (a multi-word query almost never appears verbatim
 * on one line). Matches beyond the cap are elided with an explicit marker —
 * the field failure hid a citation behind a silent slice(0, 200).
 */
function textWindows(raw: string, query: string): string | undefined {
  const lines = raw.split(/\r?\n/);
  const windowFor = (pattern: string): Set<number> => {
    const matcher = new RegExp(escapeRegExp(pattern), 'i');
    const keep = new Set<number>();
    lines.forEach((line, i) => {
      if (matcher.test(line)) {
        for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j += 1) keep.add(j);
      }
    });
    return keep;
  };
  const words = query.trim().split(/\s+/);
  let keep = windowFor(query);
  if (keep.size === 0 && words.length > 1) {
    keep = new Set<number>();
    for (const w of words) for (const i of windowFor(w)) keep.add(i);
  }
  if (keep.size === 0) return undefined;
  const ordered = [...keep].sort((a, b) => a - b);
  const slice = ordered.slice(0, ZOOM_WINDOW_CAP);
  const out = slice.map((i) => lines[i] ?? '');
  if (ordered.length > slice.length) {
    out.push(
      `[dcp: omitted ${ordered.length - slice.length} more matching lines; zoom with a section reference, a narrower query, or no query for the full raw]`,
    );
  }
  return out.join('\n');
}

/**
 * Section/page addressing for document artifacts: a query naming a section
 * (id, §id, exact title, or a parsed reference like "Example 21") or a page
 * ("page 2", "p.2") recovers that slice byte-exactly from the stored raw.
 * Residual query terms beyond the reference narrow within the recovered
 * slice; when they match nothing the whole slice serves anyway — recovery
 * never depends on the residual hitting. Returns undefined when the query
 * is not a structural reference, so text queries fall through to windows.
 */
function docSlice(artifact: ArtifactRecord, query: string): string | undefined {
  const doc = artifact.meta['doc'] as
    | { sections?: DocSection[]; pages?: DocPage[] }
    | undefined;
  if (doc?.sections === undefined || doc.sections.length === 0) return undefined;
  const q = query.trim();
  const pageRef = /^(?:p|page)\.?\s*(\d+)$/i.exec(q);
  if (pageRef !== null) {
    const page = (doc.pages ?? []).find((p) => p.page === Number(pageRef[1]));
    return page === undefined ? undefined : sectionText(artifact.raw, page);
  }
  const idRef = q.replace(/^§\s*/, '').toLowerCase().replace(/\s+/g, '-');
  const exact =
    doc.sections.find((s) => s.id.toLowerCase() === idRef) ??
    doc.sections.find((s) => s.title.toLowerCase() === q.toLowerCase());
  if (exact !== undefined) return sectionText(artifact.raw, exact);
  const refs = parseSectionRefs(q);
  if (refs.length === 0) return undefined;
  const matched = doc.sections.filter((s) => refs.some((r) => sectionMatchesRef(s, r)));
  if (matched.length === 0) return undefined;
  const slice = matched.map((s) => sectionText(artifact.raw, s)).join('\n\n');
  let residual = q;
  for (const r of refs) residual = residual.split(r.raw).join(' ');
  residual = residual.replace(/§\s*[\w.-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (residual !== '') {
    const window = textWindows(slice, residual);
    if (window !== undefined) return window;
  }
  return slice;
}

/** Referenced source documents recorded on a hits artifact (doc-search). */
function docRefTargets(store: Store, artifact: ArtifactRecord): ArtifactRecord[] {
  const refs = artifact.meta['docRefs'];
  if (!Array.isArray(refs)) return [];
  const targets: ArtifactRecord[] = [];
  for (const ref of refs) {
    const artifactId = (ref as { artifactId?: unknown }).artifactId;
    if (typeof artifactId !== 'string') continue;
    const target = store.getArtifact(artifactId);
    if (target !== undefined) targets.push(target);
  }
  return targets;
}

interface QueryResolution {
  text: string;
  matched: boolean;
  /** The artifact actually served; differs from the handle on reach-through. */
  source: ArtifactRecord;
}

/**
 * Query resolution order: structural on the artifact itself, structural
 * through its recorded source documents, codex symbol bodies, text windows
 * on the artifact, text windows through the sources, and finally — the
 * byte-recoverability contract — the full raw artifact, unconditionally.
 * A query can only narrow what a handle serves, never gate access to it.
 */
function resolveQuery(
  store: Store,
  artifact: ArtifactRecord,
  query: string,
  codex: CodexFile | undefined,
): QueryResolution {
  const sliced = docSlice(artifact, query);
  if (sliced !== undefined) return { text: sliced, matched: true, source: artifact };
  const targets = docRefTargets(store, artifact);
  for (const target of targets) {
    const reach = docSlice(target, query);
    if (reach !== undefined) return { text: reach, matched: true, source: target };
  }
  // Symbol pass before text windows: a query word naming a codex symbol for
  // this file gets the symbol's whole definition body, not a line window —
  // the h02 session needed createStyler's body and the ±2 window could not
  // carry it.
  const words = query.trim().split(/\s+/);
  const bodies = words
    .filter((w) => symbolsForFile(codex, artifact.meta['filePath']).includes(w))
    .map((w) => extractDefinition(artifact.raw, w))
    .filter((b): b is string => b !== undefined);
  if (bodies.length > 0) return { text: bodies.join('\n\n'), matched: true, source: artifact };
  const windows = textWindows(artifact.raw, query);
  if (windows !== undefined) return { text: windows, matched: true, source: artifact };
  for (const target of targets) {
    const reach = textWindows(target.raw, query);
    if (reach !== undefined) return { text: reach, matched: true, source: target };
  }
  return {
    text: `[dcp: no lines match "${query}" in artifact ${artifact.id}${
      targets.length === 0 ? '' : ' or its source documents'
    }; serving the full raw artifact]\n${artifact.raw}`,
    matched: false,
    source: artifact,
  };
}

export function zoom(
  store: Store,
  audit: AuditWriter,
  id: string,
  query?: string,
  codex?: CodexFile,
): ZoomResult {
  const artifact = store.getArtifact(id) ?? resolveFileRef(store, id);
  if (artifact === undefined) return { found: false, text: `no artifact ${id} in the store` };
  const resolution =
    query === undefined || query === ''
      ? undefined
      : resolveQuery(store, artifact, query, codex);
  const source = resolution?.source ?? artifact;
  const text = resolution?.text ?? artifact.raw;
  const event: AuditEvent = {
    id: `zoom-${id}-${randomBytes(2).toString('hex')}`,
    timestamp: new Date().toISOString(),
    sessionId: artifact.sessionId,
    module: 'sidecar.zoom',
    action: 'zoom',
    reason:
      resolution === undefined
        ? `raw artifact ${id} served`
        : resolution.matched
          ? `query slice of ${source.id === id ? id : `${id} via ${source.id}`} for "${query}"`
          : `query "${query}" matched nothing; full raw artifact ${id} served`,
    inputRef: id,
    details: { query: query ?? null, matched: resolution?.matched ?? null, servedFrom: source.id },
  };
  audit.write(event);
  store.insertAuditEvent(event);
  const result: ZoomResult = {
    found: true,
    text,
    artifactId: source.id,
    rawBytes: Buffer.byteLength(source.raw, 'utf8'),
  };
  if (resolution !== undefined) result.queryMatched = resolution.matched;
  const filePath = source.meta['filePath'];
  if (typeof filePath === 'string' && filePath !== '') result.filePath = filePath;
  return result;
}
