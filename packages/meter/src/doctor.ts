import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
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
    const pnpm = spawnSync('pnpm', ['--version'], { encoding: 'utf8', shell: true });
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

export function renderDoctor(checks: DoctorCheck[]): string {
  const lines = checks.map(
    (c) => `${c.status.toUpperCase().padEnd(5)} ${c.name.padEnd(12)} ${c.detail}. Remedy: ${c.remedy}.`,
  );
  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;
  lines.push(`${checks.length} checks: ${checks.length - fails - warns} pass, ${warns} warn, ${fails} fail.`);
  return lines.join('\n');
}
