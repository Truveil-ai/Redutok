import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildLedger, grandTotal } from '../src/ledger.js';
import { parseSessionFile } from '../src/parser.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.join(here, '..', '..', '..', 'fixtures', 'sessions', name);

describe('buildLedger on small.jsonl', () => {
  it('matches hand-computed totals to the token', async () => {
    const ledger = buildLedger(await parseSessionFile(fixture('small.jsonl')));
    expect(ledger.sessionId).toBe('s-small');
    expect(ledger.entries).toHaveLength(3);
    expect(ledger.totals).toEqual({
      input: 2160,
      output: 1470,
      cacheRead: 15100,
      cacheWrite: 920,
      // small.jsonl has no cache_creation breakdown, so the whole amount is
      // conservatively assumed at the 1-hour tier.
      cacheWrite5m: 0,
      cacheWrite1h: 920,
      cacheWriteAssumedTokens: 920,
      thinking: 450,
    });
    expect(grandTotal(ledger.totals)).toBe(20100);
  });

  it('attributes tool calls and splits turn output evenly across tools', async () => {
    const ledger = buildLedger(await parseSessionFile(fixture('small.jsonl')));
    expect(ledger.byTool['Read']).toEqual({ calls: 2, outputTokenShare: 300 + 225 });
    expect(ledger.byTool['Bash']).toEqual({ calls: 1, outputTokenShare: 225 });
  });

  it('numbers turns sequentially from 1', async () => {
    const ledger = buildLedger(await parseSessionFile(fixture('small.jsonl')));
    expect(ledger.entries.map((e) => e.turn)).toEqual([1, 2, 3]);
  });
});

for (const name of ['medium', 'long-agentic']) {
  describe(`buildLedger on ${name}.jsonl`, () => {
    it('matches the generator-computed expected totals to the token', async () => {
      const expected = JSON.parse(readFileSync(fixture(`${name}.expected.json`), 'utf8'));
      const ledger = buildLedger(await parseSessionFile(fixture(`${name}.jsonl`)));
      expect(ledger.sessionId).toBe(expected.sessionId);
      expect(ledger.entries).toHaveLength(expected.turns);
      expect(ledger.totals).toEqual(expected.totals);
    });
  });
}

describe('buildLedger fallbacks', () => {
  it('uses the fallback session id and timestamp when records omit them', () => {
    const ledger = buildLedger(
      {
        sessionId: undefined,
        assistantTurns: [
          {
            model: 'claude-sonnet-5',
            tools: [],
            tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, thinking: 0 },
          },
        ],
        counts: { lines: 1, known: 1, unknownType: 0, malformed: 0 },
        audit: [],
      },
      'fallback-session',
    );
    expect(ledger.entries[0]?.sessionId).toBe('fallback-session');
    expect(ledger.entries[0]?.timestamp).toBe('1970-01-01T00:00:00.000Z');
  });
});
