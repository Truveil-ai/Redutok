import type { AnthropicLike, MessagesCreateRequest, MessagesResponse } from './types.js';

/** Programmable mock client. Feed it an ordered list of canned responses;
 * each `messages.create` call pops the next one. `history` records every
 * request the mock received so tests can assert against them. */
export interface MockAnthropicClient extends AnthropicLike {
  history: MessagesCreateRequest[];
  push(response: MessagesResponse): void;
  responses: MessagesResponse[];
}

export function newMockClient(_initial?: MessagesResponse[]): MockAnthropicClient {
  throw new Error('chatbench:newMockClient not implemented');
}
