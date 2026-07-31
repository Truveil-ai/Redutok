import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { LIMITS, type DistillProfile } from '@redutok/shared';
import type { AuditWriter } from './audit.js';
import { distillArtifact, estimateTokens } from './distill.js';
import {
  searchDocumentSections,
  sectionAnchor,
  type DocHit,
  type DocumentIndexEntry,
} from './docs.js';
import type { LlmPass } from './llm.js';
import type { Store } from './store.js';

/**
 * dcp__explore, architecture-v2 pillar 1: one bounded, read-only internal
 * hunt (search, then skeleton-read the most relevant files) that replaces
 * the model's own turn-by-turn read/evaluate/zoom loop with a single dossier.
 * Every internal step is a distillArtifact call, so it is audited exactly
 * like any other distillation and its raw artifact is retained for zoom;
 * one additional summary event closes out the call. No writes, no shell
 * execution, no network: only readFileSync/readdirSync and the local
 * LlmPass seam (which itself never leaves localhost).
 */

export type ExploreBudget = 'quick' | 'standard' | 'thorough';

export interface ExploreRequest {
  goal: string;
  scope?: string[];
  budget?: ExploreBudget;
  sessionId: string;
  repoRoot: string;
  /**
   * Ingested document index entries (Vault Session 2): their stored extracted
   * text is searched by section and served through the doc profiles, and the
   * source files are skipped by the code walk (a .docx on disk is bytes; the
   * store holds its text).
   */
  documents?: DocumentIndexEntry[];
}

export interface DossierEvidence {
  file: string;
  line: number;
  snippet: string;
  why: string;
}

export interface Dossier {
  verdict: string;
  evidence: DossierEvidence[];
  zoomHandles: string[];
  stepsTaken: number;
  distillationRatio: number;
  incomplete?: { reason: string; continuationHint: string };
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.dcp', '.claude', 'coverage', 'backup']);
const STOPWORDS = new Set([
  'this', 'that', 'with', 'from', 'into', 'what', 'where', 'when', 'how', 'does', 'the', 'and', 'for',
  'are', 'has', 'have', 'your', 'their', 'over', 'each', 'exactly', 'produces', 'returns', 'instead',
]);
// Only an imperative opener counts as a mutation request; "explain how X
// renames Y" must not trip this, so the verb must lead the goal, not just
// appear anywhere in it.
const MUTATION_OPENER = /^\s*(fix|implement|add|write|create|delete|remove|refactor|edit|change|update|rename)\b/i;

function keywordsFrom(goal: string): string[] {
  const tokens = goal
    .split(/[^A-Za-z0-9_]+/)
    .filter((t) => t.length >= 4)
    .map((t) => t.toLowerCase())
    .filter((t) => !STOPWORDS.has(t));
  return [...new Set(tokens)];
}

interface Hit {
  file: string;
  line: number;
  text: string;
}

function walkSearch(
  roots: string[],
  keywords: string[],
  maxHits: number,
  deadline: number,
  skipFiles: Set<string> = new Set(),
): Hit[] {
  const hits: Hit[] = [];
  const pattern = new RegExp(keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
  const walk = (dir: string): void => {
    if (hits.length >= maxHits || Date.now() > deadline) return;
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (hits.length >= maxHits || Date.now() > deadline) return;
      if (SKIP_DIRS.has(name)) continue;
      const full = path.join(dir, name);
      if (skipFiles.has(path.resolve(full))) continue;
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        walk(full);
        continue;
      }
      if (stats.size > 1_000_000) continue;
      let raw: string;
      try {
        raw = readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      raw.split(/\r?\n/).forEach((line, i) => {
        if (hits.length >= maxHits) return;
        if (pattern.test(line)) hits.push({ file: full, line: i + 1, text: line.trim() });
      });
    }
  };
  for (const root of roots) walk(root);
  return hits;
}

export async function exploreGoal(
  store: Store,
  audit: AuditWriter,
  profiles: Map<string, DistillProfile>,
  llm: LlmPass,
  request: ExploreRequest,
): Promise<Dossier> {
  const startedAt = Date.now();
  const budget = request.budget ?? 'standard';
  const stepCap = LIMITS.EXPLORE_STEP_CAP[budget];
  const deadline = startedAt + LIMITS.EXPLORE_WALL_CLOCK_MS[budget];

  let stepsTaken = 0;
  let rawTokensSeen = 0;
  const zoomHandles: string[] = [];

  const finish = (
    partial: Omit<Dossier, 'stepsTaken' | 'distillationRatio'>,
  ): Dossier => {
    const dossier: Dossier = { ...partial, stepsTaken, distillationRatio: 0 };
    const dossierTokens = estimateTokens(JSON.stringify(dossier));
    dossier.distillationRatio = rawTokensSeen === 0 ? 0 : rawTokensSeen / Math.max(dossierTokens, 1);
    const event = {
      id: `explore-${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      sessionId: request.sessionId,
      module: 'sidecar.explore',
      action: 'summarize' as const,
      reason: `goal "${request.goal.slice(0, 80)}" (${budget}): ${stepsTaken} step(s), ${
        dossier.incomplete === undefined ? 'complete' : `incomplete (${dossier.incomplete.reason})`
      }`,
      details: {
        goal: request.goal,
        scope: request.scope ?? null,
        budget,
        stepsTaken,
        distillationRatio: dossier.distillationRatio,
        incomplete: dossier.incomplete ?? null,
      },
    };
    audit.write(event);
    store.insertAuditEvent(event);
    return dossier;
  };

  // Safety bound: read-only. A goal phrased as an instruction to mutate the
  // repo is answered incomplete with a continuation hint, before any step
  // runs, rather than attempting anything destructive.
  if (MUTATION_OPENER.test(request.goal)) {
    return finish({
      verdict: '',
      evidence: [],
      zoomHandles: [],
      incomplete: {
        reason: 'goal requires a mutation',
        continuationHint: 'dcp__explore is read-only; perform the edit yourself in your own turn',
      },
    });
  }

  const keywords = keywordsFrom(request.goal);
  if (keywords.length === 0) {
    return finish({
      verdict: '',
      evidence: [],
      zoomHandles: [],
      incomplete: {
        reason: 'goal too vague to search',
        continuationHint: 'restate the goal with concrete identifiers, file names, or symbols',
      },
    });
  }

  // Document phase first: ingested documents are searched by section in the
  // store (their on-disk bytes may be binary), the ranked hits become a
  // doc-search artifact, and the top documents are served ask-relevant
  // through doc-serve. Every step is a distillArtifact call like any other.
  const docEntries = (request.documents ?? []).filter((d) => d.artifactId !== undefined);
  const skipFiles = new Set(docEntries.map((d) => path.resolve(request.repoRoot, d.path)));
  const evidence: DossierEvidence[] = [];
  const docHits = docEntries.length === 0 ? [] : searchDocumentSections(store, docEntries, keywords);
  if (docHits.length > 0) {
    const byDoc = new Map<string, DocHit[]>();
    for (const h of docHits) byDoc.set(h.path, [...(byDoc.get(h.path) ?? []), h]);
    const rankedDocs = [...byDoc.entries()].sort((a, b) => b[1].length - a[1].length);
    const hitLine = (h: DocHit): string =>
      `${h.path} §${h.section.id}${h.section.page === undefined ? '' : ` p.${h.section.page}`}:${h.line}: ${h.text}`;
    const docRaw = rankedDocs.flatMap(([, hs]) => hs).map(hitLine).join('\n');
    rawTokensSeen += estimateTokens(docRaw);
    const docSearchProfile = profiles.get('doc-search');
    if (docSearchProfile !== undefined) {
      const outcome = await distillArtifact(store, audit, {
        raw: docRaw,
        profile: docSearchProfile,
        sessionId: request.sessionId,
        tool: 'dcp__explore',
      });
      zoomHandles.push(outcome.artifactId);
    }
    stepsTaken += 1;
    for (const [docPath, hs] of rankedDocs.slice(0, 6)) {
      for (const h of hs.slice(0, 2)) {
        evidence.push({
          file: docPath,
          line: h.line,
          snippet: h.text.slice(0, 200),
          why: `§${h.section.id} "${h.section.title}", ${sectionAnchor(h.section)}`,
        });
      }
    }
    const serveProfile = profiles.get('doc-serve');
    const docBudget = Math.min(rankedDocs.length, 6, Math.max(0, stepCap - stepsTaken - 2));
    for (const [docPath] of rankedDocs.slice(0, docBudget)) {
      if (Date.now() > deadline) break;
      const entry = docEntries.find((d) => d.path === docPath);
      if (serveProfile === undefined || entry?.artifactId === undefined) continue;
      const artifact = store.getArtifact(entry.artifactId);
      if (artifact === undefined) continue;
      rawTokensSeen += estimateTokens(artifact.raw);
      const outcome = await distillArtifact(store, audit, {
        raw: artifact.raw,
        profile: serveProfile,
        sessionId: request.sessionId,
        tool: 'dcp__explore',
        context: {
          filePath: entry.path,
          doc: { sections: entry.sections, pages: entry.pages, ask: request.goal },
        },
      });
      zoomHandles.push(outcome.artifactId);
      stepsTaken += 1;
    }
  }

  const roots = (request.scope !== undefined && request.scope.length > 0 ? request.scope : [request.repoRoot]).map(
    (p) => (path.isAbsolute(p) ? p : path.join(request.repoRoot, p)),
  );
  const hits = walkSearch(roots, keywords, 500, deadline, skipFiles);
  stepsTaken += 1; // the search sweep is one step regardless of how many files it touches

  if (hits.length === 0 && evidence.length === 0) {
    return finish({
      verdict: `no matches for ${keywords.join(', ')} under ${roots.join(', ')}`,
      evidence: [],
      zoomHandles,
      incomplete: {
        reason: 'no hits',
        continuationHint: 'broaden scope or restate the goal with different keywords',
      },
    });
  }

  if (hits.length > 0) {
    const searchRaw = hits.map((h) => `${path.relative(request.repoRoot, h.file)}:${h.line}:${h.text}`).join('\n');
    rawTokensSeen += estimateTokens(searchRaw);
    const searchProfile = profiles.get('search-results');
    if (searchProfile !== undefined) {
      const outcome = await distillArtifact(store, audit, {
        raw: searchRaw,
        profile: searchProfile,
        sessionId: request.sessionId,
        tool: 'dcp__explore',
      });
      zoomHandles.push(outcome.artifactId);
    }
  }

  const byFile = new Map<string, Hit[]>();
  for (const h of hits) byFile.set(h.file, [...(byFile.get(h.file) ?? []), h]);
  const rankedFiles = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length);

  const readBudget = Math.max(0, stepCap - stepsTaken);
  const filesToRead = rankedFiles.slice(0, readBudget);
  const skeletonProfile = profiles.get('file-skeleton');
  let incomplete: Dossier['incomplete'];

  for (const [file, fileHits] of filesToRead) {
    if (Date.now() > deadline) {
      incomplete = {
        reason: 'wall-clock budget exceeded',
        continuationHint: `raise budget above "${budget}" or narrow scope`,
      };
      break;
    }
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    rawTokensSeen += estimateTokens(raw);
    const relFile = path.relative(request.repoRoot, file);
    if (skeletonProfile !== undefined) {
      const outcome = await distillArtifact(store, audit, {
        raw,
        profile: skeletonProfile,
        sessionId: request.sessionId,
        tool: 'dcp__explore',
        context: { filePath: relFile },
      });
      zoomHandles.push(outcome.artifactId);
    }
    stepsTaken += 1;
    for (const h of fileHits.slice(0, 3)) {
      evidence.push({ file: relFile, line: h.line, snippet: h.text.slice(0, 200), why: `matches goal keyword` });
    }
    if (evidence.length >= 12) break;
  }

  if (incomplete === undefined && rankedFiles.length > filesToRead.length) {
    incomplete = {
      reason: 'step cap reached before all matching files were read',
      continuationHint: `raise budget above "${budget}", or narrow scope to the most relevant path`,
    };
  }

  const llmResult = await llm.summarize({
    text: evidence.map((e) => `${e.file}:${e.line}: ${e.snippet}`).join('\n'),
    prompt: `Goal: ${request.goal}\nAnswer directly from this evidence, one paragraph.`,
    timeoutMs: LIMITS.LOCAL_LLM_TIMEOUT_MS,
  });
  const verdict =
    llmResult ??
    (evidence.length === 0
      ? `no relevant evidence found for "${request.goal}"`
      : `${evidence.length} reference(s) across ${filesToRead.length} file(s) matching ${keywords
          .slice(0, 5)
          .join(', ')}: ${evidence
          .slice(0, 5)
          .map((e) => `${e.file}:${e.line} (${e.snippet})`)
          .join('; ')}`);

  return finish({ verdict, evidence, zoomHandles, incomplete });
}
