import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LIMITS } from '@redutok/shared';
import { estimateTokens } from '../src/distill.js';
import type { LlmPass } from '../src/llm.js';
import { statePath, updateRollingState } from '../src/state.js';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'redutok-state-'));

describe('updateRollingState rule fallback', () => {
  it('appends actions as a last-actions list', async () => {
    const dir = tmp();
    await updateRollingState(dir, { kind: 'tool-use', tool: 'Bash' });
    const body = await updateRollingState(dir, { kind: 'file-change', tool: 'Edit', path: 'src/a.ts' });
    expect(body).toContain('## Last actions');
    expect(body).toContain('file-change Edit src/a.ts');
    expect(readFileSync(statePath(dir), 'utf8')).toBe(body);
  });

  it('never exceeds the 600 token budget, dropping oldest whole entries', async () => {
    const dir = tmp();
    let body = '';
    for (let i = 0; i < 300; i += 1) {
      body = await updateRollingState(dir, {
        kind: 'file-change',
        tool: 'Edit',
        path: `packages/deeply/nested/module-${i}/implementation-file-${i}.ts`,
      });
    }
    expect(estimateTokens(body)).toBeLessThanOrEqual(LIMITS.SESSION_STATE_MAX_TOKENS);
    expect(body).toContain('module-299');
    expect(body).not.toContain('module-0/');
    expect(body.split('\n').every((l) => l === '' || !l.endsWith('...')));
  });
});

describe('updateRollingState llm pass', () => {
  it('uses the LlmPass summary when it fits the budget', async () => {
    const stub: LlmPass = {
      name: 'stub',
      summarize: () => Promise.resolve('task: testing\nfiles: a.ts\nopen questions: none'),
    };
    const body = await updateRollingState(tmp(), { kind: 'tool-use', tool: 'Read' }, stub);
    expect(body).toBe('task: testing\nfiles: a.ts\nopen questions: none');
  });

  it('falls back to the rule list when the summary blows the budget', async () => {
    const stub: LlmPass = {
      name: 'verbose',
      summarize: () => Promise.resolve('word '.repeat(2000)),
    };
    const body = await updateRollingState(tmp(), { kind: 'tool-use', tool: 'Read' }, stub);
    expect(body).toContain('## Last actions');
  });
});
