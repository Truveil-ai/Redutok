// Runs each distillation profile against its real fixture(s) and emits a
// ratio table: printed to the terminal and written into PROGRESS.md between
// the ratio markers. Fixture measurements only, not session-level claims.
// Requires a build first: pnpm -r build, then node scripts/measure-ratios.mjs
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sidecar = await import(
  new URL('file://' + path.join(repoRoot, 'packages', 'sidecar', 'dist', 'index.js').replace(/\\/g, '/')).href
);
const { AuditWriter, distillArtifact, estimateTokens, loadProfiles, openStore } = sidecar;

const CASES = [
  ['build-log', 'build-log-fail.txt', undefined],
  ['test-output', 'test-output-fail.txt', undefined],
  ['file-skeleton', 'large-source.ts', 'fixtures/artifacts/large-source.ts'],
  ['file-skeleton', 'sample.py', 'fixtures/artifacts/sample.py'],
  ['search-results', 'search-results.txt', undefined],
  ['generic-stdout', 'generic-stdout.txt', undefined],
];

const profiles = loadProfiles(path.join(repoRoot, 'profiles'));
const dir = mkdtempSync(path.join(os.tmpdir(), 'redutok-measure-'));
const store = openStore(path.join(dir, 'state.db'));
const audit = new AuditWriter(path.join(dir, 'audit.jsonl'));

const rows = [];
for (const [profileName, fixtureName, filePath] of CASES) {
  const raw = readFileSync(path.join(repoRoot, 'fixtures', 'artifacts', fixtureName), 'utf8');
  const outcome = await distillArtifact(store, audit, {
    raw,
    profile: profiles.get(profileName),
    sessionId: 's-measure',
    context: { filePath },
  });
  const rawTok = estimateTokens(raw);
  const distTok = estimateTokens(outcome.text);
  rows.push({
    profile: profileName,
    fixture: fixtureName,
    rawTok,
    distTok,
    ratio: (rawTok / distTok).toFixed(1),
    gates: outcome.gateReport.results.map((r) => `${r.gate}: ${r.passed ? 'pass' : 'FAIL'}`).join(', '),
    served: outcome.served,
  });
}
store.close();

const header =
  '| profile | fixture | raw tok (est) | distilled tok (est) | ratio | gates applied and results | served |';
const sep = '| --- | --- | ---: | ---: | ---: | --- | --- |';
const body = rows.map(
  (r) => `| ${r.profile} | ${r.fixture} | ${r.rawTok} | ${r.distTok} | ${r.ratio}x | ${r.gates} | ${r.served} |`,
);
const table = [header, sep, ...body].join('\n');
const section = [
  '## Measured profile ratios, fixture-based, 2026-07-19',
  '',
  'Fixture measurements from real captured artifacts in fixtures/artifacts/, produced by scripts/measure-ratios.mjs. These are per-artifact distillation ratios, not session-level savings claims; session-level numbers come only from the Phase 6 bench harness. Token counts use the chars/4 estimate from the handle format.',
  '',
  table,
].join('\n');

console.log(section);

const progressPath = path.join(repoRoot, 'PROGRESS.md');
const progress = readFileSync(progressPath, 'utf8');
const START = '<!-- ratios:start -->';
const END = '<!-- ratios:end -->';
const block = `${START}\n${section}\n${END}`;
const updated = progress.includes(START)
  ? progress.replace(new RegExp(`${START}[\\s\\S]*?${END}`), block)
  : progress.replace(/\n## Half done or not started/, `\n${block}\n\n## Half done or not started`);
writeFileSync(progressPath, updated, 'utf8');
console.log('\nPROGRESS.md updated.');
