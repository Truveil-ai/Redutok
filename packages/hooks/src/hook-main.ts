#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  handlePreCompact,
  handlePreToolUse,
  handlePostToolUse,
  handleSessionStart,
  handleStop,
  handleUserPromptSubmit,
  type HookDeps,
  type HookOutput,
} from './handlers.js';

/**
 * Hook entry: node hook-main.js <event>. Reads the hook payload from stdin,
 * writes JSON to stdout. Exit 2 with stderr guidance is the deny fallback
 * when REDUTOK_HOOK_MODE=exit2. Any internal error exits 0 (fail-open).
 */

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c) => chunks.push(c));
    // Windows shells piping the payload can prepend a UTF-8 BOM, which
    // JSON.parse rejects; strip it so scripted invocations behave like real
    // Claude Code ones.
    process.stdin.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      resolve(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    });
  });
}

function discoverDeps(): HookDeps {
  const dcpDir = process.env['REDUTOK_DCP_DIR'] ?? path.join(process.cwd(), '.dcp');
  let port = Number(process.env['REDUTOK_PORT'] ?? '48642');
  const configFile = path.join(dcpDir, 'config.json');
  if (existsSync(configFile)) {
    try {
      const config = JSON.parse(readFileSync(configFile, 'utf8')) as { port?: number };
      if (typeof config.port === 'number' && config.port > 0) port = config.port;
    } catch {
      // Bad config must not break a hook; the pidfile below is authoritative.
    }
  }
  const pidfile = path.join(dcpDir, 'sidecar.pid.json');
  if (existsSync(pidfile)) {
    try {
      port = (JSON.parse(readFileSync(pidfile, 'utf8')) as { port: number }).port;
    } catch {
      // Fall through to the default port; a bad pidfile must not break a hook.
    }
  }
  return { target: { port }, dcpDir };
}

async function main(): Promise<void> {
  const event = process.argv[2] ?? '';
  let input: Record<string, unknown> = {};
  try {
    input = JSON.parse((await readStdin()) || '{}') as Record<string, unknown>;
  } catch {
    input = {};
  }
  const deps = discoverDeps();
  let output: HookOutput = {};
  switch (event) {
    case 'SessionStart':
      output = await handleSessionStart(input, deps);
      break;
    case 'PreToolUse':
      output = await handlePreToolUse(input, deps);
      break;
    case 'PostToolUse':
      output = await handlePostToolUse(input, deps);
      break;
    case 'PreCompact':
      output = handlePreCompact(input, deps);
      break;
    case 'UserPromptSubmit':
      output = handleUserPromptSubmit(input, deps);
      break;
    case 'Stop':
    case 'SessionEnd':
      output = await handleStop(input, deps);
      break;
    default:
      break;
  }
  if (
    process.env['REDUTOK_HOOK_MODE'] === 'exit2' &&
    output.hookSpecificOutput?.permissionDecision === 'deny'
  ) {
    process.stderr.write(output.hookSpecificOutput.permissionDecisionReason ?? 'blocked by redutok');
    process.exit(2);
  }
  if (output.summaryLine !== undefined) {
    process.stdout.write(output.summaryLine + '\n');
    if (output.receiptBlock !== undefined) process.stdout.write(output.receiptBlock + '\n');
  } else if (output.hookSpecificOutput !== undefined) {
    process.stdout.write(JSON.stringify(output) + '\n');
  }
  process.exit(0);
}

main().catch(() => process.exit(0));
