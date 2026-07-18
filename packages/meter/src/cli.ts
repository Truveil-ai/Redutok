#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { buildReport, locateLastSessionLog, renderText } from './report.js';

const USAGE = `Usage: redutok report [session.jsonl] [--last] [--json]

  session.jsonl  path to a Claude Code session transcript
  --last         use the newest transcript under the default log directory
  --json         emit the full report as JSON instead of text`;

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== 'report') {
    console.error(USAGE);
    return command === undefined || command === '--help' ? 0 : 1;
  }
  const json = rest.includes('--json');
  const last = rest.includes('--last');
  const positional = rest.filter((a) => !a.startsWith('--'));

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
    console.log(json ? JSON.stringify(report, null, 2) : renderText(report));
    return 0;
  } catch (err) {
    console.error(`redutok report failed: ${err instanceof Error ? err.message : String(err)}`);
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
