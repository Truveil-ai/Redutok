import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

  it('non-source files and files outside the index are simply skipped', async () => {
    const root = cloneFixtureRepo('repo-a');
    await writeCodex(root);
    writeFileSync(path.join(root, 'notes.txt'), 'x'.repeat(100));
    const written = await refreshMirror(root, ['notes.txt']);
    expect(written).toEqual([]);
    expect(readMirrorIndex(root)?.files['notes.txt']).toBeUndefined();
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
