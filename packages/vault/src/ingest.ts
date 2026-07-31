import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  AuditWriter,
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
      if (priorDoc !== undefined && priorDoc.sha256 === hash) {
        // Incremental: unchanged by hash, artifact and entry untouched.
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
      const sections = await buildStructureMap({ ...extraction, text: redactedText }, llm);
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
