import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIMITS } from '@redutok/shared';
import { discoverPort, main, runPipe, selectProfile } from '../src/pipe.js';

/**
 * Component 1 (v3 pillar A): the redutok-pipe distiller binary. The pipe runs a
 * command, captures its output, distills it through the sidecar's /distill, and
 * preserves the exit code exactly. Every failure mode fails open to raw.
 */

// A throwaway command that writes to both streams and exits non-zero, so the
// exit-code-preservation and byte-equal-passthrough assertions are meaningful.
// A script file (not `node -e`) keeps it free of cross-shell quoting hazards.
function failingCommand(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'redutok-pipe-'));
  const script = path.join(dir, 'emit.mjs');
  writeFileSync(
    script,
    "process.stdout.write('line one\\nline two\\n'); process.stderr.write('a warning\\n'); process.exit(3);\n",
  );
  return `node "${script}"`;
}

const DEAD_TARGET = { port: 1 };

describe('selectProfile', () => {
  it('routes build, test, and everything-else output to the matching profile', () => {
    expect(selectProfile('pnpm run build')).toBe('build-log');
    expect(selectProfile('tsc -p tsconfig.json')).toBe('build-log');
    expect(selectProfile('pnpm vitest run')).toBe('test-output');
    expect(selectProfile('jest --ci')).toBe('test-output');
    expect(selectProfile('eslint .')).toBe('generic-stdout');
    expect(selectProfile('git status')).toBe('generic-stdout');
  });
});

describe('runPipe fail-open passthrough', () => {
  it('serves raw byte-for-byte and preserves the exit code when the sidecar is dead', async () => {
    const command = failingCommand();
    const vanilla = spawnSync(command, { shell: true });
    const result = await runPipe(command, { target: DEAD_TARGET, timeoutMs: 200 });
    expect(result.served).toBe('raw');
    expect(result.exitCode).toBe(vanilla.status);
    expect(result.exitCode).toBe(3);
    expect(result.stdout.equals(vanilla.stdout)).toBe(true);
    expect(result.stderr.equals(vanilla.stderr)).toBe(true);
    expect(result.raw).toBe(vanilla.stdout.toString('utf8') + vanilla.stderr.toString('utf8'));
    expect(result.profile).toBe('generic-stdout');
  });
});

describe('runPipe distilled path against a stub sidecar', () => {
  let server: http.Server;
  let port: number;
  const seen: { raw?: string; profile?: string; sessionId?: string; tool?: string } = {};

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/distill') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, string>;
          seen.raw = body['raw'];
          seen.profile = body['profile'];
          seen.sessionId = body['sessionId'];
          seen.tool = body['tool'];
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              served: 'distilled',
              text: 'build: FAILED\n  first error: emit.mjs(1,1): error TS1109',
              handle: '[dcp:artifact ab1234, raw 400 tok to 20 tok, zoom: dcp__zoom("ab1234", query?)]',
              artifactId: 'ab1234',
            }),
          );
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('emits the distilled verdict and handle, still preserving the exit code', async () => {
    const command = failingCommand();
    const result = await runPipe(command, { target: { port }, sessionId: 's-pipe' });
    expect(result.served).toBe('distilled');
    expect(result.exitCode).toBe(3);
    expect(result.distilledText).toContain('build: FAILED');
    expect(result.handle).toContain('dcp__zoom("ab1234"');
    // The pipe forwards exactly what dcp__run would: combined raw + the picked
    // profile + a session fallback + its own tool tag.
    expect(seen.raw).toBe('line one\nline two\na warning\n');
    expect(seen.profile).toBe('generic-stdout');
    expect(seen.sessionId).toBe('s-pipe');
    expect(seen.tool).toBe('redutok-pipe');
  });

  it('treats a served:raw response (gate failure) as fail-open and replays raw', async () => {
    // Repoint at a server that always answers served:raw.
    const rawServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ served: 'raw', text: 'ignored', handle: '[dcp:...]' }));
      });
    });
    await new Promise<void>((resolve) => rawServer.listen(0, '127.0.0.1', resolve));
    const rawPort = (rawServer.address() as { port: number }).port;
    try {
      const command = failingCommand();
      const vanilla = spawnSync(command, { shell: true });
      const result = await runPipe(command, { target: { port: rawPort } });
      expect(result.served).toBe('raw');
      expect(result.distilledText).toBeUndefined();
      expect(result.stdout.equals(vanilla.stdout)).toBe(true);
      expect(result.exitCode).toBe(3);
    } finally {
      await new Promise<void>((resolve) => rawServer.close(() => resolve()));
    }
  });
});

describe('discoverPort', () => {
  it('prefers the pidfile port over config.json over the default', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'redutok-pipe-port-'));
    expect(discoverPort(dir)).toBe(48642);
    writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port: 50000 }));
    expect(discoverPort(dir)).toBe(50000);
    writeFileSync(path.join(dir, 'sidecar.pid.json'), JSON.stringify({ pid: 1, port: 50123 }));
    expect(discoverPort(dir)).toBe(50123);
  });
});

describe('main', () => {
  it('returns a usage exit code when no command is given', async () => {
    expect(await main([])).toBe(2);
  });

  it('exposes the sidecar timeout as a limit', () => {
    expect(LIMITS.PIPE_SIDECAR_TIMEOUT_MS).toBeGreaterThan(LIMITS.LOCAL_LLM_TIMEOUT_MS);
  });
});
