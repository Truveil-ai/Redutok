import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { CodexFileSchema, DistillProfileSchema } from '@redutok/shared';
import { codexPaths, readCodex, writeCodex } from '../src/codex.js';
import { runProfile } from '../src/distill.js';
import {
  enrichmentFor,
  mirrorEntryPath,
  readMirrorIndex,
  refreshMirror,
  type SkeletonEnrichment,
} from '../src/mirror.js';
import { fileSkeleton } from '../src/skeleton.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..', '..');

function cloneFixtureRepo(name: string): string {
  const dst = mkdtempSync(path.join(os.tmpdir(), `redutok-enrich-${name}-`));
  cpSync(path.join(repoRoot, 'fixtures', 'repos', name), dst, { recursive: true });
  return dst;
}

const SAMPLE = [
  'const createStyler = (open, close, parent) => {',
  '\tlet openAll;',
  '\tlet closeAll;',
  '\treturn {open, close, openAll, closeAll, parent};',
  '};',
  '',
  'function applyStyle(self, string) {',
  '\treturn string + self;',
  '}',
  '',
  'const levelMapping = [1, 2, 3];',
  '',
].join('\n');

describe('fileSkeleton keep-symbols', () => {
  it('keeps the full body of a kept symbol; everything else stays elided', async () => {
    const skeleton = await fileSkeleton(SAMPLE, 'js', ['createStyler']);
    expect(skeleton).toContain('return {open, close, openAll, closeAll, parent};');
    expect(skeleton).toContain('function applyStyle(self, string) ...');
    expect(skeleton).not.toContain('return string + self;');
  });

  it('matches whole words only: a symbol never matches a superstring identifier', async () => {
    const skeleton = await fileSkeleton(SAMPLE, 'js', ['apply']);
    expect(skeleton).not.toContain('return string + self;');
  });

  it('is unchanged with no keep symbols', async () => {
    expect(await fileSkeleton(SAMPLE, 'js', [])).toBe(await fileSkeleton(SAMPLE, 'js'));
  });
});

describe('enrichmentFor path matching', () => {
  const directives: SkeletonEnrichment[] = [{ path: 'source/index.js', symbols: ['createStyler'] }];

  it('matches exactly and on /-boundary suffix, never mid-segment', () => {
    expect(enrichmentFor('source/index.js', directives)?.symbols).toEqual(['createStyler']);
    expect(enrichmentFor('fixtures/repos/chalk/source/index.js', directives)?.symbols).toEqual([
      'createStyler',
    ]);
    expect(enrichmentFor('othersource/index.js', directives)).toBeUndefined();
    expect(enrichmentFor('source/index.jsx', directives)).toBeUndefined();
  });
});

describe('mirror enrichment', () => {
  it('an enriched entry carries full bodies, notes the symbols, and fingerprints the directive', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'redutok-enrich-mirror-'));
    writeFileSync(path.join(root, 'index.js'), SAMPLE);
    const enrichments: SkeletonEnrichment[] = [{ path: 'index.js', symbols: ['createStyler'] }];
    await refreshMirror(root, ['index.js'], { enrichments });
    const entry = readFileSync(mirrorEntryPath(root, 'index.js'), 'utf8');
    expect(entry).toContain('return {open, close, openAll, closeAll, parent};');
    expect(entry.split('\n', 1)[0]).toContain('full bodies of createStyler (learned)');
    expect(readMirrorIndex(root)?.files['index.js']?.enrichment).toBeDefined();

    // Same source, same directive: byte-stable (no rewrite).
    expect(await refreshMirror(root, ['index.js'], { enrichments })).toEqual([]);

    // Directive withdrawn: the unchanged source regenerates back to a plain skeleton.
    expect(await refreshMirror(root, ['index.js'])).toEqual(['index.js']);
    const plain = readFileSync(mirrorEntryPath(root, 'index.js'), 'utf8');
    expect(plain).not.toContain('return {open, close, openAll, closeAll, parent};');
    expect(readMirrorIndex(root)?.files['index.js']?.enrichment).toBeUndefined();
  });
});

describe('file-skeleton profile enrichment', () => {
  const profile = DistillProfileSchema.parse({
    name: 'file-skeleton',
    version: '1',
    rules: [{ kind: 'skeleton', config: { languages: ['js', 'ts'] } }],
  });

  it('keeps the queried symbols full-bodied in the distillate', async () => {
    const out = await runProfile(profile, SAMPLE, {
      filePath: 'source/index.js',
      keepSymbols: ['createStyler'],
    });
    expect(out).toContain('return {open, close, openAll, closeAll, parent};');
    expect(out).toContain('function applyStyle(self, string) ...');
  });
});

describe('codex learned section carry-over', () => {
  it('learned directives and graduated pitfalls survive a structural regeneration', async () => {
    const root = cloneFixtureRepo('repo-a');
    await writeCodex(root);
    const { codex } = readCodex(root);
    if (codex === undefined) throw new Error('codex missing');
    codex.learned.push({
      kind: 'skeleton-enrichment',
      candidate: 'cand-test1',
      path: 'src/store.ts',
      symbols: ['put'],
      confidence: 0.5,
      source: 'graduated',
      addedAt: '2026-07-29T00:00:00.000Z',
    });
    codex.pitfalls.push({
      text: 'sig — fix: edit src/store.ts',
      locked: false,
      source: 'graduated',
      candidate: 'cand-test2',
      confidence: 0.5,
    });
    writeFileSync(codexPaths(root).yaml, stringifyYaml(codex), 'utf8');
    writeFileSync(path.join(root, 'src', 'extra.ts'), 'export const EXTRA = 1;\n');
    await writeCodex(root);
    const after = readCodex(root).codex;
    expect(after?.learned).toHaveLength(1);
    expect(after?.learned[0]?.candidate).toBe('cand-test1');
    expect(after?.pitfalls.some((p) => p.candidate === 'cand-test2')).toBe(true);
    // The regenerated mirror honors the directive without a separate refresh.
    const entry = readFileSync(mirrorEntryPath(root, 'src/store.ts'), 'utf8');
    expect(entry.split('\n', 1)[0]).toContain('full bodies of put (learned)');
  });

  it('parses a pre-graduation codex.yaml with no learned section', () => {
    const parsed = CodexFileSchema.parse(
      parseYaml(stringifyYaml({ version: '1', project: 'x', generatedAt: '2026-07-29T00:00:00.000Z' })),
    );
    expect(parsed.learned).toEqual([]);
  });
});
