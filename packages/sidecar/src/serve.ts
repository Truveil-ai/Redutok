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

export function serveFile(
  store: Store,
  audit: AuditWriter,
  sessionId: string,
  relPath: string,
  content: string,
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
