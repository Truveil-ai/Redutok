import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readAuditFile, type AuditEvent } from '@redutok/shared';
import type { Corpus } from './corpus.js';

/**
 * Conversational graduation for the vault (Session 4). Reads vault.ask /
 * vault.zoom audit events, buckets them by touched-sections signature and
 * document, and promotes recurring neighborhoods and repeatedly-zoomed
 * documents into a persisted graduated set that the codex emitter reads on
 * the next emission. Deterministic and idempotent: candidate ids hash the
 * signature so re-runs merge into the same records.
 */

export const TOUCHED_SECTIONS_KEY = 'touchedSections';
export const VAULT_GRADUATED_FILE = 'vault-graduated.json';

/** Number of distinct sessions a signature must appear in to graduate. */
const GRADUATE_MIN_SESSIONS = 2;
/** Number of asks/zooms overall needed alongside multi-session support. */
const GRADUATE_MIN_OCCURRENCES = 3;

export interface TouchedSection {
  document: string;
  section: string;
}

export type VaultGraduatedKind = 'ask-neighborhood' | 'zoom-hotspot';

export interface VaultGraduatedEntry {
  candidate: string;
  kind: VaultGraduatedKind;
  document?: string;
  sections: string[];
  occurrences: number;
  sessions: number;
  firstSeen: string;
  lastSeen: string;
  oneLiner: string;
  confidence: number;
  status: 'candidate' | 'graduated';
  source: 'graduated';
}

export interface VaultGraduatedFile {
  entries: VaultGraduatedEntry[];
  candidates: VaultGraduatedEntry[];
  generatedAt: string;
}

export interface MineOptions {
  /** Run inline instead of deferring; used by tests and the verify script. */
  sync?: boolean;
}

export interface MineResult {
  graduated: VaultGraduatedEntry[];
  candidates: VaultGraduatedEntry[];
  newlyGraduated: string[];
}

export function readVaultGraduated(dcpDir: string): VaultGraduatedFile {
  const p = path.join(dcpDir, VAULT_GRADUATED_FILE);
  if (!existsSync(p)) return { entries: [], candidates: [], generatedAt: new Date(0).toISOString() };
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as VaultGraduatedFile;
  } catch {
    return { entries: [], candidates: [], generatedAt: new Date(0).toISOString() };
  }
}

function writeVaultGraduated(dcpDir: string, file: VaultGraduatedFile): void {
  writeFileSync(
    path.join(dcpDir, VAULT_GRADUATED_FILE),
    JSON.stringify(file, null, 2) + '\n',
    'utf8',
  );
}

function normalizeSignature(touched: TouchedSection[]): {
  key: string;
  document: string;
  sections: string[];
} {
  if (touched.length === 0) return { key: '', document: '', sections: [] };
  // A single-document neighborhood is the load-bearing case: cross-document
  // signatures rank too broadly for one graduated line to be useful.
  const sorted = [...touched].sort((a, b) => a.document.localeCompare(b.document));
  const primary = sorted[0];
  if (primary === undefined) return { key: '', document: '', sections: [] };
  const inPrimary = touched.filter((t) => t.document === primary.document);
  const sections = [...new Set(inPrimary.map((t) => t.section))].sort();
  return {
    key: `${primary.document}#${sections.join('|')}`,
    document: primary.document,
    sections,
  };
}

function readTouched(event: AuditEvent): TouchedSection[] {
  const raw = event.details?.[TOUCHED_SECTIONS_KEY];
  if (!Array.isArray(raw)) return [];
  const out: TouchedSection[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const r = item as { document?: unknown; section?: unknown };
    if (typeof r.document === 'string' && typeof r.section === 'string' && r.document !== '' && r.section !== '') {
      out.push({ document: r.document, section: r.section });
    }
  }
  return out;
}

function confidenceFor(occurrences: number, sessions: number): number {
  // Simple saturating curve, matching the shape of GRADUATION.OCCURRENCE_HALF
  // discipline in shared/limits: two sessions with three asks sits at ~0.75.
  const occTerm = 1 - Math.pow(0.5, occurrences / 2);
  const sessTerm = 1 - Math.pow(0.5, sessions);
  return Math.round(occTerm * sessTerm * 100) / 100;
}

interface Bucket {
  kind: VaultGraduatedKind;
  document: string;
  sections: string[];
  occurrences: number;
  sessions: Set<string>;
  firstSeen: string;
  lastSeen: string;
  sampleQuestion: string;
}

function askOneLiner(kind: VaultGraduatedKind, document: string, sections: string[], sample: string): string {
  if (kind === 'ask-neighborhood') {
    const where = sections.length === 0 ? document : `${document} §${sections.join(', §')}`;
    return `${where} is asked about recurrently — sample: "${sample.slice(0, 80)}"`;
  }
  return `${document} is zoomed recurrently across sessions`;
}

export function mineVault(corpus: Corpus, options: MineOptions = {}): MineResult {
  void options; // sync is the only mode today; async deferral is a future seam.
  const events = readAuditFile(corpus.auditPath).events;
  const askBuckets = new Map<string, Bucket>();
  const zoomBuckets = new Map<string, Bucket>();

  for (const event of events) {
    if (event.module === 'vault.ask') {
      const touched = readTouched(event);
      if (touched.length === 0) continue;
      const { key, document, sections } = normalizeSignature(touched);
      if (key === '') continue;
      const bucket = askBuckets.get(key) ?? {
        kind: 'ask-neighborhood' as const,
        document,
        sections,
        occurrences: 0,
        sessions: new Set<string>(),
        firstSeen: event.timestamp,
        lastSeen: event.timestamp,
        sampleQuestion: typeof event.details?.['question'] === 'string' ? (event.details['question'] as string) : '',
      };
      bucket.occurrences += 1;
      if (event.sessionId !== undefined) bucket.sessions.add(event.sessionId);
      if (event.timestamp < bucket.firstSeen) bucket.firstSeen = event.timestamp;
      if (event.timestamp > bucket.lastSeen) bucket.lastSeen = event.timestamp;
      if (bucket.sampleQuestion === '' && typeof event.details?.['question'] === 'string') {
        bucket.sampleQuestion = event.details['question'] as string;
      }
      askBuckets.set(key, bucket);
    } else if (event.module === 'vault.zoom') {
      const document =
        typeof event.details?.['document'] === 'string' ? (event.details['document'] as string) : '';
      if (document === '') continue;
      const key = `${document}`;
      const bucket = zoomBuckets.get(key) ?? {
        kind: 'zoom-hotspot' as const,
        document,
        sections: [] as string[],
        occurrences: 0,
        sessions: new Set<string>(),
        firstSeen: event.timestamp,
        lastSeen: event.timestamp,
        sampleQuestion: '',
      };
      bucket.occurrences += 1;
      if (event.sessionId !== undefined) bucket.sessions.add(event.sessionId);
      if (event.timestamp < bucket.firstSeen) bucket.firstSeen = event.timestamp;
      if (event.timestamp > bucket.lastSeen) bucket.lastSeen = event.timestamp;
      zoomBuckets.set(key, bucket);
    }
  }

  const allBuckets = [...askBuckets.entries(), ...zoomBuckets.entries()];
  const graduated: VaultGraduatedEntry[] = [];
  const candidates: VaultGraduatedEntry[] = [];
  const priorGraduated = new Set(
    readVaultGraduated(corpus.dcpDir).entries.map((e) => e.candidate),
  );
  const newlyGraduated: string[] = [];
  for (const [key, bucket] of allBuckets) {
    const sessions = bucket.sessions.size;
    const occurrences = bucket.occurrences;
    const candidateId = `${bucket.kind}/${key}`;
    const entry: VaultGraduatedEntry = {
      candidate: candidateId,
      kind: bucket.kind,
      document: bucket.document,
      sections: bucket.sections,
      occurrences,
      sessions,
      firstSeen: bucket.firstSeen,
      lastSeen: bucket.lastSeen,
      oneLiner: askOneLiner(bucket.kind, bucket.document, bucket.sections, bucket.sampleQuestion),
      confidence: confidenceFor(occurrences, sessions),
      status:
        sessions >= GRADUATE_MIN_SESSIONS && occurrences >= GRADUATE_MIN_OCCURRENCES
          ? 'graduated'
          : 'candidate',
      source: 'graduated',
    };
    if (entry.status === 'graduated') {
      graduated.push(entry);
      if (!priorGraduated.has(candidateId)) newlyGraduated.push(candidateId);
    } else {
      candidates.push(entry);
    }
  }

  const sortByConf = (a: VaultGraduatedEntry, b: VaultGraduatedEntry): number =>
    b.confidence - a.confidence || a.candidate.localeCompare(b.candidate);
  graduated.sort(sortByConf);
  candidates.sort(sortByConf);

  writeVaultGraduated(corpus.dcpDir, {
    entries: graduated,
    candidates,
    generatedAt: new Date().toISOString(),
  });

  return { graduated, candidates, newlyGraduated };
}
