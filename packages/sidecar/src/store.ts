import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { AuditEventSchema, type AuditEvent } from '@redutok/shared';

/**
 * SQLite state store for the sidecar. Raw artifacts are retained per session
 * so zoom can always serve from here instead of re-executing anything.
 * Schema lives in versioned sql files under migrations/, applied in order and
 * tracked via PRAGMA user_version.
 */

export interface ArtifactRecord {
  id: string;
  sessionId: string;
  artifactClass: string;
  tool?: string;
  createdAt: string;
  raw: string;
  distilled?: string;
  profile?: string;
  gatesPassed: boolean;
  meta: Record<string, unknown>;
}

export interface ServedFileRecord {
  sessionId: string;
  path: string;
  hash: string;
  servedAt: string;
}

export interface SessionStateRecord {
  sessionId: string;
  stateMd: string;
  updatedAt: string;
}

function migrationsDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
}

export class Store {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.applyMigrations();
  }

  private applyMigrations(): void {
    const files = readdirSync(migrationsDir())
      .filter((f) => /^\d{3}_.*\.sql$/.test(f))
      .sort();
    const current = this.migrationVersion();
    for (const file of files) {
      const version = Number(file.slice(0, 3));
      if (version <= current) continue;
      const sql = readFileSync(path.join(migrationsDir(), file), 'utf8');
      const apply = this.db.transaction(() => {
        this.db.exec(sql);
        this.db.pragma(`user_version = ${version}`);
      });
      apply();
    }
  }

  migrationVersion(): number {
    return this.db.pragma('user_version', { simple: true }) as number;
  }

  insertArtifact(a: ArtifactRecord): void {
    this.db
      .prepare(
        `INSERT INTO artifacts (id, session_id, artifact_class, tool, created_at, raw, raw_bytes,
           distilled, distilled_bytes, profile, gates_passed, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.id,
        a.sessionId,
        a.artifactClass,
        a.tool ?? null,
        a.createdAt,
        a.raw,
        Buffer.byteLength(a.raw, 'utf8'),
        a.distilled ?? null,
        a.distilled === undefined ? null : Buffer.byteLength(a.distilled, 'utf8'),
        a.profile ?? null,
        a.gatesPassed ? 1 : 0,
        JSON.stringify(a.meta),
      );
  }

  getArtifact(id: string): ArtifactRecord | undefined {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) return undefined;
    return {
      id: row['id'] as string,
      sessionId: row['session_id'] as string,
      artifactClass: row['artifact_class'] as string,
      tool: (row['tool'] as string | null) ?? undefined,
      createdAt: row['created_at'] as string,
      raw: row['raw'] as string,
      distilled: (row['distilled'] as string | null) ?? undefined,
      profile: (row['profile'] as string | null) ?? undefined,
      gatesPassed: row['gates_passed'] === 1,
      meta: JSON.parse(row['meta'] as string) as Record<string, unknown>,
    };
  }

  recordServedFile(sessionId: string, filePath: string, hash: string, servedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO served_files (session_id, path, hash, served_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (session_id, path) DO UPDATE SET hash = excluded.hash, served_at = excluded.served_at`,
      )
      .run(sessionId, filePath, hash, servedAt);
  }

  getServedFile(sessionId: string, filePath: string): ServedFileRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM served_files WHERE session_id = ? AND path = ?')
      .get(sessionId, filePath) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    return {
      sessionId: row['session_id'] as string,
      path: row['path'] as string,
      hash: row['hash'] as string,
      servedAt: row['served_at'] as string,
    };
  }

  upsertSessionState(sessionId: string, stateMd: string, updatedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO session_state (session_id, state_md, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (session_id) DO UPDATE SET state_md = excluded.state_md, updated_at = excluded.updated_at`,
      )
      .run(sessionId, stateMd, updatedAt);
  }

  getSessionState(sessionId: string): SessionStateRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM session_state WHERE session_id = ?')
      .get(sessionId) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    return {
      sessionId: row['session_id'] as string,
      stateMd: row['state_md'] as string,
      updatedAt: row['updated_at'] as string,
    };
  }

  insertAuditEvent(event: AuditEvent): void {
    const parsed = AuditEventSchema.parse(event);
    this.db
      .prepare(
        `INSERT INTO audit (id, session_id, timestamp, module, action, reason, details)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.id,
        parsed.sessionId ?? null,
        parsed.timestamp,
        parsed.module,
        parsed.action,
        parsed.reason,
        JSON.stringify(parsed.details ?? {}),
      );
  }

  listAuditEvents(sessionId: string): AuditEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM audit WHERE session_id = ? ORDER BY seq')
      .all(sessionId) as Record<string, unknown>[];
    return rows.map((row) =>
      AuditEventSchema.parse({
        id: row['id'],
        sessionId: row['session_id'] ?? undefined,
        timestamp: row['timestamp'],
        module: row['module'],
        action: row['action'],
        reason: row['reason'],
        details: JSON.parse(row['details'] as string),
      }),
    );
  }

  close(): void {
    this.db.close();
  }
}

export function openStore(dbPath: string): Store {
  return new Store(dbPath);
}
