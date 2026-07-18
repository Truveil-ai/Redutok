import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AuditEventSchema } from '@redutok/shared';
import { parseSessionFile, parseSessionJsonl } from '../src/parser.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.join(here, '..', '..', '..', 'fixtures', 'sessions', name);

describe('parseSessionFile on small.jsonl', () => {
  it('extracts every assistant turn with exact token tallies', async () => {
    const parsed = await parseSessionFile(fixture('small.jsonl'));
    expect(parsed.sessionId).toBe('s-small');
    expect(parsed.assistantTurns).toHaveLength(3);
    expect(parsed.assistantTurns[0]?.tokens).toEqual({
      input: 1200,
      output: 300,
      cacheRead: 4000,
      cacheWrite: 800,
      thinking: 150,
    });
    expect(parsed.assistantTurns[1]?.tokens.thinking).toBe(0);
    expect(parsed.assistantTurns[1]?.tools).toEqual(['Read', 'Bash']);
    expect(parsed.assistantTurns[2]?.tools).toEqual([]);
  });

  it('skips the unknown record type with a counter and an audit event', async () => {
    const parsed = await parseSessionFile(fixture('small.jsonl'));
    expect(parsed.counts.unknownType).toBe(1);
    expect(parsed.counts.malformed).toBe(0);
    expect(parsed.audit).toHaveLength(1);
    const event = AuditEventSchema.parse(parsed.audit[0]);
    expect(event.action).toBe('skip');
    expect(event.module).toBe('meter.parser');
  });
});

describe('parseSessionFile on malformed.jsonl', () => {
  it('never crashes and classifies every bad line', async () => {
    const parsed = await parseSessionFile(fixture('malformed.jsonl'));
    expect(parsed.counts.malformed).toBe(2);
    expect(parsed.counts.unknownType).toBe(1);
    expect(parsed.assistantTurns).toHaveLength(2);
    expect(parsed.assistantTurns[1]?.tokens).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      thinking: 0,
    });
  });
});

describe('parseSessionJsonl edge cases', () => {
  it('returns an empty result with no audit event for clean empty input', () => {
    const parsed = parseSessionJsonl('');
    expect(parsed.assistantTurns).toEqual([]);
    expect(parsed.audit).toEqual([]);
  });

  it('treats a JSON array line as malformed', () => {
    const parsed = parseSessionJsonl('[1,2,3]');
    expect(parsed.counts.malformed).toBe(1);
  });
});
