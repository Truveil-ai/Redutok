import type { EnergyBand } from '@redutok/shared';
import type { LedgerLine } from './ledger.js';
import { loadReferenceRates } from './rates.js';

/**
 * Pure rollups over ledger lines. Totals sum serve and zoom lines only: an
 * ask line records the same bytes its serve lines already carry, so counting
 * both would double every figure. The corpus-resident figure rides along
 * strictly separately; it never feeds any avoided total.
 */

export type RollupScope = 'session' | 'day' | 'month' | 'corpus' | 'document';

export interface RollupQuery {
  scope: RollupScope;
  sessionId?: string;
  /** YYYY-MM-DD (UTC); defaults to today for day scope. */
  day?: string;
  /** YYYY-MM (UTC); defaults to the current month for month scope. */
  month?: string;
}

export interface DocumentRollup {
  document: string;
  reads: number;
  rawTokens: number;
  avoidedTokens: number;
  costAvoidedUsd: number;
}

export interface SessionRollup {
  sessionId: string;
  asks: number;
  avoidedTokens: number;
  costAvoidedUsd: number;
}

export interface TopDistillation {
  label: string;
  ref: string;
  rawTokens: number;
  servedTokens: number;
  avoidedTokens: number;
}

export interface VaultRollup {
  scope: RollupScope;
  corpus: string;
  sessionId?: string;
  day?: string;
  month?: string;
  lines: number;
  asks: number;
  zooms: number;
  serves: number;
  sessions: number;
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
  topDistillations: TopDistillation[];
  documents: DocumentRollup[];
  topSessions: SessionRollup[];
  /** Raw size of everything resident in the corpus store, as tokens. A
   * deliberately distinct figure: it may be rendered only under its own
   * "corpus resident size avoided" label, never as avoided tokens. */
  corpusResidentTokens: number;
}

const sumBand = (lines: LedgerLine[], pick: (l: LedgerLine) => EnergyBand): EnergyBand => ({
  base: lines.reduce((n, l) => n + pick(l).base, 0),
  low: lines.reduce((n, l) => n + pick(l).low, 0),
  high: lines.reduce((n, l) => n + pick(l).high, 0),
});

function inScope(line: LedgerLine, query: RollupQuery): boolean {
  if (query.scope === 'session') return line.sessionId === query.sessionId;
  if (query.scope === 'day') return line.timestamp.slice(0, 10) === query.day;
  if (query.scope === 'month') return line.timestamp.slice(0, 7) === query.month;
  return true;
}

export function rollupLines(
  all: LedgerLine[],
  query: RollupQuery,
  context: { corpus: string; corpusResidentTokens: number },
): VaultRollup {
  const q: RollupQuery = { ...query };
  if (q.scope === 'day' && q.day === undefined) q.day = new Date().toISOString().slice(0, 10);
  if (q.scope === 'month' && q.month === undefined) q.month = new Date().toISOString().slice(0, 7);
  const lines = all.filter((l) => inScope(l, q));
  // The honesty rule lives here: avoided totals come from the touched lines
  // (serve and zoom), and from nothing else.
  const counted = lines.filter((l) => l.kind !== 'ask');

  const documents = new Map<string, DocumentRollup>();
  for (const l of counted) {
    if (l.document === undefined) continue;
    const doc = documents.get(l.document) ?? {
      document: l.document,
      reads: 0,
      rawTokens: 0,
      avoidedTokens: 0,
      costAvoidedUsd: 0,
    };
    doc.reads += 1;
    doc.rawTokens += l.rawTokens;
    doc.avoidedTokens += l.avoidedTokens;
    doc.costAvoidedUsd += l.costAvoidedUsd;
    documents.set(l.document, doc);
  }

  const sessions = new Map<string, SessionRollup>();
  for (const l of lines) {
    const s = sessions.get(l.sessionId) ?? {
      sessionId: l.sessionId,
      asks: 0,
      avoidedTokens: 0,
      costAvoidedUsd: 0,
    };
    if (l.kind === 'ask') s.asks += 1;
    else {
      s.avoidedTokens += l.avoidedTokens;
      s.costAvoidedUsd += l.costAvoidedUsd;
    }
    sessions.set(l.sessionId, s);
  }

  const rates = loadReferenceRates();
  const rollup: VaultRollup = {
    scope: q.scope,
    corpus: context.corpus,
    lines: lines.length,
    asks: lines.filter((l) => l.kind === 'ask').length,
    zooms: lines.filter((l) => l.kind === 'zoom').length,
    serves: lines.filter((l) => l.kind === 'serve').length,
    sessions: sessions.size,
    rawTokens: counted.reduce((n, l) => n + l.rawTokens, 0),
    servedTokens: counted.reduce((n, l) => n + l.servedTokens, 0),
    avoidedTokens: counted.reduce((n, l) => n + l.avoidedTokens, 0),
    costAvoidedUsd: counted.reduce((n, l) => n + l.costAvoidedUsd, 0),
    referenceModel: counted[0]?.referenceModel ?? rates.referenceModel,
    inputPerMTokUsd: counted[0]?.inputPerMTokUsd ?? rates.inputPerMTokUsd,
    priceSource: counted[0]?.priceSource ?? rates.priceSource,
    wh: sumBand(counted, (l) => l.wh),
    gCo2e: sumBand(counted, (l) => l.gCo2e),
    region: counted[0]?.region ?? rates.region,
    topDistillations: counted
      .filter((l) => l.kind === 'serve')
      .map((l) => ({
        label: l.label ?? 'serve',
        ref: l.artifactRefs[0] ?? l.id,
        rawTokens: l.rawTokens,
        servedTokens: l.servedTokens,
        avoidedTokens: l.avoidedTokens,
      }))
      .sort((a, b) => b.avoidedTokens - a.avoidedTokens)
      .slice(0, 3),
    documents: [...documents.values()].sort(
      (a, b) => b.reads - a.reads || b.avoidedTokens - a.avoidedTokens,
    ),
    topSessions: [...sessions.values()].sort((a, b) => b.avoidedTokens - a.avoidedTokens),
    corpusResidentTokens: context.corpusResidentTokens,
  };
  if (q.sessionId !== undefined) rollup.sessionId = q.sessionId;
  if (q.day !== undefined) rollup.day = q.day;
  if (q.month !== undefined) rollup.month = q.month;
  return rollup;
}
