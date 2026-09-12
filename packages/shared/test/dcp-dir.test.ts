import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDcpDir } from '../src/dcp-dir.js';

/**
 * Hooks and the pipe run in whatever directory the session's shell is in, and
 * a Bash `cd sources` moves it. Resolving .dcp from process.cwd() alone sent
 * every hook after such a cd to a directory with no .dcp, so the session ran
 * ungoverned (field defect, ResponsibleAI, 0.1.7).
 */
function project(): { root: string; sub: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redutok-dcpdir-'));
  mkdirSync(path.join(root, '.dcp'));
  const sub = path.join(root, 'deploy', 'assets', 'reports');
  mkdirSync(sub, { recursive: true });
  return { root, sub };
}

describe('resolveDcpDir', () => {
  it('honours an explicit REDUTOK_DCP_DIR above everything', () => {
    const { sub } = project();
    expect(resolveDcpDir({ env: { REDUTOK_DCP_DIR: '/elsewhere/.dcp' }, cwd: sub })).toBe('/elsewhere/.dcp');
  });

  it('uses the Claude Code project directory when the shell has cd-ed below it', () => {
    const { root, sub } = project();
    const env = { CLAUDE_PROJECT_DIR: root.replace(/\\/g, '/') };
    expect(path.resolve(resolveDcpDir({ env, cwd: sub }))).toBe(path.join(root, '.dcp'));
  });

  it('walks up from a subdirectory to the nearest .dcp when no project directory is given', () => {
    const { root, sub } = project();
    expect(resolveDcpDir({ env: {}, cwd: sub })).toBe(path.join(root, '.dcp'));
  });

  it('falls back to cwd/.dcp when nothing above has one', () => {
    const bare = mkdtempSync(path.join(os.tmpdir(), 'redutok-dcpdir-bare-'));
    expect(resolveDcpDir({ env: {}, cwd: bare })).toBe(path.join(bare, '.dcp'));
  });
});
