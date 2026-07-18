import { describe, expect, it } from 'vitest';
import { LIMITS } from '../src/index.js';

describe('LIMITS', () => {
  it('matches the budgets fixed in BUILD.md guardrail 5', () => {
    expect(LIMITS.HOOK_FAIL_OPEN_MS).toBe(50);
    expect(LIMITS.LOCAL_LLM_TIMEOUT_MS).toBe(2500);
  });
});
