import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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

  it('reports registered hooks as pass', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'redutok-doctor-'));
    mkdirSync(path.join(dir, '.claude'));
    writeFileSync(
      path.join(dir, '.claude', 'settings.local.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'node .dcp/redutok/hook.mjs' }] }] } }),
    );
    const checks = await doctor(dir, { ollamaBaseUrl: 'http://127.0.0.1:1', skipPnpm: true });
    const byName = new Map(checks.map((c) => [c.name, c]));
    expect(byName.get('hooks')?.status).toBe('pass');
  }, 60_000);

  it('passes tree-sitter and codex freshness on this repository', async () => {
    const checks = await doctor(repoRoot, { ollamaBaseUrl: 'http://127.0.0.1:1', skipPnpm: true });
    const byName = new Map(checks.map((c) => [c.name, c]));
    expect(byName.get('tree-sitter')?.status).toBe('pass');
    expect(['pass', 'warn']).toContain(byName.get('codex')?.status);
    // Hook registration lives in .claude/settings.local.json, which is
    // machine-local and untracked: 'pass' on an initialized working copy,
    // 'warn' on a fresh checkout (CI). The detection logic itself is covered
    // hermetically by the tests above.
    expect(['pass', 'warn']).toContain(byName.get('hooks')?.status);
    // .dcp/config.json is gitignored (written by `redutok init`), so a fresh
    // checkout legitimately reports 'warn'. 'fail' means a config.json exists
    // but is invalid — that is the regression this guards against.
    expect(byName.get('config')?.status).not.toBe('fail');
  }, 120_000);
});
