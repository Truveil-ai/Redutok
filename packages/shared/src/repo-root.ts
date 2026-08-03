import path from 'node:path';

/**
 * Canonical form for comparing repository roots across the daemon and its
 * clients (hooks, pipe, MCP, lifecycle CLI). Roots compare after resolution,
 * trailing-separator strip, and (win32) case folding, so `E:\repo\` and
 * `e:/repo` agree. One definition, because the 0.1.1 field install showed
 * what happens when the two sides of a seam disagree about identity.
 */
export function normalizedRepoRoot(p: string): string {
  const resolved = path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** True when both sides name the same repository root. */
export function sameRepoRoot(a: string, b: string): boolean {
  return normalizedRepoRoot(a) === normalizedRepoRoot(b);
}
