import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sidecarRequest } from '../src/client.js';
import { startDaemon, type DaemonHandle } from '../src/daemon.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const profilesDir = path.join(repoRoot, 'profiles');
const tmpDir = () => mkdtempSync(path.join(os.tmpdir(), 'redutok-attrib-'));

function auditEvents(dcpDir: string): { sessionId?: string; action: string }[] {
  return readFileSync(path.join(dcpDir, 'audit.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { sessionId?: string; action: string });
}

async function post(daemon: DaemonHandle, route: string, body: unknown): Promise<unknown> {
  const res = await sidecarRequest({ port: daemon.port }, 'POST', route, body, { timeoutMs: 5000 });
  expect(res.ok).toBe(true);
  return res.ok ? res.body : undefined;
}

describe('session attribution, hooks register the transcript session id', () => {
  it('attributes distill and serve-file events to the registered session, not the caller placeholder', async () => {
    const dcpDir = tmpDir();
    const daemon = await startDaemon({ port: 0, dcpDir, profilesDir });
    try {
      await post(daemon, '/notify', { kind: 'session-start', sessionId: 's-transcript' });
      const health = await sidecarRequest({ port: daemon.port }, 'GET', '/health', undefined, {
        timeoutMs: 5000,
      });
      expect(health.ok && (health.body as { activeSessionId?: string }).activeSessionId).toBe(
        's-transcript',
      );

      await post(daemon, '/distill', {
        raw: 'line one\nline two\n',
        profile: 'generic-stdout',
        sessionId: 'mcp-session',
      });
      await post(daemon, '/serve-file', {
        raw: 'export const a = 1;\n',
        path: 'src/a.ts',
        sessionId: 'mcp-session',
      });

      const events = auditEvents(dcpDir);
      expect(events.length).toBeGreaterThanOrEqual(2);
      for (const event of events) expect(event.sessionId).toBe('s-transcript');
    } finally {
      await daemon.close();
    }
  });

  it('re-registration switches attribution for subsequent events', async () => {
    const dcpDir = tmpDir();
    const daemon = await startDaemon({ port: 0, dcpDir, profilesDir });
    try {
      await post(daemon, '/notify', { kind: 'session-start', sessionId: 's-first' });
      await post(daemon, '/distill', { raw: 'a\n', profile: 'generic-stdout', sessionId: 'mcp-session' });
      await post(daemon, '/notify', { kind: 'tool-use', tool: 'Bash', sessionId: 's-second' });
      await post(daemon, '/distill', { raw: 'b\n', profile: 'generic-stdout', sessionId: 'mcp-session' });
      const ids = auditEvents(dcpDir).map((e) => e.sessionId);
      expect(ids).toContain('s-first');
      expect(ids).toContain('s-second');
      expect(ids[ids.length - 1]).toBe('s-second');
    } finally {
      await daemon.close();
    }
  });

  it('falls back to the caller-provided session id, then unknown, when nothing is registered', async () => {
    const dcpDir = tmpDir();
    const daemon = await startDaemon({ port: 0, dcpDir, profilesDir });
    try {
      await post(daemon, '/distill', { raw: 'a\n', profile: 'generic-stdout', sessionId: 'mcp-session' });
      await post(daemon, '/distill', { raw: 'b\n', profile: 'generic-stdout' });
      const ids = auditEvents(dcpDir).map((e) => e.sessionId);
      expect(ids[0]).toBe('mcp-session');
      expect(ids[1]).toBe('unknown');
    } finally {
      await daemon.close();
    }
  });

  it('a notify without a session id never clears an existing registration', async () => {
    const dcpDir = tmpDir();
    const daemon = await startDaemon({ port: 0, dcpDir, profilesDir });
    try {
      await post(daemon, '/notify', { kind: 'session-start', sessionId: 's-keep' });
      await post(daemon, '/notify', { kind: 'tool-use', tool: 'Bash' });
      const health = await sidecarRequest({ port: daemon.port }, 'GET', '/health', undefined, {
        timeoutMs: 5000,
      });
      expect(health.ok && (health.body as { activeSessionId?: string }).activeSessionId).toBe('s-keep');
    } finally {
      await daemon.close();
    }
  });
});
