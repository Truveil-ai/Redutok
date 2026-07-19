import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.join(here, '..', '..', '..', 'fixtures', 'sessions', name);

/**
 * Positional-argument parsing regressions: without --file (or --out) the
 * sentinel index -1 must not swallow the first positional argument.
 */
describe('cli positional arguments', () => {
  afterEach(() => vi.restoreAllMocks());

  it('audit <session-id> without --file reaches the renderer', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await main(['audit', 's-cli-test'])).toBe(0);
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'Redutok audit for session s-cli-test',
    );
  });

  it('audit <session-id> --file <path> filters to the session', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'redutok-cli-audit-'));
    const auditPath = path.join(dir, 'audit.jsonl');
    writeFileSync(
      auditPath,
      JSON.stringify({
        id: 'e1',
        timestamp: '2026-07-19T10:00:00.000Z',
        sessionId: 's-cli-test',
        module: 'sidecar.distill',
        action: 'distill',
        reason: 'x',
        bytesIn: 100,
        bytesOut: 10,
      }) + '\n',
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await main(['audit', 's-cli-test', '--file', auditPath])).toBe(0);
    const out = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('Events: 1');
  });

  it('report <transcript> without --last or --out parses the positional path', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await main(['report', fixture('small.jsonl')])).toBe(0);
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain('Session: s-small');
  });
});
