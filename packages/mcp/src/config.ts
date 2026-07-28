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
  const configFile = path.resolve(cwd, env['REDUTOK_DCP_DIR'] ?? '.dcp', 'config.json');
  try {
    const config = JSON.parse(readFileSync(configFile, 'utf8')) as { port?: unknown };
    if (typeof config.port === 'number' && Number.isInteger(config.port) && config.port > 0) {
      return config.port;
    }
  } catch {
    // No or unreadable config: the default below keeps the fail-open path.
  }
  return DEFAULT_SIDECAR_PORT;
}
