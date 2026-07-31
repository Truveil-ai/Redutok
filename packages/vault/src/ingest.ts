import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  AuditWriter,
  DETECTOR_VERSION,
  NoopLlmPass,
  buildStructureMap,
  distillArtifact,
  extractDocument,
  isDocumentPath,
  loadProfiles,
  openStore,
  readDocumentIndex,
  redact,
  writeCodex,
  writeDocumentIndex,
  type DocumentIndex,
  type DocumentIndexEntry,
  type LlmPass,
  type StructureMapOptions,
} from '@redutok/sidecar';
import { resolveProfilesDir } from './corpus.js';

/**
 * vault ingest <path> --corpus <name>: builds the full .dcp state for an
 * arbitrary directory of mixed files, so the server can mount it. Code goes
 * through the codex (and its skeleton mirror) exactly as redutok init +
 * codex refresh would; documents are extracted, structure-mapped, and stored
 * through the redaction pass as doc-serve artifacts; every file lands in a
 * PROVENANCE record with its source hash. Re-ingestion is incremental by
 * hash: an unchanged file's artifact, index entry, and timestamps are
 * untouched.
 */

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.dcp', '.claude', 'coverage', 'backup']);
const SOURCE_EXT = new Set(['.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs', '.py']);
/** v1 extraction cap; larger documents are declared out of scope, never dropped. */
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

export type IngestStatus = 'document' | 'unchanged' | 'out-of-scope' | 'source' | 'catalogued';

export interface IngestFileResult {
  path: string;
  status: IngestStatus;
  method: string;
  sha256: string;
  artifactId?: string;
}

export interface IngestSummary {
  corpus: string;
  root: string;
  files: IngestFileResult[];
  documents: number;
  unchanged: number;
  outOfScope: number;
}

export interface IngestOptions {
  corpus: string;
  llm?: LlmPass;
  env?: NodeJS.ProcessEnv;
}

interface ProvenanceFile {
  path: string;
  sha256: string;
  bytes: number;
  method: string;
  ingestedAt: string;
  artifactId?: string;
  outOfScope?: string;
}

interface ProvenanceRecord {
  version: '1';
  corpus: string;
  generatedAt: string;
  files: ProvenanceFile[];
}

const PROVENANCE_FILE = 'PROVENANCE.json';

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (SKIP_DIRS.has(name)) continue;
      const full = path.join(dir, name);
      const stats = statSync(full);
      if (stats.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(root);
  return out;
}

const relPath = (root: string, full: string): string =>
  path.relative(root, full).split(path.sep).join('/');

const sha256 = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex');

/**
 * Load per-document heading overrides from .dcp/config.json. Shape:
 *   { "documents": { "path/to/file.pdf": { "headingPatterns": ["^Example ..."] } } }
 * A malformed pattern is skipped (with a warning to stderr) so a single bad
 * regex cannot brick the whole ingest — the rest of the file's overrides and
 * every other document still ingest normally.
 */
function loadPerDocumentOptions(configPath: string, root: string): Map<string, StructureMapOptions> {
  const out = new Map<string, StructureMapOptions>();
  if (!existsSync(configPath)) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return out;
  }
  const docs = (parsed as { documents?: unknown }).documents;
  if (docs === null || typeof docs !== 'object') return out;
  for (const [relRaw, cfgRaw] of Object.entries(docs as Record<string, unknown>)) {
    if (typeof cfgRaw !== 'object' || cfgRaw === null) continue;
    const patterns = (cfgRaw as { headingPatterns?: unknown }).headingPatterns;
    if (!Array.isArray(patterns)) continue;
    const compiled: RegExp[] = [];
    for (const p of patterns) {
      if (typeof p !== 'string') continue;
      try {
        compiled.push(new RegExp(p));
      } catch (err) {
        console.warn(
          `vault ingest: dropping invalid heading pattern for ${relRaw} in ${configPath}: ${(err as Error).message}`,
        );
      }
    }
    if (compiled.length === 0) continue;
    const rel = relRaw.split(path.sep).join('/');
    out.set(rel, { extraHeadingPatterns: compiled });
    // Also index by absolute path resolved against the corpus root, so a
    // caller who normalizes differently still matches.
    out.set(relPath(root, path.resolve(root, rel)), { extraHeadingPatterns: compiled });
  }
  return out;
}

export async function runIngest(rootDir: string, options: IngestOptions): Promise<IngestSummary> {
  const root = path.resolve(rootDir);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`cannot ingest ${root}: not a directory`);
  }
  const env = options.env ?? process.env;
  const llm = options.llm ?? new NoopLlmPass();
  const dcpDir = path.join(root, '.dcp');
  mkdirSync(dcpDir, { recursive: true });

  const configPath = path.join(dcpDir, 'config.json');
  if (!existsSync(configPath)) {
    const profilesDir = resolveProfilesDir(dcpDir, env);
    if (profilesDir === undefined) {
      throw new Error(
        `cannot ingest ${root}: no distill profiles via REDUTOK_PROFILES or the shipped profiles/`,
      );
    }
    writeFileSync(
      configPath,
      `${JSON.stringify({ port: 48642, profilesDir }, null, 2)}\n`,
      'utf8',
    );
  }
  const profilesDir = resolveProfilesDir(dcpDir, env);
  if (profilesDir === undefined) {
    throw new Error(`cannot ingest ${root}: .dcp/config.json names no usable profilesDir`);
  }
  const profiles = loadProfiles(profilesDir);
  const serveProfile = profiles.get('doc-serve');
  if (serveProfile === undefined) {
    throw new Error(`cannot ingest ${root}: no doc-serve profile in ${profilesDir}`);
  }

  // Per-document heading overrides from .dcp/config.json.documents. Compiled
  // once so a large corpus doesn't re-parse patterns per file. An invalid
  // pattern is dropped with a console warning rather than failing the whole
  // ingest — a bad override should not brick the corpus.
  const perDocOptions = loadPerDocumentOptions(configPath, root);

  const store = openStore(path.join(dcpDir, 'state.db'));
  const audit = new AuditWriter(path.join(dcpDir, 'audit.jsonl'));
  const sessionId = `ingest-${options.corpus}`;
  const priorIndex = readDocumentIndex(dcpDir);
  const priorDocs = new Map((priorIndex?.documents ?? []).map((d) => [d.path, d]));
  const priorProvenance = existsSync(path.join(dcpDir, PROVENANCE_FILE))
    ? (JSON.parse(readFileSync(path.join(dcpDir, PROVENANCE_FILE), 'utf8')) as ProvenanceRecord)
    : undefined;
  const priorFiles = new Map((priorProvenance?.files ?? []).map((f) => [f.path, f]));

  const results: IngestFileResult[] = [];
  const provenanceFiles: ProvenanceFile[] = [];
  const documents: DocumentIndexEntry[] = [];
  const now = (): string => new Date().toISOString();

  try {
    for (const full of listFiles(root)) {
      const rel = relPath(root, full);
      const bytes = readFileSync(full);
      const hash = sha256(bytes);
      const prior = priorFiles.get(rel);
      const keepStamp = prior !== undefined && prior.sha256 === hash ? prior.ingestedAt : now();

      if (!isDocumentPath(rel)) {
        const method = SOURCE_EXT.has(path.extname(rel).toLowerCase()) ? 'codex-index' : 'catalogued';
        results.push({ path: rel, status: method === 'codex-index' ? 'source' : 'catalogued', method, sha256: hash });
        provenanceFiles.push({ path: rel, sha256: hash, bytes: bytes.length, method, ingestedAt: keepStamp });
        continue;
      }

      const priorDoc = priorDocs.get(rel);
      const priorDetector = priorDoc?.detectorVersion ?? 1;
      const upToDate = priorDoc !== undefined
        && priorDoc.sha256 === hash
        && priorDetector === DETECTOR_VERSION;
      if (upToDate && priorDoc !== undefined) {
        // Incremental: unchanged by hash AND built by the current detector,
        // artifact and entry untouched. Stale detectorVersion falls through
        // to a full re-extract so structure-map improvements reach existing
        // corpora on the next ingest.
        documents.push(priorDoc);
        const result: IngestFileResult = { path: rel, status: 'unchanged', method: priorDoc.method, sha256: hash };
        if (priorDoc.artifactId !== undefined) result.artifactId = priorDoc.artifactId;
        results.push(result);
        const provenance: ProvenanceFile = {
          path: rel,
          sha256: hash,
          bytes: bytes.length,
          method: priorDoc.method,
          ingestedAt: priorDoc.ingestedAt,
        };
        if (priorDoc.artifactId !== undefined) provenance.artifactId = priorDoc.artifactId;
        if (priorDoc.outOfScope !== undefined) provenance.outOfScope = priorDoc.outOfScope;
        provenanceFiles.push(provenance);
        continue;
      }

      const extraction =
        bytes.length > MAX_DOCUMENT_BYTES
          ? {
              kind: 'text' as const,
              method: 'none',
              text: '',
              outOfScope: `document exceeds the ${MAX_DOCUMENT_BYTES / (1024 * 1024)}MB v1 extraction cap`,
            }
          : extractDocument(full);
      const stamp = now();
      if (extraction.outOfScope !== undefined) {
        const entry: DocumentIndexEntry = {
          path: rel,
          sha256: hash,
          bytes: bytes.length,
          kind: extraction.kind,
          method: extraction.method,
          ingestedAt: stamp,
          outOfScope: extraction.outOfScope,
          sections: [],
          // Stamp even on out-of-scope entries so re-ingest short-circuits on
          // them too — otherwise a scanned PDF re-extracts on every run.
          detectorVersion: DETECTOR_VERSION,
        };
        documents.push(entry);
        results.push({ path: rel, status: 'out-of-scope', method: extraction.method, sha256: hash });
        provenanceFiles.push({
          path: rel,
          sha256: hash,
          bytes: bytes.length,
          method: extraction.method,
          ingestedAt: stamp,
          outOfScope: extraction.outOfScope,
        });
        continue;
      }

      // The structure map is computed over the redacted text so section line
      // ranges match the stored artifact's raw byte-for-byte; the original
      // text goes to distillArtifact so the redaction pass runs (and audits)
      // on the storage path itself.
      const redactedText = redact(extraction.text).text;
      const structureOptions = perDocOptions.get(rel);
      const sections = await buildStructureMap(
        { ...extraction, text: redactedText },
        llm,
        structureOptions ?? {},
      );
      const context: Parameters<typeof distillArtifact>[2]['context'] = {
        filePath: rel,
        doc: { sections, ...(extraction.pages === undefined ? {} : { pages: extraction.pages }) },
      };
      const outcome = await distillArtifact(store, audit, {
        raw: extraction.text,
        profile: serveProfile,
        sessionId,
        tool: 'vault_ingest',
        context,
      });
      const entry: DocumentIndexEntry = {
        path: rel,
        sha256: hash,
        bytes: bytes.length,
        kind: extraction.kind,
        method: extraction.method,
        ingestedAt: stamp,
        artifactId: outcome.artifactId,
        sections,
        detectorVersion: DETECTOR_VERSION,
      };
      if (extraction.pages !== undefined) entry.pages = extraction.pages;
      documents.push(entry);
      results.push({
        path: rel,
        status: 'document',
        method: extraction.method,
        sha256: hash,
        artifactId: outcome.artifactId,
      });
      provenanceFiles.push({
        path: rel,
        sha256: hash,
        bytes: bytes.length,
        method: extraction.method,
        ingestedAt: stamp,
        artifactId: outcome.artifactId,
      });
    }

    // Codex and skeleton mirror over the source half, as redutok init +
    // codex refresh would produce them.
    await writeCodex(root);

    const index: DocumentIndex = {
      version: '1',
      corpus: options.corpus,
      generatedAt: now(),
      documents,
    };
    writeDocumentIndex(dcpDir, index);
    const provenance: ProvenanceRecord = {
      version: '1',
      corpus: options.corpus,
      generatedAt: now(),
      files: provenanceFiles,
    };
    writeFileSync(path.join(dcpDir, PROVENANCE_FILE), `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');

    const summary: IngestSummary = {
      corpus: options.corpus,
      root,
      files: results,
      documents: results.filter((r) => r.status === 'document').length,
      unchanged: results.filter((r) => r.status === 'unchanged').length,
      outOfScope: results.filter((r) => r.status === 'out-of-scope').length,
    };
    const event = {
      id: `ingest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: now(),
      sessionId,
      module: 'vault.ingest',
      action: 'summarize' as const,
      reason: `ingested ${options.corpus}: ${summary.documents} document(s) extracted, ${summary.unchanged} unchanged, ${summary.outOfScope} out of scope, ${results.length} file(s) in provenance`,
      details: {
        corpus: options.corpus,
        documents: summary.documents,
        unchanged: summary.unchanged,
        outOfScope: summary.outOfScope,
        files: results.length,
      },
    };
    audit.write(event);
    store.insertAuditEvent(event);
    return summary;
  } finally {
    store.close();
  }
}
