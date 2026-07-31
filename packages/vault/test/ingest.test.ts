import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readAuditFile } from '@redutok/shared';
import { openStore, readDocumentIndex } from '@redutok/sidecar';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore plain-mjs fixture generator, no type declarations
import { writeDocFixtures } from '../../../scripts/doc-fixtures.mjs';
import { runIngest } from '../src/ingest.js';
import { monorepoRoot } from './helpers.js';

const docCorpus = path.join(monorepoRoot, 'fixtures', 'doc-corpus');
const AWS_KEY_LITERAL = ['AKIA', 'QRSTUVWXYZABCDEF'].join('');

let root: string;

/** A working copy of the mixed fixture corpus: checked-in md/txt/ts plus the
 * script-generated pdf/docx, and one planted secret for the redaction path. */
beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'vault-ingest-'));
  cpSync(docCorpus, root, { recursive: true });
  writeDocFixtures(root);
  writeFileSync(
    path.join(root, 'onboarding-notes.txt'),
    `CLIENT ONBOARDING NOTES\n\n1. ACCESS\n\nThe data room upload key is ${AWS_KEY_LITERAL} and must be rotated after closing.\n`,
    'utf8',
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

describe('vault ingest', () => {
  it('builds the full .dcp state for a mixed corpus', async () => {
    const summary = await runIngest(root, { corpus: 'practice' });
    expect(summary.corpus).toBe('practice');

    // The artifact set mountCorpus expects: config, codex, store, audit.
    const dcp = path.join(root, '.dcp');
    const config = JSON.parse(readFileSync(path.join(dcp, 'config.json'), 'utf8')) as {
      profilesDir?: string;
    };
    expect(typeof config.profilesDir).toBe('string');
    expect(existsSync(path.join(dcp, 'codex.yaml'))).toBe(true);
    expect(existsSync(path.join(dcp, 'state.db'))).toBe(true);

    // The document slice index: every document with its structure map.
    const index = readDocumentIndex(dcp);
    const paths = (index?.documents ?? []).map((d) => d.path).sort();
    expect(paths).toEqual([
      'billing-policy.md',
      'engagement-letter.docx',
      'glossary.md',
      'onboarding-notes.txt',
      'retention-schedule.txt',
      'scanned-notes.pdf',
      'valuation-report.pdf',
    ]);
    const letter = index?.documents.find((d) => d.path === 'engagement-letter.docx');
    expect(letter?.sections.some((s) => s.title === 'Fees and Billing')).toBe(true);
    expect(letter?.artifactId).toBeDefined();

    // Scanned pdf: declared out of scope, never silently empty.
    const scanned = index?.documents.find((d) => d.path === 'scanned-notes.pdf');
    expect(scanned?.outOfScope).toMatch(/no extractable text|scanned/i);
    expect(scanned?.artifactId).toBeUndefined();

    // Extracted text is stored through the redaction pass.
    const store = openStore(path.join(dcp, 'state.db'));
    try {
      const notes = index?.documents.find((d) => d.path === 'onboarding-notes.txt');
      const artifact = store.getArtifact(notes?.artifactId ?? '');
      expect(artifact?.raw).toContain('[REDACTED:aws-access-key]');
      expect(artifact?.raw).not.toContain(AWS_KEY_LITERAL);
    } finally {
      store.close();
    }
    const redactions = readAuditFile(path.join(dcp, 'audit.jsonl')).events.filter(
      (e) => e.action === 'redact',
    );
    expect(redactions.length).toBeGreaterThan(0);
  });

  it('writes a provenance record hashing every source file', () => {
    const provenance = JSON.parse(
      readFileSync(path.join(root, '.dcp', 'PROVENANCE.json'), 'utf8'),
    ) as {
      corpus: string;
      files: { path: string; sha256: string; method: string; ingestedAt: string }[];
    };
    expect(provenance.corpus).toBe('practice');
    const byPath = new Map(provenance.files.map((f) => [f.path, f]));
    // The source hash is of the original file bytes, so citations trace to
    // the exact document that was ingested.
    const letterBytes = readFileSync(path.join(root, 'engagement-letter.docx'));
    expect(byPath.get('engagement-letter.docx')?.sha256).toBe(
      createHash('sha256').update(letterBytes).digest('hex'),
    );
    // Code files ride along with their own method so the record is complete.
    const code = byPath.get('tools/fee-calculator.ts');
    expect(code).toBeDefined();
    expect(code?.method).not.toBe(byPath.get('engagement-letter.docx')?.method);
    for (const file of provenance.files) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(file.ingestedAt).not.toBe('');
    }
  });

  it('re-ingests incrementally by hash: unchanged files untouched', async () => {
    const before = readDocumentIndex(path.join(root, '.dcp'));
    const summary = await runIngest(root, { corpus: 'practice' });
    expect(summary.files.filter((f) => f.status === 'unchanged').length).toBeGreaterThan(0);
    const after = readDocumentIndex(path.join(root, '.dcp'));
    // Unchanged documents keep their artifact and ingestion timestamp.
    for (const entry of before?.documents ?? []) {
      const match = after?.documents.find((d) => d.path === entry.path);
      expect(match?.artifactId).toBe(entry.artifactId);
      expect(match?.ingestedAt).toBe(entry.ingestedAt);
    }

    // A changed file is re-extracted under a fresh artifact...
    appendFileSync(
      path.join(root, 'billing-policy.md'),
      '\n## Retainers\n\nNew engagements above USD 20,000 require a retainer.\n',
      'utf8',
    );
    // ...and a removed file leaves the index.
    unlinkSync(path.join(root, 'glossary.md'));
    await runIngest(root, { corpus: 'practice' });
    const third = readDocumentIndex(path.join(root, '.dcp'));
    const billing = third?.documents.find((d) => d.path === 'billing-policy.md');
    expect(billing?.artifactId).not.toBe(
      before?.documents.find((d) => d.path === 'billing-policy.md')?.artifactId,
    );
    expect(billing?.sections.some((s) => s.title === 'Retainers')).toBe(true);
    expect(third?.documents.some((d) => d.path === 'glossary.md')).toBe(false);
  });
});
