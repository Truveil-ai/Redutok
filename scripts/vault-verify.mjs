// Live verification of the Vault server core against the axios fixture, at
// zero model cost: a scripted MCP client (initialize, tools/list, real
// calls), no LLM anywhere. Mirrors bench-live.mjs's fixture initialization:
// copy the fixture, redutok init, pin profilesDir, codex refresh.
//
//   node scripts/vault-verify.mjs
//
// Exits non-zero unless every check passes, including the >=10x
// raw-versus-served accounting on the URL-assembly ask.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'packages', 'meter', 'dist', 'cli.js');
const vaultMain = path.join(root, 'packages', 'vault', 'dist', 'main.js');
const shared = await import(pathToFileURL(path.join(root, 'packages', 'shared', 'dist', 'index.js')).href);
const { readAuditFile } = shared;

const SECRET = `vault-verify-${Math.random().toString(36).slice(2)}`;
const workDir = path.join(os.tmpdir(), `vault-verify-${Date.now()}`);
const cliEnv = { ...process.env, REDUTOK_HOME: root };

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures += 1;
};

// 1. Corpus: the axios fixture, initialized exactly as bench-live does it.
console.log(`corpus: copying axios fixture to ${workDir}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });
cpSync(path.join(root, 'fixtures', 'repos', 'axios'), workDir, { recursive: true });
execFileSync('node', [cli, 'init', workDir], { cwd: workDir, env: cliEnv });
const configPath = path.join(workDir, '.dcp', 'config.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
config.profilesDir = path.join(root, 'profiles');
writeFileSync(configPath, JSON.stringify(config, null, 2));
execFileSync('node', [cli, 'codex', 'refresh'], { cwd: workDir, env: cliEnv });

// 2. The vault server, mounted over that corpus.
const vault = spawn(
  'node',
  [vaultMain, '--corpus', `axios=${workDir}`, '--port', '0'],
  { env: { ...process.env, REDUTOK_VAULT_SECRET: SECRET }, stdio: ['ignore', 'pipe', 'pipe'] },
);
let vaultStderr = '';
vault.stderr.on('data', (chunk) => {
  vaultStderr += String(chunk);
});
const port = await new Promise((resolve, reject) => {
  const timer = setTimeout(
    () => reject(new Error(`vault did not report a port\n${vaultStderr}`)),
    30_000,
  );
  let out = '';
  vault.stdout.on('data', (chunk) => {
    out += String(chunk);
    const match = /listening on http:\/\/127\.0\.0\.1:(\d+)\/mcp/.exec(out);
    if (match !== null) {
      clearTimeout(timer);
      resolve(Number(match[1]));
    }
  });
  vault.once('exit', (code) => {
    clearTimeout(timer);
    reject(new Error(`vault exited early (${code})\n${vaultStderr}`));
  });
});
console.log(`vault: listening on 127.0.0.1:${port}`);

const url = `http://127.0.0.1:${port}/mcp`;
const post = (body, headers = {}) =>
  globalThis.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
    body: JSON.stringify(body),
  });
const toolText = (body) => body?.result?.content?.[0]?.text ?? '';

try {
  // 3. Initialize handshake: the one unauthenticated request.
  const init = await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vault-verify', version: '0' } },
  });
  const mcpSessionId = init.headers.get('mcp-session-id') ?? '';
  const initBody = await init.json();
  check(init.status === 200 && mcpSessionId !== '', 'initialize handshake succeeds without auth and assigns a session id');
  check(initBody?.result?.protocolVersion === '2025-06-18', 'initialize negotiates the protocol version');
  const session = { 'mcp-session-id': mcpSessionId };
  const auth = { ...session, authorization: `Bearer ${SECRET}` };

  // 4. Unauthenticated and wrongly authenticated calls are rejected.
  const noAuth = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, session);
  check(noAuth.status === 401, 'tools/list without the bearer is rejected with 401');
  const badAuth = await post(
    { jsonrpc: '2.0', id: 3, method: 'tools/list' },
    { ...session, authorization: `Bearer ${SECRET}-wrong` },
  );
  check(badAuth.status === 401, 'a wrong bearer is rejected with 401');

  // 5. tools/list with the bearer.
  const list = await post({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, auth);
  const listBody = await list.json();
  const toolNames = (listBody?.result?.tools ?? []).map((t) => t.name);
  check(
    list.status === 200 && ['vault_ask', 'vault_zoom', 'vault_receipt'].every((t) => toolNames.includes(t)),
    `tools/list serves the three vault tools (${toolNames.join(', ')})`,
  );

  // 6. A real ask about the URL-assembly internals.
  const ask = await post(
    {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'vault_ask',
        arguments: {
          question:
            'How does dispatchRequest hand config to the adapter where buildFullPath, combineURLs, isAbsoluteURL and buildURL assemble the fullPath?',
        },
      },
    },
    auth,
  );
  const askBody = await ask.json();
  const askText = toolText(askBody);
  check(ask.status === 200 && askBody?.result?.isError !== true, 'vault_ask returns a dossier, not an error');
  check(/buildFullPath|buildURL/.test(askText), 'the dossier evidence covers the URL-assembly internals');
  const reduction = Number(/reduction\s+([\d.]+)x/.exec(askText)?.[1] ?? '0');
  check(reduction >= 10, `accounting shows >=10x raw-versus-served (got ${reduction}x)`);
  const accountingBlock = askText.slice(askText.indexOf('[vault accounting:'));
  console.log('\n--- dossier accounting block ---');
  console.log(accountingBlock);
  console.log('--------------------------------\n');

  // 7. Zoom recovers a stored slice byte-equal to a corpus file.
  const evidenceFiles = [
    ...new Set([...askText.matchAll(/^- (.+?):\d+ /gm)].map((m) => m[1])),
  ];
  const handles = [...new Set([...askText.matchAll(/vault_zoom\("(a[0-9a-f]{6})"/g)].map((m) => m[1]))];
  let byteEqual = '';
  for (const handle of handles) {
    if (byteEqual !== '') break;
    const zoomRes = await post(
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'vault_zoom', arguments: { handle } } },
      auth,
    );
    const zoomText = toolText(await zoomRes.json());
    for (const file of evidenceFiles) {
      try {
        if (readFileSync(path.join(workDir, file), 'utf8') === zoomText) {
          byteEqual = `${handle} == ${file}`;
          break;
        }
      } catch {
        // Evidence path not readable as-is; try the next one.
      }
    }
  }
  check(byteEqual !== '', `vault_zoom recovers a slice byte-equal to the corpus (${byteEqual || 'no match'})`);

  // 8. Receipt, reconciled against the audit trail it claims to summarize.
  const receiptRes = await post(
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'vault_receipt', arguments: { scope: 'session' } } },
    auth,
  );
  const receiptText = toolText(await receiptRes.json());
  console.log('\n--- vault receipt (session scope) ---');
  console.log(receiptText);
  console.log('-------------------------------------\n');
  const vaultSessionId = `vault-${mcpSessionId}`;
  const events = readAuditFile(path.join(workDir, '.dcp', 'audit.jsonl')).events.filter(
    (e) => typeof e.sessionId === 'string' && e.sessionId.startsWith(vaultSessionId),
  );
  const avoided = events
    .filter((e) => e.bytesIn !== undefined && e.bytesOut !== undefined)
    .reduce((n, e) => n + Math.max(0, Math.round(e.bytesIn / 4) - Math.round(e.bytesOut / 4)), 0);
  const claimed = Number((/avoided ([\d,]+) tok/.exec(receiptText)?.[1] ?? '-1').replace(/,/g, ''));
  check(claimed === avoided, `receipt reconciles with the audit trail (${claimed} == ${avoided} tokens avoided)`);
  check(/cost avoided est \$/.test(receiptText), 'receipt prices cost avoided from prices.yaml');
  check(/Wh \(band /.test(receiptText) && /gCO2e \(band /.test(receiptText), 'receipt carries Wh and gCO2e bands');
} finally {
  vault.kill();
  await new Promise((resolve) => {
    vault.once('exit', resolve);
    setTimeout(resolve, 3000);
  });
  try {
    rmSync(workDir, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    console.log(`note: could not remove ${workDir}`);
  }
}

console.log(failures === 0 ? 'vault-verify: all checks passed' : `vault-verify: ${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
