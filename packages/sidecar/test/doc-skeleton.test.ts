import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AuditWriter } from '../src/audit.js';
import { loadProfiles, zoom } from '../src/distill.js';
import { isDocumentPath } from '../src/docs.js';
import { prepareSkeletonEntry } from '../src/prepare.js';
import { openStore } from '../src/store.js';

/**
 * Prose skeletons for the repo tool. Markdown, plain text and PDF are the
 * most common large artifacts in a real project and had no skeleton path at
 * all: the mirror only ever covered tree-sitter languages, so every one of
 * them entered context whole. These drive the real fixture documents of each
 * type through the same preparation the hook uses, and hold them to the code
 * skeleton's guarantees: a structure map far smaller than the source, and a
 * zoom handle that recovers what the skeleton replaced byte for byte.
 */

const monorepoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const profilesDir = path.join(monorepoRoot, 'profiles');
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function repoWith(files: { rel: string; content: string | Buffer }[]): { root: string; dcpDir: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redutok-docskel-'));
  const dcpDir = path.join(root, '.dcp');
  mkdirSync(dcpDir);
  for (const file of files) {
    const abs = path.join(root, file.rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, file.content);
  }
  return { root, dcpDir };
}

function depsFor(root: string, dcpDir: string) {
  return {
    store: openStore(path.join(dcpDir, 'state.db')),
    audit: new AuditWriter(path.join(dcpDir, 'audit.jsonl')),
    profiles: loadProfiles(profilesDir),
    repoRoot: root,
  };
}

/** A long Markdown document with real headings, the shape of a spec or policy. */
function markdownDocument(): string {
  const parts = ['# Data Retention Policy\n', 'Applies to every system of record.\n'];
  for (let i = 1; i <= 40; i += 1) {
    parts.push(`\n## Section ${i}. Retention of Class ${i} Records\n`);
    parts.push(
      `Records in this class are retained for ${i} years from the closing date. ` +
        'The controller reviews the schedule annually and records the outcome. '.repeat(12) +
        '\n',
    );
  }
  return parts.join('');
}

function textDocument(): string {
  const parts = ['RETENTION SCHEDULE\n', 'Effective 2026-01-01.\n'];
  for (let i = 1; i <= 40; i += 1) {
    parts.push(`\n${i}. Class ${i} Records\n`);
    parts.push(
      'Retained by the Records Officer under the schedule. '.repeat(14) + '\n',
    );
  }
  return parts.join('');
}

describe('prose documents are recognized as skeletonable', () => {
  it('covers Markdown, plain text and PDF', () => {
    for (const rel of ['docs/policy.md', 'notes/schedule.txt', 'sources/filing.pdf', 'a.markdown']) {
      expect(isDocumentPath(rel), rel).toBe(true);
    }
    expect(isDocumentPath('src/index.ts')).toBe(false);
  });
});

describe('a Markdown document gets a structure map instead of its body', () => {
  it('serves the map, keeps every heading, and zooms back byte-equal', async () => {
    const content = markdownDocument();
    const { root, dcpDir } = repoWith([{ rel: 'docs/policy.md', content }]);
    const deps = depsFor(root, dcpDir);
    try {
      const result = await prepareSkeletonEntry(deps, 'docs/policy.md', 's-md');
      expect(result.ok, `prepare refused: ${result.reason ?? ''}`).toBe(true);

      const entry = readFileSync(result.mirrorPath as string, 'utf8');
      expect(entry).toContain('[dcp:mirror of');
      // The structure map, not the body.
      expect(entry).toContain('Section 1. Retention of Class 1 Records');
      expect(entry).toContain('Section 40. Retention of Class 40 Records');
      expect(entry).not.toContain('The controller reviews the schedule annually');
      expect(Buffer.byteLength(entry, 'utf8')).toBeLessThan(
        Buffer.byteLength(content, 'utf8') * 0.4,
      );

      // Byte-equal recovery, the same guarantee code skeletons carry.
      const zoomId = /dcp__zoom\("(a[0-9a-f]+)"\)/.exec(entry)?.[1];
      expect(zoomId, `no zoom handle in header: ${entry.split('\n')[0] ?? ''}`).toBeDefined();
      const recovered = zoom(deps.store, deps.audit, zoomId as string, undefined, undefined);
      expect(recovered.found).toBe(true);
      expect(recovered.text).toBe(content);
    } finally {
      deps.store.close();
    }
  });
});

describe('a plain text document gets a structure map', () => {
  it('detects numbered headings and stays well under the source size', async () => {
    const content = textDocument();
    const { root, dcpDir } = repoWith([{ rel: 'notes/schedule.txt', content }]);
    const deps = depsFor(root, dcpDir);
    try {
      const result = await prepareSkeletonEntry(deps, 'notes/schedule.txt', 's-txt');
      expect(result.ok, `prepare refused: ${result.reason ?? ''}`).toBe(true);
      const entry = readFileSync(result.mirrorPath as string, 'utf8');
      expect(entry).toContain('Class 1 Records');
      expect(entry).toContain('Class 40 Records');
      expect(Buffer.byteLength(entry, 'utf8')).toBeLessThan(
        Buffer.byteLength(content, 'utf8') * 0.4,
      );
    } finally {
      deps.store.close();
    }
  });
});

describe('a PDF gets a structure map with page anchors', () => {
  it('reads the real USPTO fixture, anchors sections to pages, and zooms to the extracted text', async () => {
    const pdf = readFileSync(path.join(fixtures, 'uspto-101-p40-43.pdf'));
    const { root, dcpDir } = repoWith([{ rel: 'sources/uspto.pdf', content: pdf }]);
    const deps = depsFor(root, dcpDir);
    try {
      const result = await prepareSkeletonEntry(deps, 'sources/uspto.pdf', 's-pdf');
      expect(result.ok, `prepare refused: ${result.reason ?? ''}`).toBe(true);
      const entry = readFileSync(result.mirrorPath as string, 'utf8');
      // The header names what the raw actually is for a binary source: the
      // extracted text layer, not the container bytes.
      expect(entry).toContain('pdf-text raw');
      // Page anchors, the prose equivalent of a line anchor.
      expect(entry).toMatch(/\(p\.\d+\)/);

      const zoomId = /dcp__zoom\("(a[0-9a-f]+)"\)/.exec(entry)?.[1];
      expect(zoomId).toBeDefined();
      const recovered = zoom(deps.store, deps.audit, zoomId as string, undefined, undefined);
      expect(recovered.found).toBe(true);
      // Byte-equal to the text layer the skeleton was built from, which is
      // what a raw read of this PDF would have put in context.
      expect(recovered.text.length).toBeGreaterThan(0);
      expect(entry.length).toBeLessThan(recovered.text.length);
    } finally {
      deps.store.close();
    }
  });
});

describe('a heavily sectioned document degrades instead of being refused', () => {
  it('drops the summaries, keeps every section, and says it dropped them', async () => {
    // The field PDF's shape: many sections over a modest text layer, so the
    // fully annotated map does not fit the size gate. Refusing would put the
    // whole document in context; dropping the summaries keeps it navigable,
    // and every section still appears, which is what the entity gate checks.
    // Long opening sentences, so each section's one-liner is near the summary
    // cap and the annotated map outgrows the budget while the bare list fits.
    const content = Array.from(
      { length: 200 },
      (_, i) =>
        `## Clause ${i + 1}. Processing Records\n\n` +
        `The controller retains the processing records described in this clause for the full statutory period, ` +
        `reviews them against the retention schedule each year, and records the outcome of that review in the ` +
        `register maintained for clause ${i + 1} of this instrument. Short follow-up.\n`,
    ).join('\n');
    const { root, dcpDir } = repoWith([{ rel: 'docs/dense-long.md', content }]);
    const deps = depsFor(root, dcpDir);
    try {
      const result = await prepareSkeletonEntry(deps, 'docs/dense-long.md', 's-dense-long');
      expect(result.ok, `prepare refused: ${result.reason ?? ''}`).toBe(true);
      const entry = readFileSync(result.mirrorPath as string, 'utf8');
      expect(entry).toContain('per-section summaries omitted to fit the serve budget');
      // No section is dropped: the map lists every one of them.
      expect(entry).toContain('Clause 1. Processing Records');
      expect(entry).toContain('Clause 200. Processing Records');
      expect(entry).not.toContain('further sections');
      expect(Buffer.byteLength(entry, 'utf8')).toBeLessThan(
        Buffer.byteLength(content, 'utf8') * 0.4,
      );
    } finally {
      deps.store.close();
    }
  });

  it('serves a document that is mostly headings raw, because there is nothing to elide', async () => {
    const content = Array.from(
      { length: 300 },
      (_, i) => `## Clause ${i + 1}. Records\nRetained.\n`,
    ).join('\n');
    const { root, dcpDir } = repoWith([{ rel: 'docs/outline.md', content }]);
    const deps = depsFor(root, dcpDir);
    try {
      const result = await prepareSkeletonEntry(deps, 'docs/outline.md', 's-outline');
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('size-sanity');
    } finally {
      deps.store.close();
    }
  });
});

describe('Markdown converted out of a word processor still maps', () => {
  it('treats a wholly bold line as a heading, not body text', async () => {
    // NIST AI 600-1 in the field: 2,499 lines carrying four ATX headings and
    // all of its real structure in bold lines.
    const body = 'The framework describes governance outcomes for deployers. '.repeat(12);
    const content = [
      '# Report',
      '',
      ...Array.from({ length: 15 }, (_, i) => [`**Section ${i + 1}. Govern**`, '', body, ''].join('\n')),
      'A **bold phrase** inside a sentence is not a heading.',
    ].join('\n');
    const { root, dcpDir } = repoWith([{ rel: 'docs/converted.md', content }]);
    const deps = depsFor(root, dcpDir);
    try {
      const result = await prepareSkeletonEntry(deps, 'docs/converted.md', 's-bold');
      expect(result.ok, `prepare refused: ${result.reason ?? ''}`).toBe(true);
      const entry = readFileSync(result.mirrorPath as string, 'utf8');
      expect(entry).toContain('Section 1. Govern');
      expect(entry).toContain('Section 15. Govern');
      expect(entry).not.toContain('bold phrase');
      const declared = /document [^:]+: (\d+) sections/.exec(entry)?.[1];
      expect(Number(declared)).toBeGreaterThanOrEqual(15);
    } finally {
      deps.store.close();
    }
  });
});

describe('the prose entity gate governs the map', () => {
  it('refuses a document whose map cannot clear the size gate, and says so', async () => {
    // Heading-dense and short: the map would approach the source, so the
    // gate refuses it and the caller reads raw, exactly as before.
    const content = Array.from({ length: 30 }, (_, i) => `## H${i}\nx\n`).join('');
    const { root, dcpDir } = repoWith([{ rel: 'docs/dense.md', content }]);
    const deps = depsFor(root, dcpDir);
    try {
      const result = await prepareSkeletonEntry(deps, 'docs/dense.md', 's-dense');
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('size-sanity');
    } finally {
      deps.store.close();
    }
  });
});
