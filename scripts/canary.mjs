// CI canary: probes the installed claude CLI against the compat shim and
// exits nonzero on an unknown version so the workflow fails visibly instead
// of users breaking silently. Requires a prior pnpm -r build.
import { probeClaudeVersion, assessVersion } from '../packages/meter/dist/claude-compat.js';

const assessment = assessVersion(probeClaudeVersion());
console.log(JSON.stringify(assessment, null, 2));
if (!assessment.known) {
  console.error('canary: unknown claude CLI surface. ' + assessment.degradation);
  process.exit(1);
}
console.log('canary: claude CLI surface is within the tested range.');
