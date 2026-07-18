// Generates docs/SBOM.json (CycloneDX-flavored component list) from
// pnpm-lock.yaml. Run: node scripts/sbom.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// Resolve yaml through the shared package; pnpm keeps root node_modules strict.
const require = createRequire(path.join(root, 'packages', 'shared', 'package.json'));
const { parse } = require('yaml');
const lock = parse(readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8'));
const components = Object.keys(lock.packages ?? {})
  .map((key) => {
    const at = key.lastIndexOf('@');
    return { type: 'library', name: key.slice(0, at), version: key.slice(at + 1) };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  metadata: {
    component: { type: 'application', name: 'redutok', version: '0.1.0' },
    note: 'Generated from pnpm-lock.yaml by scripts/sbom.mjs; regenerate after dependency changes.',
  },
  components,
};
writeFileSync(path.join(root, 'docs', 'SBOM.json'), JSON.stringify(sbom, null, 2) + '\n');
console.log(`SBOM written: ${components.length} components.`);
