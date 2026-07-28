import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { sidecarRequest } from '../src/client.js';
import { startDaemon, type DaemonHandle } from '../src/daemon.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..', '..');
const profilesDir = path.join(repoRoot, 'profiles');

const dirs: string[] = [];
const daemons: DaemonHandle[] = [];

function makeRepo(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  mkdirSync(path.join(dir, '.dcp'), { recursive: true });
  return dir;
}

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function up(repo: string): Promise<DaemonHandle> {
  const daemon = await startDaemon({ port: 0, dcpDir: path.join(repo, '.dcp'), profilesDir });
  daemons.push(daemon);
  return daemon;
}

const auditText = (repo: string): string => {
  const file = path.join(repo, '.dcp', 'audit.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
};

describe('daemon cross-repo refusal (defense in depth)', () => {
  it('refuses a /serve-file whose repoRoot belongs to another repo, with an audited error', async () => {
    const repoA = makeRepo('redutok-iso-own-');
    const repoB = makeRepo('redutok-iso-other-');
    const daemon = await up(repoA);
    const res = await sidecarRequest(
      { port: daemon.port },
      'POST',
      '/serve-file',
      { raw: 'const x = 1;\n', path: 'src/x.ts', sessionId: 's-iso', repoRoot: repoB },
      { timeoutMs: 5000 },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.status).toBe(403);
    const body = res.body as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('cross-repo');
    expect(body.error).toContain(path.resolve(repoA));
    const audit = auditText(repoA);
    expect(audit).toContain('"action":"refuse"');
    expect(audit).toContain('cross-repo');
    // Refused means not served: no served-file record, no serve event.
    expect(audit).not.toContain('sidecar.serve');
  });

  it('refuses a cross-repo /zoom and audits it', async () => {
    const repoA = makeRepo('redutok-iso-own-');
    const repoB = makeRepo('redutok-iso-other-');
    const daemon = await up(repoA);
    const res = await sidecarRequest(
      { port: daemon.port },
      'POST',
      '/zoom',
      { id: 'a123456', repoRoot: repoB },
      { timeoutMs: 5000 },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toContain('cross-repo');
    expect(auditText(repoA)).toContain('"action":"refuse"');
  });

  it('serves same-repo requests carrying the daemon repoRoot, and legacy requests without one', async () => {
    const repoA = makeRepo('redutok-iso-own-');
    const daemon = await up(repoA);
    const withRoot = await sidecarRequest(
      { port: daemon.port },
      'POST',
      '/serve-file',
      { raw: 'const x = 1;\n', path: 'src/x.ts', sessionId: 's-iso', repoRoot: repoA },
      { timeoutMs: 5000 },
    );
    expect(withRoot.ok && withRoot.status === 200).toBe(true);
    const without = await sidecarRequest(
      { port: daemon.port },
      'POST',
      '/serve-file',
      { raw: 'const y = 2;\n', path: 'src/y.ts', sessionId: 's-iso' },
      { timeoutMs: 5000 },
    );
    expect(without.ok && without.status === 200).toBe(true);
  });
});
