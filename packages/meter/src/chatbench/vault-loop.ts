import type {
  AnthropicLike,
  MessageInput,
  MessagesResponse,
  ToolDefinition,
} from './types.js';

export interface VaultTools {
  vaultAsk: (args: Record<string, unknown>) => Promise<string> | string;
  vaultZoom: (args: Record<string, unknown>) => Promise<string> | string;
}

export interface VaultLoopResult {
  assistantText: string;
  turns: number;
  toolCallCount: number;
  usage: { inputTokens: number; outputTokens: number };
  messages: MessageInput[];
}

const TOOL_DEFS: ToolDefinition[] = [
  {
    name: 'vault_ask',
    description:
      'Ask the mounted corpus vault a natural-language question. Returns a dossier grounded in the corpus, with retained artifact handles for follow-up zooms.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask the vault.' },
        corpus: { type: 'string', description: 'Optional corpus name if multiple are mounted.' },
        codex_version: {
          type: 'number',
          description: 'The codex version the caller is riding, from the pasted vault_codex block.',
        },
      },
      required: ['question'],
    },
  },
  {
    name: 'vault_zoom',
    description:
      'Recover a retained artifact (e.g. an elided section, a truncated dossier, or a distillation) by its handle. Optionally focus with a query.',
    input_schema: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: 'The artifact handle to recover.' },
        query: { type: 'string', description: 'Optional focus query.' },
        corpus: { type: 'string', description: 'Optional corpus name.' },
      },
      required: ['handle'],
    },
  },
];

export async function runPasteTurn(
  client: AnthropicLike,
  model: string,
  prior: MessageInput[],
  userMessage: string,
  opts: { maxTokensPerTurn: number; temperature: number },
): Promise<{
  assistantText: string;
  usage: { inputTokens: number; outputTokens: number };
  response: MessagesResponse;
  messages: MessageInput[];
}> {
  const messages: MessageInput[] = [...prior, { role: 'user', content: userMessage }];
  const response = await client.messages.create({
    model,
    max_tokens: opts.maxTokensPerTurn,
    temperature: opts.temperature,
    messages,
  });
  const assistantText = response.content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('');
  const assistant: MessageInput = {
    role: 'assistant',
    content: response.content as MessageInput['content'],
  };
  return {
    assistantText,
    usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
    response,
    messages: [...messages, assistant],
  };
}

export async function runVaultLoop(
  client: AnthropicLike,
  model: string,
  systemPrompt: string,
  prior: MessageInput[],
  userMessage: string,
  tools: VaultTools,
  opts: { maxTokensPerTurn: number; temperature: number; maxToolTurns?: number },
): Promise<VaultLoopResult> {
  const maxToolTurns = opts.maxToolTurns ?? 8;
  let messages: MessageInput[] = [...prior, { role: 'user', content: userMessage }];
  let turns = 0;
  let toolCallCount = 0;
  let totalIn = 0;
  let totalOut = 0;
  let lastText = '';
  for (let i = 0; i <= maxToolTurns; i += 1) {
    const response = await client.messages.create({
      model,
      max_tokens: opts.maxTokensPerTurn,
      temperature: opts.temperature,
      system: systemPrompt,
      messages,
      tools: TOOL_DEFS,
    });
    turns += 1;
    totalIn += response.usage.input_tokens;
    totalOut += response.usage.output_tokens;
    const textParts = response.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');
    if (textParts !== '') lastText = textParts;
    messages = [
      ...messages,
      { role: 'assistant', content: response.content as MessageInput['content'] },
    ];
    if (response.stop_reason !== 'tool_use') break;
    const toolUses = response.content.filter(
      (p): p is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } =>
        p.type === 'tool_use',
    );
    const toolResults: MessageInput['content'] = [];
    for (const tu of toolUses) {
      toolCallCount += 1;
      let out: string;
      let isError = false;
      try {
        if (tu.name === 'vault_ask') out = await tools.vaultAsk(tu.input);
        else if (tu.name === 'vault_zoom') out = await tools.vaultZoom(tu.input);
        else {
          out = `error: unknown tool "${tu.name}"`;
          isError = true;
        }
      } catch (err) {
        out = `error: ${err instanceof Error ? err.message : String(err)}`;
        isError = true;
      }
      (toolResults as Array<{ type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }>).push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: out,
        ...(isError ? { is_error: true } : {}),
      });
    }
    messages = [...messages, { role: 'user', content: toolResults }];
  }
  return {
    assistantText: lastText,
    turns,
    toolCallCount,
    usage: { inputTokens: totalIn, outputTokens: totalOut },
    messages,
  };
}
