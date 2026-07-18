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
if (JSON.stringify(pkg.files) !== JSON.stringify(['dist'])) {
  fail(`files whitelist must be exactly ["dist"], got ${JSON.stringify(pkg.files)}`);
}
const cli = path.join(pkgDir, 'dist', 'cli.js');
if (!existsSync(cli)) fail('dist/cli.js missing; build before packing');
if (!readFileSync(cli, 'utf8').startsWith('#!/usr/bin/env node')) fail('dist/cli.js lacks the node shebang');
for (const banned of ['fixtures', 'bench']) {
  if (JSON.stringify(pkg.files ?? []).includes(banned)) fail(`files whitelist must not include ${banned}`);
}
console.log('prepublish check passed');
