import http from 'node:http';

/**
 * Fail-open client for the sidecar. Never throws: a dead or slow sidecar
 * resolves to { ok: false } so callers degrade to raw passthrough.
 */

export interface SidecarTarget {
  port?: number;
  host?: string;
  pipePath?: string;
}

export type SidecarResponse =
  | { ok: true; status: number; body: unknown }
  | { ok: false; error: string };

export function sidecarRequest(
  target: SidecarTarget,
  method: 'GET' | 'POST',
  requestPath: string,
  payload?: unknown,
  options: { timeoutMs?: number } = {},
): Promise<SidecarResponse> {
  const timeoutMs = options.timeoutMs ?? 1000;
  return new Promise((resolve) => {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const requestOptions: http.RequestOptions = {
      method,
      path: requestPath,
      timeout: timeoutMs,
      headers:
        body === undefined
          ? {}
          : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    };
    if (target.pipePath !== undefined) {
      requestOptions.socketPath = target.pipePath;
    } else {
      requestOptions.host = target.host ?? '127.0.0.1';
      requestOptions.port = target.port;
    }
    const req = http.request(requestOptions, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown = text;
        try {
          parsed = JSON.parse(text);
        } catch {
          // Non-JSON bodies are returned as text.
        }
        resolve({ ok: true, status: res.statusCode ?? 0, body: parsed });
      });
      res.on('error', (err) => resolve({ ok: false, error: err.message }));
    });
    req.on('timeout', () => {
      req.destroy(new Error(`sidecar request timed out after ${timeoutMs}ms`));
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    if (body !== undefined) req.write(body);
    req.end();
  });
}
