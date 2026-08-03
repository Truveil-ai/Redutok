// Prepack gate for the redutok package: refuses to pack a tarball that would
// ship the wrong surface. Run automatically via the prepack script.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
const EXPECTED_FILES = ['dist', 'docs', 'migrations', 'profiles', 'prices.yaml', 'energy_factors.yaml', 'grid_intensity.yaml'];
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
// A daemon without profiles starts fine and then answers 503 to every distill
// request, so an empty or absent directory has to fail the pack, not the user.
const profiles = path.join(pkgDir, 'profiles');
if (!existsSync(profiles)) fail('profiles/ missing; the daemon 503s on every distill without it');
if (readdirSync(profiles).filter((f) => f.endsWith('.yaml')).length === 0) {
  fail('profiles/ contains no .yaml profiles');
}

// The public type entry must not reference the private scope: those packages
// are bundled away and will not exist in a consumer's tree.
const typesEntry = path.join(pkgDir, 'dist', 'index.d.ts');
if (existsSync(typesEntry) && readFileSync(typesEntry, 'utf8').includes('@redutok/')) {
  fail('dist/index.d.ts references the private @redutok scope');
}

/*
 * The gate that matters.
 *
 * redutok@0.1.0 was one command away from being published with four
 * dependencies on @redutok/{hooks,mcp,shared,sidecar} — all private, all
 * unpublished. pnpm rewrites `workspace:*` into a pinned version at pack
 * time, so the manifest looked ordinary and every earlier check passed; the
 * tarball 404'd for every consumer on install. Nothing in the build or the
 * test suite could see it, because the pack test wired those four in from
 * local tarballs.
 *
 * So: resolve every declared runtime dependency against the public registry,
 * exactly as a consumer's installer would, and refuse to pack if any one of
 * them cannot be resolved. Unverifiable is treated as failure — if the
 * registry cannot be reached, we do not know whether the tarball installs, so
 * we do not ship it.
 */
const deps = Object.entries(pkg.dependencies ?? {});

for (const [name, range] of deps) {
  if (name.startsWith('@redutok/')) {
    fail(`dependency ${name} is private and unpublished; bundle it instead of depending on it`);
  }
  if (typeof range === 'string' && (range.startsWith('workspace:') || range.startsWith('link:') || range.startsWith('file:'))) {
    fail(`dependency ${name} uses the non-publishable "${range}" protocol`);
  }
}

const unresolved = [];
for (const [name, range] of deps) {
  const spec = `${name}@${range}`;
  // Joined command string, and the spec double-quoted: npm is a .cmd on
  // Windows, which Node will not spawn without a shell, and an unquoted range
  // hands its ^ to cmd.exe as an escape character. Args arrays with shell
  // true are deprecated (DEP0190), hence the single string.
  const view = spawnSync(`npm view "${spec}" version --json`, {
    encoding: 'utf8',
    shell: true,
    timeout: 60_000,
  });
  if (view.status === 0 && view.stdout.trim() !== '') {
    console.log(`  ok  ${spec}`);
    continue;
  }
  const stderr = (view.stderr ?? '').trim();
  const reason = view.error
    ? `could not run npm view (${view.error.message})`
    : /E404|is not in this registry|404 Not Found/.test(stderr)
      ? 'not found on the public registry'
      : `registry lookup failed: ${stderr.split('\n')[0] ?? `exit ${view.status}`}`;
  unresolved.push(`${spec} — ${reason}`);
}
if (unresolved.length > 0) {
  fail(
    `these dependencies would not install from the public registry:\n  ${unresolved.join('\n  ')}\n` +
      'A consumer running `npm i redutok` gets this failure. Bundle the dependency or publish it.',
  );
}

console.log(`prepublish check passed (${deps.length} dependencies resolve publicly)`);
