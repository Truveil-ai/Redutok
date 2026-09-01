// CI canary: probes the installed claude CLI against the compat shim and
// exits nonzero on an unknown version so the workflow fails visibly instead
// of users breaking silently. Requires a prior pnpm -r build.
//
// claude-compat is a deliberate entry point in packages/meter/scripts/
// bundle.mjs. Since the build moved to esbuild, tsc emits declarations only,
// so only listed entry points become .js. Importing index.js instead would
// resolve, but it statically imports better-sqlite3 -- and this probe must
// go red only when the Claude Code surface moves.
import { probeClaudeVersion, assessVersion } from '../packages/meter/dist/claude-compat.js';

const assessment = assessVersion(probeClaudeVersion());
console.log(JSON.stringify(assessment, null, 2));
if (!assessment.known) {
  console.error('canary: unknown claude CLI surface. ' + assessment.degradation);
  process.exit(1);
}
console.log('canary: claude CLI surface is within the tested range.');
