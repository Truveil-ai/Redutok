import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  CodexFileSchema,
  CodexLockSchema,
  LIMITS,
  type CodexFile,
  type CodexLock,
} from '@redutok/shared';
import { estimateTokens } from './distill.js';
import { fileSkeleton, languageForPath } from './skeleton.js';

/**
 * Codex engine, architecture section 3. The structural pass is deterministic
 * and LLM-free; the semantic pass is an optional enhancement behind
 * --with-llm (guardrail 6). Output is byte-stable across re-runs on
 * unchanged input: generatedAt only moves when content changes.
 */

const SOURCE_EXT = new Set(['.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs', '.py']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.dcp', '.claude', 'coverage', 'backup']);

export function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const full = path.join(dir, name);
      const stats = statSync(full);
      if (stats.isDirectory()) walk(full);
      else if (SOURCE_EXT.has(path.extname(name)) && stats.size < 1_000_000) {
        out.push(path.relative(root, full).replace(/\\/g, '/'));
      }
    }
  };
  walk(root);
  return out.sort();
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

function roleFor(dirPath: string): string {
  const name = dirPath.split('/').pop() ?? dirPath;
  if (/test/.test(name)) return 'tests';
  if (name === 'src' || name === 'lib') return 'implementation';
  if (/script/.test(name)) return 'maintenance scripts';
  if (/fixture/.test(name)) return 'test fixtures';
  if (/doc/.test(name)) return 'documentation';
  return 'unclassified';
}

interface FileIndexEntry {
  hash: string;
  interfaces: { name: string; signature: string; file: string }[];
  imports: string[];
  exports: string[];
}

async function indexFile(root: string, rel: string): Promise<FileIndexEntry> {
  const content = readFileSync(path.join(root, rel), 'utf8');
  const lang = languageForPath(rel) ?? 'ts';
  let skeleton = '';
  try {
    skeleton = await fileSkeleton(content, lang);
  } catch {
    skeleton = '';
  }
  const interfaces: FileIndexEntry['interfaces'] = [];
  const exports: string[] = [];
  for (const line of skeleton.split('\n')) {
    const sig = line.trim().replace(/ \.\.\.$/, '');
    const m =
      /^export (?:async )?(?:function|class|interface|type|const|enum|abstract class) ([A-Za-z0-9_$]+)/.exec(sig) ??
      /^(?:class|def) ([A-Za-z0-9_$]+)/.exec(sig);
    if (m !== null && sig.length < 160) {
      interfaces.push({ name: m[1] as string, signature: sig, file: rel });
      exports.push(m[1] as string);
    }
  }
  const imports = content
    .split(/\r?\n/)
    .map((l) => /^\s*(?:import .*?from\s+['"](\.[^'"]+)['"]|from\s+(\.[^\s]+)\s+import)/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => (m[1] ?? m[2]) as string);
  return { hash: sha256(content), interfaces, imports, exports };
}

function preserveLocked(generated: CodexFile, existing?: CodexFile): CodexFile {
  if (existing === undefined) return generated;
  // Human sections carry over wholesale; locked entries are never modified,
  // and unlocked human-section entries survive regeneration too.
  const merged = { ...generated };
  merged.architecture = existing.architecture;
  merged.glossary = existing.glossary;
  merged.pitfalls = existing.pitfalls;
  merged.conventions = existing.conventions;
  merged.locked = existing.locked;
  if (existing.summary !== undefined && existing.locked.includes('summary')) {
    merged.summary = existing.summary;
  }
  merged.map = merged.map.map((entry) => {
    const prior = existing.map.find((e) => e.path === entry.path);
    return prior !== undefined && (prior.locked || prior.roleSource !== 'rules') ? { ...entry, role: prior.role, roleSource: prior.roleSource, locked: prior.locked } : entry;
  });
  return merged;
}

export interface CodexPaths {
  yaml: string;
  lock: string;
}

export function codexPaths(root: string): CodexPaths {
  const dir = path.join(root, '.dcp');
  return { yaml: path.join(dir, 'codex.yaml'), lock: path.join(dir, 'codex.lock') };
}

export function readCodex(root: string): { codex?: CodexFile; lock?: CodexLock } {
  const paths = codexPaths(root);
  const codex = existsSync(paths.yaml)
    ? CodexFileSchema.parse(parseYaml(readFileSync(paths.yaml, 'utf8')))
    : undefined;
  const lock = existsSync(paths.lock)
    ? CodexLockSchema.parse(JSON.parse(readFileSync(paths.lock, 'utf8')))
    : undefined;
  return { codex, lock };
}

function fingerprintOf(files: Record<string, string>): string {
  return sha256(
    Object.keys(files)
      .sort()
      .map((p) => `${p}:${files[p]}`)
      .join('\n'),
  );
}

export interface CodexResult {
  changed: boolean;
  codex: CodexFile;
  lock: CodexLock;
}

export async function buildStructuralCodex(root: string): Promise<CodexResult> {
  const { codex: existing, lock: existingLock } = readCodex(root);
  const rels = listSourceFiles(root);
  const hashes: Record<string, string> = {};
  const interfaces: CodexFile['interfaces'] = [];
  const importGraph: Record<string, string[]> = {};
  const byDir = new Map<string, string[]>();

  for (const rel of rels) {
    const entry = await indexFile(root, rel);
    hashes[rel] = entry.hash;
    interfaces.push(...entry.interfaces.slice(0, 4));
    if (entry.imports.length > 0) importGraph[rel] = entry.imports;
    const dir = path.dirname(rel).replace(/\\/g, '/');
    byDir.set(dir, [...(byDir.get(dir) ?? []), ...entry.exports.slice(0, 3)]);
  }

  const lock: CodexLock = { version: 1, repoFingerprint: fingerprintOf(hashes), files: hashes };
  if (existing !== undefined && existingLock !== undefined && existingLock.repoFingerprint === lock.repoFingerprint) {
    return { changed: false, codex: existing, lock: existingLock };
  }

  const generated = CodexFileSchema.parse({
    version: '1',
    project: path.basename(root),
    generatedAt: new Date().toISOString(),
    summary: existing?.summary,
    map: [...byDir.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([dir, symbols]) => ({
        path: dir,
        role: roleFor(dir),
        roleSource: 'rules',
        keySymbols: [...new Set(symbols)].slice(0, 8),
      })),
    interfaces: interfaces.sort((a, b) => (a.file + a.name).localeCompare(b.file + b.name)),
    importGraph,
    files: rels.map((rel) => ({ path: rel, hash: hashes[rel] as string })),
  });
  return { changed: true, codex: preserveLocked(generated, existing), lock };
}

export async function writeCodex(root: string): Promise<CodexResult> {
  const result = await buildStructuralCodex(root);
  if (!result.changed) return result;
  const paths = codexPaths(root);
  mkdirSync(path.dirname(paths.yaml), { recursive: true });
  writeFileSync(paths.yaml, stringifyYaml(result.codex), 'utf8');
  writeFileSync(paths.lock, JSON.stringify(result.lock, null, 2) + '\n', 'utf8');
  return result;
}

/** Incremental path: re-skeleton and re-hash exactly the given files. */
export async function refreshFiles(root: string, changed: string[]): Promise<string[]> {
  const { codex, lock } = readCodex(root);
  if (codex === undefined || lock === undefined) return [];
  const reindexed: string[] = [];
  for (const relRaw of changed) {
    const rel = relRaw.replace(/\\/g, '/');
    if (!existsSync(path.join(root, rel)) || !SOURCE_EXT.has(path.extname(rel))) continue;
    const entry = await indexFile(root, rel);
    if (lock.files[rel] === entry.hash) continue;
    lock.files[rel] = entry.hash;
    codex.interfaces = [
      ...codex.interfaces.filter((i) => i.file !== rel),
      ...entry.interfaces.slice(0, 4),
    ].sort((a, b) => ((a.file ?? '') + a.name).localeCompare((b.file ?? '') + b.name));
    if (entry.imports.length > 0) codex.importGraph[rel] = entry.imports;
    else delete codex.importGraph[rel];
    const fileRow = codex.files.find((f) => f.path === rel);
    if (fileRow !== undefined) fileRow.hash = entry.hash;
    else codex.files.push({ path: rel, hash: entry.hash });
    reindexed.push(rel);
  }
  if (reindexed.length > 0) {
    lock.repoFingerprint = fingerprintOf(lock.files);
    codex.generatedAt = new Date().toISOString();
    const paths = codexPaths(root);
    writeFileSync(paths.yaml, stringifyYaml(codex), 'utf8');
    writeFileSync(paths.lock, JSON.stringify(lock, null, 2) + '\n', 'utf8');
  }
  return reindexed;
}

/** Injection, architecture 3.4: codex minus the files index, trust preamble, hard 3k budget. */
export const TRUST_PREAMBLE =
  'You have a verified codex of this repository. Trust it. Do not re-explore structure that the codex covers. Use dcp tools to read code.';

/** Documented degrade order when the injection exceeds the budget. */
export const DEGRADE_ORDER = ['glossary', 'conventions', 'importGraph', 'interfaces', 'keySymbols'] as const;

export function buildCodexInjection(codex: CodexFile, maxTokens = 3000): string {
  const slim: Record<string, unknown> = { ...codex };
  delete slim['files'];
  const dropped: string[] = [];
  const render = (): string => {
    const note =
      dropped.length > 0 ? `\n[codex sections dropped to fit the budget: ${dropped.join(', ')}]` : '';
    return `${TRUST_PREAMBLE}\n\n${stringifyYaml(slim)}${note}`;
  };
  let text = render();
  for (const section of DEGRADE_ORDER) {
    if (estimateTokens(text) <= maxTokens) break;
    if (section === 'keySymbols') {
      slim['map'] = (slim['map'] as { path: string; role: string }[]).map((m) => ({
        path: m.path,
        role: m.role,
      }));
    } else {
      delete slim[section];
    }
    dropped.push(section);
    text = render();
  }
  return text;
}

/** Ollama client for the semantic pass. Never throws; null means fall back to rules. */
export async function ollamaGenerate(
  baseUrl: string,
  model: string,
  prompt: string,
  timeoutMs: number = LIMITS.LOCAL_LLM_TIMEOUT_MS,
): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const url = new URL('/api/generate', baseUrl);
      // num_predict bounds decode time so single-sentence drafts cannot run long.
      const body = JSON.stringify({ model, prompt, stream: false, options: { num_predict: 64 } });
      const req = http.request(
        {
          method: 'POST',
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          timeout: timeoutMs,
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { response?: string };
              resolve(typeof parsed.response === 'string' ? parsed.response.trim() : null);
            } catch {
              resolve(null);
            }
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', () => resolve(null));
      req.write(body);
      req.end();
    } catch {
      resolve(null);
    }
  });
}

export interface SemanticOptions {
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  warmupTimeoutMs?: number;
}

export interface SemanticOutcome {
  status: 'complete' | 'unreachable' | 'nothing-to-draft';
  drafted: number;
  failed: number;
  skipped: number;
  endpoint: string;
  model: string;
}

/**
 * Semantic pass behind --with-llm: drafts module roles one directory at a
 * time. Resumable by construction: rule-sourced roles are always draftable;
 * entries whose roleSource is llm or human are skipped, so a rerun continues
 * where the last one stopped. Locked entries are never touched. A one-time
 * warmup with its own generous budget absorbs cold model load (the first
 * inference after Ollama starts loads the model and can take many seconds);
 * drafting calls keep the strict LOCAL_LLM_TIMEOUT_MS budget. Every executed
 * pass writes an audit event with drafted, failed, and skipped counts.
 */
export async function semanticPass(root: string, options: SemanticOptions = {}): Promise<SemanticOutcome> {
  const baseUrl = options.baseUrl ?? 'http://127.0.0.1:11434';
  const model = options.model ?? 'qwen2.5:7b-instruct';
  const base: SemanticOutcome = { status: 'nothing-to-draft', drafted: 0, failed: 0, skipped: 0, endpoint: baseUrl, model };
  const { codex } = readCodex(root);
  if (codex === undefined) return base;
  const candidates = codex.map.filter((e) => !e.locked && e.roleSource === 'rules');
  base.skipped = codex.map.length - candidates.length;
  if (candidates.length === 0) return base;

  const writeAudit = (outcome: SemanticOutcome): void => {
    const event = {
      id: `codex-semantic-${randomBytes(4).toString('hex')}`,
      timestamp: new Date().toISOString(),
      sessionId: 'codex',
      module: 'sidecar.codex-semantic',
      action: 'summarize' as const,
      reason: `semantic pass ${outcome.status}: drafted ${outcome.drafted}, failed ${outcome.failed}, skipped ${outcome.skipped} (endpoint ${outcome.endpoint}, model ${outcome.model})`,
      details: { ...outcome },
    };
    appendFileSync(path.join(root, '.dcp', 'audit.jsonl'), JSON.stringify(event) + '\n', 'utf8');
  };

  const warmup = await ollamaGenerate(
    baseUrl,
    model,
    'Reply with the single word ok.',
    options.warmupTimeoutMs ?? LIMITS.OLLAMA_WARMUP_TIMEOUT_MS,
  );
  if (warmup === null) {
    const outcome: SemanticOutcome = { ...base, status: 'unreachable' };
    writeAudit(outcome);
    return outcome;
  }

  let drafted = 0;
  let failed = 0;
  for (const entry of candidates) {
    const symbols = entry.keySymbols.join(', ');
    const response = await ollamaGenerate(
      baseUrl,
      model,
      `One sentence, plain text: the role of the module at ${entry.path} in project ${codex.project}, exporting ${symbols}.`,
      options.timeoutMs,
    );
    if (response === null || response === '') {
      failed += 1;
      continue;
    }
    entry.role = response.split('\n')[0]?.slice(0, 200) ?? entry.role;
    entry.roleSource = 'llm';
    drafted += 1;
  }
  if (drafted > 0) {
    codex.generatedAt = new Date().toISOString();
    writeFileSync(codexPaths(root).yaml, stringifyYaml(codex), 'utf8');
  }
  const outcome: SemanticOutcome = { ...base, status: 'complete', drafted, failed };
  writeAudit(outcome);
  return outcome;
}

/** Frontier polish stays a typed no-op seam until explicitly funded (architecture 3.2 step 3). */
export interface FrontierPolish {
  name: string;
  polish(codex: CodexFile): Promise<CodexFile | null>;
}

export class NoopFrontierPolish implements FrontierPolish {
  readonly name = 'noop';
  polish(_codex: CodexFile): Promise<CodexFile | null> {
    return Promise.resolve(null);
  }
}
