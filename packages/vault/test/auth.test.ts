import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bearerAuthorized, resolveCorporaSecret, resolveSecret } from '../src/auth.js';

describe('bearerAuthorized', () => {
  const secret = 'agent-secret-for-tests';

  it('accepts exactly the configured bearer secret', () => {
    expect(bearerAuthorized(`Bearer ${secret}`, secret)).toBe(true);
  });

  it('rejects a wrong secret, other schemes, and a missing header', () => {
    expect(bearerAuthorized(`Bearer ${secret}x`, secret)).toBe(false);
    expect(bearerAuthorized(`Basic ${secret}`, secret)).toBe(false);
    expect(bearerAuthorized('Bearer ', secret)).toBe(false);
    expect(bearerAuthorized('', secret)).toBe(false);
    expect(bearerAuthorized(undefined, secret)).toBe(false);
  });

  it('compares presentations of a different length without throwing', () => {
    // The constant-time comparison must hash both sides to a fixed length
    // first; a raw timingSafeEqual on unequal buffers would throw here.
    expect(bearerAuthorized('Bearer abc', secret)).toBe(false);
    expect(bearerAuthorized(`Bearer ${secret}${secret}`, secret)).toBe(false);
  });
});

describe('resolveSecret', () => {
  let dcpDir: string;

  afterEach(() => {
    if (dcpDir !== undefined) rmSync(path.dirname(dcpDir), { recursive: true, force: true, maxRetries: 5 });
  });

  function makeDcpDir(vaultJson?: unknown): string {
    const root = mkdtempSync(path.join(os.tmpdir(), 'vault-auth-'));
    dcpDir = path.join(root, '.dcp');
    mkdirSync(dcpDir);
    if (vaultJson !== undefined) {
      writeFileSync(path.join(dcpDir, 'vault.json'), JSON.stringify(vaultJson) + '\n', 'utf8');
    }
    return dcpDir;
  }

  it('prefers REDUTOK_VAULT_SECRET over the config file', () => {
    const dir = makeDcpDir({ secret: 'from-config' });
    const resolved = resolveSecret(dir, { REDUTOK_VAULT_SECRET: 'from-env' });
    expect(resolved).toEqual({ secret: 'from-env', source: 'env' });
  });

  it('reads .dcp/vault.json when no env secret is set', () => {
    const dir = makeDcpDir({ secret: 'from-config' });
    const resolved = resolveSecret(dir, {});
    expect(resolved).toEqual({ secret: 'from-config', source: 'config' });
  });

  it('returns undefined when neither source has a secret', () => {
    expect(resolveSecret(makeDcpDir(), {})).toBeUndefined();
  });

  it('ignores an empty or malformed configured secret', () => {
    expect(resolveSecret(makeDcpDir({ secret: '' }), {})).toBeUndefined();
    expect(resolveSecret(makeDcpDir({ secret: 42 }), {})).toBeUndefined();
    expect(resolveSecret(makeDcpDir(), { REDUTOK_VAULT_SECRET: '' })).toBeUndefined();
  });
});

/**
 * Multi-mount secret resolution (field audit, corpus idf 2026-08-02): the
 * server used to read the secret from the FIRST mounted corpus only — the
 * same silent first-mount default class as the vault_receipt wrong-corpus
 * bug. It must consider every mount and refuse a conflict by name.
 */
describe('resolveCorporaSecret', () => {
  const roots: string[] = [];

  afterEach(() => {
    while (roots.length > 0) {
      rmSync(roots.pop() as string, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  function mount(name: string, vaultJson?: unknown): { name: string; dcpDir: string } {
    const root = mkdtempSync(path.join(os.tmpdir(), 'vault-auth-multi-'));
    roots.push(root);
    const dir = path.join(root, '.dcp');
    mkdirSync(dir);
    if (vaultJson !== undefined) {
      writeFileSync(path.join(dir, 'vault.json'), JSON.stringify(vaultJson) + '\n', 'utf8');
    }
    return { name, dcpDir: dir };
  }

  it('finds a secret configured on any mount, not just the first', () => {
    const mounts = [mount('fixtures'), mount('idf', { secret: 'from-idf' })];
    expect(resolveCorporaSecret(mounts, {})).toEqual({ secret: 'from-idf', source: 'config' });
  });

  it('accepts agreeing secrets across mounts and prefers the env', () => {
    const mounts = [mount('a', { secret: 'shared' }), mount('b', { secret: 'shared' })];
    expect(resolveCorporaSecret(mounts, {})).toEqual({ secret: 'shared', source: 'config' });
    expect(resolveCorporaSecret(mounts, { REDUTOK_VAULT_SECRET: 'env-wins' })).toEqual({
      secret: 'env-wins',
      source: 'env',
    });
  });

  it('refuses conflicting secrets by corpus name', () => {
    const mounts = [mount('fixtures', { secret: 'one' }), mount('idf', { secret: 'two' })];
    expect(() => resolveCorporaSecret(mounts, {})).toThrow(/fixtures.*idf|idf.*fixtures/);
  });

  it('returns undefined when no mount configures a secret', () => {
    expect(resolveCorporaSecret([mount('a'), mount('b')], {})).toBeUndefined();
  });
});
