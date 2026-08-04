import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LIMITS } from '@redutok/shared';
import {
  buildStructureMap,
  extractDocument,
  isDocumentPath,
  renderStructureMap,
} from './docs.js';
import { buildHtmlSkeleton, isHtmlPath } from './html.js';
import { NoopLlmPass, type LlmPass } from './llm.js';
import { fileSkeleton, languageForPath } from './skeleton.js';

/**
 * Skeleton mirror, v3 pillar B. The codex engine already computes a skeleton
 * per source file; this module persists them under .dcp/mirror preserving
 * relative paths, so the PreToolUse hook can rewrite a large raw Read to the
 * mirror entry and the model receives the skeleton through the Read it
 * already made: no MCP call, no denial, no added turn.
 *
 * Staleness rule: index.json records the source-content hash each entry was
 * built from; an entry whose hash no longer matches the source is never
 * served. The mirror is refreshed by the same paths that maintain codex.lock
 * (redutok codex refresh and the daemon's file-change notify).
 */

export interface MirrorIndexEntry {
  /** Hash of the source content this entry was built from. */
  hash: string;
  rawBytes: number;
  rawLines: number;
  /**
   * Fingerprint of the skeleton-enrichment directive this entry was built
   * with (docs/GRADUATION.md); absent for a plain skeleton. A directive
   * added or withdrawn regenerates the entry even when the source hash is
   * unchanged.
   */
  enrichment?: string;
}

export interface MirrorIndex {
  version: 1;
  files: Record<string, MirrorIndexEntry>;
}

/**
 * Same shape as the codex hashes: sha256 truncated to 16 hex chars. Accepts
 * bytes as well as text so a binary document (a PDF has a skeleton too) can
 * be checked for freshness without a lossy utf8 round trip. A valid-UTF-8
 * string and its own bytes hash identically, so entries written before this
 * stayed valid.
 */
export const mirrorHash = (content: string | Buffer): string =>
  createHash('sha256').update(content).digest('hex').slice(0, 16);

export function mirrorDir(root: string): string {
  return path.join(root, '.dcp', 'mirror');
}

export function mirrorIndexPath(root: string): string {
  return path.join(mirrorDir(root), 'index.json');
}

export function mirrorEntryPath(root: string, rel: string): string {
  return path.join(mirrorDir(root), rel);
}

/** undefined on a missing or unreadable index: the caller serves raw. */
export function readMirrorIndex(root: string): MirrorIndex | undefined {
  try {
    const parsed = JSON.parse(readFileSync(mirrorIndexPath(root), 'utf8')) as MirrorIndex;
    if (parsed.version !== 1 || typeof parsed.files !== 'object' || parsed.files === null) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * The mandatory first line of every mirror entry: the real path, the raw
 * size, and the way back to full fidelity. Zoom when the sidecar already
 * holds the raw artifact; otherwise a plain Read of the real path with an
 * explicit line-range suggestion.
 */
export function buildMirrorHeader(
  realPath: string,
  rawBytes: number,
  rawLines: number,
  zoomId?: string,
  keepSymbols: readonly string[] = [],
  rawLabel = 'raw',
): string {
  const fidelity =
    zoomId === undefined
      ? `Read("${realPath}") with offset/limit, e.g. offset=1 limit=400 of ${rawLines} lines`
      : `dcp__zoom("${zoomId}")`;
  const shape =
    keepSymbols.length === 0
      ? 'skeleton only'
      : `skeleton + full bodies of ${keepSymbols.join(', ')} (learned)`;
  return `[dcp:mirror of ${realPath}, ${rawLabel} ${rawBytes} bytes / ${rawLines} lines, ${shape}; full fidelity: ${fidelity}]`;
}

/**
 * Writes one mirror entry and records it in the index. Shared by the offline
 * refresh below and the daemon's on-demand preparation (prepare.ts), so an
 * entry built either way is byte-identical in shape and equally serveable.
 */
export function writeMirrorEntry(
  root: string,
  rel: string,
  entry: {
    skeleton: string;
    hash: string;
    rawBytes: number;
    rawLines: number;
    realPath: string;
    zoomId?: string;
    keepSymbols?: readonly string[];
    enrichment?: string;
    /** Overrides the header's default description of what the raw is. */
    rawLabel?: string;
  },
): string {
  const entryPath = mirrorEntryPath(root, rel);
  const header = buildMirrorHeader(
    entry.realPath,
    entry.rawBytes,
    entry.rawLines,
    entry.zoomId,
    entry.keepSymbols ?? [],
    entry.rawLabel,
  );
  mkdirSync(path.dirname(entryPath), { recursive: true });
  writeFileSync(entryPath, `${header}\n\n${entry.skeleton}\n`, 'utf8');
  const index = readMirrorIndex(root) ?? { version: 1 as const, files: {} };
  index.files[rel] = {
    hash: entry.hash,
    rawBytes: entry.rawBytes,
    rawLines: entry.rawLines,
    ...(entry.enrichment === undefined ? {} : { enrichment: entry.enrichment }),
  };
  mkdirSync(mirrorDir(root), { recursive: true });
  writeFileSync(mirrorIndexPath(root), JSON.stringify(index, null, 2) + '\n', 'utf8');
  return entryPath;
}

/**
 * A graduated zoom-hotspot directive (codex learned section): mirror entries
 * for this path keep the full bodies of these symbols.
 */
export interface SkeletonEnrichment {
  path: string;
  symbols: string[];
  /** Originating candidate ref, riding along for audit attribution
   * (docs/POSTURE.md, per-lesson attribution). */
  candidate?: string;
}

/**
 * The directive matching a mirror-relative path: exact, or a /-boundary
 * suffix. Bench sessions observe fixture repos through their own relative
 * paths, so `source/index.js` also enriches every mirrored copy such as
 * `fixtures/repos/chalk/source/index.js` (docs/GRADUATION.md).
 */
export function enrichmentFor(
  rel: string,
  enrichments: readonly SkeletonEnrichment[] = [],
): SkeletonEnrichment | undefined {
  return enrichments.find((e) => rel === e.path || rel.endsWith(`/${e.path}`));
}

const enrichmentFingerprint = (e: SkeletonEnrichment): string =>
  mirrorHash([...e.symbols].sort().join('\n'));

export interface RefreshMirrorOptions {
  /**
   * Looks up an artifact id whose stored raw matches the source content, so
   * the header can point at dcp__zoom instead of a raw re-read. The daemon
   * supplies this from its store; the offline codex refresh runs without it.
   */
  findHandle?: (rel: string, hash: string) => string | undefined;
  /** Skeleton-enrichment directives from the codex learned section. */
  enrichments?: readonly SkeletonEnrichment[];
  /** Section one-liners for prose documents; the deterministic
   * first-sentence rule stands in when no model is configured. */
  llm?: LlmPass;
}

/** What a mirror entry is built from, once its type is known. */
interface SkeletonBuild {
  skeleton: string;
  /** The text the skeleton describes, which zoom must return. */
  raw: string;
  rawLabel: string;
}

/**
 * The skeleton for one file, by type. Markdown, plain text and PDF are the
 * most common large artifacts in a real project and had no skeleton path at
 * all until now: the mirror covered tree-sitter languages only, so every
 * document read entered context whole. A document's skeleton is its structure
 * map, and the text it describes is the extracted text layer, not the
 * container bytes.
 */
async function buildSkeletonFor(
  abs: string,
  rel: string,
  bytes: Buffer,
  options: { enrichments?: readonly string[]; llm?: LlmPass },
): Promise<SkeletonBuild | undefined> {
  const lang = languageForPath(rel);
  if (lang !== undefined) {
    const content = bytes.toString('utf8');
    const skeleton = await fileSkeleton(content, lang, options.enrichments ?? []);
    return { skeleton, raw: content, rawLabel: 'raw' };
  }
  if (isHtmlPath(rel)) {
    // A page is its own raw: the map addresses source lines, so what the
    // skeleton replaced comes back as markup, not as stripped text.
    const content = bytes.toString('utf8');
    const built = await buildHtmlSkeleton(content);
    if (built.sections.length < 2) return undefined;
    const skeleton = renderStructureMap({
      filePath: rel,
      sections: built.sections,
      zoomHint: `read ${rel} with offset/limit`,
      maxBytes: Math.floor(
        Buffer.byteLength(content, 'utf8') * LIMITS.SIZE_SANITY_MAX_RATIO * 0.95,
      ),
    });
    if (
      Buffer.byteLength(skeleton, 'utf8') >
      Buffer.byteLength(content, 'utf8') * LIMITS.SIZE_SANITY_MAX_RATIO
    ) {
      return undefined;
    }
    return { skeleton, raw: content, rawLabel: 'raw' };
  }
  if (!isDocumentPath(rel)) return undefined;
  const extraction = extractDocument(abs);
  if (extraction.outOfScope !== undefined) return undefined;
  const sections = await buildStructureMap(extraction, options.llm ?? new NoopLlmPass());
  // A document with no headings yields a single positional section covering
  // the whole file. That is not a map of anything: serving it would hide the
  // document behind one line. Structure has to exist to be summarized.
  if (sections.length < 2) return undefined;
  // The gated paths (prepare, serve-file) take this ceiling from the
  // profile's size-sanity gate; this offline path has no gate runner, so it
  // applies the same one itself rather than shipping a map that saves nothing.
  const rawBytes = Buffer.byteLength(extraction.text, 'utf8');
  const skeleton = renderStructureMap({
    filePath: rel,
    sections,
    pages: extraction.pages,
    // No stored artifact on the offline path, so the recovery route is a
    // slice of the real file; the daemon's on-demand build offers zoom.
    zoomHint: `read ${rel} with offset/limit`,
    maxBytes: Math.floor(rawBytes * LIMITS.SIZE_SANITY_MAX_RATIO * 0.95),
  });
  if (Buffer.byteLength(skeleton, 'utf8') > rawBytes * LIMITS.SIZE_SANITY_MAX_RATIO) {
    return undefined;
  }
  return { skeleton, raw: extraction.text, rawLabel: `${extraction.method} raw` };
}

/**
 * Brings the mirror entries for the given relative paths up to date with
 * their sources. Fresh entries are left untouched (byte-stable on unchanged
 * input, like the codex); sources that vanished lose their entries; files
 * whose skeleton comes back empty get no entry, so the hook serves them raw.
 * Returns the rels actually (re)written.
 */
export async function refreshMirror(
  root: string,
  rels: string[],
  options: RefreshMirrorOptions = {},
): Promise<string[]> {
  const index = readMirrorIndex(root) ?? { version: 1 as const, files: {} };
  const written: string[] = [];
  let dirty = false;
  const drop = (rel: string): void => {
    if (index.files[rel] === undefined) return;
    delete index.files[rel];
    dirty = true;
    try {
      rmSync(mirrorEntryPath(root, rel), { force: true });
    } catch {
      // A stale entry file left behind is harmless: the index governs serving.
    }
  };
  for (const relRaw of rels) {
    const rel = relRaw.replace(/\\/g, '/');
    const abs = path.join(root, rel);
    if (languageForPath(rel) === undefined && !isDocumentPath(rel) && !isHtmlPath(rel)) continue;
    if (!existsSync(abs)) {
      drop(rel);
      continue;
    }
    // Hashed over the bytes, matching what the hook and the on-demand
    // preparation compare against.
    const bytes = readFileSync(abs);
    const hash = mirrorHash(bytes);
    const entryPath = mirrorEntryPath(root, rel);
    const directive = enrichmentFor(rel, options.enrichments);
    const fingerprint = directive === undefined ? undefined : enrichmentFingerprint(directive);
    if (
      index.files[rel]?.hash === hash &&
      index.files[rel]?.enrichment === fingerprint &&
      existsSync(entryPath)
    ) {
      continue;
    }
    let build: SkeletonBuild | undefined;
    try {
      build = await buildSkeletonFor(abs, rel, bytes, {
        enrichments: directive?.symbols ?? [],
        llm: options.llm,
      });
    } catch {
      build = undefined;
    }
    if (build === undefined || build.skeleton.trim() === '') {
      // Nothing structural to show; serving a header-only mirror would hide
      // the whole file. No entry means the hook passes the raw file through.
      drop(rel);
      continue;
    }
    const rawBytes = Buffer.byteLength(build.raw, 'utf8');
    const rawLines = build.raw.split('\n').length;
    const header = buildMirrorHeader(
      abs,
      rawBytes,
      rawLines,
      options.findHandle?.(rel, hash),
      directive?.symbols ?? [],
      build.rawLabel,
    );
    mkdirSync(path.dirname(entryPath), { recursive: true });
    writeFileSync(entryPath, `${header}\n\n${build.skeleton}\n`, 'utf8');
    index.files[rel] = { hash, rawBytes, rawLines, ...(fingerprint === undefined ? {} : { enrichment: fingerprint }) };
    dirty = true;
    written.push(rel);
  }
  if (dirty) {
    mkdirSync(mirrorDir(root), { recursive: true });
    writeFileSync(mirrorIndexPath(root), JSON.stringify(index, null, 2) + '\n', 'utf8');
  }
  return written;
}
