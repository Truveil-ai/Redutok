import { randomUUID } from 'node:crypto';
import type { AuditEvent } from '@redutok/shared';
import type { AuditWriter } from './audit.js';
import type { ArtifactRecord, Store } from './store.js';

/**
 * Redaction pass, applied before anything is stored. Architecture 4.5: keys,
 * tokens, and .env patterns never reach disk by default. Every redaction
 * writes an audit event naming the kinds found, never the values.
 */

interface RedactionRule {
  kind: string;
  pattern: RegExp;
}

const RULES: RedactionRule[] = [
  {
    kind: 'private-key-block',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { kind: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { kind: 'api-key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  {
    kind: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{5,}\b/g,
  },
  { kind: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g },
  {
    kind: 'env-assignment',
    pattern:
      /^([ \t]*(?:export[ \t]+)?[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]*[ \t]*=)[^\r\n]+$/gm,
  },
];

export interface RedactionFinding {
  kind: string;
  count: number;
}

export interface RedactionResult {
  text: string;
  findings: RedactionFinding[];
}

export function redact(input: string): RedactionResult {
  let text = input;
  const findings: RedactionFinding[] = [];
  for (const rule of RULES) {
    let count = 0;
    text = text.replace(rule.pattern, (_match, prefix: unknown) => {
      count += 1;
      const marker = `[REDACTED:${rule.kind}]`;
      return rule.kind === 'env-assignment' && typeof prefix === 'string'
        ? `${prefix}${marker}`
        : marker;
    });
    if (count > 0) findings.push({ kind: rule.kind, count });
  }
  return { text, findings };
}

/**
 * The only supported write path for artifacts: redacts raw and distilled
 * content before insertion and audits any findings. Inserting unredacted
 * content directly via the store is a bug by definition.
 */
export function storeRedactedArtifact(
  store: Store,
  audit: AuditWriter,
  artifact: ArtifactRecord,
): ArtifactRecord {
  const rawResult = redact(artifact.raw);
  const distilledResult = artifact.distilled === undefined ? undefined : redact(artifact.distilled);
  const findings = [...rawResult.findings, ...(distilledResult?.findings ?? [])];
  const redacted: ArtifactRecord = {
    ...artifact,
    raw: rawResult.text,
    distilled: distilledResult?.text,
  };
  store.insertArtifact(redacted);
  if (findings.length > 0) {
    const event: AuditEvent = {
      id: `redact-${randomUUID()}`,
      timestamp: new Date().toISOString(),
      sessionId: artifact.sessionId,
      module: 'sidecar.redact',
      action: 'redact',
      reason: `redacted ${findings.reduce((n, f) => n + f.count, 0)} span(s) before storage: ${findings
        .map((f) => `${f.kind} x${f.count}`)
        .join(', ')}`,
      inputRef: artifact.id,
      details: { findings },
    };
    audit.write(event);
    store.insertAuditEvent(event);
  }
  return redacted;
}
