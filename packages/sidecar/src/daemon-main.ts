import path from 'node:path';
import { startDaemon } from './daemon.js';

/**
 * Standalone daemon entry, spawned detached by redutok up.
 * Environment: REDUTOK_DCP_DIR (state directory), REDUTOK_PORT (0 = ephemeral),
 * REDUTOK_PIPE (optional named-pipe name on Windows).
 */

const dcpDir = process.env['REDUTOK_DCP_DIR'] ?? path.join(process.cwd(), '.dcp');
const port = Number(process.env['REDUTOK_PORT'] ?? '48642');
const pipeName = process.env['REDUTOK_PIPE'];
const profilesDir = process.env['REDUTOK_PROFILES'];

startDaemon({ port, dcpDir, pipeName, profilesDir })
  .then((daemon) => {
    // The parent (redutok up or a test) reads this line to learn the port.
    console.log(`redutok sidecar listening on port ${daemon.port}`);
  })
  .catch((err) => {
    console.error(`sidecar failed to start: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
