import { randomUUID } from 'node:crypto';
import { readAuditFile, type AuditEvent } from '@redutok/shared';
import { exploreGoal, redact, zoom, type Dossier } from '@redutok/sidecar';
import { emitCodex, readCodexState, type EmitOptions } from './codex.js';
import {
  assessAskConfidence,
  renderConfidenceLine,
  renderLowConfidenceNotice,
  type AskConfidence,
} from './confidence.js';
import type { Corpus } from './corpus.js';
import { makeLedgerLine } from './ledger.js';
import { TOUCHED_SECTIONS_KEY, type TouchedSection } from './miner.js';
import { rollupLines, type RollupQuery, type RollupScope, type VaultRollup } from './rollup.js';

export { REFERENCE_MODEL } from './rates.js';
export type { VaultRollup } from './rollup.js';

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

/**
 * Resume the ask counter from the ledger: an explicit X-Vault-Session
 * identity survives server restarts, so a fresh process must continue its
 * numbering, or a reused ask id would pull the earlier ask's audit events
 * into its accounting and double-append their serve lines. Two concurrently
 * live sessions sharing one identity can still collide; restarts cannot.
 */
export function resumeAskCounter(corpora: Map<string, Corpus>, session: VaultSession): void {
  for (const corpus of corpora.values()) {
    for (const line of corpus.ledger.lines({ sessionId: session.id })) {
      if (line.kind !== 'ask' || line.askId === undefined) continue;
      const n = Number(/#ask(\d+)$/.exec(line.askId)?.[1] ?? '0');
      if (n > session.asks) session.asks = n;
    }
  }
}

const fmt = (n: number): string => n.toLocaleString('en-US');
const bytesToTokens = (bytes: number): number => Math.round(bytes / 4);

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
function askAccounting(events: AuditEvent[], askId: string, servedText: string): AskAccounting {
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

function renderAccountingBlock(a: AskAccounting, confidence: AskConfidence): string {
  return [
    `[vault accounting: ask ${a.askId}]`,
    `  raw touched  ${fmt(a.rawBytes)} bytes (~${fmt(a.rawTokens)} tok) across ${a.internalEvents} audited internal steps`,
    `  served       ${fmt(a.servedBytes)} bytes (~${fmt(a.servedTokens)} tok) in this dossier`,
    `  reduction    ${a.reduction.toFixed(1)}x raw-versus-served (compression only, never answer quality)`,
    renderConfidenceLine(confidence),
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
  // Session 4: an explicit codex_version tells us which pasted block the
  // caller is riding. If it is older than the current emission's version, a
  // one-line refresh notice is appended to the response body — never more
  // than one line, never blocking the answer.
  const clientCodexVersion = readClientCodexVersion(args['codex_version']);
  session.asks += 1;
  const askId = `${session.id}#ask${session.asks}`;
  const dossier = await exploreGoal(corpus.store, corpus.audit, corpus.profiles, corpus.llm, {
    goal: question,
    sessionId: askId,
    repoRoot: corpus.root,
    // One remote ask replaces a whole chat-side exploration loop, so it runs
    // at the deepest bounded budget rather than the interactive default.
    budget: 'thorough',
    // Ingested documents are searched by section and cited with document,
    // section, and page context alongside any code evidence.
    documents: corpus.documents,
  });
  // Accounting honesty: the confidence assessment is deterministic on the
  // dossier, and a low band puts a plain-language warning ABOVE the answer —
  // the reduction figure alone must never be readable as answer quality.
  const confidence = assessAskConfidence(question, dossier);
  const dossierBody = renderDossier(dossier);
  const body =
    confidence.band === 'low'
      ? `${renderLowConfidenceNotice(confidence)}\n\n${dossierBody}`
      : dossierBody;
  const askEvents = readAuditFile(corpus.auditPath).events.filter((e) => e.sessionId === askId);
  const accounting = askAccounting(askEvents, askId, body);
  const touchedSections = touchedSectionsFromDossier(dossier);
  // The vault event carries the byte totals in details only: the per-step
  // distill events already account these bytes, and a second bytesIn would
  // double-count them in every rollup.
  const askEventId = `vault-ask-${randomUUID()}`;
  writeVaultEvent(corpus, {
    id: askEventId,
    timestamp: new Date().toISOString(),
    sessionId: session.id,
    module: 'vault.ask',
    action: 'summarize',
    reason: `ask "${question.slice(0, 80)}" on corpus ${corpus.name}: ${dossier.stepsTaken} step(s), ${accounting.reduction.toFixed(1)}x raw-versus-served`,
    details: {
      askId,
      corpus: corpus.name,
      question,
      rawBytes: accounting.rawBytes,
      servedBytes: accounting.servedBytes,
      evidence: dossier.evidence.length,
      confidence: {
        band: confidence.band,
        headingMatch: confidence.headingMatch,
        sectionRefs: confidence.sectionRefs,
        resolvedRefs: confidence.resolvedRefs,
        termsMatched: confidence.termsMatched,
        termsTotal: confidence.termsTotal,
        incomplete: confidence.incomplete,
      },
      // The touched-sections signature is what the vault miner keys on to
      // detect recurring neighborhoods (Session 4 conversational graduation).
      [TOUCHED_SECTIONS_KEY]: touchedSections,
      incomplete: dossier.incomplete ?? null,
    },
  });
  const now = new Date().toISOString();
  // One ledger 'serve' line per measured internal step; rollup totals sum
  // those, so the 'ask' line on top records the accounting block without
  // double-counting the same bytes.
  for (const e of askEvents) {
    if (e.bytesIn === undefined || e.bytesOut === undefined) continue;
    const doc = documentFor(corpus, e.inputRef);
    corpus.ledger.append(
      makeLedgerLine({
        kind: 'serve',
        corpus: corpus.name,
        sessionId: session.id,
        askId,
        timestamp: now,
        rawBytes: e.bytesIn,
        servedBytes: e.bytesOut,
        label:
          typeof e.details?.['profile'] === 'string' ? (e.details['profile'] as string) : e.module,
        artifactRefs: e.inputRef === undefined ? [] : [e.inputRef],
        auditIds: [e.id],
        confidence: confidence.band,
        ...(doc === undefined ? {} : { document: doc }),
      }),
    );
  }
  corpus.ledger.append(
    makeLedgerLine({
      kind: 'ask',
      corpus: corpus.name,
      sessionId: session.id,
      askId,
      timestamp: now,
      rawBytes: accounting.rawBytes,
      servedBytes: accounting.servedBytes,
      artifactRefs: dossier.zoomHandles,
      auditIds: [askEventId],
      confidence: confidence.band,
    }),
  );
  const stale = staleCodexNotice(corpus, clientCodexVersion);
  const full = stale === undefined
    ? `${body}\n\n${renderAccountingBlock(accounting, confidence)}`
    : `${body}\n\n${renderAccountingBlock(accounting, confidence)}\n${stale}`;
  return redact(full).text;
}

/** Coerces the codex_version arg to a number; empty/absent means "no claim". */
function readClientCodexVersion(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** The one-line refresh notice, or undefined when the claim is current. */
function staleCodexNotice(corpus: Corpus, clientVersion: number | undefined): string | undefined {
  if (clientVersion === undefined) return undefined;
  const state = readCodexState(corpus.dcpDir);
  if (state === undefined || state.version <= clientVersion) return undefined;
  return `[vault codex refresh: pasted block is v${clientVersion}; current v${state.version} — re-emit with \`redutok-vault codex --corpus ${corpus.name}\` and repaste.]`;
}

/**
 * Pull touched (document, section) tuples from the dossier evidence. Explore
 * writes section anchors into `evidence.why` as "§section-id ..." for every
 * document hit; the vault miner keys on this signature.
 */
function touchedSectionsFromDossier(dossier: Dossier): TouchedSection[] {
  const out: TouchedSection[] = [];
  for (const e of dossier.evidence) {
    const match = /§([\w./:-]+)/.exec(e.why);
    if (match === null || match[1] === undefined) continue;
    out.push({ document: e.file, section: match[1] });
  }
  // Dedup while preserving first-seen order (some evidence rows share sections).
  const seen = new Set<string>();
  return out.filter((t) => {
    const k = `${t.document}#${t.section}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function vaultCodex(
  corpora: Map<string, Corpus>,
  session: VaultSession,
  args: Record<string, unknown>,
): string {
  const corpus = pickCorpus(corpora, args['corpus']);
  const options: EmitOptions = {};
  if (typeof args['maxTokens'] === 'number') options.maxTokens = args['maxTokens'];
  const emission = emitCodex(corpus, options);
  writeVaultEvent(corpus, {
    id: `vault-codex-${randomUUID()}`,
    timestamp: new Date().toISOString(),
    sessionId: session.id,
    module: 'vault.codex',
    action: 'summarize',
    reason: `codex emission v${emission.version} on corpus ${corpus.name}: ${emission.includedGraduated.length} graduated included, ${emission.excludedGraduated.length} excluded`,
    details: {
      corpus: corpus.name,
      version: emission.version,
      textHash: emission.textHash,
      includedGraduated: emission.includedGraduated,
      excludedGraduated: emission.excludedGraduated,
    },
  });
  if (args['json'] === true) {
    return JSON.stringify(emission, null, 2);
  }
  return emission.text;
}

/** Corpus-relative path behind an artifact, from its stored meta or the
 * document index, for per-document ledger attribution. */
function documentFor(corpus: Corpus, artifactId: string | undefined): string | undefined {
  if (artifactId === undefined) return undefined;
  const filePath = corpus.store.getArtifact(artifactId)?.meta['filePath'];
  if (typeof filePath === 'string' && filePath !== '') return filePath;
  return corpus.documents.find((d) => d.artifactId === artifactId)?.path;
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
  const served = redact(result.text).text;
  const rawBytes = result.rawBytes ?? Buffer.byteLength(result.text, 'utf8');
  const servedBytes = Buffer.byteLength(served, 'utf8');
  // Unlike the ask event, the zoom event carries its bytes directly: no
  // per-step event accounts this serve, so this is the one measurement.
  const eventId = `vault-zoom-${randomUUID()}`;
  const timestamp = new Date().toISOString();
  writeVaultEvent(corpus, {
    id: eventId,
    timestamp,
    sessionId: session.id,
    module: 'vault.zoom',
    action: 'zoom',
    reason: `zoom ${ref}${query === undefined ? '' : ' with query'} on corpus ${corpus.name}`,
    inputRef: ref,
    bytesIn: rawBytes,
    bytesOut: servedBytes,
  });
  const artifactId = result.artifactId ?? ref;
  const doc = result.filePath ?? documentFor(corpus, result.artifactId);
  corpus.ledger.append(
    makeLedgerLine({
      kind: 'zoom',
      corpus: corpus.name,
      sessionId: session.id,
      timestamp,
      rawBytes,
      servedBytes,
      artifactRefs: [artifactId],
      auditIds: [eventId],
      // A zoom that resolved its query (or asked for the raw outright) is a
      // high-confidence serve; the unmatched-query raw fallback is low.
      confidence: result.queryMatched === false ? 'low' : 'high',
      ...(doc === undefined ? {} : { document: doc }),
    }),
  );
  return served;
}

/**
 * Rollup from the persistent ledger. Session scope covers this vault session
 * id; day and month scopes cut by line timestamp (UTC); corpus scope covers
 * the corpus lifetime of vault serving; document scope groups per document.
 * The ledger reconciles with the audit trail by construction, so these
 * figures always match a recomputation from the trail.
 */
export function buildVaultReceipt(corpus: Corpus, query?: string | RollupQuery): VaultRollup {
  const q: RollupQuery =
    typeof query === 'string'
      ? { scope: 'session', sessionId: query }
      : (query ?? { scope: 'corpus' });
  const filter: { sessionId?: string; day?: string; month?: string } = {};
  if (q.scope === 'session' && q.sessionId !== undefined) filter.sessionId = q.sessionId;
  if (q.scope === 'day' && q.day !== undefined) filter.day = q.day;
  if (q.scope === 'month' && q.month !== undefined) filter.month = q.month;
  return rollupLines(corpus.ledger.lines(filter), q, {
    corpus: corpus.name,
    corpusResidentTokens: bytesToTokens(corpus.store.residentRawBytes()),
  });
}

export function renderVaultReceipt(r: VaultRollup): string {
  const lines: string[] = [`Redutok vault receipt (scope: ${r.scope}, corpus: ${r.corpus})`];
  if (r.sessionId !== undefined) lines.push(`  session      ${r.sessionId}`);
  if (r.day !== undefined) lines.push(`  day          ${r.day}`);
  if (r.month !== undefined) lines.push(`  month        ${r.month}`);
  const c = r.asksByConfidence;
  lines.push(
    `  ledger lines ${fmt(r.lines)} (${fmt(r.asks)} asks, ${fmt(r.zooms)} zooms, ${fmt(r.serves)} serves; ${fmt(r.sessions)} sessions)`,
    `  asks by confidence ${fmt(c.high)} high / ${fmt(c.medium)} medium / ${fmt(c.low)} low${c.unrated === 0 ? '' : ` / ${fmt(c.unrated)} unrated`}`,
    `  raw touched  ${fmt(r.rawTokens)} tok; served ${fmt(r.servedTokens)} tok; avoided ${fmt(r.avoidedTokens)} tok`,
  );
  if (r.topDistillations.length > 0 && r.scope !== 'document') {
    lines.push('  top distillations by tokens avoided');
    r.topDistillations.forEach((d, i) => {
      lines.push(
        `    ${i + 1}. ${d.label} (${d.ref}): ${fmt(d.rawTokens)} raw to ${fmt(d.servedTokens)} served, ${fmt(d.avoidedTokens)} avoided`,
      );
    });
  }
  if (r.documents.length > 0) {
    const shown = r.scope === 'document' ? r.documents : r.documents.slice(0, 5);
    lines.push(
      r.scope === 'document' ? '  documents by reads' : '  top documents by reads',
    );
    shown.forEach((d, i) => {
      lines.push(
        `    ${i + 1}. ${d.document}: ${fmt(d.reads)} read${d.reads === 1 ? '' : 's'}, ${fmt(d.avoidedTokens)} tok avoided, $${d.costAvoidedUsd.toFixed(4)}`,
      );
    });
  }
  if (r.scope !== 'session' && r.topSessions.length > 0) {
    lines.push('  top sessions by tokens avoided');
    r.topSessions.slice(0, 5).forEach((s, i) => {
      lines.push(
        `    ${i + 1}. ${s.sessionId}: ${fmt(s.asks)} ask${s.asks === 1 ? '' : 's'}, ${fmt(s.avoidedTokens)} tok avoided, $${s.costAvoidedUsd.toFixed(4)}`,
      );
    });
  }
  lines.push(
    `  cost avoided est $${r.costAvoidedUsd.toFixed(4)} USD at ${r.referenceModel} input rate ($${r.inputPerMTokUsd.toFixed(2)}/MTok), rate row prices.yaml ${r.referenceModel} (source: ${r.priceSource})`,
    `  energy avoided est ${r.wh.base.toFixed(3)} Wh (band ${r.wh.low.toFixed(3)}-${r.wh.high.toFixed(3)}), ${r.gCo2e.base.toFixed(3)} gCO2e (band ${r.gCo2e.low.toFixed(3)}-${r.gCo2e.high.toFixed(3)}), region ${r.region}, context multiplier 1.0`,
    `  corpus resident size avoided ${fmt(r.corpusResidentTokens)} tok: the whole corpus at rest, a distinct figure from the avoided total above, which counts only what was touched`,
    '  estimates per docs/METHODOLOGY.md: bands are the claim, base is a midpoint convenience',
  );
  return lines.join('\n');
}

const SCOPES: RollupScope[] = ['session', 'day', 'month', 'corpus', 'document'];

export function vaultReceipt(
  corpora: Map<string, Corpus>,
  session: VaultSession,
  args: Record<string, unknown>,
): string {
  const scopeArg = args['scope'];
  if (scopeArg !== undefined && !SCOPES.includes(scopeArg as RollupScope)) {
    throw new VaultError(`unknown scope "${String(scopeArg)}" (${SCOPES.join(' | ')})`);
  }
  const scope = (scopeArg ?? 'session') as RollupScope;
  const corpus = pickCorpus(corpora, args['corpus']);
  const query: RollupQuery = { scope };
  if (scope === 'session') query.sessionId = session.id;
  if (scope === 'day' && args['day'] !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(args['day']))) {
      throw new VaultError(`invalid day "${String(args['day'])}" (YYYY-MM-DD)`);
    }
    query.day = String(args['day']);
  }
  if (scope === 'month' && args['month'] !== undefined) {
    if (!/^\d{4}-\d{2}$/.test(String(args['month']))) {
      throw new VaultError(`invalid month "${String(args['month'])}" (YYYY-MM)`);
    }
    query.month = String(args['month']);
  }
  const receipt = buildVaultReceipt(corpus, query);
  writeVaultEvent(corpus, {
    id: `vault-receipt-${randomUUID()}`,
    timestamp: new Date().toISOString(),
    sessionId: session.id,
    module: 'vault.receipt',
    action: 'summarize',
    reason: `receipt (${scope}) on corpus ${corpus.name}: ${receipt.avoidedTokens} tokens avoided across ${receipt.lines} ledger lines`,
    details: { scope, corpus: corpus.name, avoidedTokens: receipt.avoidedTokens },
  });
  const text =
    args['json'] === true ? JSON.stringify(receipt, null, 2) : renderVaultReceipt(receipt);
  return redact(text).text;
}
