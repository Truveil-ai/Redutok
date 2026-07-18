import path from 'node:path';
import { readAuditFile, type AuditFileResult } from '@redutok/shared';

/** Renderer for redutok audit <session>. Reads the append-only audit.jsonl. */

export function defaultAuditPath(cwd: string = process.cwd()): string {
  return path.join(cwd, '.dcp', 'audit.jsonl');
}

export function renderAuditText(result: AuditFileResult, sessionId: string): string {
  const lines: string[] = [`Redutok audit for session ${sessionId}`];
  if (result.missing) {
    lines.push('No audit file found. Nothing has been distilled yet, or the sidecar is not installed here.');
    return lines.join('\n');
  }
  if (result.events.length === 0) {
    lines.push('No audit events recorded for this session.');
  }
  for (const e of result.events) {
    const size =
      e.bytesIn !== undefined && e.bytesOut !== undefined ? ` ${e.bytesIn}B to ${e.bytesOut}B` : '';
    lines.push(`${e.timestamp}  ${e.action.padEnd(9)} ${e.module.padEnd(18)}${size}  ${e.reason}`);
  }
  lines.push('');
  lines.push(`Events: ${result.events.length}. Malformed lines skipped: ${result.malformed}.`);
  return lines.join('\n');
}

export function buildAuditReport(sessionId: string, filePath?: string): AuditFileResult {
  return readAuditFile(filePath ?? defaultAuditPath(), sessionId);
}
