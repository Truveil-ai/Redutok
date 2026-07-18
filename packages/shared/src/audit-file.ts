import { existsSync, readFileSync } from 'node:fs';
import { AuditEventSchema, type AuditEvent } from './schemas.js';

/**
 * Reader for the append-only audit.jsonl format. Lives in shared so the meter
 * can render audit trails without depending on the sidecar package.
 * Tolerant like the transcript parser: malformed lines are counted, not thrown.
 */

export interface AuditFileResult {
  events: AuditEvent[];
  malformed: number;
  missing: boolean;
}

export function readAuditFile(filePath: string, sessionId?: string): AuditFileResult {
  if (!existsSync(filePath)) return { events: [], malformed: 0, missing: true };
  const events: AuditEvent[] = [];
  let malformed = 0;
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (line.trim() === '') continue;
    try {
      const event = AuditEventSchema.parse(JSON.parse(line));
      if (sessionId === undefined || event.sessionId === sessionId) events.push(event);
    } catch {
      malformed += 1;
    }
  }
  return { events, malformed, missing: false };
}
