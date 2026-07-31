import { describe, expect, it } from 'vitest';
import {
  newMockClient,
  runPasteTurn,
  runVaultLoop,
  type MessagesResponse,
} from '../../src/chatbench/index.js';

const mkResponse = (partial: Partial<MessagesResponse>): MessagesResponse => ({
  id: partial.id ?? 'msg-1',
  model: 'claude-sonnet-5',
  role: 'assistant',
  content: partial.content ?? [{ type: 'text', text: 'ok' }],
  stop_reason: partial.stop_reason ?? 'end_turn',
  usage: partial.usage ?? { input_tokens: 100, output_tokens: 20 },
});

describe('runPasteTurn', () => {
  it('sends a single request and returns text + usage', async () => {
    const client = newMockClient([
      mkResponse({ content: [{ type: 'text', text: 'answer body' }] }),
    ]);
    const out = await runPasteTurn(client, 'claude-sonnet-5', [], 'What is X?', {
      maxTokensPerTurn: 512,
      temperature: 0,
    });
    expect(out.assistantText).toBe('answer body');
    expect(out.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
    expect(client.history).toHaveLength(1);
    expect(client.history[0]!.messages[0]!.role).toBe('user');
    expect(out.messages).toHaveLength(2);
    expect(out.messages[1]!.role).toBe('assistant');
  });

  it('rides prior turns for a multi-turn conversation', async () => {
    const client = newMockClient([
      mkResponse({ content: [{ type: 'text', text: 'first' }] }),
      mkResponse({ content: [{ type: 'text', text: 'second' }], usage: { input_tokens: 150, output_tokens: 25 } }),
    ]);
    const t1 = await runPasteTurn(client, 'claude-sonnet-5', [], 'Q1', {
      maxTokensPerTurn: 512,
      temperature: 0,
    });
    const t2 = await runPasteTurn(client, 'claude-sonnet-5', t1.messages, 'Q2', {
      maxTokensPerTurn: 512,
      temperature: 0,
    });
    expect(t2.assistantText).toBe('second');
    // Turn 2's request carries turn 1's user + assistant + turn 2's user.
    expect(client.history[1]!.messages).toHaveLength(3);
  });
});

describe('runVaultLoop', () => {
  it('proxies vault_ask and returns the final text after tool_result', async () => {
    const client = newMockClient([
      // First turn: model requests vault_ask.
      mkResponse({
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'vault_ask', input: { question: 'find X' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 200, output_tokens: 40 },
      }),
      // Second turn: model returns the final answer.
      mkResponse({
        content: [{ type: 'text', text: 'X is defined at foo.ts:42' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 260, output_tokens: 30 },
      }),
    ]);
    const asks: unknown[] = [];
    const out = await runVaultLoop(
      client,
      'claude-sonnet-5',
      'system prompt with codex',
      [],
      'Where is X defined?',
      {
        vaultAsk: (args) => {
          asks.push(args);
          return 'X is at foo.ts:42 [vault accounting: ...]';
        },
        vaultZoom: () => 'unused',
      },
      { maxTokensPerTurn: 512, temperature: 0 },
    );
    expect(out.assistantText).toBe('X is defined at foo.ts:42');
    expect(out.turns).toBe(2);
    expect(out.toolCallCount).toBe(1);
    expect(out.usage.inputTokens).toBe(460);
    expect(out.usage.outputTokens).toBe(70);
    expect(asks).toEqual([{ question: 'find X' }]);
    // The tool_result must have been fed back on turn 2.
    const turn2Msgs = client.history[1]!.messages;
    const lastUser = turn2Msgs[turn2Msgs.length - 1]!;
    expect(Array.isArray(lastUser.content)).toBe(true);
    const parts = lastUser.content as Array<{ type: string }>;
    expect(parts.some((p) => p.type === 'tool_result')).toBe(true);
  });

  it('handles zoom after ask (multi-tool loop)', async () => {
    const client = newMockClient([
      mkResponse({
        content: [{ type: 'tool_use', id: 'tu_1', name: 'vault_ask', input: {} }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 200, output_tokens: 20 },
      }),
      mkResponse({
        content: [{ type: 'tool_use', id: 'tu_2', name: 'vault_zoom', input: { handle: 'h1' } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 250, output_tokens: 20 },
      }),
      mkResponse({
        content: [{ type: 'text', text: 'final' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 300, output_tokens: 15 },
      }),
    ]);
    const out = await runVaultLoop(
      client,
      'claude-sonnet-5',
      'sys',
      [],
      'q',
      {
        vaultAsk: () => 'ask body',
        vaultZoom: () => 'zoom body',
      },
      { maxTokensPerTurn: 512, temperature: 0 },
    );
    expect(out.turns).toBe(3);
    expect(out.toolCallCount).toBe(2);
    expect(out.assistantText).toBe('final');
  });

  it('surfaces the system prompt on every turn', async () => {
    const client = newMockClient([
      mkResponse({ content: [{ type: 'text', text: 'x' }] }),
    ]);
    await runVaultLoop(
      client,
      'claude-sonnet-5',
      'THE SYSTEM PROMPT',
      [],
      'q',
      { vaultAsk: () => '', vaultZoom: () => '' },
      { maxTokensPerTurn: 512, temperature: 0 },
    );
    const sys = client.history[0]!.system;
    const text = typeof sys === 'string' ? sys : (sys as Array<{ text: string }>)[0]!.text;
    expect(text).toBe('THE SYSTEM PROMPT');
  });
});
