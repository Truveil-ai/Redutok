import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function distFiles(): string[] {
  const out: string[] = [];
  for (const pkg of readdirSync(path.join(repoRoot, 'packages'))) {
    const dist = path.join(repoRoot, 'packages', pkg, 'dist');
    try {
      for (const f of readdirSync(dist).filter((f) => f.endsWith('.js'))) out.push(path.join(dist, f));
    } catch {
      continue;
    }
  }
  return out;
}

describe('no telemetry, no non-local network (static scan of built output)', () => {
  it('built code contains no fetch, https module, or telemetry endpoints', () => {
    const files = distFiles();
    expect(files.length).toBeGreaterThan(20);
    for (const file of files) {
      const code = readFileSync(file, 'utf8');
      const name = path.relative(repoRoot, file);
      expect(code, `${name} uses fetch`).not.toMatch(/\bfetch\s*\(/);
      expect(code, `${name} imports https`).not.toContain("'node:https'");
      for (const marker of ['api.anthropic', 'telemetry', 'sentry', 'posthog', 'analytics.']) {
        expect(code.toLowerCase(), `${name} references ${marker}`).not.toContain(marker);
      }
    }
  });

  it('every file using http.request is localhost-only by construction', () => {
    for (const file of distFiles()) {
      const code = readFileSync(file, 'utf8');
      if (!code.includes('.request(')) continue;
      const name = path.relative(repoRoot, file);
      expect(
        code.includes('127.0.0.1') || code.includes('localhost') || code.includes('socketPath'),
        `${name} makes http requests without a localhost default`,
      ).toBe(true);
    }
  });
});
