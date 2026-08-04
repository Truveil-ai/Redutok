/**
 * Builds the published `redutok` artifact.
 *
 * Why bundle at all: redutok's four workspace dependencies (@redutok/shared,
 * @redutok/sidecar, @redutok/mcp, @redutok/hooks) are private and
 * unpublished. Shipping them as ordinary dependencies produced a tarball that
 * 404'd on install for every consumer. Bundling folds them into this package
 * so redutok installs as a single self-contained artifact, and the four stay
 * private.
 *
 * Why esbuild: one pinned dependency, no plugin stack, deterministic output
 * for a given version and input set, and it leaves `import.meta.url` alone in
 * ESM output — which the asset paths below depend on. Rollup would need three
 * or four plugins to reach the same place.
 *
 * What is bundled and what is not: only the @redutok/* workspace packages are
 * inlined. Every third-party dependency stays external and is declared in
 * package.json, because better-sqlite3 is a native module that cannot be
 * bundled, tree-sitter-wasms is resolved from node_modules at runtime via
 * require.resolve, and keeping the rest external preserves npm's dedupe,
 * audit and license reporting.
 *
 * Asset paths: shared and sidecar locate their runtime assets relative to
 * their own module URL (`dirname(import.meta.url)/..`). Once inlined, that
 * resolves against this package's dist/, so `..` lands at the package root.
 * copyAssets() puts prices.yaml, energy_factors.yaml, grid_intensity.yaml,
 * migrations/, profiles/ and docs/ exactly there. Keep every entry point
 * directly in dist/ or these paths break.
 */
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const meterDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.join(meterDir, '..', '..');
const pkgSrc = (pkg, file) => path.join(repoRoot, 'packages', pkg, 'src', `${file}.ts`);
const outdir = path.join(meterDir, 'dist');

/** Entry points, all emitted directly into dist/ (see asset-path note above). */
const ENTRIES = {
  index: pkgSrc('meter', 'index'),
  cli: pkgSrc('meter', 'cli'),
  pipe: pkgSrc('meter', 'pipe'),
  // Reachable only through the launchers redutok init generates, and through
  // sidecar-cli spawning the daemon. They must exist as real files here:
  // the scoped specifiers they replace no longer resolve in a consumer tree.
  'hook-main': pkgSrc('hooks', 'hook-main'),
  'mcp-main': pkgSrc('mcp', 'main'),
  'daemon-main': pkgSrc('sidecar', 'daemon-main'),
};

/**
 * Resolves workspace specifiers to their TypeScript sources and marks
 * everything else external. Going to src rather than each package's dist
 * keeps the bundle independent of sibling build order, and breaks the
 * hooks -> redutok import cycle at the source level.
 */
const workspaceResolver = {
  name: 'redutok-workspace',
  setup(build) {
    build.onResolve({ filter: /^(@redutok\/|redutok$|redutok\/)/ }, (args) => {
      const spec = args.path;
      if (spec === 'redutok') return { path: pkgSrc('meter', 'index') };
      if (spec.startsWith('redutok/')) return { path: pkgSrc('meter', spec.slice('redutok/'.length)) };
      const rest = spec.slice('@redutok/'.length);
      const slash = rest.indexOf('/');
      if (slash === -1) return { path: pkgSrc(rest, 'index') };
      return { path: pkgSrc(rest.slice(0, slash), rest.slice(slash + 1)) };
    });
    // Bare specifiers that are not ours: node builtins and third-party deps.
    build.onResolve({ filter: /^[^./]/ }, (args) =>
      args.kind === 'entry-point' ? null : { path: args.path, external: true },
    );
  },
};

/** Runtime assets, copied to the package root so the inlined `..` lookups land. */
function copyAssets() {
  for (const name of ['prices.yaml', 'energy_factors.yaml', 'grid_intensity.yaml']) {
    cpSync(path.join(repoRoot, 'packages', 'shared', name), path.join(meterDir, name));
  }
  rmSync(path.join(meterDir, 'migrations'), { recursive: true, force: true });
  cpSync(path.join(repoRoot, 'packages', 'sidecar', 'migrations'), path.join(meterDir, 'migrations'), {
    recursive: true,
  });
  // The daemon loads these at startup; without them it answers 503 to every
  // distill request, which is the whole point of the package.
  rmSync(path.join(meterDir, 'profiles'), { recursive: true, force: true });
  cpSync(path.join(repoRoot, 'profiles'), path.join(meterDir, 'profiles'), { recursive: true });
  // redutok init splices blocks out of these two documents.
  const docs = path.join(meterDir, 'docs');
  mkdirSync(docs, { recursive: true });
  for (const name of ['PROTOCOL.md', 'SCOUT.md']) {
    cpSync(path.join(repoRoot, 'docs', name), path.join(docs, name));
  }
}

// tsc owns dist/*.d.ts and this script owns dist/*.js. Deleting dist/ without
// also deleting tsconfig.tsbuildinfo leaves tsc believing it is up to date, so
// it emits no declarations while the bundle below still writes the .js --
// which surfaces far away, as "could not find a declaration file for module
// 'redutok'" when ../hooks compiles. Fail here instead, with the remedy.
if (!existsSync(path.join(outdir, 'index.d.ts'))) {
  throw new Error(
    'dist/index.d.ts is missing after tsc. Stale build info: delete ' +
      'packages/meter/tsconfig.tsbuildinfo alongside dist/ and rebuild.',
  );
}

const result = await build({
  entryPoints: ENTRIES,
  outdir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  // Matches the engines floor in the root manifest.
  target: 'node20',
  sourcemap: true,
  // Splitting is deliberately off: self-contained entry files keep every
  // output directly in dist/, which is what the asset paths above rely on.
  splitting: false,
  plugins: [workspaceResolver],
  logLevel: 'warning',
  metafile: true,
});

// cli.ts and pipe.ts carry their own shebang; assert rather than inject one,
// so a source change that drops it fails the build instead of the publish.
for (const name of ['cli', 'pipe']) {
  const file = path.join(outdir, `${name}.js`);
  if (!readFileSync(file, 'utf8').startsWith('#!/usr/bin/env node')) {
    throw new Error(`dist/${name}.js lost its shebang; check the banner in src/${name}.ts`);
  }
}

copyAssets();

const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
writeFileSync(path.join(outdir, '.bundle-meta.json'), JSON.stringify(result.metafile.outputs, null, 2));
console.log(`bundled ${Object.keys(ENTRIES).length} entry points, ${(bytes / 1024).toFixed(0)} KB total`);
