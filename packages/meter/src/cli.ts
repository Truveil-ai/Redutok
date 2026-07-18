#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { renderBadgeSvg, renderShareLine } from './badge.js';
import { buildReport, locateLastSessionLog, renderText } from './report.js';

const USAGE = `Usage: redutok <report|badge> [session.jsonl] [--last] [options]

  session.jsonl  path to a Claude Code session transcript
  --last         use the newest transcript under the default log directory

report options:
  --json         emit the full report as JSON instead of text

badge options:
  --out <file>   write the SVG badge to this path (default redutok-badge.svg)`;

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== 'report' && command !== 'badge') {
    console.error(USAGE);
    return command === undefined || command === '--help' ? 0 : 1;
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

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
