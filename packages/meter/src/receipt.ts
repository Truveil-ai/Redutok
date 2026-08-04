import { readFileSync } from 'node:fs';
import {
  LIMITS,
  loadEnergyFactors,
  loadGridIntensity,
  loadPrices,
  readAuditFile,
  type AuditEvent,
} from '@redutok/shared';
import { computeSessionCost } from './cost.js';
import { computeSessionEnergy } from './energy.js';
import { grandTotal, type SessionLedger } from './ledger.js';
import { renderCompositeValue, scoreSession } from './scoring.js';

/**
 * Session receipt: billed tokens and cost from the ledger, avoided tokens and
 * top distillations from the session-attributed audit trail. Assembled
 * entirely from local files; this path involves no model call and no network,
 * so producing a receipt is always free.
 */

export interface ReceiptDistillation {
  /** Distill profile name when recorded, else the emitting module. */
  label: string;
  /** Artifact reference for zooming, else the audit event id. */
  ref: string;
  rawTokens: number;
  servedTokens: number;
  avoidedTokens: number;
}

/** An artifact that entered context whole, with the reason it did. */
export interface ReceiptPassthrough {
  path: string;
  rawTokens: number;
  reason: string;
}

export interface SessionReceipt {
  sessionId: string;
  turns: number;
  billedTokens: number;
  /** Undefined when no turn had a price row. */
  costUsd?: number;
  /** Composite like "97 (A)"; undefined when no score was computable. */
  grade?: string;
  /** Audit events attributed to this session. */
  auditEvents: number;
  avoidedTokens: number;
  /** Top three distill events by tokens avoided. */
  topDistillations: ReceiptDistillation[];
  /** Session posture with its basis (docs/POSTURE.md), e.g. "full (156
   * files, 2,900 KB source, 19 learned)". Undefined when no record matches. */
  posture?: string;
  /** False when the session produced no serve at all: the receipt has to
   * lead with that rather than rendering a figure that implies it worked. */
  governed: boolean;
  /** Why context efficiency could not be scored, when it could not. */
  notScorableReason?: string;
  /** Large artifacts that entered context whole, each with its reason. */
  passthroughs: ReceiptPassthrough[];
  /**
   * A floor on what distilling those artifacts would have saved, in tokens.
   * Derived from the size gate every profile must clear (a distillate over
   * SIZE_SANITY_MAX_RATIO of its raw is refused), so it is arithmetic on a
   * published bound rather than a projection: an estimate, and labelled one.
   */
  estimatedAvoidableTokens: number;
}

/** Same 4-chars-per-token heuristic the sidecar uses for handle estimates. */
const bytesToTokens = (bytes: number): number => Math.round(bytes / 4);

const avoidedFor = (e: { bytesIn: number; bytesOut: number }): number =>
  Math.max(0, bytesToTokens(e.bytesIn) - bytesToTokens(e.bytesOut));

export interface SessionReceiptOptions {
  /** Sidecar audit trail, normally <dcpDir>/audit.jsonl. */
  auditPath: string;
  pricesPath?: string;
  region?: string;
  /** SessionStart's posture record, normally <dcpDir>/session-posture.json. */
  posturePath?: string;
}

/** Formats the posture record for the receipt when it belongs to this
 * session; local file only, like everything else the receipt reads. */
function postureLineFor(posturePath: string | undefined, sessionId: string): string | undefined {
  if (posturePath === undefined) return undefined;
  try {
    const record = JSON.parse(readFileSync(posturePath, 'utf8')) as {
      sessionId?: string;
      posture?: string;
      pinned?: boolean;
      files?: number;
      sourceBytes?: number;
      learnedEntries?: number;
    };
    if (typeof record.posture !== 'string' || record.sessionId !== sessionId) return undefined;
    if (record.pinned === true) return `${record.posture} (pinned)`;
    const kb = Math.round((record.sourceBytes ?? 0) / 1024);
    return `${record.posture} (${fmt(record.files ?? 0)} files, ${fmt(kb)} KB source, ${fmt(record.learnedEntries ?? 0)} learned)`;
  } catch {
    return undefined;
  }
}

export function buildSessionReceipt(
  ledger: SessionLedger,
  options: SessionReceiptOptions,
): SessionReceipt {
  const audit = readAuditFile(options.auditPath, ledger.sessionId).events;
  const cost = computeSessionCost(ledger, loadPrices(options.pricesPath));
  const energy = computeSessionEnergy(
    ledger,
    loadEnergyFactors(),
    loadGridIntensity(),
    options.region,
  );
  const scores = scoreSession(ledger, energy, audit);

  const measured = audit.filter(
    (e): e is AuditEvent & { bytesIn: number; bytesOut: number } =>
      e.bytesIn !== undefined && e.bytesOut !== undefined,
  );
  const topDistillations = measured
    .filter((e) => e.action === 'distill')
    .map((e) => ({
      label: typeof e.details?.['profile'] === 'string' ? (e.details['profile'] as string) : e.module,
      ref: e.inputRef ?? e.id,
      rawTokens: bytesToTokens(e.bytesIn),
      servedTokens: bytesToTokens(e.bytesOut),
      avoidedTokens: avoidedFor(e),
    }))
    .sort((a, b) => b.avoidedTokens - a.avoidedTokens)
    .slice(0, 3);

  const passthroughs = audit
    .filter((e) => e.action === 'passthrough')
    .map((e) => ({
      path: typeof e.details?.['path'] === 'string' ? (e.details['path'] as string) : '(unnamed)',
      rawTokens: bytesToTokens(e.bytesIn ?? 0),
      reason:
        typeof e.details?.['reason'] === 'string'
          ? (e.details['reason'] as string)
          : 'no skeleton available',
    }))
    .sort((a, b) => b.rawTokens - a.rawTokens);

  const served = measured.filter((e) => e.action === 'distill' || e.action === 'serve-raw');
  const contextEfficiency = scores.contextEfficiency;

  return {
    sessionId: ledger.sessionId,
    turns: ledger.entries.length,
    billedTokens: grandTotal(ledger.totals),
    costUsd: cost.pricedTurns > 0 ? cost.totalUsd : undefined,
    grade: scores.composite === undefined ? undefined : renderCompositeValue(scores.composite),
    auditEvents: audit.length,
    avoidedTokens: measured.reduce((n, e) => n + avoidedFor(e), 0),
    topDistillations,
    posture: postureLineFor(options.posturePath, ledger.sessionId),
    governed: served.length > 0,
    notScorableReason: contextEfficiency.scorable ? undefined : contextEfficiency.reason,
    passthroughs,
    estimatedAvoidableTokens: Math.round(
      passthroughs.reduce((n, p) => n + p.rawTokens, 0) * (1 - LIMITS.SIZE_SANITY_MAX_RATIO),
    ),
  };
}

const fmt = (n: number): string => n.toLocaleString('en-US');

export function renderReceiptBlock(receipt: SessionReceipt): string {
  const cost =
    receipt.costUsd === undefined
      ? 'cost not estimable (no price row)'
      : `est ${receipt.costUsd.toFixed(4)} USD`;
  const lines: string[] = [`Redutok receipt for session ${receipt.sessionId}`];
  // A session that governed nothing leads with that, ahead of every figure a
  // reader could mistake for a result. The field receipt said "no
  // distillations this session" beside a grade and left the reader to work
  // out whether the tool had run at all.
  if (!receipt.governed) {
    lines.push('  nothing was governed this session: no artifact was distilled or served');
    lines.push(`  billed   ${fmt(receipt.billedTokens)} tokens across ${receipt.turns} turns, ${cost}`);
    if (receipt.posture !== undefined) {
      lines.push(`  posture  ${receipt.posture}, which sets the default engagement`);
    }
    if (receipt.notScorableReason !== undefined) {
      lines.push(`  context efficiency is not scorable: ${receipt.notScorableReason}`);
    }
    lines.push(...passthroughLines(receipt));
    return lines.join('\n');
  }
  lines.push(`  billed   ${fmt(receipt.billedTokens)} tokens across ${receipt.turns} turns, ${cost}`);
  if (receipt.posture !== undefined) lines.push(`  posture  ${receipt.posture}`);
  if (receipt.topDistillations.length === 0) {
    lines.push('  no distillations this session');
  } else {
    lines.push(
      `  avoided  ${fmt(receipt.avoidedTokens)} tokens across ${receipt.auditEvents} audit events`,
    );
    lines.push('  top distillations by tokens avoided');
    receipt.topDistillations.forEach((d, i) => {
      lines.push(
        `    ${i + 1}. ${d.label} (${d.ref}): ${fmt(d.rawTokens)} raw to ${fmt(d.servedTokens)} served, ${fmt(d.avoidedTokens)} avoided`,
      );
    });
  }
  lines.push(...passthroughLines(receipt));
  lines.push(`  grade    ${receipt.grade ?? 'not scorable'}`);
  return lines.join('\n');
}

/**
 * The artifacts that entered context whole, each with the reason no skeleton
 * covered it, and what distilling them would have saved. The saving is a
 * floor derived from the size gate every profile must clear, so it is stated
 * as an estimate and never as a measurement.
 */
function passthroughLines(receipt: SessionReceipt): string[] {
  if (receipt.passthroughs.length === 0) return [];
  const lines = [`  read raw  ${receipt.passthroughs.length} large artifacts entered context whole`];
  for (const p of receipt.passthroughs) {
    lines.push(`    ${p.path}: ${fmt(p.rawTokens)} tokens, ${p.reason}`);
  }
  lines.push(
    `  had those been distilled, an estimated ${fmt(receipt.estimatedAvoidableTokens)} tokens would have been avoided ` +
      `(a floor: the size gate refuses any distillate over ${Math.round(LIMITS.SIZE_SANITY_MAX_RATIO * 100)} percent of its raw)`,
  );
  return lines;
}
