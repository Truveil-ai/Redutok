// PostToolUse hook: format the file just written or edited with prettier.
// Fail-open by design: any error exits 0 so the edit is never blocked.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const FORMATTABLE = /\.(ts|tsx|js|mjs|cjs|json|md|yaml|yml)$/;

try {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const filePath = payload?.tool_input?.file_path;
      if (!filePath || !FORMATTABLE.test(filePath) || !existsSync(filePath)) {
        process.exit(0);
      }
      const prettierBin = path.join(
        process.cwd(),
        'node_modules',
        '.bin',
        process.platform === 'win32' ? 'prettier.CMD' : 'prettier',
      );
      if (!existsSync(prettierBin)) process.exit(0);
      execFileSync(prettierBin, ['--write', filePath], {
        stdio: 'ignore',
        timeout: 10_000,
        shell: process.platform === 'win32',
      });
      process.exit(0);
    } catch {
      process.exit(0);
    }
  });
} catch {
  process.exit(0);
}
