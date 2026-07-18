import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { AuditEventSchema, type AuditEvent } from '@redutok/shared';

/**
 * Append-only audit.jsonl writer. Guardrail 3: every transformation writes an
 * event here or the operation does not count as done. The file is only ever
 * appended to; nothing in this module can truncate or rewrite it.
 * The matching reader is readAuditFile in @redutok/shared.
 */

export class AuditWriter {
  constructor(private readonly filePath: string) {
    mkdirSync(path.dirname(filePath), { recursive: true });
  }

  write(event: AuditEvent): void {
    const parsed = AuditEventSchema.parse(event);
    appendFileSync(this.filePath, JSON.stringify(parsed) + '\n', 'utf8');
  }
}
