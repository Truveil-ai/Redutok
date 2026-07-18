import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { type AuditEvent, type TokenTally } from '@redutok/shared';

/**
 * Tolerant JSONL parser for Claude Code session transcripts.
 * Unknown record types and malformed lines are counted and reported via an
 * audit event, never thrown. Guardrail 3: no silent transformation.
 */

import { KNOWN_TRANSCRIPT_RECORD_TYPES } from './claude-compat.js';

const KNOWN_TYPES = new Set<string>(KNOWN_TRANSCRIPT_RECORD_TYPES);

export interface AssistantTurn {
  uuid?: string;
  timestamp?: string;
  sessionId?: string;
  model: string;
  tools: string[];
  tokens: TokenTally;
}

export interface ParseCounts {
  lines: number;
  known: number;
  unknownType: number;
  malformed: number;
}

export interface ParsedSession {
  sessionId?: string;
  assistantTurns: AssistantTurn[];
  counts: ParseCounts;
  audit: AuditEvent[];
}

function toInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function usageToTally(usage: unknown): TokenTally {
  const u = (usage ?? {}) as Record<string, unknown>;
  return {
    input: toInt(u['input_tokens']),
    output: toInt(u['output_tokens']),
    cacheRead: toInt(u['cache_read_input_tokens']),
    cacheWrite: toInt(u['cache_creation_input_tokens']),
    thinking: toInt(u['thinking_tokens']),
  };
}

function extractTools(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const tools: string[] = [];
  for (const block of content) {
    if (
      block !== null &&
      typeof block === 'object' &&
      (block as Record<string, unknown>)['type'] === 'tool_use' &&
      typeof (block as Record<string, unknown>)['name'] === 'string'
    ) {
      tools.push((block as Record<string, unknown>)['name'] as string);
    }
  }
  return tools;
}

export function parseSessionJsonl(content: string, sourceRef?: string): ParsedSession {
  const counts: ParseCounts = { lines: 0, known: 0, unknownType: 0, malformed: 0 };
  const assistantTurns: AssistantTurn[] = [];
  let sessionId: string | undefined;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    counts.lines += 1;

    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      counts.malformed += 1;
      continue;
    }
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      counts.malformed += 1;
      continue;
    }
    const rec = record as Record<string, unknown>;
    if (typeof rec['type'] !== 'string') {
      counts.malformed += 1;
      continue;
    }
    if (!KNOWN_TYPES.has(rec['type'])) {
      counts.unknownType += 1;
      continue;
    }
    counts.known += 1;
    if (typeof rec['sessionId'] === 'string' && sessionId === undefined) {
      sessionId = rec['sessionId'];
    }
    if (rec['type'] !== 'assistant') continue;

    const message = (rec['message'] ?? {}) as Record<string, unknown>;
    assistantTurns.push({
      uuid: typeof rec['uuid'] === 'string' ? rec['uuid'] : undefined,
      timestamp: typeof rec['timestamp'] === 'string' ? rec['timestamp'] : undefined,
      sessionId: typeof rec['sessionId'] === 'string' ? rec['sessionId'] : undefined,
      model: typeof message['model'] === 'string' ? message['model'] : 'unknown-model',
      tools: extractTools(message['content']),
      tokens: usageToTally(message['usage']),
    });
  }

  const audit: AuditEvent[] = [];
  const skipped = counts.unknownType + counts.malformed;
  if (skipped > 0) {
    audit.push({
      id: `parse-skip-${randomUUID()}`,
      timestamp: new Date().toISOString(),
      sessionId,
      module: 'meter.parser',
      action: 'skip',
      reason: `skipped ${skipped} of ${counts.lines} lines while parsing (${counts.unknownType} unknown type, ${counts.malformed} malformed)`,
      inputRef: sourceRef,
      details: { ...counts },
    });
  }

  return { sessionId, assistantTurns, counts, audit };
}

export async function parseSessionFile(filePath: string): Promise<ParsedSession> {
  const content = await readFile(filePath, 'utf8');
  return parseSessionJsonl(content, filePath);
}
