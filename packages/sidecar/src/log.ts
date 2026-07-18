import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/** Structured JSONL logger for the sidecar. One object per line, never throws. */

export type LogLevel = 'info' | 'warn' | 'error';

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(filePath: string): Logger {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const write = (level: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    try {
      appendFileSync(
        filePath,
        JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }) + '\n',
        'utf8',
      );
    } catch {
      // Logging must never take the daemon down.
    }
  };
  return {
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
  };
}
