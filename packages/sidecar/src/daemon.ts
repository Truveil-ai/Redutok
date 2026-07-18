import http from 'node:http';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createLogger, type Logger } from './log.js';

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
}

export interface DaemonHandle {
  port: number;
  pipePath?: string;
  pidfile: string;
  close(): Promise<void>;
}

function handler(log: Logger): http.RequestListener {
  const startedAt = Date.now();
  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const respond = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    log.info('request', { method: req.method, path: url.pathname });
    if (req.method === 'GET' && url.pathname === '/health') {
      respond(200, { ok: true, pid: process.pid, uptimeMs: Date.now() - startedAt });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/debug/slow') {
      // Test-only endpoint used by the kill-mid-request degradation test.
      const ms = Math.min(Number(url.searchParams.get('ms') ?? '1000'), 30_000);
      setTimeout(() => respond(200, { ok: true, sleptMs: ms }), ms);
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
  const listener = handler(log);
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
    if (existsSync(pidfile)) rmSync(pidfile);
    log.info('daemon stopped', { port });
  };
  process.once('redutok:shutdown' as never, () => {
    void close();
  });
  return { port, pipePath, pidfile, close };
}
