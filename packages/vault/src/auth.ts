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
