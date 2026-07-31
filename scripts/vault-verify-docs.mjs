// Live verification of Vault Session 2 (document ingestion) at zero model
// cost: copy the mixed doc-corpus fixture, generate its PDF/DOCX halves,
// ingest it with the real CLI, mount it, and drive the server with a
// scripted MCP client. Verifies: a cross-document ask cited by document,
// section, and page with the accounting block; byte-equal section recovery
// from the store; hash-incremental re-ingest; the prose entity gate blocking
// a distillate that drops a date; and X-Vault-Session identity on receipts.
//
//   node scripts/vault-verify-docs.mjs
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeDocFixtures } from './doc-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vaultMain = path.join(root, 'packages', 'vault', 'dist', 'main.js');
const sidecar = await import(
  pathToFileURL(path.join(root, 'packages', 'sidecar', 'dist', 'index.js')).href
);

const SECRET = `vault-verify-docs-${Math.random().toString(36).slice(2)}`;
const VAULT_SESSION = 'verify-docs-1';
const workDir = path.join(os.tmpdir(), `vault-verify-docs-${Date.now()}`);

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures += 1;
};

// 1. Corpus: the checked-in md/txt/ts fixture plus script-generated binaries.
console.log(`corpus: assembling doc-corpus fixture at ${workDir}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });
cpSync(path.join(root, 'fixtures', 'doc-corpus'), workDir, { recursive: true });
writeDocFixtures(workDir);

// 2. Ingest with the real CLI, then re-ingest to prove incrementality.
console.log('\n--- vault ingest (first run) ---');
console.log(execFileSync('node', [vaultMain, 'ingest', workDir, '--corpus', 'practice'], { encoding: 'utf8' }).trim());
const dcp = path.join(workDir, '.dcp');
const indexAfterFirst = JSON.parse(readFileSync(path.join(dcp, 'documents.json'), 'utf8'));
const provenance = JSON.parse(readFileSync(path.join(dcp, 'PROVENANCE.json'), 'utf8'));
check(provenance.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)), 'PROVENANCE hashes every source file');
const scanned = indexAfterFirst.documents.find((d) => d.path === 'scanned-notes.pdf');
check(
  scanned !== undefined && typeof scanned.outOfScope === 'string' && scanned.outOfScope !== '',
  `scanned pdf declared out of scope: "${scanned?.outOfScope ?? 'MISSING'}"`,
);
execFileSync('node', [vaultMain, 'ingest', workDir, '--corpus', 'practice'], { encoding: 'utf8' });
const indexAfterSecond = JSON.parse(readFileSync(path.join(dcp, 'documents.json'), 'utf8'));
check(
  indexAfterFirst.documents.every(
    (d) => indexAfterSecond.documents.find((e) => e.path === d.path)?.artifactId === d.artifactId,
  ),
  're-ingest is incremental by hash: every unchanged artifact id survives',
);

// 3. The entity gate, demonstrably blocking a distillate that drops a date:
// a doctored doc-serve profile truncates section bodies to one line, which
// drops 2026-03-31/2033-03-31 from the conclusion-relevant region.
{
  const gateDir = mkdtempSync(path.join(os.tmpdir(), 'vault-verify-gate-'));
  const store = sidecar.openStore(path.join(gateDir, 'state.db'));
  const audit = new sidecar.AuditWriter(path.join(gateDir, 'audit.jsonl'));
  const profiles = sidecar.loadProfiles(path.join(root, 'profiles'));
  const extraction = sidecar.extractDocument(path.join(workDir, 'retention-schedule.txt'));
  const sections = await sidecar.buildStructureMap(extraction, new sidecar.NoopLlmPass());
  const doctored = {
    ...profiles.get('doc-serve'),
    rules: [{ kind: 'relevant-sections', config: { maxSections: 4, maxSectionLines: 1 } }],
  };
  const outcome = await sidecar.distillArtifact(store, audit, {
    raw: extraction.text,
    profile: doctored,
    sessionId: 'verify-gate',
    tool: 'vault_ask',
    context: {
      filePath: 'retention-schedule.txt',
      doc: { sections, ask: 'how long must valuation workpapers be retained' },
    },
  });
  const entityGate = outcome.gateReport.results.find((r) => r.gate === 'entity-preservation');
  check(
    outcome.served === 'raw' && entityGate?.passed === false,
    `entity gate blocks a distillate that drops a date (served raw; ${entityGate?.detail ?? 'no gate ran'})`,
  );
  store.close();
  try {
    rmSync(gateDir, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // best effort
  }
}

// 4. The vault server over the ingested corpus.
const vault = spawn('node', [vaultMain, '--corpus', `practice=${workDir}`, '--port', '0'], {
  env: { ...process.env, REDUTOK_VAULT_SECRET: SECRET },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let vaultStderr = '';
vault.stderr.on('data', (chunk) => {
  vaultStderr += String(chunk);
});
const port = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`vault did not report a port\n${vaultStderr}`)), 30_000);
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
console.log(`\nvault: listening on 127.0.0.1:${port}`);

const url = `http://127.0.0.1:${port}/mcp`;
const post = (body, headers = {}) =>
  globalThis.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
    body: JSON.stringify(body),
  });
const toolText = (body) => body?.result?.content?.[0]?.text ?? '';

try {
  // 5. Initialize with an explicit vault session identity.
  const init = await post(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vault-verify-docs', version: '0' } },
    },
    { 'x-vault-session': VAULT_SESSION },
  );
  const mcpSessionId = init.headers.get('mcp-session-id') ?? '';
  check(init.status === 200 && mcpSessionId !== '', 'initialize succeeds and assigns an mcp session id');
  const auth = { 'mcp-session-id': mcpSessionId, authorization: `Bearer ${SECRET}` };

  // 6. A question whose answer spans two documents.
  const question =
    'What fixed fee applies to the Meridian valuation engagement and how long must its workpapers be retained?';
  const ask = await post(
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'vault_ask', arguments: { question } } },
    auth,
  );
  const askBody = await ask.json();
  const askText = toolText(askBody);
  check(ask.status === 200 && askBody?.result?.isError !== true, 'vault_ask returns a dossier, not an error');
  check(
    askText.includes('engagement-letter.docx') && askText.includes('retention-schedule.txt'),
    'the dossier spans both documents (engagement letter + retention schedule)',
  );
  check(/§3/.test(askText) && /§2/.test(askText), 'citations name sections (§3 fees, §2 workpaper retention)');
  check(/p\.\d/.test(askText), 'citations carry page anchors where the format has pages');
  const reduction = Number(/reduction\s+([\d.]+)x/.exec(askText)?.[1] ?? '0');
  check(reduction >= 1.5, `accounting reconciles with a real reduction (got ${reduction}x)`);
  console.log('\n--- dossier (cross-document ask) ---');
  console.log(askText);
  console.log('------------------------------------');

  // 7. Zoom recovers the cited fees section byte-equal from the store.
  const letter = indexAfterSecond.documents.find((d) => d.path === 'engagement-letter.docx');
  const fees = letter?.sections.find((s) => s.id === '3');
  const zoomRes = await post(
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'vault_zoom', arguments: { handle: letter?.artifactId ?? '', query: '§3' } },
    },
    auth,
  );
  const zoomText = toolText(await zoomRes.json());
  const store = sidecar.openStore(path.join(dcp, 'state.db'));
  const stored = store.getArtifact(letter?.artifactId ?? '');
  const expected = sidecar.sectionText(stored?.raw ?? '', fees ?? { startLine: 1, endLine: 1 });
  store.close();
  check(
    zoomText !== '' && zoomText === expected,
    `vault_zoom("§3") recovers the fees section byte-equal from the store (${Buffer.byteLength(zoomText, 'utf8')} bytes)`,
  );

  // 8. Receipt attributes to the explicit X-Vault-Session identity.
  const receiptRes = await post(
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'vault_receipt', arguments: { scope: 'session' } } },
    auth,
  );
  const receiptText = toolText(await receiptRes.json());
  check(
    receiptText.includes(`vault-${VAULT_SESSION}`),
    `receipt attributes to the explicit session (vault-${VAULT_SESSION})`,
  );
  console.log('\n--- vault receipt (session scope) ---');
  console.log(receiptText);
  console.log('-------------------------------------');
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

console.log(failures === 0 ? '\nvault-verify-docs: all checks passed' : `\nvault-verify-docs: ${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
