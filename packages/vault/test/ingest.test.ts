import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readAuditFile } from '@redutok/shared';
import { DETECTOR_VERSION, openStore, readDocumentIndex } from '@redutok/sidecar';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore plain-mjs fixture generator, no type declarations
import { makeUsptoExamplesPdf, writeDocFixtures } from '../../../scripts/doc-fixtures.mjs';
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

describe('vault ingest heading-detection upgrade', () => {
  // Field finding from a 109-page USPTO PDF: default detection produced
  // generic offset blocks instead of "Example N" / "Claim N" headings. The
  // upgrade path must re-map an unchanged file whose detectorVersion is stale,
  // and must respect a per-document heading override in .dcp/config.json —
  // both without disturbing sibling docs or the ledger sitting alongside.
  let upgradeRoot: string;

  beforeAll(() => {
    upgradeRoot = mkdtempSync(path.join(os.tmpdir(), 'vault-ingest-upgrade-'));
    cpSync(docCorpus, upgradeRoot, { recursive: true });
    writeDocFixtures(upgradeRoot);
    writeFileSync(path.join(upgradeRoot, 'uspto.pdf'), makeUsptoExamplesPdf());
  });

  afterAll(() => {
    rmSync(upgradeRoot, { recursive: true, force: true, maxRetries: 5 });
  });

  it('stamps DETECTOR_VERSION on every entry and re-maps stale entries', async () => {
    await runIngest(upgradeRoot, { corpus: 'uspto' });
    const dcp = path.join(upgradeRoot, '.dcp');
    const first = readDocumentIndex(dcp);
    const uspto = first?.documents.find((d) => d.path === 'uspto.pdf');
    expect(uspto?.detectorVersion, 'fresh entry carries detectorVersion').toBe(DETECTOR_VERSION);
    expect(uspto?.sections.some((s) => s.id === 'example-1')).toBe(true);

    // Simulate a corpus ingested by an older detector: bytes unchanged, but
    // structure map is out of date. Rewriting documents.json with a stale
    // detectorVersion is enough — the ingester should notice on next run.
    if (first === undefined || uspto === undefined) throw new Error('index missing');
    const staleEntry = {
      ...uspto,
      detectorVersion: 1,
      sections: [
        {
          id: 's1',
          title: '(preamble)',
          level: 1,
          startLine: 1,
          endLine: 999,
          summary: 'stale block',
        },
      ],
    };
    const stale = {
      ...first,
      documents: first.documents.map((d) => (d.path === 'uspto.pdf' ? staleEntry : d)),
    };
    writeFileSync(path.join(dcp, 'documents.json'), `${JSON.stringify(stale, null, 2)}\n`, 'utf8');

    // A ledger sitting alongside must not be touched by re-ingest — verify by
    // planting a marker file and asserting its bytes are byte-equal after.
    const ledgerMarker = path.join(dcp, 'ledger.db');
    writeFileSync(ledgerMarker, 'LEDGER-BYTES-DO-NOT-TOUCH', 'utf8');

    const summary = await runIngest(upgradeRoot, { corpus: 'uspto' });
    const rerun = summary.files.find((f) => f.path === 'uspto.pdf');
    expect(rerun?.status, 'stale detectorVersion forces re-extract').toBe('document');
    const after = readDocumentIndex(dcp);
    const upgraded = after?.documents.find((d) => d.path === 'uspto.pdf');
    expect(upgraded?.detectorVersion).toBe(DETECTOR_VERSION);
    expect(upgraded?.sections.some((s) => s.id === 'example-1')).toBe(true);
    expect(upgraded?.sections.some((s) => s.title === '(preamble)')).toBe(false);
    expect(readFileSync(ledgerMarker, 'utf8')).toBe('LEDGER-BYTES-DO-NOT-TOUCH');
  });

  it('honors per-document headingPatterns from .dcp/config.json', async () => {
    const dcp = path.join(upgradeRoot, '.dcp');
    // Add a text file with a bespoke heading pattern and configure an override.
    const bespokePath = 'notes-bespoke.txt';
    writeFileSync(
      path.join(upgradeRoot, bespokePath),
      [
        'Preamble.',
        '',
        'USPTO-2019-EX-01',
        'Body of the first custom example.',
        '',
        'USPTO-2019-EX-02',
        'Body of the second custom example.',
        '',
      ].join('\n'),
      'utf8',
    );

    // Extend the corpus config with a per-document override.
    const configPath = path.join(dcp, 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    config['documents'] = {
      [bespokePath]: { headingPatterns: ['^USPTO-\\d{4}-EX-\\d+$'] },
    };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    await runIngest(upgradeRoot, { corpus: 'uspto' });
    const after = readDocumentIndex(dcp);
    const bespoke = after?.documents.find((d) => d.path === bespokePath);
    const customs = bespoke?.sections.filter((s) => /^USPTO-\d{4}-EX-\d+$/.test(s.title)) ?? [];
    expect(customs.length, 'per-doc override detects bespoke headings').toBe(2);
    expect(customs[0]?.id).toBe('uspto-2019-ex-01');
  });
});
