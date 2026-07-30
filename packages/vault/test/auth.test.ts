import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bearerAuthorized, resolveSecret } from '../src/auth.js';

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
