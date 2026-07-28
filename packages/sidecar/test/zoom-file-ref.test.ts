import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditWriter } from '../src/audit.js';
import { distillArtifact, loadProfiles, zoom } from '../src/distill.js';
import { serveFile } from '../src/serve.js';
import { openStore, type Store } from '../src/store.js';

/**
 * F-refs from the served-file delta registry must be recoverable by zoom:
 * the h02 bench session was handed [dcp:file F88a9@...] and zooming it
 * answered "no artifact ... in the store" — a dead-end reference.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..', '..');
const chalkIndex = path.join(repoRoot, 'fixtures', 'repos', 'chalk', 'source', 'index.js');

const dirs: string[] = [];
const stores: Store[] = [];

function makeWorld(): { store: Store; audit: AuditWriter } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'redutok-zoom-ref-'));
  dirs.push(dir);
  const store = openStore(path.join(dir, 'state.db'));
  stores.push(store);
  return { store, audit: new AuditWriter(path.join(dir, 'audit.jsonl')) };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('zoom resolves served-file F-refs', () => {
  it('resolves an F-ref to the stored artifact behind the first full serve', async () => {
    const { store, audit } = makeWorld();
    const raw = readFileSync(chalkIndex, 'utf8');
    const profiles = loadProfiles(path.join(repoRoot, 'profiles'));
    const first = serveFile(store, audit, 's-h02', 'source/index.js', raw);
    expect(first.mode).toBe('full');
    await distillArtifact(store, audit, {
      raw,
      profile: profiles.get('file-skeleton')!,
      sessionId: 's-h02',
      tool: 'dcp__read',
      context: { filePath: 'source/index.js' },
    });
    const second = serveFile(store, audit, 's-h02', 'source/index.js', raw);
    expect(second.mode).toBe('unchanged');

    const result = zoom(store, audit, second.ref);
    expect(result.found).toBe(true);
    expect(result.text).toBe(raw);
  });

  it('resolves an F-ref from the registry content when no artifact matches, with query slicing', () => {
    const { store, audit } = makeWorld();
    const raw = readFileSync(chalkIndex, 'utf8');
    const served = serveFile(store, audit, 's-h02', 'source/index.js', raw);

    const full = zoom(store, audit, served.ref);
    expect(full.found).toBe(true);
    expect(full.text).toBe(raw);

    const sliced = zoom(store, audit, served.ref, 'applyStyle openAll closeAll function context');
    expect(sliced.found).toBe(true);
    expect(sliced.text).toContain('applyStyle');
    expect(sliced.text.length).toBeLessThan(raw.length);
  });

  it('still reports an unknown F-ref clearly', () => {
    const { store, audit } = makeWorld();
    const result = zoom(store, audit, 'Fdead@0123456789abcdef');
    expect(result.found).toBe(false);
    expect(result.text).toContain('Fdead@0123456789abcdef');
  });
});
