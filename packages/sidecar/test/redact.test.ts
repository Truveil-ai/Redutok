import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readAuditFile } from '@redutok/shared';
import { AuditWriter } from '../src/audit.js';
import { redact, storeRedactedArtifact } from '../src/redact.js';
import { openStore } from '../src/store.js';

const SECRETS = {
  aws: 'AKIAIOSFODNN7EXAMPLE',
  github: 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8',
  apiKey: 'sk-abcdefghijklmnopqrstuvwxyz123456',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  envLine: 'DATABASE_PASSWORD=hunter2secret',
  privateKey: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7bq8\n-----END RSA PRIVATE KEY-----',
};

describe('redact', () => {
  it('redacts every supported secret pattern and counts findings by kind', () => {
    const input = Object.values(SECRETS).join('\nplain line\n');
    const result = redact(input);
    for (const secret of [SECRETS.aws, SECRETS.github, SECRETS.apiKey, SECRETS.jwt]) {
      expect(result.text).not.toContain(secret);
    }
    expect(result.text).not.toContain('hunter2secret');
    expect(result.text).not.toContain('MIIEowIBAAKCAQEA7bq8');
    expect(result.text).toContain('[REDACTED:');
    expect(result.text).toContain('plain line');
    expect(result.findings.length).toBeGreaterThanOrEqual(5);
  });

  it('leaves ordinary build output untouched with zero findings', () => {
    const input = 'src/index.ts:42 error TS2304\n17 tests passed in 1.4s\nversion 1.2.3';
    const result = redact(input);
    expect(result.text).toBe(input);
    expect(result.findings).toEqual([]);
  });
});

describe('storeRedactedArtifact', () => {
  it('proves redacted spans never reach disk, and writes a redact audit event', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'redutok-redact-'));
    const dbPath = path.join(dir, 'state.db');
    const auditPath = path.join(dir, 'audit.jsonl');
    const store = openStore(dbPath);
    const writer = new AuditWriter(auditPath);

    storeRedactedArtifact(store, writer, {
      id: 'a1',
      sessionId: 's-1',
      artifactClass: 'generic-stdout',
      createdAt: '2026-07-19T10:00:00.000Z',
      raw: `deploy log start\n${SECRETS.envLine}\ntoken ${SECRETS.apiKey} used\ndone`,
      distilled: `summary: deploy ok, token ${SECRETS.apiKey}`,
      gatesPassed: true,
      meta: {},
    });
    const stored = store.getArtifact('a1');
    expect(stored?.raw).toContain('[REDACTED:');
    expect(stored?.distilled).toContain('[REDACTED:');
    store.close();

    for (const file of [dbPath, `${dbPath}-wal`, auditPath]) {
      if (!existsSync(file)) continue;
      const bytes = readFileSync(file);
      expect(bytes.includes('hunter2secret'), `${path.basename(file)} leaked env secret`).toBe(false);
      expect(bytes.includes(SECRETS.apiKey), `${path.basename(file)} leaked api key`).toBe(false);
    }

    const audit = readAuditFile(auditPath, 's-1');
    const redactEvents = audit.events.filter((e) => e.action === 'redact');
    expect(redactEvents).toHaveLength(1);
    expect(redactEvents[0]?.module).toBe('sidecar.redact');
  });

  it('writes no redact event when nothing was found', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'redutok-redact-'));
    const store = openStore(path.join(dir, 'state.db'));
    const writer = new AuditWriter(path.join(dir, 'audit.jsonl'));
    storeRedactedArtifact(store, writer, {
      id: 'a2',
      sessionId: 's-1',
      artifactClass: 'generic-stdout',
      createdAt: '2026-07-19T10:00:00.000Z',
      raw: 'clean output',
      gatesPassed: true,
      meta: {},
    });
    expect(readAuditFile(path.join(dir, 'audit.jsonl'), 's-1').events).toEqual([]);
    store.close();
  });
});
