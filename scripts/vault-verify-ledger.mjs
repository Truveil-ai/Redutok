// Live verification of Vault Session 3 (the persistent receipt ledger) at
// zero model cost: both fixture corpora (the axios code fixture and the
// mixed document corpus) mounted on one server, a dozen asks and zooms over
// two simulated sessions (X-Vault-Session team-a / team-b), a server restart
// mid-sequence, then the checks: per-session receipts differ and reconcile
// to the audit trail, the ledger survives the restart, the per-document
// rollup ranks correctly, and the month statement renders with correct
// totals. Prints the month statement at the end.
//
//   node scripts/vault-verify-ledger.mjs
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeDocFixtures } from './doc-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'packages', 'meter', 'dist', 'cli.js');
const vaultMain = path.join(root, 'packages', 'vault', 'dist', 'main.js');
const shared = await import(pathToFileURL(path.join(root, 'packages', 'shared', 'dist', 'index.js')).href);
const { readAuditFile } = shared;

const SECRET = `vault-verify-ledger-${Math.random().toString(36).slice(2)}`;
const stamp = Date.now();
const codeDir = path.join(os.tmpdir(), `vault-ledger-code-${stamp}`);
const docsDir = path.join(os.tmpdir(), `vault-ledger-docs-${stamp}`);
const cliEnv = { ...process.env, REDUTOK_HOME: root };
const MONTH = new Date().toISOString().slice(0, 7);

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures += 1;
};
const tok = (bytes) => Math.round(bytes / 4);

// 1. Corpus A: the axios fixture, initialized as bench-live does it.
console.log(`corpus A: copying axios fixture to ${codeDir}`);
rmSync(codeDir, { recursive: true, force: true });
mkdirSync(codeDir, { recursive: true });
cpSync(path.join(root, 'fixtures', 'repos', 'axios'), codeDir, { recursive: true });
execFileSync('node', [cli, 'init', codeDir], { cwd: codeDir, env: cliEnv });
const configPath = path.join(codeDir, '.dcp', 'config.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
config.profilesDir = path.join(root, 'profiles');
writeFileSync(configPath, JSON.stringify(config, null, 2));
execFileSync('node', [cli, 'codex', 'refresh'], { cwd: codeDir, env: cliEnv });

// 2. Corpus B: the mixed document corpus, ingested with the real CLI.
console.log(`corpus B: assembling doc-corpus fixture at ${docsDir}`);
rmSync(docsDir, { recursive: true, force: true });
mkdirSync(docsDir, { recursive: true });
cpSync(path.join(root, 'fixtures', 'doc-corpus'), docsDir, { recursive: true });
writeDocFixtures(docsDir);
execFileSync('node', [vaultMain, 'ingest', docsDir, '--corpus', 'practice'], { encoding: 'utf8' });

// 3. The vault server over both corpora, restartable.
async function startVault() {
  const child = spawn(
    'node',
    [vaultMain, '--corpus', `axios=${codeDir}`, '--corpus', `practice=${docsDir}`, '--port', '0'],
    { env: { ...process.env, REDUTOK_VAULT_SECRET: SECRET }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`vault did not report a port\n${stderr}`)), 30_000);
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
      const match = /listening on http:\/\/127\.0\.0\.1:(\d+)\/mcp/.exec(out);
      if (match !== null) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`vault exited early (${code})\n${stderr}`));
    });
  });
  return { child, port };
}

const stopVault = (handle) =>
  new Promise((resolve) => {
    handle.child.once('exit', resolve);
    handle.child.kill();
    setTimeout(resolve, 3000);
  });

let vault = await startVault();
console.log(`vault: listening on 127.0.0.1:${vault.port}`);

const post = (body, headers = {}) =>
  globalThis.fetch(`http://127.0.0.1:${vault.port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
    body: JSON.stringify(body),
  });
const toolText = (body) => body?.result?.content?.[0]?.text ?? '';
let rpcId = 100;

async function initSession(team) {
  const res = await post(
    {
      jsonrpc: '2.0',
      id: (rpcId += 1),
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vault-verify-ledger', version: '0' } },
    },
    { 'x-vault-session': team },
  );
  const mcpSessionId = res.headers.get('mcp-session-id') ?? '';
  return { 'mcp-session-id': mcpSessionId, authorization: `Bearer ${SECRET}` };
}

async function callTool(auth, name, args) {
  const res = await post(
    { jsonrpc: '2.0', id: (rpcId += 1), method: 'tools/call', params: { name, arguments: args } },
    auth,
  );
  const body = await res.json();
  if (res.status !== 200 || body?.result?.isError === true) {
    throw new Error(`${name} failed (${res.status}): ${toolText(body)}`);
  }
  return toolText(body);
}

const firstHandle = (dossier) => /vault_zoom\("(a[0-9a-f]{6})"/.exec(dossier)?.[1] ?? '';
const receiptJson = async (auth, args) =>
  JSON.parse(await callTool(auth, 'vault_receipt', { ...args, json: true }));

/** Audit-side recomputation: measured events for the session prefix. */
function auditAvoided(dir, sessionPrefix) {
  return readAuditFile(path.join(dir, '.dcp', 'audit.jsonl'))
    .events.filter((e) => typeof e.sessionId === 'string' && e.sessionId.startsWith(sessionPrefix))
    .filter((e) => e.bytesIn !== undefined && e.bytesOut !== undefined)
    .reduce((n, e) => n + Math.max(0, tok(e.bytesIn) - tok(e.bytesOut)), 0);
}

try {
  // 4. Two simulated sessions, part one of the sequence (7 tool calls).
  let teamA = await initSession('team-a');
  let teamB = await initSession('team-b');

  const a1 = await callTool(teamA, 'vault_ask', {
    corpus: 'axios',
    question:
      'How does dispatchRequest hand config to the adapter where buildFullPath, combineURLs, isAbsoluteURL and buildURL assemble the fullPath?',
  });
  const a2 = await callTool(teamA, 'vault_ask', {
    corpus: 'axios',
    question: 'Where does combineURLs join the baseURL and a relative requested URL?',
  });
  await callTool(teamA, 'vault_zoom', { corpus: 'axios', handle: firstHandle(a1) });
  await callTool(teamA, 'vault_zoom', { corpus: 'axios', handle: firstHandle(a2), query: 'combineURLs' });

  const b1 = await callTool(teamB, 'vault_ask', {
    corpus: 'practice',
    question:
      'What fixed fee applies to the Meridian valuation engagement and how long must its workpapers be retained?',
  });
  await callTool(teamB, 'vault_zoom', { corpus: 'practice', handle: firstHandle(b1) });
  await callTool(teamB, 'vault_ask', {
    corpus: 'practice',
    question: 'Which retention periods apply to engagement letters and valuation workpapers?',
  });

  const beforeRestartA = await receiptJson(teamA, { scope: 'session', corpus: 'axios' });
  check(beforeRestartA.avoidedTokens > 0, `team-a session receipt on axios has real avoided tokens (${beforeRestartA.avoidedTokens})`);

  // 5. Restart the server mid-sequence.
  console.log('\nvault: restarting mid-sequence');
  await stopVault(vault);
  vault = await startVault();
  console.log(`vault: listening again on 127.0.0.1:${vault.port}`);
  teamA = await initSession('team-a');
  teamB = await initSession('team-b');

  // 6. Ledger continuity: the same session identity sees its pre-restart
  // lines with no new activity in between.
  const afterRestartA = await receiptJson(teamA, { scope: 'session', corpus: 'axios' });
  check(
    afterRestartA.avoidedTokens === beforeRestartA.avoidedTokens &&
      afterRestartA.lines === beforeRestartA.lines,
    `ledger survives the restart: team-a axios receipt unchanged (${afterRestartA.avoidedTokens} tok across ${afterRestartA.lines} lines)`,
  );

  // 7. Part two of the sequence (5 more tool calls; 12 in total).
  const a3 = await callTool(teamA, 'vault_ask', {
    corpus: 'practice',
    question: 'How long must valuation workpapers be retained after engagement close?',
  });
  const b2 = await callTool(teamB, 'vault_ask', {
    corpus: 'axios',
    question: 'What does isAbsoluteURL treat as an absolute URL when buildFullPath decides to ignore the baseURL?',
  });
  await callTool(teamB, 'vault_zoom', { corpus: 'axios', handle: firstHandle(b2) });
  await callTool(teamB, 'vault_ask', {
    corpus: 'practice',
    question: 'What fixed fee does the engagement letter set for the Meridian valuation?',
  });
  await callTool(teamB, 'vault_zoom', { corpus: 'practice', handle: firstHandle(a3) });

  // 8. Per-session receipts differ and reconcile to the audit trail.
  const finalA = await receiptJson(teamA, { scope: 'session', corpus: 'axios' });
  const finalB = await receiptJson(teamB, { scope: 'session', corpus: 'axios' });
  check(
    finalA.sessionId === 'vault-team-a' && finalB.sessionId === 'vault-team-b',
    'session receipts carry their own explicit identities',
  );
  check(
    finalA.avoidedTokens !== finalB.avoidedTokens || finalA.lines !== finalB.lines,
    `per-session receipts differ (team-a ${finalA.avoidedTokens} tok / ${finalA.lines} lines vs team-b ${finalB.avoidedTokens} tok / ${finalB.lines} lines)`,
  );
  for (const [team, receipt] of [
    ['vault-team-a', finalA],
    ['vault-team-b', finalB],
  ]) {
    const recomputed = auditAvoided(codeDir, team);
    check(
      receipt.avoidedTokens === recomputed,
      `${team} axios receipt reconciles to the audit trail (${receipt.avoidedTokens} == ${recomputed})`,
    );
  }
  const practiceB = await receiptJson(teamB, { scope: 'session', corpus: 'practice' });
  check(
    practiceB.avoidedTokens === auditAvoided(docsDir, 'vault-team-b'),
    `vault-team-b practice receipt reconciles to the audit trail (${practiceB.avoidedTokens} tok)`,
  );

  // 9. The per-document rollup ranks correctly.
  const docRollup = await receiptJson(teamB, { scope: 'document', corpus: 'practice' });
  const docs = docRollup.documents;
  check(docs.length >= 2, `document rollup covers the corpus (${docs.length} documents)`);
  const ranked = docs.every(
    (d, i) =>
      i === 0 ||
      docs[i - 1].reads > d.reads ||
      (docs[i - 1].reads === d.reads && docs[i - 1].avoidedTokens >= d.avoidedTokens),
  );
  check(ranked, 'document rollup ranks by reads, then tokens avoided');
  const top = docs[0];
  check(
    top.reads >= 2,
    `the most-consumed document was read ${top.reads} times (${top.document})`,
  );

  // 10. The month statement renders with correct totals.
  const statementJson = JSON.parse(
    execFileSync(
      'node',
      [vaultMain, 'statement', docsDir, '--corpus', 'practice', '--month', MONTH, '--json'],
      { encoding: 'utf8' },
    ),
  );
  const corpusRollup = await receiptJson(teamB, { scope: 'corpus', corpus: 'practice' });
  check(
    statementJson.avoidedTokens === corpusRollup.avoidedTokens &&
      statementJson.lines === corpusRollup.lines,
    `month statement totals match the corpus-lifetime rollup (${statementJson.avoidedTokens} tok across ${statementJson.lines} lines)`,
  );
  const statementText = execFileSync(
    'node',
    [vaultMain, 'statement', docsDir, '--corpus', 'practice', '--month', MONTH],
    { encoding: 'utf8' },
  );
  check(/estimates, never measurements/.test(statementText), 'statement carries the estimates-never-measurements framing');
  check(/corpus resident size avoided/.test(statementText), 'statement labels the whole-corpus figure distinctly');
  check(!/[–—]/.test(statementText), 'statement uses no em-dashes or en-dashes');
  console.log('\n--- month statement (corpus: practice) ---');
  console.log(statementText.trimEnd());
  console.log('-------------------------------------------');
} finally {
  await stopVault(vault);
  for (const dir of [codeDir, docsDir]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      console.log(`note: could not remove ${dir}`);
    }
  }
}

console.log(
  failures === 0 ? '\nvault-verify-ledger: all checks passed' : `\nvault-verify-ledger: ${failures} check(s) FAILED`,
);
process.exitCode = failures === 0 ? 0 : 1;
