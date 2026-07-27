import { readFileSync } from 'node:fs';
import path from 'node:path';
import { sidecarRequest, type SidecarTarget } from '@redutok/sidecar/client';

/**
 * DCP MCP server core: a pure JSON-RPC handler so tests need no stdio.
 * Every tool is a thin client of the sidecar with the fail-open rule from
 * the architecture: sidecar down means raw passthrough with a notice.
 */

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface McpDeps {
  target?: SidecarTarget;
  timeoutMs?: number;
  sessionId?: string;
}

const NOTICE = '[dcp notice: sidecar unavailable, raw passthrough]';

const TOOLS = [
  {
    name: 'dcp__read',
    description:
      'Read a source file as a distilled skeleton (signatures and docstrings) with a zoom handle. Falls back to raw when the sidecar is down.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute or repo-relative file path' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'dcp__run',
    description:
      'Run a shell command and return distilled output (verdict, first error, handles). Falls back to raw output when the sidecar is down.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string' },
      },
      required: ['command'],
    },
  },
  {
    name: 'dcp__search',
    description:
      'Search file contents under a directory and return ranked, capped hits with a zoom handle.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression' },
        path: { type: 'string', description: 'Directory to search, default cwd' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'dcp__explore',
    description:
      'Run one bounded internal exploration hunt against a goal (search, then skeleton-read the most relevant files) and return a single dossier: verdict, evidence, zoom handles. Replaces a turn-by-turn read/search/zoom loop with one call. Read-only; a goal that requires a mutation comes back incomplete with a continuation hint.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'Natural-language statement of what to find or answer' },
        scope: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional path hints to bound the search; omitted means repo-wide',
        },
        budget: {
          type: 'string',
          enum: ['quick', 'standard', 'thorough'],
          description: 'Internal step-count and wall-clock ceiling; default standard',
        },
      },
      required: ['goal'],
    },
  },
  {
    name: 'dcp__zoom',
    description: 'Recover the raw artifact behind a dcp handle id, optionally sliced by a query.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        query: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'dcp__state',
    description: 'Report sidecar health and session distillation state.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function text(value: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: value }] };
}

async function distillViaSidecar(
  deps: McpDeps,
  raw: string,
  profile: string,
  filePath?: string,
): Promise<string> {
  const res = await sidecarRequest(
    deps.target ?? {},
    'POST',
    '/distill',
    { raw, profile, sessionId: deps.sessionId ?? 'mcp-session', filePath },
    { timeoutMs: deps.timeoutMs ?? 2500 },
  );
  if (!res.ok || res.status !== 200) return `${raw}\n${NOTICE}`;
  const body = res.body as { text: string; handle: string };
  return `${body.text}\n${body.handle}`;
}

async function toolRead(deps: McpDeps, args: Record<string, unknown>): Promise<string> {
  // The schema names the argument file_path, but callers do send `path`
  // (dcp__search's name for it) — observed in a real session, where
  // String(undefined) then resolved to a literal file named "undefined".
  // Accept the alias; anything else fails with the argument name, not ENOENT.
  const pathArg = args['file_path'] ?? args['path'];
  if (typeof pathArg !== 'string' || pathArg.length === 0) {
    return 'dcp__read failed: missing required argument file_path (string)';
  }
  const filePath = pathArg;
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    return `dcp__read failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  // Delta path first: unchanged files return a reference, changed files a
  // unified diff, and only first serves flow through the skeleton profile.
  const res = await sidecarRequest(
    deps.target ?? {},
    'POST',
    '/serve-file',
    { raw, path: filePath, sessionId: deps.sessionId ?? 'mcp-session' },
    { timeoutMs: deps.timeoutMs ?? 2500 },
  );
  if (!res.ok || res.status !== 200) return `${raw}\n${NOTICE}`;
  const body = res.body as { text: string; handle: string };
  return `${body.text}\n${body.handle}`;
}

async function toolRun(deps: McpDeps, args: Record<string, unknown>): Promise<string> {
  const { execSync } = await import('node:child_process');
  const command = String(args['command']);
  let raw: string;
  try {
    raw = execSync(command, {
      cwd: args['cwd'] === undefined ? process.cwd() : String(args['cwd']),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300_000,
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    raw = `${e.stdout ?? ''}\n${e.stderr ?? ''}\ncommand failed: ${e.message}`;
  }
  const profile = /\b(tsc|build)\b/.test(command)
    ? 'build-log'
    : /\b(vitest|jest|test)\b/.test(command)
      ? 'test-output'
      : 'generic-stdout';
  return distillViaSidecar(deps, raw, profile);
}

async function toolSearch(deps: McpDeps, args: Record<string, unknown>): Promise<string> {
  const { readdirSync, statSync } = await import('node:fs');
  const pattern = new RegExp(String(args['pattern']));
  const root = args['path'] === undefined ? process.cwd() : String(args['path']);
  const hits: string[] = [];
  const skip = new Set(['node_modules', '.git', 'dist', '.dcp', 'coverage']);
  const walk = (dir: string): void => {
    if (hits.length >= 2000) return;
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (skip.has(name)) continue;
      const full = path.join(dir, name);
      try {
        const stats = statSync(full);
        if (stats.isDirectory()) walk(full);
        else if (stats.size < 1_000_000) {
          const lines = readFileSync(full, 'utf8').split(/\r?\n/);
          lines.forEach((line, i) => {
            if (pattern.test(line)) hits.push(`${path.relative(root, full)}:${i + 1}:${line}`);
          });
        }
      } catch {
        continue;
      }
    }
  };
  walk(root);
  if (hits.length === 0) return `no matches for ${String(args['pattern'])} under ${root}`;
  return distillViaSidecar(deps, hits.join('\n'), 'search-results');
}

interface ExploreDossier {
  verdict: string;
  evidence: { file: string; line: number; snippet: string; why: string }[];
  zoomHandles: string[];
  stepsTaken: number;
  distillationRatio: number;
  incomplete?: { reason: string; continuationHint: string };
}

async function toolExplore(deps: McpDeps, args: Record<string, unknown>): Promise<string> {
  const goal = String(args['goal'] ?? '');
  const scope = Array.isArray(args['scope']) ? (args['scope'] as unknown[]).map(String) : undefined;
  const budget = args['budget'] === undefined ? undefined : String(args['budget']);
  const res = await sidecarRequest(
    deps.target ?? {},
    'POST',
    '/explore',
    { goal, scope, budget, sessionId: deps.sessionId ?? 'mcp-session' },
    { timeoutMs: deps.timeoutMs ?? 20_000 },
  );
  if (!res.ok || res.status !== 200) {
    return `dcp__explore: sidecar unavailable, fall back to raw Read/Bash/Grep for this exploration.\n${NOTICE}`;
  }
  const d = res.body as ExploreDossier;
  const lines = [
    `verdict: ${d.verdict}`,
    '',
    'evidence:',
    ...(d.evidence.length === 0 ? ['(none)'] : d.evidence.map((e) => `- ${e.file}:${e.line}: ${e.snippet} (${e.why})`)),
    '',
    `steps taken: ${d.stepsTaken}, distillation ratio: ${d.distillationRatio.toFixed(1)}x`,
    d.zoomHandles.length === 0
      ? 'zoom handles: none'
      : `zoom handles: ${d.zoomHandles.map((id) => `dcp__zoom("${id}")`).join(', ')}`,
  ];
  if (d.incomplete !== undefined) {
    lines.push(`incomplete: ${d.incomplete.reason} — ${d.incomplete.continuationHint}`);
  }
  return lines.join('\n');
}

async function toolZoom(deps: McpDeps, args: Record<string, unknown>): Promise<string> {
  const res = await sidecarRequest(
    deps.target ?? {},
    'POST',
    '/zoom',
    { id: String(args['id']), query: args['query'] === undefined ? undefined : String(args['query']) },
    { timeoutMs: deps.timeoutMs ?? 2500 },
  );
  if (!res.ok) return `dcp__zoom: sidecar unavailable (${res.error}); the raw artifact cannot be recovered until redutok up`;
  const body = res.body as { found: boolean; text: string };
  return body.text;
}

async function toolState(deps: McpDeps): Promise<string> {
  const res = await sidecarRequest(deps.target ?? {}, 'GET', '/health', undefined, {
    timeoutMs: deps.timeoutMs ?? 1500,
  });
  if (!res.ok) return 'Sidecar: not running. Sessions degrade to raw passthrough. Start it with redutok up.';
  const body = res.body as { pid: number; uptimeMs: number };
  return `Sidecar: running, pid ${body.pid}, uptime ${Math.round(body.uptimeMs / 1000)}s.`;
}

export async function handleMcpRequest(
  req: JsonRpcRequest,
  deps: McpDeps,
): Promise<JsonRpcResponse | null> {
  const reply = (result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id: req.id ?? null, result });
  if (req.method.startsWith('notifications/')) return null;
  if (req.method === 'initialize') {
    return reply({
      protocolVersion: '2024-11-05',
      serverInfo: { name: 'redutok-dcp', version: '0.0.1' },
      capabilities: { tools: {} },
    });
  }
  if (req.method === 'tools/list') return reply({ tools: TOOLS });
  if (req.method === 'tools/call') {
    const params = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    const args = params.arguments ?? {};
    const run: Record<string, () => Promise<string>> = {
      dcp__read: () => toolRead(deps, args),
      dcp__run: () => toolRun(deps, args),
      dcp__search: () => toolSearch(deps, args),
      dcp__explore: () => toolExplore(deps, args),
      dcp__zoom: () => toolZoom(deps, args),
      dcp__state: () => toolState(deps),
    };
    const fn = run[params.name ?? ''];
    if (fn === undefined) {
      return { jsonrpc: '2.0', id: req.id ?? null, error: { code: -32602, message: `unknown tool ${params.name}` } };
    }
    return reply(text(await fn()));
  }
  return { jsonrpc: '2.0', id: req.id ?? null, error: { code: -32601, message: `method not found: ${req.method}` } };
}
