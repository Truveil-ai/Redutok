import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sidecarRequest } from '@redutok/sidecar/client';
import { readDcpConfig, readPidfile } from './sidecar-cli.js';

/** redutok doctor: environment diagnostics, one pass/warn/fail line each with a remedy. */

export interface DoctorCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
  remedy: string;
}

export interface DoctorOptions {
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  skipPnpm?: boolean;
  /** Override for Claude Code's per-user state file, default ~/.claude.json. */
  claudeJsonPath?: string;
}

export async function doctor(repoRoot: string, options: DoctorOptions = {}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const dcpDir = path.join(repoRoot, '.dcp');

  const major = Number(process.versions.node.split('.')[0]);
  checks.push({
    name: 'node',
    status: major >= 20 ? 'pass' : 'fail',
    detail: `node ${process.versions.node}`,
    remedy: major >= 20 ? 'none needed' : 'install node 20 or newer',
  });

  if (options.skipPnpm !== true) {
    // Single command string with shell: true; passing an args array alongside
    // shell mode is deprecated (DEP0190) and unsafe.
    const pnpm = spawnSync('pnpm --version', { encoding: 'utf8', shell: true });
    checks.push({
      name: 'pnpm',
      status: pnpm.status === 0 ? 'pass' : 'warn',
      detail: pnpm.status === 0 ? `pnpm ${pnpm.stdout.trim()}` : 'pnpm not found on PATH',
      remedy: pnpm.status === 0 ? 'none needed' : 'npm install -g pnpm',
    });
  }

  const pidfile = readPidfile(dcpDir);
  if (pidfile === undefined) {
    checks.push({
      name: 'sidecar',
      status: 'warn',
      detail: 'not running (no pidfile); sessions run vanilla',
      remedy: 'redutok up',
    });
  } else {
    const health = await sidecarRequest({ port: pidfile.port }, 'GET', '/health', undefined, {
      timeoutMs: 1500,
    });
    checks.push({
      name: 'sidecar',
      status: health.ok ? 'pass' : 'warn',
      detail: health.ok ? `running on port ${pidfile.port}` : `stale pidfile for port ${pidfile.port}`,
      remedy: health.ok ? 'none needed' : 'redutok down, then redutok up',
    });
  }

  const base = options.ollamaBaseUrl ?? 'http://127.0.0.1:11434';
  const model = options.ollamaModel ?? 'qwen2.5:7b-instruct';
  const url = new URL('/api/tags', base);
  const tags = await sidecarRequest(
    { host: url.hostname, port: Number(url.port) },
    'GET',
    url.pathname,
    undefined,
    { timeoutMs: 1500 },
  );
  if (!tags.ok) {
    checks.push({
      name: 'ollama',
      status: 'warn',
      detail: 'unreachable; semantic passes fall back to rules',
      remedy: 'install Ollama and pull the model, or ignore for rule-only operation',
    });
  } else {
    const names = JSON.stringify(tags.body);
    checks.push({
      name: 'ollama',
      status: names.includes(model.split(':')[0] ?? model) ? 'pass' : 'warn',
      detail: names.includes(model.split(':')[0] ?? model)
        ? `reachable with ${model}`
        : `reachable but model ${model} not pulled`,
      remedy: `ollama pull ${model}`,
    });
  }

  try {
    const { fileSkeleton } = await import('@redutok/sidecar');
    const skeleton = await fileSkeleton('export function probe(): number { return 1; }', 'ts');
    checks.push({
      name: 'tree-sitter',
      status: skeleton.includes('probe') ? 'pass' : 'fail',
      detail: skeleton.includes('probe') ? 'wasm parser loads and parses' : 'parser loaded but produced nothing',
      remedy: 'pnpm install to restore web-tree-sitter and tree-sitter-wasms',
    });
  } catch (err) {
    checks.push({
      name: 'tree-sitter',
      status: 'fail',
      detail: `wasm load failed: ${err instanceof Error ? err.message : String(err)}`,
      remedy: 'pnpm install to restore web-tree-sitter and tree-sitter-wasms',
    });
  }

  const settingsPath = path.join(repoRoot, '.claude', 'settings.local.json');
  const hooksRegistered =
    existsSync(settingsPath) && readFileSync(settingsPath, 'utf8').includes('redutok/hook.mjs');
  checks.push({
    name: 'hooks',
    status: hooksRegistered ? 'pass' : 'warn',
    detail: hooksRegistered ? 'redutok hooks registered' : 'redutok hooks not registered in this repo',
    remedy: hooksRegistered ? 'none needed' : 'redutok init .',
  });

  const mcpJsonPath = path.join(repoRoot, '.mcp.json');
  const launcherPath = path.join(repoRoot, '.claude', 'redutok', 'mcp.mjs');
  const registered =
    existsSync(mcpJsonPath) &&
    readFileSync(mcpJsonPath, 'utf8').includes('redutok/mcp.mjs') &&
    existsSync(launcherPath);
  if (!registered) {
    checks.push({
      name: 'mcp-launcher',
      status: 'warn',
      detail: 'redutok MCP server not registered in .mcp.json (dcp tools absent)',
      remedy: 'redutok init .',
    });
  } else {
    // The exact chain the generated launchers run; a resolution error here is
    // why the MCP server dies at startup and the hook silently no-ops.
    try {
      const repoRequire = createRequire(pathToFileURL(path.join(repoRoot, 'package.json')));
      const meterPkg = repoRequire.resolve('redutok/package.json');
      createRequire(meterPkg).resolve('@redutok/mcp/main');
      checks.push({
        name: 'mcp-launcher',
        status: 'pass',
        detail: 'launcher resolves the installed redutok packages',
        remedy: 'none needed',
      });
    } catch (err) {
      checks.push({
        name: 'mcp-launcher',
        status: 'fail',
        detail: `launcher cannot resolve the installed package, so the MCP server dies at startup and hooks no-op: ${err instanceof Error ? err.message : String(err)}`,
        remedy:
          'pnpm install to restore node_modules; if the error mentions "exports", the named package must export "./package.json"',
      });
    }
  }

  const claudeJsonPath = options.claudeJsonPath ?? path.join(os.homedir(), '.claude.json');
  checks.push(mcpApprovalCheck(repoRoot, claudeJsonPath));

  const lockPath = path.join(dcpDir, 'codex.lock');
  if (!existsSync(lockPath)) {
    checks.push({
      name: 'codex',
      status: 'warn',
      detail: 'no codex generated',
      remedy: 'redutok codex refresh',
    });
  } else {
    try {
      const { buildStructuralCodex } = await import('@redutok/sidecar');
      const fresh = await buildStructuralCodex(repoRoot);
      checks.push({
        name: 'codex',
        status: fresh.changed ? 'warn' : 'pass',
        detail: fresh.changed ? 'codex is stale against the working tree' : 'codex current with the lock',
        remedy: fresh.changed ? 'redutok codex refresh' : 'none needed',
      });
    } catch (err) {
      checks.push({
        name: 'codex',
        status: 'fail',
        detail: `codex check failed: ${err instanceof Error ? err.message : String(err)}`,
        remedy: 'delete .dcp/codex.yaml and .dcp/codex.lock, then redutok codex refresh',
      });
    }
  }

  const config = readDcpConfig(dcpDir);
  const configOk = typeof config.port === 'number' && config.port > 0;
  checks.push({
    name: 'config',
    status: existsSync(path.join(dcpDir, 'config.json')) ? (configOk ? 'pass' : 'fail') : 'warn',
    detail: configOk
      ? `port ${config.port}, profiles ${config.profilesDir === undefined ? 'unset' : 'set'}`
      : 'config missing or invalid',
    remedy: configOk ? 'none needed' : 'redutok init . rewrites .dcp/config.json',
  });

  return checks;
}

const APPROVAL_REMEDY =
  'start Claude Code in this repo and approve the project MCP server prompt (choose to use the .mcp.json servers); to re-prompt run: claude mcp reset-project-choices; verify with: claude mcp list';

/**
 * Project-scope .mcp.json servers need a one-time per-user approval, recorded
 * in ~/.claude.json under projects.<repo>.enabledMcpjsonServers. Without it the
 * dcp tools are absent even when the launcher is healthy.
 */
function mcpApprovalCheck(repoRoot: string, claudeJsonPath: string): DoctorCheck {
  if (!existsSync(claudeJsonPath)) {
    return {
      name: 'mcp-approval',
      status: 'warn',
      detail: `no Claude Code user state at ${claudeJsonPath}; cannot verify project MCP approval`,
      remedy: APPROVAL_REMEDY,
    };
  }
  let projects: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(claudeJsonPath, 'utf8')) as Record<string, unknown>;
    projects = (parsed['projects'] ?? {}) as Record<string, unknown>;
  } catch {
    return {
      name: 'mcp-approval',
      status: 'warn',
      detail: `${claudeJsonPath} is not readable JSON; cannot verify project MCP approval`,
      remedy: APPROVAL_REMEDY,
    };
  }
  const wanted = normalizeProjectPath(repoRoot);
  let enabled = false;
  let disabled = false;
  let seen = false;
  for (const [key, value] of Object.entries(projects)) {
    if (normalizeProjectPath(key) !== wanted) continue;
    seen = true;
    const entry = (value ?? {}) as Record<string, unknown>;
    const list = Array.isArray(entry['enabledMcpjsonServers']) ? entry['enabledMcpjsonServers'] : [];
    const denyList = Array.isArray(entry['disabledMcpjsonServers'])
      ? entry['disabledMcpjsonServers']
      : [];
    if (list.includes('redutok') || entry['enableAllProjectMcpServers'] === true) enabled = true;
    if (denyList.includes('redutok')) disabled = true;
  }
  if (enabled) {
    return {
      name: 'mcp-approval',
      status: 'pass',
      detail: 'project MCP server approved in Claude Code',
      remedy: 'none needed',
    };
  }
  return {
    name: 'mcp-approval',
    status: disabled ? 'fail' : 'warn',
    detail: disabled
      ? 'project MCP server was declined in Claude Code; dcp tools stay absent'
      : seen
        ? 'project MCP server not yet approved in Claude Code; dcp tools stay absent until the one-time approval'
        : 'this repo has no Claude Code project entry yet; approval happens on first session',
    remedy: APPROVAL_REMEDY,
  };
}

function normalizeProjectPath(p: string): string {
  const resolved = path.resolve(p).replace(/[\\/]+$/, '').replace(/\\/g, '/');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function renderDoctor(checks: DoctorCheck[]): string {
  const lines = checks.map(
    (c) => `${c.status.toUpperCase().padEnd(5)} ${c.name.padEnd(12)} ${c.detail}. Remedy: ${c.remedy}.`,
  );
  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;
  lines.push(`${checks.length} checks: ${checks.length - fails - warns} pass, ${warns} warn, ${fails} fail.`);
  return lines.join('\n');
}
