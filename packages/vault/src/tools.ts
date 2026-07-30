import { randomUUID } from 'node:crypto';
import {
  loadEnergyFactors,
  loadGridIntensity,
  loadPrices,
  readAuditFile,
  type AuditEvent,
  type EnergyBand,
} from '@redutok/shared';
import { exploreGoal, redact, zoom, type Dossier } from '@redutok/sidecar';
import type { Corpus } from './corpus.js';

/**
 * The three vault tools, built directly on the sidecar engines. Everything
 * served is redacted; every call writes an audit event under the vault
 * session id; failures throw VaultError and surface as explicit tool errors.
 */

export class VaultError extends Error {}

export interface VaultSession {
  id: string;
  asks: number;
}

/** The vault session id is derived from the MCP session id. */
export function newVaultSession(mcpSessionId: string): VaultSession {
  return { id: `vault-${mcpSessionId}`, asks: 0 };
}

const fmt = (n: number): string => n.toLocaleString('en-US');
const bytesToTokens = (bytes: number): number => Math.round(bytes / 4);
const avoidedFor = (e: { bytesIn: number; bytesOut: number }): number =>
  Math.max(0, bytesToTokens(e.bytesIn) - bytesToTokens(e.bytesOut));

function pickCorpus(corpora: Map<string, Corpus>, arg: unknown): Corpus {
  if (arg === undefined || arg === null || arg === '') {
    const first = corpora.values().next();
    if (first.done === true) throw new VaultError('no corpus mounted');
    return first.value;
  }
  const corpus = corpora.get(String(arg));
  if (corpus === undefined) {
    throw new VaultError(
      `unknown corpus "${String(arg)}" (mounted: ${[...corpora.keys()].join(', ')})`,
    );
  }
  return corpus;
}

function writeVaultEvent(corpus: Corpus, event: AuditEvent): void {
  corpus.audit.write(event);
  corpus.store.insertAuditEvent(event);
}

interface AskAccounting {
  askId: string;
  internalEvents: number;
  rawBytes: number;
  rawTokens: number;
  servedBytes: number;
  servedTokens: number;
  reduction: number;
}

/**
 * The mandatory per-ask accounting: raw bytes touched come straight from the
 * audit events this ask wrote (so the block always reconciles with the
 * trail); served bytes are the dossier text actually handed to the client.
 */
function askAccounting(corpus: Corpus, askId: string, servedText: string): AskAccounting {
  const events = readAuditFile(corpus.auditPath).events.filter((e) => e.sessionId === askId);
  const rawBytes = events.reduce((n, e) => n + (e.bytesIn ?? 0), 0);
  const servedBytes = Buffer.byteLength(servedText, 'utf8');
  return {
    askId,
    internalEvents: events.length,
    rawBytes,
    rawTokens: bytesToTokens(rawBytes),
    servedBytes,
    servedTokens: bytesToTokens(servedBytes),
    reduction: servedBytes === 0 ? 0 : rawBytes / servedBytes,
  };
}

function renderAccountingBlock(a: AskAccounting): string {
  return [
    `[vault accounting: ask ${a.askId}]`,
    `  raw touched  ${fmt(a.rawBytes)} bytes (~${fmt(a.rawTokens)} tok) across ${a.internalEvents} audited internal steps`,
    `  served       ${fmt(a.servedBytes)} bytes (~${fmt(a.servedTokens)} tok) in this dossier`,
    `  reduction    ${a.reduction.toFixed(1)}x raw-versus-served`,
  ].join('\n');
}

function renderDossier(d: Dossier): string {
  const lines: string[] = [d.verdict === '' ? 'no verdict' : d.verdict];
  if (d.evidence.length > 0) {
    lines.push('', 'evidence:');
    for (const e of d.evidence) lines.push(`- ${e.file}:${e.line} — ${e.snippet} (${e.why})`);
  }
  if (d.zoomHandles.length > 0) {
    lines.push('', 'retained artifacts (recover any elision with vault_zoom(handle, query?)):');
    for (const h of d.zoomHandles) lines.push(`- vault_zoom("${h}", query?)`);
  }
  if (d.incomplete !== undefined) {
    lines.push('', `[incomplete: ${d.incomplete.reason}; ${d.incomplete.continuationHint}]`);
  }
  return lines.join('\n');
}

export async function vaultAsk(
  corpora: Map<string, Corpus>,
  session: VaultSession,
  args: Record<string, unknown>,
): Promise<string> {
  const question = typeof args['question'] === 'string' ? args['question'].trim() : '';
  if (question === '') throw new VaultError('question is required (a non-empty string)');
  const corpus = pickCorpus(corpora, args['corpus']);
  session.asks += 1;
  const askId = `${session.id}#ask${session.asks}`;
  const dossier = await exploreGoal(corpus.store, corpus.audit, corpus.profiles, corpus.llm, {
    goal: question,
    sessionId: askId,
    repoRoot: corpus.root,
    // One remote ask replaces a whole chat-side exploration loop, so it runs
    // at the deepest bounded budget rather than the interactive default.
    budget: 'thorough',
  });
  const body = renderDossier(dossier);
  const accounting = askAccounting(corpus, askId, body);
  // The vault event carries the byte totals in details only: the per-step
  // distill events already account these bytes, and a second bytesIn would
  // double-count them in every rollup.
  writeVaultEvent(corpus, {
    id: `vault-ask-${randomUUID()}`,
    timestamp: new Date().toISOString(),
    sessionId: session.id,
    module: 'vault.ask',
    action: 'summarize',
    reason: `ask "${question.slice(0, 80)}" on corpus ${corpus.name}: ${dossier.stepsTaken} step(s), ${accounting.reduction.toFixed(1)}x raw-versus-served`,
    details: {
      askId,
      corpus: corpus.name,
      rawBytes: accounting.rawBytes,
      servedBytes: accounting.servedBytes,
      evidence: dossier.evidence.length,
      incomplete: dossier.incomplete ?? null,
    },
  });
  return redact(`${body}\n\n${renderAccountingBlock(accounting)}`).text;
}

export function vaultZoom(
  corpora: Map<string, Corpus>,
  session: VaultSession,
  args: Record<string, unknown>,
): string {
  const ref = args['handle'] ?? args['id'];
  if (typeof ref !== 'string' || ref === '') {
    throw new VaultError('handle is required (id is an accepted alias)');
  }
  const corpus = pickCorpus(corpora, args['corpus']);
  const query = args['query'] === undefined ? undefined : String(args['query']);
  const result = zoom(corpus.store, corpus.audit, ref, query, corpus.codex);
  if (!result.found) throw new VaultError(result.text);
  writeVaultEvent(corpus, {
    id: `vault-zoom-${randomUUID()}`,
    timestamp: new Date().toISOString(),
    sessionId: session.id,
    module: 'vault.zoom',
    action: 'zoom',
    reason: `zoom ${ref}${query === undefined ? '' : ' with query'} on corpus ${corpus.name}`,
    inputRef: ref,
  });
  return redact(result.text).text;
}

/** All avoided-cost and energy numbers are stated against this row of
 * prices.yaml / energy_factors.yaml, named in the receipt itself. */
export const REFERENCE_MODEL = 'claude-sonnet-5';

export interface VaultReceipt {
  scope: 'session' | 'corpus';
  corpus: string;
  sessionId?: string;
  auditEvents: number;
  measuredEvents: number;
  rawTokens: number;
  servedTokens: number;
  avoidedTokens: number;
  topDistillations: {
    label: string;
    ref: string;
    rawTokens: number;
    servedTokens: number;
    avoidedTokens: number;
  }[];
  referenceModel: string;
  inputPerMTokUsd: number;
  costAvoidedUsd: number;
  wh: EnergyBand;
  gCo2e: EnergyBand;
  region: string;
}

/**
 * Rollup from the corpus audit trail: session scope filters to events whose
 * sessionId starts with the vault session id (per-ask ids are derived from
 * it); corpus scope takes the whole trail. Cost at current API rates from
 * prices.yaml; Wh and gCO2e bands per docs/METHODOLOGY.md, with the context
 * multiplier held at 1.0 because the counterfactual context shape of avoided
 * tokens is unknowable.
 */
export function buildVaultReceipt(corpus: Corpus, sessionId?: string): VaultReceipt {
  const all = readAuditFile(corpus.auditPath).events;
  const events =
    sessionId === undefined
      ? all
      : all.filter((e) => typeof e.sessionId === 'string' && e.sessionId.startsWith(sessionId));
  const measured = events.filter(
    (e): e is AuditEvent & { bytesIn: number; bytesOut: number } =>
      e.bytesIn !== undefined && e.bytesOut !== undefined,
  );
  const avoidedTokens = measured.reduce((n, e) => n + avoidedFor(e), 0);
  const topDistillations = measured
    .filter((e) => e.action === 'distill')
    .map((e) => ({
      label:
        typeof e.details?.['profile'] === 'string' ? (e.details['profile'] as string) : e.module,
      ref: e.inputRef ?? e.id,
      rawTokens: bytesToTokens(e.bytesIn),
      servedTokens: bytesToTokens(e.bytesOut),
      avoidedTokens: avoidedFor(e),
    }))
    .sort((a, b) => b.avoidedTokens - a.avoidedTokens)
    .slice(0, 3);

  const priceRow = loadPrices().models.find((m) => m.id === REFERENCE_MODEL);
  if (priceRow === undefined) {
    throw new VaultError(`reference model ${REFERENCE_MODEL} has no row in prices.yaml`);
  }
  const factorRow = loadEnergyFactors().classes.find((c) => c.models.includes(REFERENCE_MODEL));
  if (factorRow === undefined) {
    throw new VaultError(`reference model ${REFERENCE_MODEL} has no class in energy_factors.yaml`);
  }
  const grid = loadGridIntensity();
  const gridRow = grid.regions.find((r) => r.region === grid.defaultRegion);
  if (gridRow === undefined) {
    throw new VaultError(`grid_intensity.yaml has no row for its own default region`);
  }
  const mtok = avoidedTokens / 1e6;
  const wh: EnergyBand = {
    base: mtok * factorRow.whPerMTok.base,
    low: mtok * factorRow.whPerMTok.low,
    high: mtok * factorRow.whPerMTok.high,
  };
  const toGrams = (x: number): number => (x / 1000) * gridRow.gCo2ePerKwh;
  const receipt: VaultReceipt = {
    scope: sessionId === undefined ? 'corpus' : 'session',
    corpus: corpus.name,
    auditEvents: events.length,
    measuredEvents: measured.length,
    rawTokens: measured.reduce((n, e) => n + bytesToTokens(e.bytesIn), 0),
    servedTokens: measured.reduce((n, e) => n + bytesToTokens(e.bytesOut), 0),
    avoidedTokens,
    topDistillations,
    referenceModel: REFERENCE_MODEL,
    inputPerMTokUsd: priceRow.inputPerMTokUsd,
    costAvoidedUsd: mtok * priceRow.inputPerMTokUsd,
    wh,
    gCo2e: { base: toGrams(wh.base), low: toGrams(wh.low), high: toGrams(wh.high) },
    region: grid.defaultRegion,
  };
  if (sessionId !== undefined) receipt.sessionId = sessionId;
  return receipt;
}

export function renderVaultReceipt(r: VaultReceipt): string {
  const lines: string[] = [`Redutok vault receipt (scope: ${r.scope}, corpus: ${r.corpus})`];
  if (r.sessionId !== undefined) lines.push(`  session      ${r.sessionId}`);
  lines.push(
    `  audit events ${fmt(r.auditEvents)} (${fmt(r.measuredEvents)} with byte accounting)`,
    `  raw touched  ${fmt(r.rawTokens)} tok; served ${fmt(r.servedTokens)} tok; avoided ${fmt(r.avoidedTokens)} tok`,
  );
  if (r.topDistillations.length > 0) {
    lines.push('  top distillations by tokens avoided');
    r.topDistillations.forEach((d, i) => {
      lines.push(
        `    ${i + 1}. ${d.label} (${d.ref}): ${fmt(d.rawTokens)} raw to ${fmt(d.servedTokens)} served, ${fmt(d.avoidedTokens)} avoided`,
      );
    });
  }
  lines.push(
    `  cost avoided est $${r.costAvoidedUsd.toFixed(4)} USD at ${r.referenceModel} input rate ($${r.inputPerMTokUsd.toFixed(2)}/MTok)`,
    `  energy avoided est ${r.wh.base.toFixed(3)} Wh (band ${r.wh.low.toFixed(3)}-${r.wh.high.toFixed(3)}), ${r.gCo2e.base.toFixed(3)} gCO2e (band ${r.gCo2e.low.toFixed(3)}-${r.gCo2e.high.toFixed(3)}), region ${r.region}, context multiplier 1.0`,
    '  estimates per docs/METHODOLOGY.md: bands are the claim, base is a midpoint convenience',
  );
  return lines.join('\n');
}

export function vaultReceipt(
  corpora: Map<string, Corpus>,
  session: VaultSession,
  args: Record<string, unknown>,
): string {
  const scopeArg = args['scope'];
  if (scopeArg !== undefined && scopeArg !== 'session' && scopeArg !== 'corpus') {
    throw new VaultError(`unknown scope "${String(scopeArg)}" (session | corpus)`);
  }
  const scope = scopeArg === 'corpus' ? 'corpus' : 'session';
  const corpus = pickCorpus(corpora, args['corpus']);
  const receipt = buildVaultReceipt(corpus, scope === 'session' ? session.id : undefined);
  writeVaultEvent(corpus, {
    id: `vault-receipt-${randomUUID()}`,
    timestamp: new Date().toISOString(),
    sessionId: session.id,
    module: 'vault.receipt',
    action: 'summarize',
    reason: `receipt (${scope}) on corpus ${corpus.name}: ${receipt.avoidedTokens} tokens avoided across ${receipt.auditEvents} audit events`,
    details: { scope, corpus: corpus.name, avoidedTokens: receipt.avoidedTokens },
  });
  return redact(renderVaultReceipt(receipt)).text;
}
