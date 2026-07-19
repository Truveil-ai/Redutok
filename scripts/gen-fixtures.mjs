// Deterministic generator for the medium and long synthetic session fixtures.
// Run with: node scripts/gen-fixtures.mjs
// Regenerating produces byte-identical output; expected totals are written
// alongside each fixture so tests compare against independently summed values.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', 'fixtures', 'sessions');

// Small linear congruential generator so fixtures are reproducible.
function lcg(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function generate({ name, sessionId, turns, seed, models, toolPool, unknownEvery }) {
  const rand = lcg(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const int = (min, max) => min + Math.floor(rand() * (max - min + 1));

  const lines = [];
  const totals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    // These fixtures carry no cache_creation tier breakdown (see the usage
    // object below), so the meter conservatively assumes the whole
    // cache-write amount at the 1-hour tier; cacheWrite1h/cacheWriteAssumedTokens
    // track cacheWrite exactly and are finalized after the loop.
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheWriteAssumedTokens: 0,
    thinking: 0,
  };
  let cacheBase = int(2000, 6000);
  const start = Date.parse('2026-07-18T12:00:00.000Z');

  lines.push(JSON.stringify({ type: 'summary', summary: `Synthetic ${name} session` }));
  for (let i = 0; i < turns; i += 1) {
    const ts = new Date(start + i * 15000).toISOString();
    lines.push(
      JSON.stringify({
        type: 'user',
        uuid: `u${i}`,
        timestamp: ts,
        sessionId,
        message: { role: 'user', content: `step ${i}` },
      }),
    );
    if (unknownEvery && i > 0 && i % unknownEvery === 0) {
      lines.push(JSON.stringify({ type: 'x-progress', uuid: `x${i}`, step: i }));
    }
    const toolCount = int(0, 3);
    const tools = Array.from({ length: toolCount }, () => pick(toolPool));
    const usage = {
      input_tokens: int(50, 2500),
      output_tokens: int(80, 1600),
      cache_read_input_tokens: cacheBase,
      cache_creation_input_tokens: int(0, 900),
      thinking_tokens: rand() < 0.4 ? int(50, 1200) : 0,
    };
    cacheBase += int(100, 1200);
    totals.input += usage.input_tokens;
    totals.output += usage.output_tokens;
    totals.cacheRead += usage.cache_read_input_tokens;
    totals.cacheWrite += usage.cache_creation_input_tokens;
    totals.thinking += usage.thinking_tokens;
    const content = [
      ...tools.map((t, j) => ({ type: 'tool_use', id: `t${i}-${j}`, name: t, input: {} })),
      { type: 'text', text: `assistant turn ${i}` },
    ];
    lines.push(
      JSON.stringify({
        type: 'assistant',
        uuid: `a${i}`,
        timestamp: new Date(start + i * 15000 + 5000).toISOString(),
        sessionId,
        message: { role: 'assistant', model: pick(models), content, usage },
      }),
    );
  }

  // No turn in this generator emits a cache_creation tier breakdown, so the
  // parser conservatively assumes the entire cacheWrite amount at the
  // 1-hour tier (see packages/meter/src/parser.ts splitCacheWriteTier).
  totals.cacheWrite1h = totals.cacheWrite;
  totals.cacheWriteAssumedTokens = totals.cacheWrite;

  writeFileSync(path.join(outDir, `${name}.jsonl`), lines.join('\n') + '\n');
  writeFileSync(
    path.join(outDir, `${name}.expected.json`),
    JSON.stringify({ sessionId, turns, totals }, null, 2) + '\n',
  );
  console.log(`${name}: ${turns} turns, totals ${JSON.stringify(totals)}`);
}

generate({
  name: 'medium',
  sessionId: 's-medium',
  turns: 20,
  seed: 42,
  models: ['claude-sonnet-5'],
  toolPool: ['Read', 'Bash', 'Grep', 'Edit'],
  unknownEvery: 7,
});

generate({
  name: 'long-agentic',
  sessionId: 's-long-agentic',
  turns: 150,
  seed: 1337,
  models: ['claude-sonnet-5', 'claude-haiku-4-5'],
  toolPool: ['Read', 'Bash', 'Grep', 'Glob', 'Edit', 'Write', 'Agent'],
  unknownEvery: 11,
});
