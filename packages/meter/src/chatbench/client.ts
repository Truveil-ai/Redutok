import type { AnthropicLike, MessagesCreateRequest, MessagesResponse } from './types.js';

export interface MockAnthropicClient extends AnthropicLike {
  history: MessagesCreateRequest[];
  responses: MessagesResponse[];
  push(response: MessagesResponse): void;
}

/**
 * Programmable mock. Every `messages.create` call pops the next canned
 * response and records the request. Throws if the queue is empty — a
 * missing canned response is a test bug, not a graceful default.
 */
export function newMockClient(initial: MessagesResponse[] = []): MockAnthropicClient {
  const history: MessagesCreateRequest[] = [];
  const responses = [...initial];
  const client: MockAnthropicClient = {
    history,
    responses,
    push(r) {
      responses.push(r);
    },
    messages: {
      async create(req: MessagesCreateRequest): Promise<MessagesResponse> {
        history.push(req);
        const r = responses.shift();
        if (r === undefined) {
          throw new Error(
            `chatbench mock: no more canned responses (call #${history.length})`,
          );
        }
        return r;
      },
    },
  };
  return client;
}
