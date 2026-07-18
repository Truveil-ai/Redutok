import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LIMITS } from '@redutok/shared';
import { estimateTokens } from './distill.js';
import { NoopLlmPass, type LlmPass } from './llm.js';

/**
 * Rolling session state, architecture 5.2. Rule fallback is a last-actions
 * list; a local model may rewrite it into prose via the LlmPass seam. The
 * file never exceeds SESSION_STATE_MAX_TOKENS; trimming drops the oldest
 * whole entries, never truncating mid-entry.
 */

const HEADER = '# Session state (rolling, maintained by Redutok)\n\n## Last actions\n';

export interface StateEvent {
  kind: string;
  tool?: string;
  path?: string;
}

export function statePath(dcpDir: string): string {
  return path.join(dcpDir, 'session-state.md');
}

export async function updateRollingState(
  dcpDir: string,
  event: StateEvent,
  llm: LlmPass = new NoopLlmPass(),
): Promise<string> {
  mkdirSync(dcpDir, { recursive: true });
  const file = statePath(dcpDir);
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : HEADER;
  const lines = existing.split('\n').filter((l) => l.startsWith('- '));
  const stamp = new Date().toISOString().slice(11, 19);
  lines.push(
    `- ${stamp} ${event.kind}${event.tool === undefined ? '' : ` ${event.tool}`}${
      event.path === undefined ? '' : ` ${event.path}`
    }`,
  );

  let body = HEADER + lines.join('\n') + '\n';
  const summarized = await llm.summarize({
    text: body,
    prompt: 'Rewrite this session state under 600 tokens: task, decisions, files touched, open questions.',
    timeoutMs: LIMITS.LOCAL_LLM_TIMEOUT_MS,
  });
  if (summarized !== null && estimateTokens(summarized) <= LIMITS.SESSION_STATE_MAX_TOKENS) {
    body = summarized;
  } else {
    while (estimateTokens(body) > LIMITS.SESSION_STATE_MAX_TOKENS && lines.length > 1) {
      lines.shift();
      body = HEADER + lines.join('\n') + '\n';
    }
  }
  writeFileSync(file, body, 'utf8');
  return body;
}
