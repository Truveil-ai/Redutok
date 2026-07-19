import http from 'node:http';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DistillProfile } from '@redutok/shared';
import { AuditWriter } from './audit.js';
import { refreshFiles } from './codex.js';
import { distillArtifact, loadProfiles, zoom } from './distill.js';
import { serveFile } from './serve.js';
import { updateRollingState } from './state.js';
import { createLogger, type Logger } from './log.js';
import { openStore, type Store } from './store.js';

/**
 * Sidecar daemon: localhost HTTP plus, on Windows, a named-pipe transport
 * (unix domain sockets are not portable here). Zero position in the request
 * path: if this process dies, sessions continue at full fidelity.
 */

export interface DaemonOptions {
  /** 0 selects an ephemeral port. */
  port: number;
  /** Directory for pidfile and logs, normally <repo>/.dcp. */
  dcpDir: string;
  /** When set, also listen on \\.\pipe\<pipeName> (Windows only). */
  pipeName?: string;
  /** Directory of profiles/*.yaml; when set, /distill and /zoom are served. */
  profilesDir?: string;
}

export interface DaemonHandle {
  port: number;
  pipePath?: string;
  pidfile: string;
  close(): Promise<void>;
}

interface Engines {
  store: Store;
  audit: AuditWriter;
  profiles: Map<string, DistillProfile>;
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on('error', reject);
  });
}

function handler(
  log: Logger,
  engines?: Engines,
  onFileChange?: (filePath: string) => Promise<string[]>,
  onNotify?: (event: { kind: string; tool?: string; path?: string }) => Promise<void>,
): http.RequestListener {
  const startedAt = Date.now();
  // Active Claude Code transcript session, registered by the SessionStart and
  // PostToolUse hooks via /notify. The MCP server cannot know the transcript
  // id (Claude Code does not pass it to MCP servers), so when a session is
  // registered it overrides the caller-provided placeholder on every artifact
  // and audit event. Fallback when nothing is registered: the caller-provided
  // sessionId, then "unknown". Last registration wins; in-memory only, hooks
  // re-register on every matched tool use.
  const session: { activeId?: string } = {};
  const attributedSessionId = (provided: unknown): string =>
    session.activeId ?? String(provided ?? 'unknown');
  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const respond = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    log.info('request', { method: req.method, path: url.pathname });
    if (req.method === 'POST' && url.pathname === '/serve-file') {
      // Delta path for dcp__read: first serve full (then distilled by the
      // caller's profile), later serves as diff or unchanged reference.
      if (engines === undefined) {
        respond(503, { ok: false, error: 'daemon started without a profiles directory' });
        return;
      }
      void readBody(req)
        .then(async (payload) => {
          const p = payload as Record<string, unknown>;
          const sessionId = attributedSessionId(p['sessionId']);
          const relPath = String(p['path'] ?? '');
          const raw = String(p['raw'] ?? '');
          const served = serveFile(engines.store, engines.audit, sessionId, relPath, raw);
          if (served.mode !== 'full') {
            respond(200, { ...served, handle: `[dcp:file ${served.ref}]` });
            return;
          }
          const profile = engines.profiles.get('file-skeleton');
          if (profile === undefined) {
            respond(200, { ...served, handle: `[dcp:file ${served.ref}]` });
            return;
          }
          const outcome = await distillArtifact(engines.store, engines.audit, {
            raw,
            profile,
            sessionId,
            tool: 'dcp__read',
            context: { filePath: relPath },
          });
          respond(200, {
            mode: 'full',
            ref: served.ref,
            text: outcome.text,
            handle: outcome.handle,
          });
        })
        .catch((err: unknown) =>
          respond(400, { ok: false, error: err instanceof Error ? err.message : String(err) }),
        );
      return;
    }
    if (req.method === 'POST' && (url.pathname === '/distill' || url.pathname === '/zoom')) {
      if (engines === undefined) {
        respond(503, { ok: false, error: 'daemon started without a profiles directory' });
        return;
      }
      void readBody(req)
        .then(async (payload) => {
          const p = payload as Record<string, unknown>;
          if (url.pathname === '/zoom') {
            respond(200, zoom(engines.store, engines.audit, String(p['id']), p['query'] as string | undefined));
            return;
          }
          const profile = engines.profiles.get(String(p['profile']));
          if (profile === undefined) {
            respond(400, { ok: false, error: `unknown profile "${String(p['profile'])}"` });
            return;
          }
          const outcome = await distillArtifact(engines.store, engines.audit, {
            raw: String(p['raw'] ?? ''),
            profile,
            sessionId: attributedSessionId(p['sessionId']),
            tool: p['tool'] as string | undefined,
            context: { filePath: p['filePath'] as string | undefined },
          });
          respond(200, outcome);
        })
        .catch((err: unknown) => {
          log.error('request failed', { path: url.pathname, error: String(err) });
          respond(400, { ok: false, error: err instanceof Error ? err.message : String(err) });
        });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      respond(200, {
        ok: true,
        pid: process.pid,
        uptimeMs: Date.now() - startedAt,
        activeSessionId: session.activeId ?? null,
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/debug/slow') {
      // Test-only endpoint used by the kill-mid-request degradation test.
      const ms = Math.min(Number(url.searchParams.get('ms') ?? '1000'), 30_000);
      setTimeout(() => respond(200, { ok: true, sleptMs: ms }), ms);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/notify') {
      // Metering pings and file-change notifications from PostToolUse hooks.
      // File changes trigger incremental codex maintenance (architecture 3.3).
      void readBody(req)
        .then(async (payload) => {
          log.info('notify', { payload });
          const p = payload as { kind?: string; tool?: string; path?: string; sessionId?: string };
          if (typeof p.sessionId === 'string' && p.sessionId !== '') {
            session.activeId = p.sessionId;
          }
          if (onNotify !== undefined) {
            await onNotify({ kind: p.kind ?? 'tool-use', tool: p.tool, path: p.path });
          }
          if (p.kind === 'file-change' && typeof p.path === 'string' && onFileChange !== undefined) {
            const reindexed = await onFileChange(p.path);
            respond(200, { ok: true, reindexed });
            return;
          }
          respond(200, { ok: true });
        })
        .catch(() => respond(400, { ok: false }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/shutdown') {
      respond(200, { ok: true, shuttingDown: true });
      setImmediate(() => process.emit('redutok:shutdown' as never));
      return;
    }
    respond(404, { ok: false, error: `no route for ${req.method} ${url.pathname}` });
  };
}

export async function startDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  const log = createLogger(path.join(options.dcpDir, 'sidecar.log.jsonl'));
  let engines: Engines | undefined;
  if (options.profilesDir !== undefined) {
    engines = {
      store: openStore(path.join(options.dcpDir, 'state.db')),
      audit: new AuditWriter(path.join(options.dcpDir, 'audit.jsonl')),
      profiles: loadProfiles(options.profilesDir),
    };
  }
  const repoRoot = path.dirname(path.resolve(options.dcpDir));
  const onFileChange = async (filePath: string): Promise<string[]> => {
    try {
      const rel = path.isAbsolute(filePath) ? path.relative(repoRoot, filePath) : filePath;
      return await refreshFiles(repoRoot, [rel]);
    } catch {
      return [];
    }
  };
  const onNotify = async (event: { kind: string; tool?: string; path?: string }): Promise<void> => {
    try {
      await updateRollingState(options.dcpDir, event);
    } catch {
      // State maintenance must never fail a notify.
    }
  };
  const listener = handler(log, engines, onFileChange, onNotify);
  const httpServer = http.createServer(listener);
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.port, '127.0.0.1', resolve);
  });
  const address = httpServer.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;

  let pipeServer: http.Server | undefined;
  let pipePath: string | undefined;
  if (options.pipeName !== undefined && process.platform === 'win32') {
    pipePath = `\\\\.\\pipe\\${options.pipeName}`;
    pipeServer = http.createServer(listener);
    await new Promise<void>((resolve, reject) => {
      pipeServer?.once('error', reject);
      pipeServer?.listen(pipePath, resolve);
    });
  }

  const pidfile = path.join(options.dcpDir, 'sidecar.pid.json');
  writeFileSync(pidfile, JSON.stringify({ pid: process.pid, port, pipePath }) + '\n', 'utf8');
  log.info('daemon started', { port, pipePath, pid: process.pid });

  const close = async (): Promise<void> => {
    await Promise.all(
      [httpServer, pipeServer]
        .filter((s): s is http.Server => s !== undefined)
        .map(
          (s) =>
            new Promise<void>((resolve) => {
              s.close(() => resolve());
              s.closeAllConnections();
            }),
        ),
    );
    engines?.store.close();
    if (existsSync(pidfile)) rmSync(pidfile);
    log.info('daemon stopped', { port });
  };
  process.once('redutok:shutdown' as never, () => {
    void close();
  });
  return { port, pipePath, pidfile, close };
}
