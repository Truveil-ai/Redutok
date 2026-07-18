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

describe('incremental maintenance through the daemon notify path', () => {
  it('a PostToolUse file-change notify re-indexes exactly the changed file', async () => {
    const { startDaemon } = await import('../src/daemon.js');
    const { sidecarRequest } = await import('../src/client.js');
    const root = cloneFixtureRepo('repo-a');
    await writeCodex(root);
    const lockBefore = readCodex(root).lock;
    const daemon = await startDaemon({ port: 0, dcpDir: path.join(root, '.dcp') });
    try {
      appendFileSync(path.join(root, 'src', 'store.ts'), '\nexport const NOTIFIED = true;\n');
      const res = await sidecarRequest(
        { port: daemon.port },
        'POST',
        '/notify',
        { kind: 'file-change', tool: 'Edit', path: 'src/store.ts' },
        { timeoutMs: 10_000 },
      );
      expect(res.ok).toBe(true);
      if (res.ok) expect((res.body as { reindexed: string[] }).reindexed).toEqual(['src/store.ts']);
      const lockAfter = readCodex(root).lock;
      expect(lockAfter?.files['src/store.ts']).not.toBe(lockBefore?.files['src/store.ts']);
      expect(lockAfter?.files['src/service.ts']).toBe(lockBefore?.files['src/service.ts']);
    } finally {
      await daemon.close();
    }
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
  it('drafts roles, reports counts, audits the pass, and resumes to nothing-to-draft', async () => {
    const root = cloneFixtureRepo('repo-a');
    await writeCodex(root);
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ response: 'stub role for the module' }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const outcome = await semanticPass(root, { baseUrl: `http://127.0.0.1:${port}` });
      expect(outcome.status).toBe('complete');
      expect(outcome.drafted).toBeGreaterThan(0);
      expect(outcome.failed).toBe(0);
      const { codex } = readCodex(root);
      expect(codex?.map.every((m) => m.roleSource === 'llm')).toBe(true);
      const { readAuditFile } = await import('@redutok/shared');
      const events = readAuditFile(path.join(root, '.dcp', 'audit.jsonl')).events;
      const pass = events.find((e) => e.module === 'sidecar.codex-semantic');
      expect(pass?.details?.['drafted']).toBe(outcome.drafted);
      expect(pass?.details?.['failed']).toBe(0);
      // Resumable: a second pass has nothing left to do.
      const again = await semanticPass(root, { baseUrl: `http://127.0.0.1:${port}` });
      expect(again.status).toBe('nothing-to-draft');
    } finally {
      server.close();
    }
  });

  it('absorbs a cold model load in the warmup, keeping the 2500ms drafting budget', async () => {
    const root = cloneFixtureRepo('repo-a');
    await writeCodex(root);
    let first = true;
    const server = http.createServer((req, res) => {
      const delay = first ? 4000 : 50;
      first = false;
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ response: 'warmed role' }));
      }, delay);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const outcome = await semanticPass(root, {
        baseUrl: `http://127.0.0.1:${port}`,
        timeoutMs: 2500,
        warmupTimeoutMs: 20_000,
      });
      expect(outcome.status).toBe('complete');
      expect(outcome.drafted).toBeGreaterThan(0);
      expect(outcome.failed).toBe(0);
    } finally {
      server.close();
    }
  }, 60_000);

  it('reports unreachable with the endpoint when the warmup fails, roles untouched', async () => {
    const root = cloneFixtureRepo('repo-a');
    await writeCodex(root);
    const outcome = await semanticPass(root, {
      baseUrl: 'http://127.0.0.1:1',
      timeoutMs: 200,
      warmupTimeoutMs: 300,
    });
    expect(outcome.status).toBe('unreachable');
    expect(outcome.endpoint).toContain('127.0.0.1:1');
    expect(outcome.drafted).toBe(0);
    expect(readCodex(root).codex?.map.every((m) => m.roleSource === 'rules')).toBe(true);
  });
});

// Reachability probe only: /api/tags answers instantly even when the model
// is cold; semanticPass itself owns the warmup.
const ollamaLive = await new Promise<boolean>((resolve) => {
  const req = http.get('http://127.0.0.1:11434/api/tags', { timeout: 1500 }, (res) => {
    res.resume();
    resolve(res.statusCode === 200);
  });
  req.on('error', () => resolve(false));
  req.on('timeout', () => {
    req.destroy();
    resolve(false);
  });
});

describe.runIf(ollamaLive)('semantic pass against live Ollama', () => {
  it('drafts at least one role from the real local model', async () => {
    const root = cloneFixtureRepo('repo-a');
    await writeCodex(root);
    // Same budget the CLI's offline batch path uses; see limits.ts rationale.
    const { LIMITS } = await import('@redutok/shared');
    const outcome = await semanticPass(root, { timeoutMs: LIMITS.SEMANTIC_BATCH_DRAFT_TIMEOUT_MS });
    expect(outcome.status).toBe('complete');
    expect(outcome.drafted).toBeGreaterThan(0);
    expect(outcome.failed).toBe(0);
  }, 300_000);
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
