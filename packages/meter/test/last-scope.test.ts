import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { projectDirName, projectTranscriptDir } from '../src/claude-compat.js';
import { locateLastSessionLog } from '../src/report.js';

/**
 * `--last` used to mean "the newest transcript anywhere", so running
 * `redutok report --last` inside one project could report a session from a
 * different project entirely, silently and with no indication that it had.
 * It now means "the newest transcript of this project", and says so when
 * there is none rather than reaching for someone else's.
 */

/** A transcript root holding two projects, with the newer file in `other`. */
function twoProjectRoot(): { root: string; mine: string; other: string; mineLog: string; otherLog: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redutok-last-root-'));
  const mine = mkdtempSync(path.join(os.tmpdir(), 'redutok-proj-mine-'));
  const other = mkdtempSync(path.join(os.tmpdir(), 'redutok-proj-other-'));
  const write = (cwd: string, name: string, mtimeSeconds: number): string => {
    const dir = path.join(root, projectDirName(cwd));
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    writeFileSync(file, '');
    utimesSync(file, mtimeSeconds, mtimeSeconds);
    return file;
  };
  // The other project's session is deliberately the newest one on disk.
  const mineLog = write(mine, 'mine.jsonl', 1_000);
  const otherLog = write(other, 'other.jsonl', 9_000);
  return { root, mine, other, mineLog, otherLog };
}

describe('project directory naming', () => {
  // The path has to be absolute on the host platform: projectDirName
  // resolves before encoding, so a Windows-shaped path on Linux would be
  // resolved against the current directory and encode that prefix too.
  const win32 = process.platform === 'win32';
  const absolute = win32 ? 'C:\\Users\\k\\Desktop\\App' : '/users/k/Desktop/App';
  const encoded = win32 ? 'C--Users-k-Desktop-App' : '-users-k-Desktop-App';

  it('matches how Claude Code encodes a working directory', () => {
    // Every character outside [A-Za-z0-9] becomes a dash, verified against a
    // real transcript root of 64 project directories.
    expect(projectDirName(absolute)).toBe(encoded);
    expect(projectTranscriptDir(absolute, '/root')).toBe(path.join('/root', encoded));
  });

  it.runIf(win32)('encodes the observed win32 case exactly', () => {
    // "E:\Redutok - Token Optimisation" is stored as
    // "E--Redutok---Token-Optimisation" in the real root.
    expect(projectDirName('E:\\Redutok - Token Optimisation')).toBe('E--Redutok---Token-Optimisation');
  });
});

describe('--last is scoped to the current project', () => {
  it('returns this project session even when another project has a newer one', () => {
    const { root, mine, mineLog } = twoProjectRoot();
    expect(locateLastSessionLog({ root, cwd: mine })).toBe(mineLog);
  });

  it('returns the newest across every project when widened', () => {
    const { root, mine, otherLog } = twoProjectRoot();
    expect(locateLastSessionLog({ root, cwd: mine, allProjects: true })).toBe(otherLog);
  });

  it('finds nothing for a project with no sessions, rather than another project one', () => {
    const { root, otherLog } = twoProjectRoot();
    const empty = mkdtempSync(path.join(os.tmpdir(), 'redutok-proj-empty-'));
    expect(locateLastSessionLog({ root, cwd: empty })).toBeUndefined();
    // The widened scope still finds one, which is what makes the default a
    // scope decision rather than an empty root.
    expect(locateLastSessionLog({ root, cwd: empty, allProjects: true })).toBe(otherLog);
  });

  it('resolves from a subdirectory to the project that encloses it', () => {
    // Sessions are keyed to the directory claude was launched from, so
    // running redutok from packages/meter inside its own repo has to find
    // the repo's sessions rather than reporting none.
    const { root, mine, mineLog } = twoProjectRoot();
    const nested = path.join(mine, 'packages', 'meter');
    mkdirSync(nested, { recursive: true });
    expect(locateLastSessionLog({ root, cwd: nested })).toBe(mineLog);
  });

  it('picks the newest of several sessions within the project', () => {
    const { root, mine } = twoProjectRoot();
    const dir = path.join(root, projectDirName(mine));
    const newer = path.join(dir, 'newer.jsonl');
    writeFileSync(newer, '');
    utimesSync(newer, 5_000, 5_000);
    expect(locateLastSessionLog({ root, cwd: mine })).toBe(newer);
  });
});

describe('the CLI says so plainly when this project has no session', () => {
  const cwd = process.cwd();
  afterEach(() => {
    process.chdir(cwd);
    vi.restoreAllMocks();
  });

  it('report --last fails with the reason instead of another project report', async () => {
    // A fresh directory has no transcript directory at all under the real
    // root, which is exactly the case that used to silently report elsewhere.
    const empty = mkdtempSync(path.join(os.tmpdir(), 'redutok-cli-empty-'));
    process.chdir(empty);
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((msg: unknown) => {
      errors.push(String(msg));
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await main(['report', '--last'])).toBe(1);
    const text = errors.join('\n');
    expect(text).toContain('No transcript found for this project');
    expect(text).toContain(projectDirName(empty));
    expect(text).toContain('--all-projects');
    // Nothing was reported: no fallback to a foreign session.
    expect(log).not.toHaveBeenCalled();
  });

  it('badge --last fails the same way, on the same scope', async () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), 'redutok-cli-empty-badge-'));
    process.chdir(empty);
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((msg: unknown) => {
      errors.push(String(msg));
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await main(['badge', '--last'])).toBe(1);
    expect(errors.join('\n')).toContain('No transcript found for this project');
    expect(log).not.toHaveBeenCalled();
  });
});
