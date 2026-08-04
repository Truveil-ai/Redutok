import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LIMITS, type SessionPosture } from '@redutok/shared';
import { startDaemon, mirrorEntryPath, writeCodex } from '@redutok/sidecar';
import { handlePreToolUse, SMALL_READ_BYTES, LARGE_READ_BYTES, type HookDeps } from '../src/handlers.js';

/**
 * The artifact-size escape hatch (docs/POSTURE.md). Posture sets the
 * session's default engagement; it must never veto an individual oversized
 * artifact. The field case: a documents repo assessed light at 81 files read
 * a 263KB Markdown, a 186KB Markdown and a 1.2MB PDF entirely raw and the
 * session recorded two audit events.
 *
 * The contract pinned here, per posture: an artifact at or above
 * GOVERN_ANY_ARTIFACT_BYTES engages in every posture including idle, and
 * everything below it in idle stays genuinely vanilla so the idle worst case
 * is unchanged.
 */

const SESSION = 's-posture';
const monorepoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const profilesDir = path.join(monorepoRoot, 'profiles');

/**
 * A source file of at least `bytes`: signatures over real bodies, so the
 * skeleton is a small fraction of the raw and passes the size gate the way
 * ordinary code does. An all-signatures file would be refused by that gate,
 * correctly, and would prove nothing about posture.
 */
function sourceOfSize(bytes: number): string {
  const block = `/** Applies step $N of the pipeline. */
export function step$N(input: string, scale: number): string {
  const parts = input.split(',').map((p) => p.trim()).filter((p) => p !== '');
  const scaled = parts.map((p) => p.repeat(Math.max(1, scale % 3)));
  const joined = scaled.join('|');
  if (joined.length === 0) {
    return 'empty-$N';
  }
  let total = 0;
  for (const ch of joined) {
    total += ch.charCodeAt(0) % 7;
  }
  return joined.slice(0, 40) + ':' + String(total);
}
`;
  let out = '';
  let n = 0;
  while (Buffer.byteLength(out, 'utf8') < bytes) {
    out += block.replace(/\$N/g, String(n));
    n += 1;
  }
  return out;
}

interface Repo {
  root: string;
  dcpDir: string;
  huge: string;
  mid: string;
  tiny: string;
}

/** A repo with a built codex and mirror, holding one artifact of each size class. */
async function repoWithMirror(prefix: string): Promise<Repo> {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  mkdirSync(path.join(root, 'src'));
  const huge = path.join(root, 'src', 'huge.ts');
  const mid = path.join(root, 'src', 'mid.ts');
  const tiny = path.join(root, 'src', 'tiny.ts');
  writeFileSync(huge, sourceOfSize(LIMITS.GOVERN_ANY_ARTIFACT_BYTES + 4_096));
  writeFileSync(mid, sourceOfSize(LARGE_READ_BYTES + 4_096));
  writeFileSync(tiny, 'export const tiny = 1;\n');
  await writeCodex(root);
  const dcpDir = path.join(root, '.dcp');
  writeFileSync(path.join(dcpDir, 'protocol.md'), '## Delta Context Protocol (Redutok)\nrules');
  return { root, dcpDir, huge, mid, tiny };
}

function pinPosture(dcpDir: string, posture: SessionPosture): void {
  writeFileSync(
    path.join(dcpDir, 'session-posture.json'),
    JSON.stringify({
      sessionId: SESSION,
      posture,
      pinned: true,
      files: 81,
      sourceBytes: 1_103_982,
      learnedEntries: 0,
      pitfallEntries: 0,
      capped: false,
      decidedAt: new Date().toISOString(),
    }),
  );
}

const read = (deps: HookDeps, filePath: string) =>
  handlePreToolUse({ tool_name: 'Read', tool_input: { file_path: filePath }, session_id: SESSION }, deps);

describe('artifact size escapes the posture veto', () => {
  it.each<SessionPosture>(['idle', 'light', 'full'])(
    'an artifact at or above the threshold engages in %s posture',
    async (posture) => {
      const repo = await repoWithMirror(`redutok-escape-${posture}-`);
      const daemon = await startDaemon({ port: 0, dcpDir: repo.dcpDir });
      try {
        pinPosture(repo.dcpDir, posture);
        const deps: HookDeps = { target: { port: daemon.port }, dcpDir: repo.dcpDir, timeoutMs: 2000 };
        const out = await read(deps, repo.huge);
        expect(out.hookSpecificOutput?.permissionDecision, `${posture} must govern an oversized artifact`).toBe('allow');
        expect((out.hookSpecificOutput?.updatedInput as { file_path: string }).file_path).toBe(
          mirrorEntryPath(repo.root, 'src/huge.ts'),
        );
      } finally {
        await daemon.close();
      }
    },
  );

  it.each<SessionPosture>(['idle', 'light', 'full'])(
    'a small artifact is untouched in %s posture',
    async (posture) => {
      const repo = await repoWithMirror(`redutok-escape-small-${posture}-`);
      const daemon = await startDaemon({ port: 0, dcpDir: repo.dcpDir });
      try {
        pinPosture(repo.dcpDir, posture);
        const deps: HookDeps = { target: { port: daemon.port }, dcpDir: repo.dcpDir, timeoutMs: 2000 };
        expect(await read(deps, repo.tiny)).toEqual({});
      } finally {
        await daemon.close();
      }
    },
  );

  it('idle stays genuinely idle between the large and escape-hatch thresholds', async () => {
    const repo = await repoWithMirror('redutok-escape-mid-');
    const daemon = await startDaemon({ port: 0, dcpDir: repo.dcpDir });
    try {
      const deps: HookDeps = { target: { port: daemon.port }, dcpDir: repo.dcpDir, timeoutMs: 2000 };
      // Above LARGE_READ_BYTES, below GOVERN_ANY_ARTIFACT_BYTES: engaged
      // postures govern it, idle leaves the session vanilla.
      pinPosture(repo.dcpDir, 'idle');
      expect(await read(deps, repo.mid)).toEqual({});

      pinPosture(repo.dcpDir, 'light');
      const light = await read(deps, repo.mid);
      expect(light.hookSpecificOutput?.permissionDecision).toBe('allow');
      expect((light.hookSpecificOutput?.updatedInput as { file_path: string }).file_path).toBe(
        mirrorEntryPath(repo.root, 'src/mid.ts'),
      );
    } finally {
      await daemon.close();
    }
  });

  it('the thresholds stand in a documented order', () => {
    expect(SMALL_READ_BYTES).toBeLessThan(LARGE_READ_BYTES);
    expect(LARGE_READ_BYTES).toBeLessThan(LIMITS.GOVERN_ANY_ARTIFACT_BYTES);
  });
});

describe('an oversized artifact with no mirror entry is prepared on demand', () => {
  it('engages in idle posture, where nothing was ever indexed', async () => {
    // The idle worst case is a repo with no codex at all: the escape hatch
    // has to reach a skeleton that does not exist yet, or "engages regardless
    // of posture" is a promise the mirror silently declines to keep.
    const root = mkdtempSync(path.join(os.tmpdir(), 'redutok-escape-ondemand-'));
    mkdirSync(path.join(root, 'src'));
    const huge = path.join(root, 'src', 'huge.ts');
    writeFileSync(huge, sourceOfSize(LIMITS.GOVERN_ANY_ARTIFACT_BYTES + 4_096));
    const dcpDir = path.join(root, '.dcp');
    mkdirSync(dcpDir);
    writeFileSync(path.join(dcpDir, 'protocol.md'), '## Delta Context Protocol (Redutok)\nrules');
    const daemon = await startDaemon({ port: 0, dcpDir, profilesDir });
    try {
      pinPosture(dcpDir, 'idle');
      const deps: HookDeps = { target: { port: daemon.port }, dcpDir, timeoutMs: 5000 };
      const out = await read(deps, huge);
      expect(out.hookSpecificOutput?.permissionDecision).toBe('allow');
      expect((out.hookSpecificOutput?.updatedInput as { file_path: string }).file_path).toBe(
        mirrorEntryPath(root, 'src/huge.ts'),
      );
    } finally {
      await daemon.close();
    }
  });
});
