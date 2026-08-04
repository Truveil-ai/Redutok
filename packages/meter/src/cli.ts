#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildAuditReport, renderAuditText } from './audit-render.js';
import { renderBadgeSvg, renderShareLine } from './badge.js';
import { projectTranscriptDir } from './claude-compat.js';
import { buildReport, defaultLogRoot, locateLastSessionLog, renderText } from './report.js';
import { initRepo, removeRepo } from './installer.js';
import { sidecarDown, sidecarStatus, sidecarUp } from './sidecar-cli.js';

const USAGE = `Usage: redutok <report|badge|audit|candidates|up|down|status> [args] [options]

report and badge take a transcript:
  session.jsonl  path to a Claude Code session transcript
  --last         use this project's newest transcript
  --all-projects (with --last) widen the search to every project
  --json         (report) emit the full report as JSON instead of text
  --out <file>   (badge) write the SVG to this path (default redutok-badge.svg)

audit takes a session id:
  redutok audit <session-id> [--file audit.jsonl]   render the audit trail

candidates (graduation miner output, mined post-session):
  redutok candidates [--file candidates.jsonl]      render candidates with counts and ages

sidecar lifecycle (state in ./.dcp):
  redutok up | down | status

install into a repo (idempotent; remove reverts byte-identical):
  redutok init [dir] | remove [dir]

codex (structural pass; --with-llm adds the local-model semantic pass):
  redutok codex refresh [--with-llm] [--model <name>]`;

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'codex') {
    const sub = rest[0];
    if (sub !== 'refresh') {
      console.error('Usage: redutok codex refresh [--with-llm] [--model <name>]');
      return 1;
    }
    const { writeCodex, semanticPass } = await import('@redutok/sidecar');
    const result = await writeCodex(process.cwd());
    console.log(
      result.changed
        ? `Codex refreshed: ${result.codex.files.length} files indexed.`
        : 'Codex already current; nothing changed.',
    );
    if (rest.includes('--with-llm')) {
      const modelIndex = rest.indexOf('--model');
      const model = modelIndex >= 0 ? rest[modelIndex + 1] : undefined;
      const { LIMITS } = await import('@redutok/shared');
      // Offline batch drafting gets its own budget; see limits.ts rationale.
      const outcome = await semanticPass(process.cwd(), {
        model,
        timeoutMs: LIMITS.SEMANTIC_BATCH_DRAFT_TIMEOUT_MS,
        redraft: rest.includes('--redraft'),
      });
      if (outcome.status === 'unreachable') {
        console.log(
          `Semantic pass: Ollama unreachable or model failed to load at ${outcome.endpoint} within the warmup budget (model ${outcome.model}). Rule-based roles remain.`,
        );
      } else if (outcome.status === 'nothing-to-draft') {
        console.log(
          `Semantic pass: nothing left to draft (${outcome.skipped} roles already llm-drafted, human, or locked).`,
        );
      } else {
        console.log(
          `Semantic pass: drafted ${outcome.drafted} roles, ${outcome.failed} failed and kept the rule fallback, ${outcome.skipped} skipped as already drafted or locked.`,
        );
      }
    }
    return 0;
  }
  if (command === 'bench') {
    const { runReplay, loadBenchTasks, dryRunMatrix, loadSlopeTier } = await import('./bench.js');
    const tasksDir = 'bench/tasks';
    if (rest.includes('--replay')) {
      const results = await runReplay(process.cwd(), tasksDir, 'bench/RESULTS.md');
      console.log(results);
      console.log('Written to bench/RESULTS.md');
      return 0;
    }
    if (rest.includes('--dry-run')) {
      const nIndex = rest.indexOf('--n');
      const mIndex = rest.indexOf('--model');
      const n = nIndex >= 0 ? Number(rest[nIndex + 1]) : 3;
      const model = mIndex >= 0 ? String(rest[mIndex + 1]) : 'claude-sonnet-5';
      const tasks = loadBenchTasks(tasksDir);
      const tierFile = path.join('bench', 'tiers', 'slope.yaml');
      const slope = existsSync(tierFile) ? loadSlopeTier(tierFile, tasks) : undefined;
      console.log(dryRunMatrix(tasks, n, model, slope).join('\n'));
      return 0;
    }
    console.error('Usage: redutok bench --replay | --dry-run [--n N] [--model <name>]. Live execution is operator-only; use --dry-run to see the command matrix.');
    return 1;
  }
  if (command === 'doctor') {
    const { doctor, renderDoctor } = await import('./doctor.js');
    const checks = await doctor(process.cwd());
    console.log(renderDoctor(checks));
    return checks.some((c) => c.status === 'fail') ? 1 : 0;
  }
  if (command === 'handoff') {
    const { writeHandoff } = await import('./discipline.js');
    const result = writeHandoff(process.cwd());
    console.log(`Handoff written to ${result.file}`);
    console.log(`Resume with: ${result.resumeCommand}`);
    return 0;
  }
  if (command === 'init' || command === 'remove') {
    const target = rest.filter((a) => !a.startsWith('--'))[0] ?? process.cwd();
    // init refusing is an ordinary outcome, not a crash: it is what a user
    // gets for running it before installing redutok into the project. The
    // message is the instruction that fixes it, so print that rather than
    // letting it surface as an unhandled rejection with a stack trace.
    try {
      console.log(command === 'init' ? initRepo(target) : removeRepo(target));
      return 0;
    } catch (err) {
      console.error(`redutok ${command} failed: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  if (command === 'up' || command === 'down' || command === 'status') {
    const run = command === 'up' ? sidecarUp : command === 'down' ? sidecarDown : sidecarStatus;
    console.log(await run());
    return 0;
  }
  if (command === 'candidates') {
    const { buildCandidatesReport, renderCandidatesText } = await import('./candidates-render.js');
    const fileIndex = rest.indexOf('--file');
    const filePath = fileIndex >= 0 ? rest[fileIndex + 1] : undefined;
    console.log(renderCandidatesText(buildCandidatesReport(filePath)));
    return 0;
  }
  if (command === 'audit') {
    const fileIndex = rest.indexOf('--file');
    const filePath = fileIndex >= 0 ? rest[fileIndex + 1] : undefined;
    // fileIndex is -1 without --file; guard so index 0 is not dropped then.
    const sessionId = rest.filter((a, i) => !a.startsWith('--') && (fileIndex < 0 || i !== fileIndex + 1))[0];
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
  const positional = rest.filter((a, i) => !a.startsWith('--') && (outIndex < 0 || i !== outIndex + 1));

  let target = positional[0];
  if (last) {
    // Scoped to this project by default: the newest transcript anywhere is
    // very often another project's, and reporting it here would be wrong
    // without looking wrong.
    const allProjects = rest.includes('--all-projects');
    target = locateLastSessionLog({ allProjects });
    if (target === undefined) {
      console.error(
        allProjects
          ? `No .jsonl transcript found under ${defaultLogRoot()}.`
          : `No transcript found for this project: no .jsonl session under ${projectTranscriptDir()}, or for any directory above it.\n` +
              'redutok --last is scoped to the current directory so it cannot report another project session.\n' +
              'Run it from the project you meant, or pass --all-projects to search every project.',
      );
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
