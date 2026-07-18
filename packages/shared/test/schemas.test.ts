import { describe, expect, it } from 'vitest';
import {
  AuditEventSchema,
  CodexFileSchema,
  DistillProfileSchema,
  LedgerEntrySchema,
  addTally,
  emptyTally,
} from '../src/index.js';

function roundTrip<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  const first = schema.parse(value);
  const second = schema.parse(JSON.parse(JSON.stringify(first)));
  expect(second).toEqual(first);
  return second;
}

describe('LedgerEntrySchema', () => {
  const entry = {
    sessionId: 's-1',
    turn: 1,
    timestamp: '2026-07-18T10:00:00.000Z',
    model: 'claude-sonnet-5',
    tools: ['Read', 'Bash'],
    tokens: { input: 100, output: 20, cacheRead: 500, cacheWrite: 50, thinking: 10 },
  };

  it('round-trips through JSON', () => {
    roundTrip(LedgerEntrySchema, entry);
  });

  it('rejects negative token counts', () => {
    const bad = { ...entry, tokens: { ...entry.tokens, output: -1 } };
    expect(() => LedgerEntrySchema.parse(bad)).toThrow();
  });

  it('defaults tools to an empty array', () => {
    const { tools: _tools, ...withoutTools } = entry;
    expect(LedgerEntrySchema.parse(withoutTools).tools).toEqual([]);
  });
});

describe('AuditEventSchema', () => {
  const event = {
    id: 'evt-1',
    timestamp: '2026-07-18T10:00:00.000Z',
    sessionId: 's-1',
    module: 'meter.parser',
    action: 'skip',
    reason: 'unknown record type',
    details: { recordType: 'x-future' },
  };

  it('round-trips through JSON', () => {
    roundTrip(AuditEventSchema, event);
  });

  it('rejects unknown actions', () => {
    expect(() => AuditEventSchema.parse({ ...event, action: 'invent' })).toThrow();
  });
});

describe('DistillProfileSchema', () => {
  it('round-trips and applies defaults', () => {
    const parsed = roundTrip(DistillProfileSchema, { name: 'build-log', version: '1' });
    expect(parsed.match.tools).toEqual([]);
    expect(parsed.gates.entityPreservationMinRatio).toBe(0.95);
    expect(parsed.llm.enabled).toBe(false);
  });
});

describe('CodexFileSchema', () => {
  it('round-trips through JSON', () => {
    roundTrip(CodexFileSchema, {
      version: '1',
      project: 'redutok',
      generatedAt: '2026-07-18T10:00:00.000Z',
      files: [{ path: 'src/index.ts', hash: 'abc123' }],
      interfaces: [{ name: 'loadPrices', signature: '(filePath: string) => PricesFile' }],
      locked: ['project.description'],
    });
  });
});

describe('tally helpers', () => {
  it('adds tallies field by field', () => {
    const a = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, thinking: 5 };
    expect(addTally(emptyTally(), a)).toEqual(a);
    expect(addTally(a, a)).toEqual({ input: 2, output: 4, cacheRead: 6, cacheWrite: 8, thinking: 10 });
  });
});
