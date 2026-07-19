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
      // small.jsonl has no cache_creation tier breakdown, so the whole
      // amount is conservatively assumed at the higher-cost 1-hour tier.
      cacheWrite5m: 0,
      cacheWrite1h: 800,
      cacheWriteAssumedTokens: 800,
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
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheWriteAssumedTokens: 0,
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
      // This usage fixture has no cache_creation breakdown either, so the
      // same conservative 1-hour assumption applies.
      cacheWrite5m: 0,
      cacheWrite1h: 275,
      cacheWriteAssumedTokens: 275,
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

describe('parseSessionJsonl cache-write tier detection', () => {
  const turn = (usage: Record<string, unknown>) =>
    JSON.stringify({
      type: 'assistant',
      uuid: 'u1',
      message: { id: 'msg_1', model: 'claude-sonnet-5', usage, content: [] },
    });

  it('splits cacheWrite by the transcript cache_creation breakdown when it reconciles to the total', () => {
    // Reproduced shape from a live bench capture (bench/runs/t01-redutok-1.jsonl):
    // real transcripts carry the split even though only the 1h tier was
    // observed in that run; this fixture also exercises a non-zero 5m share.
    const usage = {
      input_tokens: 10,
      output_tokens: 100,
      cache_read_input_tokens: 500,
      cache_creation_input_tokens: 300,
      cache_creation: { ephemeral_5m_input_tokens: 120, ephemeral_1h_input_tokens: 180 },
    };
    const parsed = parseSessionJsonl(turn(usage));
    expect(parsed.assistantTurns[0]?.tokens).toEqual({
      input: 10,
      output: 100,
      cacheRead: 500,
      cacheWrite: 300,
      cacheWrite5m: 120,
      cacheWrite1h: 180,
      cacheWriteAssumedTokens: 0,
      thinking: 0,
    });
  });

  it('assumes the whole amount at the 1-hour tier when cache_creation is absent, disclosed via cacheWriteAssumedTokens', () => {
    const usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 500,
    };
    const parsed = parseSessionJsonl(turn(usage));
    expect(parsed.assistantTurns[0]?.tokens.cacheWrite5m).toBe(0);
    expect(parsed.assistantTurns[0]?.tokens.cacheWrite1h).toBe(500);
    expect(parsed.assistantTurns[0]?.tokens.cacheWriteAssumedTokens).toBe(500);
  });

  it('does not trust a cache_creation breakdown that fails to reconcile to the reported total, falling back to the conservative assumption', () => {
    const usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 500,
      // Deliberately inconsistent: 120 + 180 = 300, not 500. A partial or
      // corrupted breakdown must not be silently trusted (guardrail 3).
      cache_creation: { ephemeral_5m_input_tokens: 120, ephemeral_1h_input_tokens: 180 },
    };
    const parsed = parseSessionJsonl(turn(usage));
    expect(parsed.assistantTurns[0]?.tokens.cacheWrite5m).toBe(0);
    expect(parsed.assistantTurns[0]?.tokens.cacheWrite1h).toBe(500);
    expect(parsed.assistantTurns[0]?.tokens.cacheWriteAssumedTokens).toBe(500);
  });

  it('never marks tokens assumed when cacheWrite is zero, breakdown present or not', () => {
    const withBreakdown = {
      input_tokens: 5,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
    };
    const parsed = parseSessionJsonl(turn(withBreakdown));
    expect(parsed.assistantTurns[0]?.tokens.cacheWrite5m).toBe(0);
    expect(parsed.assistantTurns[0]?.tokens.cacheWrite1h).toBe(0);
    expect(parsed.assistantTurns[0]?.tokens.cacheWriteAssumedTokens).toBe(0);
  });
});
