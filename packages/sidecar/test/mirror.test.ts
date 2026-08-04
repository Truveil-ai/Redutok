import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { refreshFiles, writeCodex } from '../src/codex.js';
import {
  mirrorEntryPath,
  mirrorHash,
  mirrorIndexPath,
  readMirrorIndex,
  refreshMirror,
} from '../src/mirror.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..', '..');

function cloneFixtureRepo(name: string): string {
  const dst = mkdtempSync(path.join(os.tmpdir(), `redutok-mirror-${name}-`));
  cpSync(path.join(repoRoot, 'fixtures', 'repos', name), dst, { recursive: true });
  return dst;
}

describe('skeleton mirror store (v3 pillar B)', () => {
  it('writeCodex persists a mirror entry per source file, header first', async () => {
    const root = cloneFixtureRepo('repo-a');
    await writeCodex(root);
    const index = readMirrorIndex(root);
    expect(Object.keys(index?.files ?? {}).sort()).toEqual([
      'src/service.ts',
      'src/store.ts',
      'test/service.test.ts',
    ]);
    const rel = 'src/store.ts';
    const source = readFileSync(path.join(root, rel), 'utf8');
    expect(index?.files[rel]?.hash).toBe(mirrorHash(source));
    expect(index?.files[rel]?.rawBytes).toBe(Buffer.byteLength(source, 'utf8'));
    const entry = readFileSync(mirrorEntryPath(root, rel), 'utf8');
    const header = entry.split('\n', 1)[0] ?? '';
    // The mandatory header line: real path, raw size, and the way back.
    expect(header).toContain('[dcp:mirror of ');
    expect(header).toContain(path.join(root, 'src', 'store.ts'));
    expect(header).toContain(`raw ${Buffer.byteLength(source, 'utf8')} bytes`);
    expect(header).toContain('offset/limit');
    // The body is the skeleton (elided bodies), not the raw file. Size wins
    // only matter for large sources; the mirror-sizes test below measures that.
    expect(entry).toContain('...');
    expect(entry).not.toContain('return');
  });

  it('is byte-stable on unchanged input and refreshes exactly the stale entry', async () => {
    const root = cloneFixtureRepo('repo-a');
    await writeCodex(root);
    const indexBytes = readFileSync(mirrorIndexPath(root), 'utf8');
    const entryBytes = readFileSync(mirrorEntryPath(root, 'src/store.ts'), 'utf8');
    expect(await refreshMirror(root, ['src/store.ts', 'src/service.ts'])).toEqual([]);
    expect(readFileSync(mirrorIndexPath(root), 'utf8')).toBe(indexBytes);
    expect(readFileSync(mirrorEntryPath(root, 'src/store.ts'), 'utf8')).toBe(entryBytes);

    appendFileSync(path.join(root, 'src', 'store.ts'), '\nexport const STORE_VERSION = 2;\n');
    expect(await refreshMirror(root, ['src/store.ts', 'src/service.ts'])).toEqual(['src/store.ts']);
    const refreshed = readFileSync(mirrorEntryPath(root, 'src/store.ts'), 'utf8');
    expect(refreshed).toContain('STORE_VERSION');
    const index = readMirrorIndex(root);
    expect(index?.files['src/store.ts']?.hash).toBe(
      mirrorHash(readFileSync(path.join(root, 'src', 'store.ts'), 'utf8')),
    );
  });

  it('refreshFiles (the codex.lock incremental path) maintains the mirror too', async () => {
    const root = cloneFixtureRepo('repo-a');
    await writeCodex(root);
    appendFileSync(path.join(root, 'src', 'service.ts'), '\nexport const SERVICE_VERSION = 2;\n');
    // Also delete a mirror entry behind an up-to-date lock: the incremental
    // path must repair it even though the codex hash is unchanged.
    rmSync(mirrorEntryPath(root, 'src/store.ts'));
    await refreshFiles(root, ['src/service.ts', 'src/store.ts']);
    expect(readFileSync(mirrorEntryPath(root, 'src/service.ts'), 'utf8')).toContain(
      'SERVICE_VERSION',
    );
    expect(existsSync(mirrorEntryPath(root, 'src/store.ts'))).toBe(true);
  });

  it('drops the entry for a vanished source and for an empty skeleton', async () => {
    const root = cloneFixtureRepo('repo-a');
    await writeCodex(root);
    rmSync(path.join(root, 'src', 'store.ts'));
    await refreshMirror(root, ['src/store.ts']);
    expect(readMirrorIndex(root)?.files['src/store.ts']).toBeUndefined();
    expect(existsSync(mirrorEntryPath(root, 'src/store.ts'))).toBe(false);

    // A file with no structural declarations mirrors nothing: the hook will
    // pass the raw file through instead of serving a header-only shell.
    writeFileSync(path.join(root, 'src', 'flat.ts'), '// only comments here\n// nothing else\n');
    await refreshMirror(root, ['src/flat.ts']);
    expect(readMirrorIndex(root)?.files['src/flat.ts']).toBeUndefined();
  });

  it('points the header at dcp__zoom when a matching artifact handle is found', async () => {
    const root = cloneFixtureRepo('repo-a');
    await writeCodex(root);
    const rel = 'src/store.ts';
    appendFileSync(path.join(root, rel), '\nexport const STORE_VERSION = 3;\n');
    const source = readFileSync(path.join(root, rel), 'utf8');
    await refreshMirror(root, [rel], {
      findHandle: (r, hash) => (r === rel && hash === mirrorHash(source) ? 'a1b2c3' : undefined),
    });
    const header = readFileSync(mirrorEntryPath(root, rel), 'utf8').split('\n', 1)[0] ?? '';
    expect(header).toContain('dcp__zoom("a1b2c3")');
    expect(header).not.toContain('offset/limit');
  });

  it('files of a type with no skeleton builder are simply skipped', async () => {
    const root = cloneFixtureRepo('repo-a');
    await writeCodex(root);
    // Neither a tree-sitter language nor a prose document: nothing can build
    // a skeleton for it, so the hook serves it raw.
    writeFileSync(path.join(root, 'data.csv'), 'a,b\n'.repeat(100));
    const written = await refreshMirror(root, ['data.csv']);
    expect(written).toEqual([]);
    expect(readMirrorIndex(root)?.files['data.csv']).toBeUndefined();
  });

  it('a structureless document is skipped, a structured one is mirrored', async () => {
    const root = cloneFixtureRepo('repo-a');
    await writeCodex(root);
    // No headings anywhere: a structure map would be one positional section
    // over the whole file, which hides the document instead of mapping it.
    writeFileSync(path.join(root, 'flat.txt'), 'x'.repeat(100));
    expect(await refreshMirror(root, ['flat.txt'])).toEqual([]);

    // Sized like a real document: a map only earns its place when it is far
    // smaller than the prose it maps, which the size ceiling enforces.
    const structured = Array.from(
      { length: 12 },
      (_, i) =>
        `## Section ${i + 1}. Retention\n\n` +
        'The controller retains these records and reviews the schedule annually. '.repeat(10) +
        '\n',
    ).join('\n');
    writeFileSync(path.join(root, 'notes.md'), `# Retention Policy\n\n${structured}`);
    expect(await refreshMirror(root, ['notes.md'])).toEqual(['notes.md']);
    const entry = readMirrorIndex(root)?.files['notes.md'];
    expect(entry).toBeDefined();
    expect(readFileSync(mirrorEntryPath(root, 'notes.md'), 'utf8')).toContain('§');
  });
});

describe('store handle lookup for mirror headers', () => {
  it('findArtifactIdByFile matches the latest artifact whose raw hashes to the source', async () => {
    const { openStore } = await import('../src/store.js');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'redutok-mirror-store-'));
    const store = openStore(path.join(dir, 'state.db'));
    try {
      const raw = 'export const x = 1;\n';
      store.insertArtifact({
        id: 'a0aaaa',
        sessionId: 's-m',
        artifactClass: 'file-skeleton',
        createdAt: '2026-07-28T00:00:00.000Z',
        raw: 'stale content',
        gatesPassed: true,
        meta: { filePath: 'src/x.ts' },
      });
      store.insertArtifact({
        id: 'a0bbbb',
        sessionId: 's-m',
        artifactClass: 'file-skeleton',
        createdAt: '2026-07-28T00:00:01.000Z',
        raw,
        gatesPassed: true,
        meta: { filePath: 'src/x.ts' },
      });
      expect(store.findArtifactIdByFile(['src/x.ts'], mirrorHash(raw))).toBe('a0bbbb');
      expect(store.findArtifactIdByFile(['src/x.ts'], mirrorHash('other'))).toBeUndefined();
      expect(store.findArtifactIdByFile(['src/other.ts'], mirrorHash(raw))).toBeUndefined();
    } finally {
      store.close();
    }
  });
});

describe('mirror sizes', () => {
  it('mirrors are dramatically smaller than large sources', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'redutok-mirror-big-'));
    const big = readFileSync(path.join(repoRoot, 'fixtures', 'artifacts', 'large-source.ts'), 'utf8')
      .split('export')
      .join('\n// section\nexport')
      .repeat(15);
    writeFileSync(path.join(root, 'big.ts'), big);
    expect(statSync(path.join(root, 'big.ts')).size).toBeGreaterThan(65_536);
    await writeCodex(root);
    const entry = readFileSync(mirrorEntryPath(root, 'big.ts'), 'utf8');
    expect(entry.length).toBeLessThan(big.length * 0.4);
  });
});

describe('the offline refresh pre-builds documents and pages', () => {
  /**
   * Field check on 0.1.6: a repository holding one 134KB single-file
   * application reported "Codex refreshed: 0 files indexed" and wrote no
   * mirror at all, because the refresh took its work from the codex lock and
   * the codex indexes source only. Every document and page in a real docs
   * repository paid the on-demand build at first read for the same reason.
   */
  function proseRepo(): string {
    const root = mkdtempSync(path.join(os.tmpdir(), 'redutok-mirror-docs-'));
    mkdirSync(path.join(root, 'docs'));
    mkdirSync(path.join(root, 'app'));
    const policy = [
      '# Data Retention Policy\n',
      ...Array.from(
        { length: 40 },
        (_, i) =>
          `\n## Section ${i + 1}. Retention of Class ${i + 1} Records\n` +
          // First sentence becomes the section's one-liner; the filler after
          // it is body, and body is what the map must not carry.
          `Records in this class are retained for ${i + 1} years. ` +
          'The controller reviews the schedule annually and records the outcome. '.repeat(12) +
          '\n',
      ),
    ].join('');
    writeFileSync(path.join(root, 'docs', 'policy.md'), policy);
    cpSync(
      path.join(here, 'fixtures', 'revenue-dashboard.html'),
      path.join(root, 'app', 'index.html'),
    );
    return root;
  }

  it('mirrors a repo whose only artifacts are a document and a page', async () => {
    const root = proseRepo();
    const result = await writeCodex(root);
    // No source at all: the codex indexes nothing, and that used to be the
    // end of it.
    expect(result.codex.files).toEqual([]);
    expect(result.mirrored).toEqual(['app/index.html', 'docs/policy.md']);

    const index = readMirrorIndex(root);
    expect(Object.keys(index?.files ?? {}).sort()).toEqual(['app/index.html', 'docs/policy.md']);

    const page = readFileSync(mirrorEntryPath(root, 'app/index.html'), 'utf8');
    expect(page).toContain('[dcp:mirror of ');
    expect(page).toMatch(/inline script, \d+ lines/);
    expect(page).not.toContain('Northwind Traders');

    const doc = readFileSync(mirrorEntryPath(root, 'docs/policy.md'), 'utf8');
    expect(doc).toContain('Section 40. Retention of Class 40 Records');
    expect(doc).not.toContain('The controller reviews the schedule annually');
  });

  it('is byte-stable: a second refresh rebuilds nothing', async () => {
    const root = proseRepo();
    await writeCodex(root);
    const before = readFileSync(mirrorEntryPath(root, 'app/index.html'), 'utf8');
    const second = await writeCodex(root);
    expect(second.mirrored).toEqual([]);
    expect(readFileSync(mirrorEntryPath(root, 'app/index.html'), 'utf8')).toBe(before);
  });

  it('rebuilds exactly the document that changed', async () => {
    const root = proseRepo();
    await writeCodex(root);
    appendFileSync(
      path.join(root, 'docs', 'policy.md'),
      '\n## Section 41. Retention of Class 41 Records\n' +
        'Records in this class are retained for 41 years. ' +
        'The controller reviews the schedule annually and records the outcome. '.repeat(12) +
        '\n',
    );
    const result = await writeCodex(root);
    expect(result.mirrored).toEqual(['docs/policy.md']);
    expect(readFileSync(mirrorEntryPath(root, 'docs/policy.md'), 'utf8')).toContain(
      'Section 41. Retention of Class 41 Records',
    );
  });

  it('leaves documents to the caller that has already parsed them', async () => {
    // The Vault's ingest path: every document is extracted and stored before
    // the refresh runs, so a document mirror pass would parse each one twice.
    const root = proseRepo();
    const result = await writeCodex(root, { mirrorDocuments: false });
    expect(result.mirrored).toEqual([]);
    expect(readMirrorIndex(root)?.files ?? {}).toEqual({});
  });
});
