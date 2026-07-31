import { randomBytes } from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { resolveSecret } from './auth.js';
import { mountCorpus, type Corpus } from './corpus.js';
import { startVaultServer } from './http.js';
import { runIngest } from './ingest.js';
import { handleVaultRequest, type JsonRpcRequest, type JsonRpcResponse } from './server.js';
import { statementFromDcp } from './statement.js';
import { newVaultSession, type VaultSession } from './tools.js';

/**
 * redutok-vault entry: streamable HTTP by default, --stdio for local
 * testing, `ingest <path> --corpus <name>` to build the .dcp state for an
 * arbitrary directory. HTTP requires a bearer agent secret
 * (REDUTOK_VAULT_SECRET or <corpus>/.dcp/vault.json); stdio has no headers
 * to carry one, so it is documented as trusted-local only.
 */

export interface CliOptions {
  corpora: string[];
  port: number;
  host?: string;
  allowExternal: boolean;
  stdio: boolean;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { corpora: [], port: 48650, allowExternal: false, stdio: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${String(arg)} needs a value`);
      i += 1;
      return value;
    };
    if (arg === '--corpus') options.corpora.push(next());
    else if (arg === '--port') options.port = Number(next());
    else if (arg === '--host') options.host = next();
    else if (arg === '--allow-external') options.allowExternal = true;
    else if (arg === '--stdio') options.stdio = true;
    else throw new Error(`unknown argument ${String(arg)} (usage: redutok-vault --corpus <path | name=path> [--port N] [--host ADDR --allow-external] [--stdio])`);
  }
  return options;
}

/**
 * Session identity over stdio (Session 1 finding): every initialize mints a
 * fresh per-initialize session id — never a shared per-process fallback — so
 * receipts and audit attribute strictly per session. Requests before any
 * initialize are refused rather than served on an implicit identity.
 */
export function createStdioHandler(
  corpora: Map<string, Corpus>,
): (line: string) => Promise<JsonRpcResponse | null> {
  let session: VaultSession | undefined;
  return async (line) => {
    let rpc: JsonRpcRequest;
    try {
      rpc = JSON.parse(line) as JsonRpcRequest;
    } catch {
      return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } };
    }
    if (rpc.method === 'initialize') {
      session = newVaultSession(`stdio-${randomBytes(4).toString('hex')}`);
    }
    if (session === undefined) {
      if (rpc.method.startsWith('notifications/')) return null;
      return {
        jsonrpc: '2.0',
        id: rpc.id ?? null,
        error: { code: -32002, message: 'no session on this stdio stream: initialize first' },
      };
    }
    return handleVaultRequest(rpc, { corpora, session }, { authorized: true });
  };
}

async function runStdio(corpora: Map<string, Corpus>): Promise<void> {
  const handler = createStdioHandler(corpora);
  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (line.trim() === '') continue;
    const response = await handler(line);
    if (response !== null) process.stdout.write(JSON.stringify(response) + '\n');
  }
}

async function runIngestCommand(argv: string[]): Promise<void> {
  let target: string | undefined;
  let corpus: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--corpus') {
      corpus = argv[i + 1];
      i += 1;
    } else if (target === undefined && arg !== undefined && !arg.startsWith('--')) {
      target = arg;
    } else {
      throw new Error(`unknown argument ${String(arg)} (usage: redutok-vault ingest <path> --corpus <name>)`);
    }
  }
  if (target === undefined || corpus === undefined || corpus === '') {
    throw new Error('usage: redutok-vault ingest <path> --corpus <name>');
  }
  const summary = await runIngest(target, { corpus });
  for (const file of summary.files) {
    if (file.status === 'document' || file.status === 'out-of-scope') {
      console.log(`  ${file.status.padEnd(12)} ${file.path} (${file.method})`);
    }
  }
  console.log(
    `ingested corpus ${summary.corpus} at ${summary.root}: ${summary.documents} document(s) extracted, ` +
      `${summary.unchanged} unchanged, ${summary.outOfScope} out of scope, ${summary.files.length} file(s) in PROVENANCE.json`,
  );
}

export interface StatementArgs {
  target: string;
  corpus?: string;
  month: string;
  json: boolean;
}

export function parseStatementArgs(argv: string[]): StatementArgs {
  let target: string | undefined;
  let corpus: string | undefined;
  let month: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--corpus') {
      corpus = argv[i + 1];
      i += 1;
    } else if (arg === '--month') {
      month = argv[i + 1];
      i += 1;
      if (month === undefined || !/^\d{4}-\d{2}$/.test(month)) {
        throw new Error(`invalid --month "${String(month)}" (YYYY-MM)`);
      }
    } else if (arg === '--json') {
      json = true;
    } else if (target === undefined && arg !== undefined && !arg.startsWith('--')) {
      target = arg;
    } else {
      throw new Error(
        `unknown argument ${String(arg)} (usage: redutok-vault statement <path> [--corpus <name>] [--month YYYY-MM] [--json])`,
      );
    }
  }
  if (target === undefined) {
    throw new Error('usage: redutok-vault statement <path> [--corpus <name>] [--month YYYY-MM] [--json]');
  }
  const args: StatementArgs = {
    target,
    month: month ?? new Date().toISOString().slice(0, 7),
    json,
  };
  if (corpus !== undefined) args.corpus = corpus;
  return args;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv[0] === 'ingest') {
    await runIngestCommand(argv.slice(1));
    return;
  }
  if (argv[0] === 'statement') {
    const args = parseStatementArgs(argv.slice(1));
    const opts: Parameters<typeof statementFromDcp>[1] = { month: args.month, json: args.json };
    if (args.corpus !== undefined) opts.corpus = args.corpus;
    console.log(statementFromDcp(args.target, opts));
    return;
  }
  const options = parseArgs(argv);
  if (options.corpora.length === 0) {
    throw new Error('at least one --corpus <path | name=path> is required');
  }
  const corpora = new Map<string, Corpus>();
  for (const spec of options.corpora) {
    const eq = spec.indexOf('=');
    const corpus =
      eq === -1
        ? mountCorpus(spec)
        : mountCorpus(spec.slice(eq + 1), { name: spec.slice(0, eq) });
    if (corpora.has(corpus.name)) throw new Error(`duplicate corpus name ${corpus.name}`);
    corpora.set(corpus.name, corpus);
  }
  if (options.stdio) {
    await runStdio(corpora);
    return;
  }
  const first = corpora.values().next();
  if (first.done === true) throw new Error('no corpus mounted');
  const secret = resolveSecret(first.value.dcpDir);
  if (secret === undefined) {
    throw new Error(
      'no agent secret: set REDUTOK_VAULT_SECRET or write { "secret": "..." } to <corpus>/.dcp/vault.json',
    );
  }
  const serverOptions: Parameters<typeof startVaultServer>[0] = {
    corpora,
    secret: secret.secret,
    port: options.port,
    allowExternal: options.allowExternal,
  };
  if (options.host !== undefined) serverOptions.host = options.host;
  const handle = await startVaultServer(serverOptions);
  // The parent (a launcher or the verify script) reads this line for the port.
  console.log(
    `redutok vault listening on http://${handle.host}:${handle.port}/mcp (corpora: ${[...corpora.keys()].join(', ')}; secret from ${secret.source})`,
  );
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  main().catch((err: unknown) => {
    console.error(`redutok-vault failed to start: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
