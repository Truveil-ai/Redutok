import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Where the governed repository's .dcp state lives, for a process that runs in
 * the session shell's current directory: hooks and the pipe. That directory
 * moves with every Bash `cd`, so process.cwd() alone is not the project. The
 * 0.1.7 field session that cd-ed into deploy/assets/reports ran ungoverned.
 *
 * In order: an explicit REDUTOK_DCP_DIR; the project Claude Code opened
 * (CLAUDE_PROJECT_DIR, set for hook processes but not for the tools' shells);
 * the nearest ancestor of cwd holding a .dcp; and last, cwd/.dcp as before.
 */
export function resolveDcpDir(options: { env: NodeJS.ProcessEnv; cwd: string }): string {
  const explicit = options.env['REDUTOK_DCP_DIR'];
  if (explicit !== undefined && explicit !== '') return explicit;
  const project = options.env['CLAUDE_PROJECT_DIR'];
  if (project !== undefined && project !== '' && existsSync(path.join(project, '.dcp'))) {
    return path.join(project, '.dcp');
  }
  for (let dir = path.resolve(options.cwd); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, '.dcp');
    if (existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) break;
  }
  return path.join(options.cwd, '.dcp');
}
