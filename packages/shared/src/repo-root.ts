import { realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * Canonical form for comparing repository roots across the daemon and its
 * clients (hooks, pipe, MCP, lifecycle CLI). Roots compare after resolution,
 * trailing-separator strip, and (win32) case folding, so `E:\repo\` and
 * `e:/repo` agree. On win32 the path is also canonicalized through
 * realpathSync.native, which expands 8.3 short names: CI runners hand
 * processes a mix of `RUNNER~1` and `runneradmin` spellings of one temp
 * directory, and a string-only comparison refuses legitimate same-repo
 * traffic. One definition, because the 0.1.1 field install showed what
 * happens when the two sides of a seam disagree about identity.
 */
export function normalizedRepoRoot(p: string): string {
  let resolved = path.resolve(p);
  if (process.platform === 'win32') {
    try {
      resolved = realpathSync.native(resolved);
    } catch {
      // A path that does not exist has no canonical spelling; the resolved
      // string is all there is to compare.
    }
  }
  resolved = resolved.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** True when both sides name the same repository root. */
export function sameRepoRoot(a: string, b: string): boolean {
  return normalizedRepoRoot(a) === normalizedRepoRoot(b);
}
