import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SIDECAR_PORT, resolveSidecarPort } from '../src/config.js';

const dirs: string[] = [];
function makeRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'redutok-mcp-config-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('resolveSidecarPort', () => {
  it('reads the port from the repo .dcp/config.json', () => {
    const repo = makeRepo();
    mkdirSync(path.join(repo, '.dcp'));
    writeFileSync(path.join(repo, '.dcp', 'config.json'), JSON.stringify({ port: 51001 }), 'utf8');
    expect(resolveSidecarPort({}, repo)).toBe(51001);
  });

  it('treats REDUTOK_PORT as an explicit override beating the config', () => {
    const repo = makeRepo();
    mkdirSync(path.join(repo, '.dcp'));
    writeFileSync(path.join(repo, '.dcp', 'config.json'), JSON.stringify({ port: 51001 }), 'utf8');
    expect(resolveSidecarPort({ REDUTOK_PORT: '51002' }, repo)).toBe(51002);
  });

  it('honours REDUTOK_DCP_DIR when the state directory is not .dcp', () => {
    const repo = makeRepo();
    mkdirSync(path.join(repo, 'state'));
    writeFileSync(path.join(repo, 'state', 'config.json'), JSON.stringify({ port: 51003 }), 'utf8');
    expect(resolveSidecarPort({ REDUTOK_DCP_DIR: 'state' }, repo)).toBe(51003);
  });

  it('falls back to the default port when there is no config', () => {
    expect(resolveSidecarPort({}, makeRepo())).toBe(DEFAULT_SIDECAR_PORT);
  });

  it('ignores an unreadable config and an empty or garbage REDUTOK_PORT', () => {
    const repo = makeRepo();
    mkdirSync(path.join(repo, '.dcp'));
    writeFileSync(path.join(repo, '.dcp', 'config.json'), 'not json', 'utf8');
    expect(resolveSidecarPort({}, repo)).toBe(DEFAULT_SIDECAR_PORT);
    expect(resolveSidecarPort({ REDUTOK_PORT: '' }, repo)).toBe(DEFAULT_SIDECAR_PORT);
    expect(resolveSidecarPort({ REDUTOK_PORT: 'abc' }, repo)).toBe(DEFAULT_SIDECAR_PORT);
  });
});
