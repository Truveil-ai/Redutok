// Prepack gate for the redutok package: refuses to pack a tarball that would
// ship the wrong surface. Run automatically via the prepack script.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const pkgDir = process.cwd();
const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
const fail = (msg) => {
  console.error(`prepublish check failed: ${msg}`);
  process.exit(1);
};

if (pkg.name !== 'redutok') fail(`name must be redutok, got ${pkg.name}`);
if (!pkg.description?.endsWith('by Truveil')) fail('description must end "by Truveil"');
if (pkg.license !== 'MIT') fail('license must be MIT');
if (!pkg.repository?.url?.includes('github.com')) fail('repository url missing');

// The whitelist carries dist/ plus the runtime assets that scripts/bundle.mjs
// copies to the package root, because the inlined shared/sidecar code locates
// them at `dirname(import.meta.url)/..`. Everything else stays out.
const EXPECTED_FILES = ['dist', 'docs', 'migrations', 'prices.yaml', 'energy_factors.yaml', 'grid_intensity.yaml'];
const actualFiles = [...(pkg.files ?? [])].sort();
if (JSON.stringify(actualFiles) !== JSON.stringify([...EXPECTED_FILES].sort())) {
  fail(`files whitelist must be exactly ${JSON.stringify(EXPECTED_FILES)}, got ${JSON.stringify(pkg.files)}`);
}
for (const banned of ['fixtures', 'bench', '.dcp']) {
  if (JSON.stringify(pkg.files ?? []).includes(banned)) fail(`files whitelist must not include ${banned}`);
}

// Every entry point the bin, the exports map and the generated launchers reach
// for. hook-main/mcp-main/daemon-main are reachable only at runtime, so a
// missing one would surface as a broken install rather than a failed build.
for (const entry of ['index', 'cli', 'pipe', 'hook-main', 'mcp-main', 'daemon-main']) {
  if (!existsSync(path.join(pkgDir, 'dist', `${entry}.js`))) {
    fail(`dist/${entry}.js missing; run the build before packing`);
  }
}
for (const entry of ['cli', 'pipe']) {
  const file = path.join(pkgDir, 'dist', `${entry}.js`);
  if (!readFileSync(file, 'utf8').startsWith('#!/usr/bin/env node')) {
    fail(`dist/${entry}.js lacks the node shebang`);
  }
}
for (const asset of ['prices.yaml', 'energy_factors.yaml', 'grid_intensity.yaml']) {
  if (!existsSync(path.join(pkgDir, asset))) fail(`${asset} missing; run the build before packing`);
}
for (const doc of ['PROTOCOL.md', 'SCOUT.md']) {
  if (!existsSync(path.join(pkgDir, 'docs', doc))) fail(`docs/${doc} missing; redutok init reads it`);
}
if (!existsSync(path.join(pkgDir, 'migrations'))) fail('migrations/ missing; the sidecar store reads it');

// The public type entry must not reference the private scope: those packages
// are bundled away and will not exist in a consumer's tree.
const typesEntry = path.join(pkgDir, 'dist', 'index.d.ts');
if (existsSync(typesEntry) && readFileSync(typesEntry, 'utf8').includes('@redutok/')) {
  fail('dist/index.d.ts references the private @redutok scope');
}

console.log('prepublish check passed');
