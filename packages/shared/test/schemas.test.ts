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
  it('adds tallies field by field, treating an absent cache-write tier split as zero', () => {
    const a = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, thinking: 5 };
    expect(addTally(emptyTally(), a)).toEqual({
      ...a,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheWriteAssumedTokens: 0,
    });
    expect(addTally(a, a)).toEqual({
      input: 2,
      output: 4,
      cacheRead: 6,
      cacheWrite: 8,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheWriteAssumedTokens: 0,
      thinking: 10,
    });
  });

  it('emptyTally starts every field, including the cache-write tier split, at zero', () => {
    expect(emptyTally()).toEqual({
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

  it('sums the cache-write tier split across tallies that carry it', () => {
    const a = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 100,
      cacheWrite5m: 40,
      cacheWrite1h: 60,
      cacheWriteAssumedTokens: 0,
      thinking: 0,
    };
    const b = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 50,
      cacheWrite5m: 0,
      cacheWrite1h: 50,
      cacheWriteAssumedTokens: 50,
      thinking: 0,
    };
    const sum = addTally(a, b);
    expect(sum.cacheWrite5m).toBe(40);
    expect(sum.cacheWrite1h).toBe(110);
    expect(sum.cacheWriteAssumedTokens).toBe(50);
    expect(sum.cacheWrite).toBe(150);
  });
});

describe('TokenTallySchema cache-write tier split', () => {
  const base = {
    sessionId: 's-1',
    turn: 1,
    timestamp: '2026-07-18T10:00:00.000Z',
    model: 'm',
    tools: [],
  };

  it('accepts a tally with no tier split (backward compatible with older fixtures)', () => {
    expect(() =>
      LedgerEntrySchema.parse({
        ...base,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 10, thinking: 0 },
      }),
    ).not.toThrow();
  });

  it('accepts a tally whose split sums exactly to cacheWrite', () => {
    expect(() =>
      LedgerEntrySchema.parse({
        ...base,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 10, cacheWrite5m: 4, cacheWrite1h: 6, thinking: 0 },
      }),
    ).not.toThrow();
  });

  it('rejects a tally whose split does not sum to cacheWrite, rather than silently trusting a partial breakdown', () => {
    expect(() =>
      LedgerEntrySchema.parse({
        ...base,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 10, cacheWrite5m: 4, cacheWrite1h: 4, thinking: 0 },
      }),
    ).toThrow();
  });
});
