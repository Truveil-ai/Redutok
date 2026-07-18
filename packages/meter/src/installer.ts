import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * redutok init and remove. Idempotent install into a target repo; remove
 * reverts byte-identical from backups taken on first init. Managed files:
 * .claude/settings.json, .mcp.json, CLAUDE.md, plus the .dcp scaffold.
 */

const MANAGED = ['.claude/settings.json', '.mcp.json', 'CLAUDE.md'];
const HOOK_EVENTS: { event: string; matcher?: string }[] = [
  { event: 'SessionStart' },
  { event: 'PreToolUse', matcher: 'Read|Bash|Grep|Glob' },
  { event: 'PostToolUse', matcher: 'Read|Bash|Edit|Write' },
  { event: 'PreCompact' },
  { event: 'Stop' },
  { event: 'SessionEnd' },
];

interface ManifestEntry {
  path: string;
  existed: boolean;
}

interface Manifest {
  version: 1;
  entries: ManifestEntry[];
  createdDirs: string[];
}

const require = createRequire(import.meta.url);

function resolveEntry(spec: string): string {
  return require.resolve(spec);
}

function protocolBlock(): string {
  const protocolPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..', '..', '..', 'docs', 'PROTOCOL.md',
  );
  const text = readFileSync(protocolPath, 'utf8');
  const match = /<!-- dcp:start v1 -->[\s\S]*?<!-- dcp:end -->/.exec(text);
  if (match === null) throw new Error('docs/PROTOCOL.md is missing the dcp block markers');
  return match[0];
}

export function initRepo(targetDir: string): string {
  const dcpDir = path.join(targetDir, '.dcp');
  const backupDir = path.join(dcpDir, 'backup');
  const manifestPath = path.join(backupDir, 'manifest.json');

  if (!existsSync(manifestPath)) {
    const createdDirs: string[] = [];
    for (const dir of [dcpDir, backupDir, path.join(targetDir, '.claude')]) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
        createdDirs.push(path.relative(targetDir, dir).replace(/\\/g, '/'));
      }
    }
    const entries: ManifestEntry[] = MANAGED.map((rel) => {
      const full = path.join(targetDir, rel);
      const existed = existsSync(full);
      if (existed) copyFileSync(full, path.join(backupDir, rel.replace(/[/\\]/g, '__')));
      return { path: rel, existed };
    });
    const manifest: Manifest = { version: 1, entries, createdDirs };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  }

  const hookMain = resolveEntry('@redutok/hooks/hook-main');
  const mcpMain = resolveEntry('@redutok/mcp/main');

  const settingsPath = path.join(targetDir, '.claude', 'settings.json');
  const settings = existsSync(settingsPath)
    ? (JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>)
    : {};
  const hooks = (settings['hooks'] ?? {}) as Record<string, unknown[]>;
  for (const { event, matcher } of HOOK_EVENTS) {
    const command = `node "${hookMain}" ${event}`;
    const existing = (hooks[event] ?? []).filter(
      (entry) => !JSON.stringify(entry).includes('hook-main.js'),
    );
    const entry: Record<string, unknown> = { hooks: [{ type: 'command', command }] };
    if (matcher !== undefined) entry['matcher'] = matcher;
    hooks[event] = [...existing, entry];
  }
  settings['hooks'] = hooks;
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');

  const mcpPath = path.join(targetDir, '.mcp.json');
  const mcpConfig = existsSync(mcpPath)
    ? (JSON.parse(readFileSync(mcpPath, 'utf8')) as Record<string, unknown>)
    : {};
  const servers = (mcpConfig['mcpServers'] ?? {}) as Record<string, unknown>;
  servers['redutok'] = {
    command: 'node',
    args: [mcpMain],
    env: { REDUTOK_PORT: '48642', REDUTOK_DCP_DIR: dcpDir },
  };
  mcpConfig['mcpServers'] = servers;
  writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2) + '\n', 'utf8');

  const block = protocolBlock();
  const claudeMdPath = path.join(targetDir, 'CLAUDE.md');
  let claudeMd = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, 'utf8') : '';
  if (/<!-- dcp:start [\s\S]*?<!-- dcp:end -->/.test(claudeMd)) {
    claudeMd = claudeMd.replace(/<!-- dcp:start [\s\S]*?<!-- dcp:end -->/, block);
  } else {
    claudeMd = claudeMd === '' ? block + '\n' : claudeMd.replace(/\n*$/, '\n\n') + block + '\n';
  }
  writeFileSync(claudeMdPath, claudeMd, 'utf8');

  writeFileSync(path.join(dcpDir, 'protocol.md'), block + '\n', 'utf8');
  return `Redutok installed into ${targetDir}. Hooks, MCP server, and protocol block are in place. Run redutok up to start the sidecar.`;
}

export function removeRepo(targetDir: string): string {
  const dcpDir = path.join(targetDir, '.dcp');
  const backupDir = path.join(dcpDir, 'backup');
  const manifestPath = path.join(backupDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return 'Nothing to remove: no .dcp/backup/manifest.json found. Was redutok init run here?';
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  for (const entry of manifest.entries) {
    const full = path.join(targetDir, entry.path);
    if (entry.existed) {
      copyFileSync(path.join(backupDir, entry.path.replace(/[/\\]/g, '__')), full);
    } else if (existsSync(full)) {
      rmSync(full);
    }
  }
  rmSync(dcpDir, { recursive: true, force: true });
  for (const rel of manifest.createdDirs) {
    const full = path.join(targetDir, rel);
    if (existsSync(full) && readdirSync(full).length === 0) rmSync(full, { recursive: true });
  }
  return `Redutok removed from ${targetDir}; managed files restored byte-identical.`;
}
