import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readAuditFile } from '@redutok/shared';
import { startDaemon } from '@redutok/sidecar';
import { handlePreToolUse, type HookDeps } from '../src/handlers.js';
import {
  decideRewrite,
  loadAllowlist,
  parseAllowlist,
  SHIPPED_ALLOWLIST_YAML,
  shellQuote,
} from '../src/pipe-allowlist.js';

/**
 * Component 2 (v3 pillar A): the PreToolUse command rewrite. Allowlisted
 * read-only, log-producing commands are rewritten through redutok-pipe; side
 * effects, composition, and non-allowlisted commands are left alone; every
 * rewrite is recorded in the audit trail with the matched rule.
 */

const profilesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'profiles',
);

function tempDcp(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'redutok-rewrite-'));
}

describe('allowlist matching', () => {
  const list = parseAllowlist(SHIPPED_ALLOWLIST_YAML);

  it('rewrites the allowlisted read-only shapes with the matched rule', () => {
    const cases: [string, string][] = [
      ['pnpm run build', 'build'],
      ['tsc -p tsconfig.json', 'typecheck'],
      ['pnpm vitest run', 'test'],
      ['eslint .', 'lint'],
    ];
    for (const [command, rule] of cases) {
      const decision = decideRewrite(command, list);
      expect(decision?.rule).toBe(rule);
      expect(decision?.command).toBe(`redutok-pipe -c ${shellQuote(command)}`);
    }
  });

  it('never rewrites side effects, composition, non-allowlisted, or already-wrapped commands', () => {
    for (const command of [
      'pnpm build > out.txt', // redirection
      'pnpm build && rm -rf dist', // chain + delete
      'pnpm build | tee build.log', // pipe
      'pnpm install', // side effect
      'git commit -am wip', // VCS mutation
      'ls -la', // not allowlisted
      "redutok-pipe -c 'pnpm build'", // already wrapped
    ]) {
      expect(decideRewrite(command, list)).toBeUndefined();
    }
  });

  it('shell-quotes the wrapped command so the pipe receives it verbatim', () => {
    expect(shellQuote("pnpm run it's-fine")).toBe("'pnpm run it'\\''s-fine'");
  });
});

describe('loadAllowlist override', () => {
  it('uses a .dcp override when present and falls back to shipped defaults when malformed', () => {
    const dir = tempDcp();
    expect(loadAllowlist(dir).invoke).toBe('redutok-pipe');
    writeFileSync(
      path.join(dir, 'pipe-allowlist.yaml'),
      'version: 1\ninvoke: pnpm exec redutok-pipe\nallow:\n  - rule: build\n    pattern: \\bbuild\\b\ndeny: []\n',
    );
    const overridden = loadAllowlist(dir);
    expect(overridden.invoke).toBe('pnpm exec redutok-pipe');
    expect(decideRewrite('pnpm run build', overridden)?.command).toContain('pnpm exec redutok-pipe -c');
    // A malformed override must not disable the backstop.
    writeFileSync(path.join(dir, 'pipe-allowlist.yaml'), ': : not yaml : :\n  - [');
    expect(loadAllowlist(dir).invoke).toBe('redutok-pipe');
  });
});

describe('handlePreToolUse rewrite with a live sidecar', () => {
  it('rewrites in place and records the decision in the audit trail, but not when the sidecar is down', async () => {
    const dcpDir = tempDcp();
    writeFileSync(path.join(dcpDir, 'protocol.md'), '## Delta Context Protocol (Redutok)\nrules');
    const daemon = await startDaemon({ port: 0, dcpDir, profilesDir });
    try {
      const deps: HookDeps = { target: { port: daemon.port }, dcpDir, timeoutMs: 1000 };
      const out = await handlePreToolUse(
        { tool_name: 'Bash', tool_input: { command: 'pnpm run build' }, session_id: 's-rw' },
        deps,
      );
      expect(out.hookSpecificOutput?.permissionDecision).toBe('allow');
      const rewritten = (out.hookSpecificOutput?.updatedInput as { command: string }).command;
      expect(rewritten).toBe("redutok-pipe -c 'pnpm run build'");

      const audit = readAuditFile(path.join(dcpDir, 'audit.jsonl'), 's-rw');
      const rewrite = audit.events.find((e) => e.action === 'rewrite');
      expect(rewrite).toBeDefined();
      expect(rewrite?.details?.['rule']).toBe('build');
      expect(rewrite?.details?.['command']).toBe('pnpm run build');
    } finally {
      await daemon.close();
    }

    // Sidecar down: the command is left untouched (never rewrite blind).
    const down = await handlePreToolUse(
      { tool_name: 'Bash', tool_input: { command: 'pnpm run build' } },
      { target: { port: daemon.port }, dcpDir, timeoutMs: 100 },
    );
    expect(down).toEqual({});
  });
});
