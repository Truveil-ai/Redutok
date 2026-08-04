import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { DistillProfile } from '@redutok/shared';
import type { AuditWriter } from './audit.js';
import { distillArtifact } from './distill.js';
import {
  buildStructureMap,
  extractDocument,
  isDocumentPath,
  type DocPage,
  type DocSection,
} from './docs.js';
import { buildHtmlSkeleton, isHtmlPath } from './html.js';
import { NoopLlmPass, type LlmPass } from './llm.js';
import { mirrorHash, readMirrorIndex, mirrorEntryPath, writeMirrorEntry } from './mirror.js';
import { languageForPath } from './skeleton.js';
import type { Store } from './store.js';

/**
 * On-demand skeleton preparation, the second half of the artifact-size escape
 * hatch (docs/POSTURE.md).
 *
 * The mirror is normally built ahead of time by the codex refresh and the
 * file-change notify, but neither has necessarily run for the artifact in
 * front of the model: an idle repo may have no codex at all, and a file added
 * since the last refresh has no entry. "Engages regardless of posture" has to
 * mean the skeleton is built now, not that it was hopefully built earlier.
 *
 * The build runs through distillArtifact, so an on-demand skeleton is the
 * same object as any other: the same profile and quality gates decide whether
 * it may be served, the raw is stored for byte-equal zoom recovery, and the
 * distill lands in the audit trail. A failure is reported with its reason and
 * audited as a passthrough, which is what lets the receipt say why an
 * artifact was read raw instead of leaving the session to guess.
 */

export interface PrepareDeps {
  store: Store;
  audit: AuditWriter;
  profiles: Map<string, DistillProfile>;
  repoRoot: string;
  /** Section one-liners go through this seam; without it the deterministic
   * first-sentence rule stands in, which is what runs on a repo with no
   * local model (docs/PROSE.md). */
  llm?: LlmPass;
}

export interface PrepareResult {
  ok: boolean;
  /** Present when ok: the mirror entry the caller should read instead. */
  mirrorPath?: string;
  /** Present when not ok: why this artifact cannot be served as a skeleton. */
  reason?: string;
  rawBytes?: number;
}

/**
 * The profile that turns this file into a skeleton, by type: tree-sitter
 * languages become signature lists, prose documents become structure maps,
 * HTML pages become document maps with their inline blocks summarized.
 * Everything else has no skeleton builder and is read raw.
 */
export function skeletonProfileFor(rel: string): string | undefined {
  if (languageForPath(rel) !== undefined) return 'file-skeleton';
  if (isDocumentPath(rel)) return 'doc-skeleton';
  if (isHtmlPath(rel)) return 'html-skeleton';
  return undefined;
}

/** A mirror entry already fresh for this source needs no rebuild. */
function freshEntry(repoRoot: string, rel: string, hash: string): string | undefined {
  const entry = readMirrorIndex(repoRoot)?.files[rel];
  if (entry === undefined || entry.hash !== hash) return undefined;
  const entryPath = mirrorEntryPath(repoRoot, rel);
  return existsSync(entryPath) ? entryPath : undefined;
}

export async function prepareSkeletonEntry(
  deps: PrepareDeps,
  rel: string,
  sessionId: string,
): Promise<PrepareResult> {
  const relPath = rel.replace(/\\/g, '/');
  const abs = path.join(deps.repoRoot, relPath);
  if (!existsSync(abs)) return { ok: false, reason: 'file not found under this repo' };
  const rawBytes = statSync(abs).size;

  const profileName = skeletonProfileFor(relPath);
  if (profileName === undefined) {
    return { ok: false, reason: `no skeleton builder for ${path.extname(relPath) || 'this file type'}`, rawBytes };
  }
  const profile = deps.profiles.get(profileName);
  if (profile === undefined) {
    return { ok: false, reason: `profile ${profileName} is not loaded`, rawBytes };
  }

  // Hashed over the bytes, which is what the hook compares against.
  let bytes: Buffer;
  try {
    bytes = readFileSync(abs);
  } catch (err) {
    return { ok: false, reason: `unreadable: ${err instanceof Error ? err.message : String(err)}`, rawBytes };
  }
  const hash = mirrorHash(bytes);
  const fresh = freshEntry(deps.repoRoot, relPath, hash);
  if (fresh !== undefined) return { ok: true, mirrorPath: fresh, rawBytes };

  // For a document the raw is its extracted text, not its container bytes:
  // that is what a read puts in context, what the structure map is computed
  // over, and therefore what zoom has to return byte for byte.
  let content: string;
  let rawLabel = 'raw';
  let doc: { sections: DocSection[]; pages?: DocPage[]; regionLines?: string[] } | undefined;
  if (profileName === 'html-skeleton') {
    // A page's raw is the page: sections address source lines, so zoom hands
    // back the markup, the script and the stylesheet as written.
    content = bytes.toString('utf8');
    const built = await buildHtmlSkeleton(content);
    if (built.sections.length < 2) {
      return { ok: false, reason: 'no document structure detected in this page', rawBytes };
    }
    doc = { sections: built.sections, regionLines: built.regionLines };
  } else if (profileName === 'doc-skeleton') {
    let extraction;
    try {
      extraction = extractDocument(abs);
    } catch (err) {
      return { ok: false, reason: `extraction failed: ${err instanceof Error ? err.message : String(err)}`, rawBytes };
    }
    if (extraction.outOfScope !== undefined) {
      return { ok: false, reason: `no text layer to skeletonize: ${extraction.outOfScope}`, rawBytes };
    }
    const sections = await buildStructureMap(extraction, deps.llm ?? new NoopLlmPass());
    if (sections.length === 0) {
      return { ok: false, reason: 'no sections detected in this document', rawBytes };
    }
    content = extraction.text;
    doc = { sections, ...(extraction.pages === undefined ? {} : { pages: extraction.pages }) };
    rawLabel = `${extraction.method} raw`;
  } else {
    content = bytes.toString('utf8');
  }

  const outcome = await distillArtifact(deps.store, deps.audit, {
    raw: content,
    profile,
    sessionId,
    tool: 'Read',
    context: { filePath: relPath, ...(doc === undefined ? {} : { doc }) },
  });
  if (outcome.served !== 'distilled') {
    // The gates refused it; the caller reads raw, exactly as it would have
    // without the escape hatch. The distillArtifact call has already audited
    // this as a serve-raw with the failing gate named.
    const failed = outcome.gateReport.results
      .filter((r) => !r.passed)
      .map((r) => `${r.gate} (${r.detail})`)
      .join('; ');
    return { ok: false, reason: `skeleton failed the quality gates: ${failed}`, rawBytes };
  }

  const mirrorPath = writeMirrorEntry(deps.repoRoot, relPath, {
    skeleton: outcome.text,
    hash,
    rawBytes: Buffer.byteLength(content, 'utf8'),
    rawLines: content.split('\n').length,
    realPath: abs,
    zoomId: outcome.artifactId,
    rawLabel,
  });
  return { ok: true, mirrorPath, rawBytes };
}
