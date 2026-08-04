import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AuditWriter } from '../src/audit.js';
import { loadProfiles, zoom } from '../src/distill.js';
import { buildHtmlSkeleton, isHtmlPath } from '../src/html.js';
import { refreshMirror } from '../src/mirror.js';
import { prepareSkeletonEntry, skeletonProfileFor } from '../src/prepare.js';
import { openStore } from '../src/store.js';

/**
 * HTML skeletons. Until now a large .html file had no structure-aware path at
 * all: it was neither a tree-sitter language the mirror knew nor a prose
 * document, so the only thing standing between a 20KB single-file app and the
 * context window was the size escape hatch, which serves it raw. The common
 * real-world shape — one file carrying its own markup, its stylesheet and its
 * whole application script — is exactly the shape that hurts most, so these
 * hold the HTML map to the same contract the code and prose skeletons carry:
 * a map far smaller than the source, every heading and block boundary named,
 * script and style bodies summarized rather than passed through, and a zoom
 * handle that recovers the file byte for byte.
 */

const monorepoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const profilesDir = path.join(monorepoRoot, 'profiles');
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** The realistic case: a single-file dashboard, 626 lines, no build step. */
const dashboard = (): string =>
  readFileSync(path.join(fixtures, 'revenue-dashboard.html'), 'utf8');

function repoWith(files: { rel: string; content: string | Buffer }[]): { root: string; dcpDir: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redutok-htmlskel-'));
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

describe('HTML is recognized as skeletonable', () => {
  it('routes .html and .htm to the html-skeleton profile', () => {
    for (const rel of ['app/index.html', 'legacy/page.htm', 'A/B/REPORT.HTML']) {
      expect(isHtmlPath(rel), rel).toBe(true);
      expect(skeletonProfileFor(rel), rel).toBe('html-skeleton');
    }
    expect(isHtmlPath('src/index.ts')).toBe(false);
    expect(isHtmlPath('docs/policy.md')).toBe(false);
    // The existing routes are untouched.
    expect(skeletonProfileFor('src/index.ts')).toBe('file-skeleton');
    expect(skeletonProfileFor('docs/policy.md')).toBe('doc-skeleton');
  });
});

describe('the HTML structure map', () => {
  it('names the document outline: headings, sections, and block boundaries', async () => {
    const source = dashboard();
    const { sections } = await buildHtmlSkeleton(source);
    const titles = sections.map((s) => s.title);
    const ids = sections.map((s) => s.id);

    // Headings, including the page title.
    expect(titles).toContain('Quarterly Revenue Dashboard');
    expect(titles).toContain('Bookings by quarter');
    expect(titles).toContain('Accounts');
    // Top-level element outline: the id'd landmarks a reader would zoom to.
    for (const id of ['masthead', 'viewTabs', 'filters', 'kpis', 'chartSection', 'tableSection', 'detail']) {
      expect(ids, `landmark ${id}`).toContain(id);
    }
    // Script and style block boundaries, each its own section.
    expect(titles.filter((t) => t.startsWith('<style'))).toHaveLength(1);
    expect(titles.filter((t) => t.startsWith('<script'))).toHaveLength(2);
  });

  it('summarizes the inline script by what it defines, never by its body', async () => {
    const source = dashboard();
    const { sections } = await buildHtmlSkeleton(source);
    const script = sections.find((s) => s.title === '<script>');
    expect(script).toBeDefined();
    const summary = (script as { summary: string }).summary;
    // The one-liner a reader needs: how big the block is and what is in it.
    expect(summary).toMatch(/inline script, \d+ lines/);
    expect(summary).toContain('defines');
    expect(summary).toContain('QUARTERS');
    expect(summary).toContain('formatMoney');
    // Named, not pasted: no statement from the block survives into the map.
    expect(summary).not.toContain('Math.max.apply');
    expect(summary).not.toContain('addEventListener');
    // A non-JavaScript block is described by its type, not parsed as code.
    const ldjson = sections.find((s) => s.title.includes('application/ld+json'));
    expect(ldjson?.summary).toMatch(/\d+ lines/);
  });

  it('summarizes the inline stylesheet by its rules and selectors', async () => {
    const source = dashboard();
    const { sections } = await buildHtmlSkeleton(source);
    const style = sections.find((s) => s.title === '<style>');
    expect(style).toBeDefined();
    const summary = (style as { summary: string }).summary;
    expect(summary).toMatch(/inline style, \d+ lines, \d+ rules/);
    expect(summary).toContain(':root');
    // Declarations stay behind the zoom handle.
    expect(summary).not.toContain('--accent-soft');
    expect(summary).not.toContain('box-sizing');
  });

  it('partitions the file exactly, so every section is a byte-exact slice', async () => {
    const source = dashboard();
    const { sections } = await buildHtmlSkeleton(source);
    const lines = source.split('\n');
    expect(sections[0]?.startLine).toBe(1);
    expect(sections[sections.length - 1]?.endLine).toBe(lines.length);
    for (let i = 0; i < sections.length; i += 1) {
      const section = sections[i] as { startLine: number; endLine: number };
      expect(section.endLine).toBeGreaterThanOrEqual(section.startLine);
      const next = sections[i + 1];
      if (next !== undefined) expect(next.startLine).toBe(section.endLine + 1);
    }
    // Concatenating every section reproduces the file.
    const rebuilt = sections
      .map((s) => lines.slice(s.startLine - 1, s.endLine).join('\n'))
      .join('\n');
    expect(rebuilt).toBe(source);
  });

  it('puts every heading line in the region the entity gate checks', async () => {
    const source = dashboard();
    const { regionLines } = await buildHtmlSkeleton(source);
    expect(regionLines.some((l) => l.includes('<h1>Quarterly Revenue Dashboard</h1>'))).toBe(true);
    expect(regionLines.some((l) => l.includes('<h2>Bookings by quarter</h2>'))).toBe(true);
    expect(regionLines.some((l) => l.includes('<style>'))).toBe(true);
    // Body markup is not part of the region: the map never promises to carry it.
    expect(regionLines.some((l) => l.includes('Northwind Traders'))).toBe(false);
  });
});

describe('a single-file HTML app gets a map instead of its body', () => {
  it('serves the map, stays far under the source, and zooms back byte-equal', async () => {
    const content = dashboard();
    const { root, dcpDir } = repoWith([{ rel: 'app/index.html', content }]);
    const deps = depsFor(root, dcpDir);
    try {
      const result = await prepareSkeletonEntry(deps, 'app/index.html', 's-html');
      expect(result.ok, `prepare refused: ${result.reason ?? ''}`).toBe(true);

      const entry = readFileSync(result.mirrorPath as string, 'utf8');
      expect(entry).toContain('[dcp:mirror of');
      expect(entry).toContain('Quarterly Revenue Dashboard');
      expect(entry).toContain('Bookings by quarter');
      // The two things a single-file app hides its bulk in are summarized.
      expect(entry).toMatch(/inline script, \d+ lines/);
      expect(entry).toMatch(/inline style, \d+ lines/);
      // and neither body is passed through.
      expect(entry).not.toContain('const peak = Math.max.apply');
      expect(entry).not.toContain('grid-template-columns');
      expect(entry).not.toContain('Northwind Traders');

      expect(Buffer.byteLength(entry, 'utf8')).toBeLessThan(
        Buffer.byteLength(content, 'utf8') * 0.4,
      );

      const zoomId = /dcp__zoom\("(a[0-9a-f]+)"\)/.exec(entry)?.[1];
      expect(zoomId, `no zoom handle in header: ${entry.split('\n')[0] ?? ''}`).toBeDefined();
      const recovered = zoom(deps.store, deps.audit, zoomId as string, undefined, undefined);
      expect(recovered.found).toBe(true);
      // Byte-equal to the file itself: for HTML the raw is the source, not an
      // extracted text layer — a reader zooming an app wants the app back.
      expect(recovered.text).toBe(content);
    } finally {
      deps.store.close();
    }
  });

  it('recovers one named block byte-exactly through its section id', async () => {
    const content = dashboard();
    const { root, dcpDir } = repoWith([{ rel: 'app/index.html', content }]);
    const deps = depsFor(root, dcpDir);
    try {
      const result = await prepareSkeletonEntry(deps, 'app/index.html', 's-html-zoom');
      expect(result.ok, `prepare refused: ${result.reason ?? ''}`).toBe(true);
      const entry = readFileSync(result.mirrorPath as string, 'utf8');
      const zoomId = /dcp__zoom\("(a[0-9a-f]+)"\)/.exec(entry)?.[1] as string;

      const { sections } = await buildHtmlSkeleton(content);
      // The stylesheet: summarized in the map, whole behind its own id.
      const target = sections.find((s) => s.id === 'style');
      expect(target).toBeDefined();
      const expected = content
        .split('\n')
        .slice((target as { startLine: number }).startLine - 1, (target as { endLine: number }).endLine)
        .join('\n');

      const recovered = zoom(deps.store, deps.audit, zoomId, 'style', undefined);
      expect(recovered.found).toBe(true);
      expect(recovered.text).toBe(expected);
      // What the one-liner replaced comes back in full, byte for byte.
      expect(recovered.text).toContain('--accent-soft: #eaf0ff;');
      expect(recovered.text).toContain('@media (prefers-color-scheme: dark)');
    } finally {
      deps.store.close();
    }
  });
});

describe('line endings survive the round trip', () => {
  it('recovers a section of a CRLF page with its carriage returns intact', async () => {
    // A Windows checkout hands the reader CRLF, and a slice that rejoined the
    // lines with \n was not the byte-exact recovery the map promises. CI on
    // windows-latest caught this; the fixture is LF on disk, so the CRLF case
    // is pinned here explicitly rather than left to the runner.
    const content = dashboard().replace(/\n/g, '\r\n');
    const { root, dcpDir } = repoWith([{ rel: 'app/crlf.html', content }]);
    const deps = depsFor(root, dcpDir);
    try {
      const result = await prepareSkeletonEntry(deps, 'app/crlf.html', 's-crlf');
      expect(result.ok, `prepare refused: ${result.reason ?? ''}`).toBe(true);
      const entry = readFileSync(result.mirrorPath as string, 'utf8');
      const zoomId = /dcp__zoom\("(a[0-9a-f]+)"\)/.exec(entry)?.[1] as string;

      const whole = zoom(deps.store, deps.audit, zoomId, undefined, undefined);
      expect(whole.text).toBe(content);

      const { sections } = await buildHtmlSkeleton(content);
      const target = sections.find((s) => s.id === 'style') as { startLine: number; endLine: number };
      const expected = content
        .split('\n')
        .slice(target.startLine - 1, target.endLine)
        .join('\n');
      const slice = zoom(deps.store, deps.audit, zoomId, 'style', undefined);
      expect(slice.text).toBe(expected);
      expect(slice.text).toContain('\r\n');
    } finally {
      deps.store.close();
    }
  });
});

describe('the mirror covers HTML like any other skeletonable file', () => {
  it('writes an entry on refresh and names the real path in the header', async () => {
    const content = dashboard();
    const { root } = repoWith([{ rel: 'app/index.html', content }]);
    const written = await refreshMirror(root, ['app/index.html']);
    expect(written).toEqual(['app/index.html']);
    const entry = readFileSync(path.join(root, '.dcp', 'mirror', 'app/index.html'), 'utf8');
    // The header names the real file and the way back, like any other entry.
    expect(entry.split('\n')[0]).toContain('index.html');
    expect(entry.split('\n')[0]).toContain('with offset/limit');
    expect(entry).toContain('Bookings by quarter');
    expect(entry).not.toContain('Northwind Traders');
  });
});

describe('an HTML file with nothing to elide is served raw', () => {
  it('refuses when the map cannot beat the source', async () => {
    const content = '<!doctype html>\n<html><body><p>Hello.</p></body></html>\n';
    const { root, dcpDir } = repoWith([{ rel: 'tiny.html', content }]);
    const deps = depsFor(root, dcpDir);
    try {
      const result = await prepareSkeletonEntry(deps, 'tiny.html', 's-tiny');
      expect(result.ok).toBe(false);
      expect(result.reason).toBeDefined();
    } finally {
      deps.store.close();
    }
  });

  it('leaves no mirror entry for a file it cannot map', async () => {
    const content = '<!doctype html>\n<html><body><p>Hello.</p></body></html>\n';
    const { root } = repoWith([{ rel: 'tiny.html', content }]);
    const written = await refreshMirror(root, ['tiny.html']);
    expect(written).toEqual([]);
  });
});
