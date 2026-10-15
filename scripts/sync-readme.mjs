/**
 * Copies the root README.md into the package directory being packed.
 *
 * npm takes a package's README from the package directory, not from the
 * workspace root, and redutok is published from packages/meter. Every version
 * through 0.1.9 therefore shipped with no README at all, and the registry page
 * answered "ERROR: No README data found!". The copy is generated at pack time
 * and gitignored, so the root file stays the single source.
 *
 * Run from the package directory (npm sets that cwd for prepack), ahead of
 * prepublish-check.mjs, which refuses to publish a package without one.
 */
import { copyFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(repoRoot, 'README.md');
const target = path.join(process.cwd(), 'README.md');

if (path.resolve(source) === path.resolve(target)) {
  console.log('sync-readme: packing the root package, nothing to copy');
  process.exit(0);
}

const bytes = readFileSync(source).length;
if (bytes === 0) {
  console.error('sync-readme failed: the root README.md is empty');
  process.exit(1);
}
copyFileSync(source, target);
console.log(`sync-readme: copied README.md (${bytes} bytes) into ${path.basename(process.cwd())}`);
