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

describe('parseSessionJsonl dedup by message.id', () => {
  const usage = {
    input_tokens: 2,
    output_tokens: 418,
    cache_read_input_tokens: 45561,
    cache_creation_input_tokens: 275,
  };
  // Real Claude Code transcripts stream one API response as several JSONL
  // records sharing message.id, each carrying one content block but an
  // identical running usage total (reproduced from a live bench capture,
  // bench/runs/t06-redutok-1.jsonl message msg_011CdBVCzEBbFnaS8TRGKKLc).
  const streamed = [
    { type: 'assistant', uuid: 'u1', sessionId: 's-x', timestamp: '2026-07-19T10:00:00.000Z', message: { id: 'msg_1', model: 'claude-sonnet-5', usage, content: [{ type: 'thinking' }] } },
    { type: 'assistant', uuid: 'u2', sessionId: 's-x', timestamp: '2026-07-19T10:00:01.000Z', message: { id: 'msg_1', model: 'claude-sonnet-5', usage, content: [{ type: 'text', text: 'looking' }] } },
    { type: 'assistant', uuid: 'u3', sessionId: 's-x', timestamp: '2026-07-19T10:00:02.000Z', message: { id: 'msg_1', model: 'claude-sonnet-5', usage, content: [{ type: 'tool_use', name: 'Read', id: 't1' }] } },
    { type: 'assistant', uuid: 'u4', sessionId: 's-x', timestamp: '2026-07-19T10:00:03.000Z', message: { id: 'msg_1', model: 'claude-sonnet-5', usage, content: [{ type: 'tool_use', name: 'Read', id: 't2' }] } },
  ];

  it('folds records sharing message.id into a single turn, tokens counted once', () => {
    const parsed = parseSessionJsonl(streamed.map((r) => JSON.stringify(r)).join('\n'));
    expect(parsed.assistantTurns).toHaveLength(1);
    expect(parsed.assistantTurns[0]?.tokens).toEqual({
      input: 2,
      output: 418,
      cacheRead: 45561,
      cacheWrite: 275,
      thinking: 0,
    });
  });

  it('unions tool_use blocks across the folded records instead of dropping later ones', () => {
    const parsed = parseSessionJsonl(streamed.map((r) => JSON.stringify(r)).join('\n'));
    expect(parsed.assistantTurns[0]?.tools).toEqual(['Read', 'Read']);
  });

  it('keeps the first record identity (uuid, timestamp) for the folded turn', () => {
    const parsed = parseSessionJsonl(streamed.map((r) => JSON.stringify(r)).join('\n'));
    expect(parsed.assistantTurns[0]?.uuid).toBe('u1');
    expect(parsed.assistantTurns[0]?.timestamp).toBe('2026-07-19T10:00:00.000Z');
  });

  it('counts a naive per-record sum at roughly 4x the deduped total for this fixture', () => {
    const parsed = parseSessionJsonl(streamed.map((r) => JSON.stringify(r)).join('\n'));
    const deduped = parsed.assistantTurns[0]?.tokens;
    const naiveTotal = streamed.length * (usage.input_tokens + usage.output_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens);
    const dedupedTotal = (deduped?.input ?? 0) + (deduped?.output ?? 0) + (deduped?.cacheRead ?? 0) + (deduped?.cacheWrite ?? 0);
    expect(naiveTotal / dedupedTotal).toBe(4);
  });

  it('does not fold distinct API responses (different message.id) into one turn', () => {
    const two = [
      { type: 'assistant', uuid: 'a', message: { id: 'msg_a', model: 'm', usage, content: [] } },
      { type: 'assistant', uuid: 'b', message: { id: 'msg_b', model: 'm', usage, content: [] } },
    ];
    const parsed = parseSessionJsonl(two.map((r) => JSON.stringify(r)).join('\n'));
    expect(parsed.assistantTurns).toHaveLength(2);
  });

  it('falls back to uuid, one turn per record, when message.id is absent (synthetic and older transcripts)', () => {
    const noMessageId = [
      { type: 'assistant', uuid: 'x1', message: { model: 'm', usage: { input_tokens: 1, output_tokens: 1 }, content: [] } },
      { type: 'assistant', uuid: 'x2', message: { model: 'm', usage: { input_tokens: 1, output_tokens: 1 }, content: [] } },
    ];
    const parsed = parseSessionJsonl(noMessageId.map((r) => JSON.stringify(r)).join('\n'));
    expect(parsed.assistantTurns).toHaveLength(2);
  });
});
