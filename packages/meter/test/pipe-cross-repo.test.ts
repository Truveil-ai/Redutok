import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { startDaemon } from '@redutok/sidecar';
import { runPipe } from '../src/pipe.js';

/**
 * The 0.1.1 field failure mode: every install wrote the same sidecar port, so
 * a pipe in repo B reached repo A's daemon. /distill had no repo guard, so the
 * foreign daemon minted handles into its own store that repo B's /zoom was
 * then refused — a distilled tool result whose raw was unreachable. The pipe
 * now names its repo on /distill and the refusal fails open to raw output.
 */

const monorepoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const profilesDir = path.join(monorepoRoot, 'profiles');

describe('pipe against a daemon serving another repo', () => {
  it('serves raw, and the foreign store mints nothing', async () => {
    const foreignRoot = mkdtempSync(path.join(os.tmpdir(), 'redutok-pipe-foreign-'));
    const foreignDcp = path.join(foreignRoot, '.dcp');
    mkdirSync(foreignDcp);
    const ownRoot = mkdtempSync(path.join(os.tmpdir(), 'redutok-pipe-own-'));
    const daemon = await startDaemon({ port: 0, dcpDir: foreignDcp, profilesDir });
    try {
      const result = await runPipe('node -e "console.log(\'ok\'.repeat(4000))"', {
        target: { port: daemon.port },
        sessionId: 's-cross',
        repoRoot: ownRoot,
        cwd: ownRoot,
      });
      expect(result.served).toBe('raw');
      expect(result.exitCode).toBe(0);
      expect(result.handle).toBeUndefined();
      const auditFile = path.join(foreignDcp, 'audit.jsonl');
      const audit = existsSync(auditFile) ? readFileSync(auditFile, 'utf8') : '';
      expect(audit).not.toContain('"action": "distill"');
      expect(audit).not.toContain('"action":"distill"');
    } finally {
      await daemon.close();
    }
  });
});
