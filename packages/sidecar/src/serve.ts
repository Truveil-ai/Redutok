import { createHash } from 'node:crypto';
import { createPatch } from 'diff';
import type { AuditEvent } from '@redutok/shared';
import type { AuditWriter } from './audit.js';
import type { Store } from './store.js';

/**
 * Served-file delta registry, architecture 5.1. A file already served this
 * session is never re-served; a changed file is served as a unified diff
 * against the last served content. References are stable F-id@hash.
 */

const short = (text: string, n: number): string =>
  createHash('sha256').update(text).digest('hex').slice(0, n);

export function fileIdFor(relPath: string): string {
  return `F${short(relPath, 4)}`;
}

export interface ServeResult {
  mode: 'full' | 'diff' | 'unchanged';
  ref: string;
  text: string;
}

export interface ServeOptions {
  /**
   * Whether a first (full) serve is recorded as a serve event.
   *
   * False when the caller will distil this content and serve the distillate
   * instead: the full text never reaches the model, so recording it as a raw
   * serve would book bytes that never entered context and count the same
   * artifact's raw twice, once here and once on the distill event. A diff or
   * unchanged serve is always recorded, because that text is what is served.
   */
  auditFullServe?: boolean;
}

export function serveFile(
  store: Store,
  audit: AuditWriter,
  sessionId: string,
  relPath: string,
  content: string,
  options: ServeOptions = {},
): ServeResult {
  const hash = short(content, 16);
  const ref = `${fileIdFor(relPath)}@${hash}`;
  const prior = store.getServedFile(sessionId, relPath);
  const now = new Date().toISOString();

  let result: ServeResult;
  let reason: string;
  if (prior === undefined) {
    store.recordServedFile(sessionId, relPath, hash, now, content);
    result = { mode: 'full', ref, text: content };
    reason = `first serve of ${relPath} as ${ref}`;
  } else if (prior.hash === hash) {
    result = {
      mode: 'unchanged',
      ref,
      text: `[dcp:file ${ref} unchanged since last serve; zoom or re-read is unnecessary]`,
    };
    reason = `${relPath} unchanged since ${prior.hash}; reference served`;
  } else {
    const patch = createPatch(relPath, prior.content, content, prior.hash, hash);
    store.recordServedFile(sessionId, relPath, hash, now, content);
    result = { mode: 'diff', ref, text: patch };
    reason = `${relPath} served as unified diff ${prior.hash} to ${hash}`;
  }

  if (result.mode === 'full' && options.auditFullServe === false) return result;

  const event: AuditEvent = {
    id: `serve-${short(sessionId + relPath + now + result.mode, 8)}`,
    timestamp: now,
    sessionId,
    module: 'sidecar.serve',
    action: result.mode === 'full' ? 'serve-raw' : 'distill',
    reason,
    inputRef: ref,
    bytesIn: Buffer.byteLength(content, 'utf8'),
    bytesOut: Buffer.byteLength(result.text, 'utf8'),
    details: { mode: result.mode },
  };
  audit.write(event);
  store.insertAuditEvent(event);
  return result;
}
