import { appendFileSync, cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import http from 'node:http';
import { stringify as stringifyYaml } from 'yaml';
import {
  NoopFrontierPolish,
  buildCodexInjection,
  codexPaths,
  ollamaGenerate,
  readCodex,
  refreshFiles,
  semanticPass,
  writeCodex,
} from '../src/codex.js';
import { estimateTokens } from '../src/distill.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..', '..');

function cloneFixtureRepo(name: string): string {
  const dst = mkdtempSync(path.join(os.tmpdir(), `redutok-codex-${name}-`));
  cpSync(path.join(repoRoot, 'fixtures', 'repos', name), dst, { recursive: true });
  return dst;
}

describe('structural codex on the pinned fixture repos', () => {
  it('produces a valid structural-only codex for repo-a with no LLM anywhere', async () => {
    const root = cloneFixtureRepo('repo-a');
    const result = await writeCodex(root);
    expect(result.changed).toBe(true);
    const { codex, lock } = readCodex(root);
    expect(codex?.files.map((f) => f.path)).toEqual([
      'src/service.ts',
      'src/store.ts',
      'test/service.test.ts',
    ]);
    expect(codex?.interfaces.some((i) => i.name === 'totalValue')).toBe(true);
    expect(codex?.importGraph['src/service.ts']).toEqual(['./store.js']);
    expect(codex?.map.find((m) => m.path === 'src')?.role).toBe('implementation');
    expect(lock?.files['src/store.ts']).toMatch(/^[0-9a-f]{16}$/);
  });

  it('indexes python and js in repo-b', async () => {
    const root = cloneFixtureRepo('repo-b');
    await writeCodex(root);
    const { codex } = readCodex(root);
    expect(codex?.interfaces.some((i) => i.name === 'tokenize')).toBe(true);
    expect(codex?.interfaces.some((i) => i.name === 'formatCounts')).toBe(true);
  });

  it('is byte-stable across re-runs on unchanged input', async () => {
    const root = cloneFixtureRepo('repo-a');
    await writeCodex(root);
    const paths = codexPaths(root);
    const yaml1 = readFileSync(paths.yaml, 'utf8');
    const lock1 = readFileSync(paths.lock, 'utf8');
    const second = await writeCodex(root);
    expect(second.changed).toBe(false);
    expect(readFileSync(paths.yaml, 'utf8')).toBe(yaml1);
    expect(readFileSync(paths.lock, 'utf8')).toBe(lock1);
  });
});

describe('hash drift and incremental refresh', () => {
  it('re-indexes exactly the changed files', async () => {
    const root = cloneFixtureRepo('repo-a');
    await writeCodex(root);
    const lockBefore = readCodex(root).lock;
    appendFileSync(path.join(root, 'src', 'store.ts'), '\nexport const STORE_VERSION = 2;\n');
    const reindexed = await refreshFiles(root, ['src/store.ts', 'src/service.ts']);
    expect(reindexed).toEqual(['src/store.ts']);
    const { codex, lock } = readCodex(root);
    expect(lock?.files['src/store.ts']).not.toBe(lockBefore?.files['src/store.ts']);
    expect(lock?.files['src/service.ts']).toBe(lockBefore?.files['src/service.ts']);
    expect(lock?.files['test/service.test.ts']).toBe(lockBefore?.files['test/service.test.ts']);
    expect(codex?.interfaces.some((i) => i.name === 'STORE_VERSION')).toBe(true);
  });
});

describe('locked entries', () => {
  it('survive both the structural and semantic passes untouched', async () => {
    const root = cloneFixtureRepo('repo-a');
    await writeCodex(root);
    const { codex } = readCodex(root);
    if (codex === undefined) throw new Error('codex missing');
    codex.pitfalls.push({ text: 'never call put during iteration', locked: true });
    codex.glossary.push({ term: 'row', means: 'one keyed value', locked: false });
    const srcEntry = codex.map.find((m) => m.path === 'src');
    if (srcEntry !== undefined) {
      srcEntry.role = 'hand written role';
      srcEntry.roleSource = 'human';
      srcEntry.locked = true;
    }
    writeFileSync(codexPaths(root).yaml, stringifyYaml(codex), 'utf8');
    appendFileSync(path.join(root, 'src', 'service.ts'), '\nexport const X = 1;\n');
    await writeCodex(root);
    await semanticPass(root, { baseUrl: 'http://127.0.0.1:1', timeoutMs: 100 });
    const after = readCodex(root).codex;
    expect(after?.pitfalls).toEqual([{ text: 'never call put during iteration', locked: true }]);
    expect(after?.glossary[0]?.term).toBe('row');
    expect(after?.map.find((m) => m.path === 'src')?.role).toBe('hand written role');
  });
});

describe('semantic pass against a stub server', () => {
  it('drafts roles with the llm, resumable and timeout-safe', async () => {
    const root = cloneFixtureRepo('repo-a');
    await writeCodex(root);
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ response: 'stub role for the module' }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const updated = await semanticPass(root, { baseUrl: `http://127.0.0.1:${port}` });
      expect(updated).toBeGreaterThan(0);
      const { codex } = readCodex(root);
      expect(codex?.map.every((m) => m.roleSource === 'llm')).toBe(true);
      // Resumable: a second pass has nothing left to do.
      expect(await semanticPass(root, { baseUrl: `http://127.0.0.1:${port}` })).toBe(0);
    } finally {
      server.close();
    }
  });

  it('falls back to rule roles when the server is unreachable', async () => {
    const root = cloneFixtureRepo('repo-a');
    await writeCodex(root);
    const updated = await semanticPass(root, { baseUrl: 'http://127.0.0.1:1', timeoutMs: 200 });
    expect(updated).toBe(0);
    expect(readCodex(root).codex?.map.every((m) => m.roleSource === 'rules')).toBe(true);
  });
});

const ollamaLive = await (async () => {
  const probe = await ollamaGenerate('http://127.0.0.1:11434', 'qwen2.5:7b-instruct', 'say ok', 1500);
  return probe !== null;
})();

describe.runIf(ollamaLive)('semantic pass against live Ollama', () => {
  it('drafts at least one role from the real local model', async () => {
    const root = cloneFixtureRepo('repo-a');
    await writeCodex(root);
    const updated = await semanticPass(root, {});
    expect(updated).toBeGreaterThan(0);
  }, 60_000);
});

describe('injection', () => {
  it('injects codex minus the files index with the trust preamble, under budget', async () => {
    for (const name of ['repo-a', 'repo-b']) {
      const root = cloneFixtureRepo(name);
      await writeCodex(root);
      const { codex } = readCodex(root);
      if (codex === undefined) throw new Error('codex missing');
      const injection = buildCodexInjection(codex);
      expect(injection).toContain('You have a verified codex of this repository. Trust it.');
      expect(injection).not.toContain('files:');
      expect(estimateTokens(injection)).toBeLessThan(3000);
    }
  });

  it('degrades by dropping documented sections, never truncating mid-entry', async () => {
    const root = cloneFixtureRepo('repo-a');
    await writeCodex(root);
    const { codex } = readCodex(root);
    if (codex === undefined) throw new Error('codex missing');
    codex.glossary = Array.from({ length: 200 }, (_, i) => ({
      term: `term${i}`,
      means: 'a long meaning string to inflate the payload well past the budget line',
      locked: false,
    }));
    const injection = buildCodexInjection(codex, 500);
    expect(injection).toContain('sections dropped to fit the budget');
    expect(injection).not.toContain('term199');
    expect(estimateTokens(injection)).toBeLessThan(3000);
  });

  it('stays under 3000 estimated tokens on this repository (acceptance)', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'redutok-codex-self-'));
    cpSync(path.join(repoRoot, 'packages'), path.join(root, 'packages'), {
      recursive: true,
      filter: (src) => !/node_modules|dist/.test(src),
    });
    cpSync(path.join(repoRoot, 'scripts'), path.join(root, 'scripts'), { recursive: true });
    await writeCodex(root);
    const { codex } = readCodex(root);
    if (codex === undefined) throw new Error('codex missing');
    const injection = buildCodexInjection(codex);
    expect(estimateTokens(injection)).toBeLessThan(3000);
  }, 120_000);
});

describe('frontier polish seam', () => {
  it('is a typed no-op', async () => {
    const root = cloneFixtureRepo('repo-a');
    await writeCodex(root);
    const { codex } = readCodex(root);
    if (codex === undefined) throw new Error('codex missing');
    expect(await new NoopFrontierPolish().polish(codex)).toBeNull();
  });
});
