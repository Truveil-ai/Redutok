import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { doctor, renderDoctor } from '../src/doctor.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('redutok doctor', () => {
  it('reports simulated failures with warns and remedies on a bare directory', async () => {
    const bare = mkdtempSync(path.join(os.tmpdir(), 'redutok-doctor-'));
    const checks = await doctor(bare, { ollamaBaseUrl: 'http://127.0.0.1:1', skipPnpm: true });
    const byName = new Map(checks.map((c) => [c.name, c]));
    expect(byName.get('node')?.status).toBe('pass');
    expect(byName.get('sidecar')?.status).toBe('warn');
    expect(byName.get('sidecar')?.remedy).toBe('redutok up');
    expect(byName.get('ollama')?.status).toBe('warn');
    expect(byName.get('hooks')?.status).toBe('warn');
    expect(byName.get('hooks')?.remedy).toBe('redutok init .');
    expect(byName.get('codex')?.status).toBe('warn');
    expect(byName.get('config')?.status).toBe('warn');
    const text = renderDoctor(checks);
    expect(text).toMatch(/WARN\s+sidecar/);
    expect(text).toMatch(/\d+ checks: \d+ pass, \d+ warn, \d+ fail\./);
  }, 60_000);

  it('passes tree-sitter and codex freshness on this repository', async () => {
    const checks = await doctor(repoRoot, { ollamaBaseUrl: 'http://127.0.0.1:1', skipPnpm: true });
    const byName = new Map(checks.map((c) => [c.name, c]));
    expect(byName.get('tree-sitter')?.status).toBe('pass');
    expect(['pass', 'warn']).toContain(byName.get('codex')?.status);
    expect(byName.get('hooks')?.status).toBe('pass');
    expect(byName.get('config')?.status).toBe('pass');
  }, 120_000);
});
