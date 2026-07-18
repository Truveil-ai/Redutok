#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { buildAuditReport, renderAuditText } from './audit-render.js';
import { renderBadgeSvg, renderShareLine } from './badge.js';
import { buildReport, locateLastSessionLog, renderText } from './report.js';
import { initRepo, removeRepo } from './installer.js';
import { sidecarDown, sidecarStatus, sidecarUp } from './sidecar-cli.js';

const USAGE = `Usage: redutok <report|badge|audit|up|down|status> [args] [options]

report and badge take a transcript:
  session.jsonl  path to a Claude Code session transcript
  --last         use the newest transcript under the default log directory
  --json         (report) emit the full report as JSON instead of text
  --out <file>   (badge) write the SVG to this path (default redutok-badge.svg)

audit takes a session id:
  redutok audit <session-id> [--file audit.jsonl]   render the audit trail

sidecar lifecycle (state in ./.dcp):
  redutok up | down | status

install into a repo (idempotent; remove reverts byte-identical):
  redutok init [dir] | remove [dir]`;

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'init' || command === 'remove') {
    const target = rest.filter((a) => !a.startsWith('--'))[0] ?? process.cwd();
    console.log(command === 'init' ? initRepo(target) : removeRepo(target));
    return 0;
  }
  if (command === 'up' || command === 'down' || command === 'status') {
    const run = command === 'up' ? sidecarUp : command === 'down' ? sidecarDown : sidecarStatus;
    console.log(await run());
    return 0;
  }
  if (command === 'audit') {
    const fileIndex = rest.indexOf('--file');
    const filePath = fileIndex >= 0 ? rest[fileIndex + 1] : undefined;
    const sessionId = rest.filter((a, i) => !a.startsWith('--') && i !== fileIndex + 1)[0];
    if (sessionId === undefined) {
      console.error(USAGE);
      return 1;
    }
    console.log(renderAuditText(buildAuditReport(sessionId, filePath), sessionId));
    return 0;
  }
  if (command === undefined || command === '--help' || command === 'help') {
    console.log(USAGE);
    return 0;
  }
  if (command !== 'report' && command !== 'badge') {
    console.error(USAGE);
    return 1;
  }
  const json = rest.includes('--json');
  const last = rest.includes('--last');
  const outIndex = rest.indexOf('--out');
  const outPath = outIndex >= 0 ? rest[outIndex + 1] : undefined;
  const positional = rest.filter((a, i) => !a.startsWith('--') && i !== outIndex + 1);

  let target = positional[0];
  if (last) {
    target = locateLastSessionLog();
    if (target === undefined) {
      console.error('No .jsonl transcript found under the default log directory.');
      return 1;
    }
  }
  if (target === undefined) {
    console.error(USAGE);
    return 1;
  }

  try {
    const report = await buildReport(target);
    if (command === 'badge') {
      const file = outPath ?? 'redutok-badge.svg';
      await writeFile(file, renderBadgeSvg(report) + '\n', 'utf8');
      console.log(renderShareLine(report));
      console.log(`Badge written to ${file}`);
      return 0;
    }
    console.log(json ? JSON.stringify(report, null, 2) : renderText(report));
    return 0;
  } catch (err) {
    console.error(`redutok ${command} failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

// Resolve argv[1] through symlinks and junctions: pnpm bin shims invoke the
// node_modules path while import.meta.url reflects the real workspace path.
const isDirectRun = ((): boolean => {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
})();
if (isDirectRun) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
