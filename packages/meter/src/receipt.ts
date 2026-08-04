import { readFileSync } from 'node:fs';
import { loadEnergyFactors, loadGridIntensity, loadPrices, readAuditFile } from '@redutok/shared';
import { computeSessionCost } from './cost.js';
import { computeSessionEnergy } from './energy.js';
import { grandTotal, type SessionLedger } from './ledger.js';
import {
  computeSessionSavings,
  passthroughLines,
  type Distillation,
  type Passthrough,
  type SessionSavings,
} from './savings.js';
import { renderCompositeValue, scoreSession } from './scoring.js';

/**
 * Session receipt: billed tokens and cost from the ledger, avoided tokens and
 * top distillations from the session-attributed audit trail. Assembled
 * entirely from local files; this path involves no model call and no network,
 * so producing a receipt is always free.
 */

export type ReceiptDistillation = Distillation;

/** An artifact that entered context whole, with the reason it did. */
export type ReceiptPassthrough = Passthrough;

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
  /** The full savings computation, shared with the report (savings.ts). */
  savings: SessionSavings;
  /**
   * A floor on what distilling those artifacts would have saved, in tokens.
   * Derived from the size gate every profile must clear (a distillate over
   * SIZE_SANITY_MAX_RATIO of its raw is refused), so it is arithmetic on a
   * published bound rather than a projection: an estimate, and labelled one.
   */
  estimatedAvoidableTokens: number;
}

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

  // One computation, shared with the report: the two surfaces cannot
  // disagree about what a session saved because there is only one answer.
  const savings = computeSessionSavings({
    ledger,
    audit,
    contextEfficiency: scores.contextEfficiency,
    prices: loadPrices(options.pricesPath),
    factors: loadEnergyFactors(),
    grid: loadGridIntensity(),
    region: options.region,
  });

  return {
    sessionId: ledger.sessionId,
    turns: ledger.entries.length,
    billedTokens: grandTotal(ledger.totals),
    costUsd: cost.pricedTurns > 0 ? cost.totalUsd : undefined,
    grade: scores.composite === undefined ? undefined : renderCompositeValue(scores.composite),
    auditEvents: audit.length,
    avoidedTokens: savings.avoidedTokens,
    topDistillations: savings.topDistillations,
    posture: postureLineFor(options.posturePath, ledger.sessionId),
    governed: savings.governed,
    notScorableReason: savings.notScorableReason,
    passthroughs: savings.passthroughs,
    estimatedAvoidableTokens: savings.estimatedAvoidableTokens,
    savings,
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
    lines.push(...passthroughLines(receipt.savings));
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
  lines.push(...passthroughLines(receipt.savings));
  lines.push(`  grade    ${receipt.grade ?? 'not scorable'}`);
  return lines.join('\n');
}
