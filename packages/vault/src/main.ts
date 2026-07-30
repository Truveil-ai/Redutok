import { randomBytes } from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { resolveSecret } from './auth.js';
import { mountCorpus, type Corpus } from './corpus.js';
import { startVaultServer } from './http.js';
import { handleVaultRequest, type JsonRpcRequest, type JsonRpcResponse } from './server.js';
import { newVaultSession } from './tools.js';

/**
 * redutok-vault entry: streamable HTTP by default, --stdio for local
 * testing. HTTP requires a bearer agent secret (REDUTOK_VAULT_SECRET or
 * <corpus>/.dcp/vault.json); stdio has no headers to carry one, so it is
 * documented as trusted-local only.
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

async function runStdio(corpora: Map<string, Corpus>): Promise<void> {
  const session = newVaultSession(`stdio-${randomBytes(4).toString('hex')}`);
  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (line.trim() === '') continue;
    let response: JsonRpcResponse | null;
    try {
      const rpc = JSON.parse(line) as JsonRpcRequest;
      response = await handleVaultRequest(rpc, { corpora, session }, { authorized: true });
    } catch {
      response = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } };
    }
    if (response !== null) process.stdout.write(JSON.stringify(response) + '\n');
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
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
