#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { handleMcpRequest, type JsonRpcRequest, type McpDeps } from './server.js';

/**
 * Stdio entry: newline-delimited JSON-RPC per the MCP stdio transport.
 * Sidecar discovery via REDUTOK_PORT, defaulting to the pidfile-free
 * fail-open path (a dead target just means raw passthrough).
 */

const deps: McpDeps = {
  target: { port: Number(process.env['REDUTOK_PORT'] ?? '48642') },
  sessionId: process.env['REDUTOK_SESSION'] ?? `mcp-${process.pid}`,
};

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (line.trim() === '') return;
  void (async () => {
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch {
      return;
    }
    try {
      const response = await handleMcpRequest(request, deps);
      if (response !== null) process.stdout.write(JSON.stringify(response) + '\n');
    } catch (err) {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id ?? null,
          error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
        }) + '\n',
      );
    }
  })();
});
