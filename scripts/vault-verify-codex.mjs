// Live verification of Vault Session 4 (zero-turn channel + conversational
// graduation) at zero model cost. The sequence:
//   1. Assemble the doc-corpus fixture, ingest into a corpus.
//   2. Emit codex v1; note the version and hash.
//   3. Run two simulated sessions (team-a / team-b) that hit the same
//      touched-sections neighborhood — no LLM calls, only the vault engines.
//   4. Run graduation (mine) synchronously.
//   5. Emit codex v2; assert the version bumped, a graduated line appeared,
//      and print the diff (v1 vs v2) plus the first 40 lines of the v2 block.
//   6. Ask carrying codex_version=v1: the response has exactly one refresh
//      line naming the current version; ask carrying v2 has none.
//
//   node scripts/vault-verify-codex.mjs
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeDocFixtures } from './doc-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vaultMain = path.join(root, 'packages', 'vault', 'dist', 'main.js');

const SECRET = `vault-verify-codex-${Math.random().toString(36).slice(2)}`;
const stamp = Date.now();
const docsDir = path.join(os.tmpdir(), `vault-codex-docs-${stamp}`);

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures += 1;
};

console.log(`corpus: assembling doc-corpus fixture at ${docsDir}`);
rmSync(docsDir, { recursive: true, force: true });
mkdirSync(docsDir, { recursive: true });
cpSync(path.join(root, 'fixtures', 'doc-corpus'), docsDir, { recursive: true });
writeDocFixtures(docsDir);
execFileSync('node', [vaultMain, 'ingest', docsDir, '--corpus', 'practice'], { encoding: 'utf8' });

// --- Step 2: emit codex v1 by driving the CLI directly (no server) ---
const codexV1Raw = execFileSync(
  'node',
  [vaultMain, 'codex', docsDir, '--corpus', 'practice', '--json'],
  { encoding: 'utf8' },
);
const codexV1 = JSON.parse(codexV1Raw);
console.log(`codex v1: version=${codexV1.version} hash=${codexV1.textHash} rendered ${codexV1.text.length} chars`);
check(codexV1.version === 1, 'codex v1 is version 1');

// --- Step 3: bring up the vault server and drive two sessions of asks ---
async function startVault() {
  const child = spawn(
    'node',
    [vaultMain, '--corpus', `practice=${docsDir}`, '--port', '0'],
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
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vault-verify-codex', version: '0' } },
    },
    { authorization: `Bearer ${SECRET}`, 'x-vault-session': team },
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

// Two sessions ask the same recurring question — enough for the miner to
// promote an ask-neighborhood (>=2 sessions, >=3 occurrences).
const RECURRING = 'what is the billing policy fee?';
try {
  for (const team of ['team-a', 'team-b']) {
    const auth = await initSession(team);
    for (let i = 0; i < 2; i += 1) {
      await callTool(auth, 'vault_ask', { question: RECURRING });
    }
  }
} finally {
  await stopVault(vault);
}
console.log('asks: two sessions x two asks each on the same neighborhood');

// --- Step 4: run graduation (mine) synchronously via the CLI ---
const mineOut = execFileSync('node', [vaultMain, 'mine', docsDir, '--corpus', 'practice'], { encoding: 'utf8' });
console.log(mineOut.trimEnd());
check(/\bgraduated\b/.test(mineOut) && !/0 graduated/.test(mineOut), 'mine promoted at least one graduated entry');

// --- Step 5: emit codex v2, diff versus v1, print the first 40 lines ---
const codexV2Raw = execFileSync(
  'node',
  [vaultMain, 'codex', docsDir, '--corpus', 'practice', '--json'],
  { encoding: 'utf8' },
);
const codexV2 = JSON.parse(codexV2Raw);
check(codexV2.version === codexV1.version + 1, `codex v2 bumped (v${codexV1.version} -> v${codexV2.version})`);
check(codexV2.textHash !== codexV1.textHash, 'v2 textHash differs from v1');
check(/Graduated knowledge/.test(codexV2.text), 'v2 contains a Graduated knowledge section');

function diffTexts(a, b) {
  const aLines = new Set(a.split('\n'));
  const bLines = b.split('\n');
  const added = bLines.filter((l) => !aLines.has(l));
  const bSet = new Set(bLines);
  const removed = a.split('\n').filter((l) => !bSet.has(l));
  const lines = [];
  for (const l of removed) lines.push(`- ${l}`);
  for (const l of added) lines.push(`+ ${l}`);
  return lines.join('\n');
}
console.log('\n--- v1 -> v2 diff ---');
console.log(diffTexts(codexV1.text, codexV2.text));

console.log('\n--- v2 first 40 lines ---');
console.log(codexV2.text.split('\n').slice(0, 40).join('\n'));

// --- Step 6: staleness handshake via a fresh server session ---
vault = await startVault();
try {
  const auth = await initSession('team-refresh');
  const staleBody = await callTool(auth, 'vault_ask', {
    question: RECURRING,
    codex_version: codexV1.version,
  });
  const freshBody = await callTool(auth, 'vault_ask', {
    question: RECURRING,
    codex_version: codexV2.version,
  });
  const refreshCount = (staleBody.match(/\[vault codex refresh:/g) ?? []).length;
  check(refreshCount === 1, `stale ask carries exactly one refresh line (got ${refreshCount})`);
  check(new RegExp(`current v${codexV2.version}`).test(staleBody), `refresh line names current v${codexV2.version}`);
  check(!/\[vault codex refresh:/.test(freshBody), 'fresh ask has no refresh line');
} finally {
  await stopVault(vault);
}

// --- Sanity: on-disk state file agrees ---
const state = JSON.parse(readFileSync(path.join(docsDir, '.dcp', 'vault-codex.json'), 'utf8'));
check(state.version === codexV2.version, 'vault-codex.json version matches v2');

// --- Summary ---
console.log('');
if (failures === 0) console.log('all checks passed');
else {
  console.log(`${failures} check(s) FAILED`);
  process.exitCode = 1;
}
