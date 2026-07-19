import {
  loadEnergyFactors,
  loadGridIntensity,
  loadPrices,
  readAuditFile,
  type AuditEvent,
} from '@redutok/shared';
import { computeSessionCost } from './cost.js';
import { computeSessionEnergy } from './energy.js';
import { grandTotal, type SessionLedger } from './ledger.js';
import { scoreSession } from './scoring.js';

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

  return {
    sessionId: ledger.sessionId,
    turns: ledger.entries.length,
    billedTokens: grandTotal(ledger.totals),
    costUsd: cost.pricedTurns > 0 ? cost.totalUsd : undefined,
    grade:
      scores.composite === undefined
        ? undefined
        : `${scores.composite.value} (${scores.composite.grade})`,
    auditEvents: audit.length,
    avoidedTokens: measured.reduce((n, e) => n + avoidedFor(e), 0),
    topDistillations,
  };
}

const fmt = (n: number): string => n.toLocaleString('en-US');

export function renderReceiptBlock(receipt: SessionReceipt): string {
  const cost =
    receipt.costUsd === undefined
      ? 'cost not estimable (no price row)'
      : `est ${receipt.costUsd.toFixed(4)} USD`;
  const lines: string[] = [
    `Redutok receipt for session ${receipt.sessionId}`,
    `  billed   ${fmt(receipt.billedTokens)} tokens across ${receipt.turns} turns, ${cost}`,
  ];
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
  lines.push(`  grade    ${receipt.grade ?? 'not scorable'}`);
  return lines.join('\n');
}
