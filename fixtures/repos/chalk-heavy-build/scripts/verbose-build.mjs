#!/usr/bin/env node
// Zero-dependency verbose build check for the vendored chalk snapshot: this
// isolated fixture copy ships with no node_modules, so the only tool it can
// rely on is `node` itself. Walks every source file, syntax-checks it with
// `node --check`, and on failure dumps full context (source excerpt, raw
// checker output, and the propagated ESM import stack) the way a verbose
// bundler build log would.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(root, 'source');

function listJsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listJsFiles(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = listJsFiles(sourceDir);
console.log(`build: checking ${files.length} source files under ${path.relative(root, sourceDir)}`);
console.log('');

let failures = 0;
for (const file of files) {
  const rel = path.relative(root, file);
  const lines = readFileSync(file, 'utf8').split('\n');
  console.log(`--- checking ${rel} (${lines.length} lines) ---`);
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    console.log(`ok: ${rel}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL: ${rel}`);
    console.log(err.stderr.toString());
    const match = err.stderr.toString().match(/:(\d+)$/m);
    const errorLine = match ? Number(match[1]) : undefined;
    if (errorLine !== undefined) {
      console.log(`context around ${rel}:${errorLine}:`);
      const start = Math.max(0, errorLine - 6);
      const end = Math.min(lines.length, errorLine + 5);
      for (let i = start; i < end; i += 1) {
        console.log(`${String(i + 1).padStart(5)} | ${lines[i]}`);
      }
    }
  }
  console.log('');
}

if (failures > 0) {
  console.log('--- propagated import stack (entry point source/index.js) ---');
  try {
    await import(pathToFileURL(path.join(sourceDir, 'index.js')).href);
  } catch (err) {
    console.log(err.stack);
  }
  console.log('');
  console.log(`BUILD FAILED: ${failures} of ${files.length} files failed the syntax check`);
  process.exit(1);
}
console.log(`BUILD OK: ${files.length} files passed`);
