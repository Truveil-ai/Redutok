import { randomUUID } from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { EnergyBand } from '@redutok/shared';
import { loadReferenceRates, priceAvoidedTokens } from './rates.js';

/**
 * The persistent vault ledger: one SQLite file per corpus, alongside the
 * store under .dcp/. Every ask, zoom, and internal serve appends a line with
 * its byte and token accounting, the rate row it was priced against, energy
 * bands per docs/METHODOLOGY.md, and the artifact and audit references
 * backing it, so the ledger reconciles with the audit trail by construction
 * and survives server restarts.
 */

export type LedgerKind = 'ask' | 'zoom' | 'serve';

export interface LedgerLine {
  id: string;
  kind: LedgerKind;
  corpus: string;
  sessionId: string;
  askId?: string;
  timestamp: string;
  rawBytes: number;
  servedBytes: number;
  rawTokens: number;
  servedTokens: number;
  avoidedTokens: number;
  costAvoidedUsd: number;
  referenceModel: string;
  inputPerMTokUsd: number;
  priceSource: string;
  wh: EnergyBand;
  gCo2e: EnergyBand;
  region: string;
  /** Corpus-relative path of the document or file this line served. */
  document?: string;
  /** Display label (the distill profile for serve lines). */
  label?: string;
  artifactRefs: string[];
  auditIds: string[];
}

export interface LedgerLineInput {
  id?: string;
  kind: LedgerKind;
  corpus: string;
  sessionId: string;
  askId?: string;
  timestamp: string;
  rawBytes: number;
  servedBytes: number;
  document?: string;
  label?: string;
  artifactRefs?: string[];
  auditIds?: string[];
}

export interface LedgerFilter {
  sessionId?: string;
  /** YYYY-MM-DD, matched against the line timestamp (UTC). */
  day?: string;
  /** YYYY-MM, matched against the line timestamp (UTC). */
  month?: string;
}

const bytesToTokens = (bytes: number): number => Math.round(bytes / 4);

/**
 * Completes a ledger line from its byte accounting: token estimates, cost at
 * the current rate row (pinned into the line so the citation survives future
 * price changes), and energy bands. Avoided tokens compare served size
 * against the raw size of what this line actually touched, never against any
 * whole-corpus figure.
 */
export function makeLedgerLine(input: LedgerLineInput): LedgerLine {
  const rates = loadReferenceRates();
  const rawTokens = bytesToTokens(input.rawBytes);
  const servedTokens = bytesToTokens(input.servedBytes);
  const avoidedTokens = Math.max(0, rawTokens - servedTokens);
  const priced = priceAvoidedTokens(avoidedTokens, rates);
  const line: LedgerLine = {
    id: input.id ?? `ledger-${randomUUID()}`,
    kind: input.kind,
    corpus: input.corpus,
    sessionId: input.sessionId,
    timestamp: input.timestamp,
    rawBytes: input.rawBytes,
    servedBytes: input.servedBytes,
    rawTokens,
    servedTokens,
    avoidedTokens,
    costAvoidedUsd: priced.costAvoidedUsd,
    referenceModel: rates.referenceModel,
    inputPerMTokUsd: rates.inputPerMTokUsd,
    priceSource: rates.priceSource,
    wh: priced.wh,
    gCo2e: priced.gCo2e,
    region: rates.region,
    artifactRefs: input.artifactRefs ?? [],
    auditIds: input.auditIds ?? [],
  };
  if (input.askId !== undefined) line.askId = input.askId;
  if (input.document !== undefined) line.document = input.document;
  if (input.label !== undefined) line.label = input.label;
  return line;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ledger (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('ask', 'zoom', 'serve')),
  corpus TEXT NOT NULL,
  session_id TEXT NOT NULL,
  ask_id TEXT,
  timestamp TEXT NOT NULL,
  raw_bytes INTEGER NOT NULL,
  served_bytes INTEGER NOT NULL,
  raw_tokens INTEGER NOT NULL,
  served_tokens INTEGER NOT NULL,
  avoided_tokens INTEGER NOT NULL,
  cost_avoided_usd REAL NOT NULL,
  reference_model TEXT NOT NULL,
  input_per_mtok_usd REAL NOT NULL,
  price_source TEXT NOT NULL,
  wh_base REAL NOT NULL,
  wh_low REAL NOT NULL,
  wh_high REAL NOT NULL,
  g_co2e_base REAL NOT NULL,
  g_co2e_low REAL NOT NULL,
  g_co2e_high REAL NOT NULL,
  region TEXT NOT NULL,
  document TEXT,
  label TEXT,
  artifact_refs TEXT NOT NULL DEFAULT '[]',
  audit_ids TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_ledger_session ON ledger (session_id);
CREATE INDEX IF NOT EXISTS idx_ledger_timestamp ON ledger (timestamp);
`;

export class VaultLedger {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    // Single-file schema versioned via user_version, mirroring the store's
    // migration discipline at ledger scale (one table today).
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version < 1) {
      const apply = this.db.transaction(() => {
        this.db.exec(SCHEMA);
        this.db.pragma('user_version = 1');
      });
      apply();
    }
  }

  append(line: LedgerLine): void {
    this.db
      .prepare(
        `INSERT INTO ledger (id, kind, corpus, session_id, ask_id, timestamp,
           raw_bytes, served_bytes, raw_tokens, served_tokens, avoided_tokens,
           cost_avoided_usd, reference_model, input_per_mtok_usd, price_source,
           wh_base, wh_low, wh_high, g_co2e_base, g_co2e_low, g_co2e_high,
           region, document, label, artifact_refs, audit_ids)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        line.id,
        line.kind,
        line.corpus,
        line.sessionId,
        line.askId ?? null,
        line.timestamp,
        line.rawBytes,
        line.servedBytes,
        line.rawTokens,
        line.servedTokens,
        line.avoidedTokens,
        line.costAvoidedUsd,
        line.referenceModel,
        line.inputPerMTokUsd,
        line.priceSource,
        line.wh.base,
        line.wh.low,
        line.wh.high,
        line.gCo2e.base,
        line.gCo2e.low,
        line.gCo2e.high,
        line.region,
        line.document ?? null,
        line.label ?? null,
        JSON.stringify(line.artifactRefs),
        JSON.stringify(line.auditIds),
      );
  }

  lines(filter: LedgerFilter = {}): LedgerLine[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.sessionId !== undefined) {
      clauses.push('session_id = ?');
      params.push(filter.sessionId);
    }
    if (filter.day !== undefined) {
      clauses.push("substr(timestamp, 1, 10) = ?");
      params.push(filter.day);
    }
    if (filter.month !== undefined) {
      clauses.push("substr(timestamp, 1, 7) = ?");
      params.push(filter.month);
    }
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
    const rows = this.db
      .prepare(`SELECT * FROM ledger${where} ORDER BY seq`)
      .all(...params) as Record<string, unknown>[];
    return rows.map((row) => {
      const line: LedgerLine = {
        id: row['id'] as string,
        kind: row['kind'] as LedgerKind,
        corpus: row['corpus'] as string,
        sessionId: row['session_id'] as string,
        timestamp: row['timestamp'] as string,
        rawBytes: row['raw_bytes'] as number,
        servedBytes: row['served_bytes'] as number,
        rawTokens: row['raw_tokens'] as number,
        servedTokens: row['served_tokens'] as number,
        avoidedTokens: row['avoided_tokens'] as number,
        costAvoidedUsd: row['cost_avoided_usd'] as number,
        referenceModel: row['reference_model'] as string,
        inputPerMTokUsd: row['input_per_mtok_usd'] as number,
        priceSource: row['price_source'] as string,
        wh: {
          base: row['wh_base'] as number,
          low: row['wh_low'] as number,
          high: row['wh_high'] as number,
        },
        gCo2e: {
          base: row['g_co2e_base'] as number,
          low: row['g_co2e_low'] as number,
          high: row['g_co2e_high'] as number,
        },
        region: row['region'] as string,
        artifactRefs: JSON.parse(row['artifact_refs'] as string) as string[],
        auditIds: JSON.parse(row['audit_ids'] as string) as string[],
      };
      if (row['ask_id'] !== null) line.askId = row['ask_id'] as string;
      if (row['document'] !== null) line.document = row['document'] as string;
      if (row['label'] !== null) line.label = row['label'] as string;
      return line;
    });
  }

  close(): void {
    this.db.close();
  }
}

export function openLedger(dcpDir: string): VaultLedger {
  return new VaultLedger(path.join(dcpDir, 'ledger.db'));
}
