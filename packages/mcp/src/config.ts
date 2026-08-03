import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Sidecar discovery for the MCP entry. The repo's .dcp/config.json (written
 * by redutok init) is the source of truth for the port, so every repo's MCP
 * server targets its own daemon; REDUTOK_PORT is an explicit override only.
 * A hardcoded port in .mcp.json used to point every temp copy at the dogfood
 * daemon — the bench cross-repo contamination scenario.
 */

export const DEFAULT_SIDECAR_PORT = 48642;

export function resolveSidecarPort(
  env: Record<string, string | undefined>,
  cwd: string,
): number {
  const explicit = Number(env['REDUTOK_PORT'] ?? '');
  if (env['REDUTOK_PORT'] !== undefined && env['REDUTOK_PORT'] !== '' && Number.isInteger(explicit) && explicit > 0) {
    return explicit;
  }
  const dcpDir = path.resolve(cwd, env['REDUTOK_DCP_DIR'] ?? '.dcp');
  let port = DEFAULT_SIDECAR_PORT;
  try {
    const config = JSON.parse(readFileSync(path.join(dcpDir, 'config.json'), 'utf8')) as { port?: unknown };
    if (typeof config.port === 'number' && Number.isInteger(config.port) && config.port > 0) {
      port = config.port;
    }
  } catch {
    // No or unreadable config: the default below keeps the fail-open path.
  }
  // Pidfile beats config, as in the hook and pipe launchers: a daemon whose
  // configured port was busy falls back to an ephemeral one and records it
  // there, so the pidfile is the only place the real port is guaranteed.
  try {
    const pidfile = JSON.parse(readFileSync(path.join(dcpDir, 'sidecar.pid.json'), 'utf8')) as { port?: unknown };
    if (typeof pidfile.port === 'number' && Number.isInteger(pidfile.port) && pidfile.port > 0) {
      port = pidfile.port;
    }
  } catch {
    // No pidfile: the config or default port stands.
  }
  return port;
}
