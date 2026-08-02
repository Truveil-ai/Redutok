import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Bearer agent-secret auth for the vault. The secret comes from the
 * environment or the corpus config file; the comparison is constant-time.
 */

export interface ResolvedSecret {
  secret: string;
  source: 'env' | 'config';
}

/** REDUTOK_VAULT_SECRET wins; else <dcpDir>/vault.json { "secret": "..." }. */
export function resolveSecret(
  dcpDir: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedSecret | undefined {
  const fromEnv = env['REDUTOK_VAULT_SECRET'];
  if (fromEnv !== undefined && fromEnv !== '') return { secret: fromEnv, source: 'env' };
  try {
    const raw = JSON.parse(readFileSync(path.join(dcpDir, 'vault.json'), 'utf8')) as {
      secret?: unknown;
    };
    if (typeof raw.secret === 'string' && raw.secret !== '') {
      return { secret: raw.secret, source: 'config' };
    }
  } catch {
    // No config file (or malformed json) simply means no configured secret.
  }
  return undefined;
}

/**
 * The secret for a whole mount set. Reading it from the first mounted corpus
 * alone is the same silent first-mount default that sent vault_receipt to
 * the wrong ledger (field audit, corpus idf 2026-08-02): a secret configured
 * on the second corpus was invisible, and the server refused to start with
 * one sitting right there. Every mount is consulted; disagreeing mounts are
 * refused by name rather than resolved arbitrarily.
 */
export function resolveCorporaSecret(
  mounts: { name: string; dcpDir: string }[],
  env: NodeJS.ProcessEnv = process.env,
): ResolvedSecret | undefined {
  const fromEnv = env['REDUTOK_VAULT_SECRET'];
  if (fromEnv !== undefined && fromEnv !== '') return { secret: fromEnv, source: 'env' };
  const found = new Map<string, string[]>();
  for (const mount of mounts) {
    const resolved = resolveSecret(mount.dcpDir, {});
    if (resolved === undefined) continue;
    found.set(resolved.secret, [...(found.get(resolved.secret) ?? []), mount.name]);
  }
  if (found.size === 0) return undefined;
  if (found.size > 1) {
    const where = [...found.values()].map((names) => names.join('+')).join(' vs ');
    throw new Error(
      `mounted corpora configure different agent secrets (${where}); make them agree or set REDUTOK_VAULT_SECRET`,
    );
  }
  return { secret: [...found.keys()][0] as string, source: 'config' };
}

/**
 * Constant-time bearer check. Both sides are hashed to a fixed length first,
 * so a length mismatch neither throws nor short-circuits the comparison.
 */
export function bearerAuthorized(header: string | undefined, secret: string): boolean {
  if (header === undefined || secret === '') return false;
  const match = /^Bearer +(\S+)$/.exec(header);
  if (match === null) return false;
  const presented = createHash('sha256').update(match[1] ?? '', 'utf8').digest();
  const expected = createHash('sha256').update(secret, 'utf8').digest();
  return timingSafeEqual(presented, expected);
}
