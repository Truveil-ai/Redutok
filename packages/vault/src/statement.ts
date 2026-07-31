import { existsSync } from 'node:fs';
import path from 'node:path';
import { openStore } from '@redutok/sidecar';
import { VaultLedger } from './ledger.js';
import { rollupLines, type VaultRollup } from './rollup.js';

/**
 * The monthly statement: a ledger rollup rendered so it can be attached to
 * an internal report as-is. Totals, top documents, top sessions, avoided
 * cost and energy with bands, the methodology citation, and the mandatory
 * estimates-never-measurements framing. House style: no em-dashes, and the
 * whole-corpus figure appears only under its own corpus resident size
 * avoided label, never as avoided tokens.
 */

const fmt = (n: number): string => n.toLocaleString('en-US');

export function renderMonthlyStatement(r: VaultRollup, generatedAt: string): string {
  if (r.scope !== 'month' || r.month === undefined) {
    throw new Error(`the monthly statement renders a month rollup, got scope "${r.scope}"`);
  }
  const lines: string[] = [
    'Redutok vault monthly statement',
    `corpus ${r.corpus}, month ${r.month}, generated ${generatedAt}`,
    '',
    'activity',
    `  ${fmt(r.asks)} asks, ${fmt(r.zooms)} zooms, ${fmt(r.serves)} serves across ${fmt(r.sessions)} sessions (${fmt(r.lines)} ledger lines)`,
    '',
    'tokens, counting only what was actually touched',
    `  raw touched  ${fmt(r.rawTokens)} tok`,
    `  served       ${fmt(r.servedTokens)} tok`,
    `  avoided      ${fmt(r.avoidedTokens)} tok`,
    '',
    'avoided cost, estimate',
    `  $${r.costAvoidedUsd.toFixed(4)} USD at ${r.referenceModel} input rate ($${r.inputPerMTokUsd.toFixed(2)}/MTok)`,
    `  rate row prices.yaml ${r.referenceModel} (source: ${r.priceSource})`,
    '',
    'avoided energy, estimate',
    `  ${r.wh.base.toFixed(3)} Wh (band ${r.wh.low.toFixed(3)} to ${r.wh.high.toFixed(3)})`,
    `  ${r.gCo2e.base.toFixed(3)} gCO2e (band ${r.gCo2e.low.toFixed(3)} to ${r.gCo2e.high.toFixed(3)}), grid region ${r.region}, context multiplier 1.0`,
  ];
  if (r.documents.length > 0) {
    lines.push('', 'top documents by reads');
    r.documents.slice(0, 5).forEach((d, i) => {
      lines.push(
        `  ${i + 1}. ${d.document}: ${fmt(d.reads)} read${d.reads === 1 ? '' : 's'}, ${fmt(d.avoidedTokens)} tok avoided, $${d.costAvoidedUsd.toFixed(4)}`,
      );
    });
  }
  if (r.topSessions.length > 0) {
    lines.push('', 'top sessions by tokens avoided');
    r.topSessions.slice(0, 5).forEach((s, i) => {
      lines.push(
        `  ${i + 1}. ${s.sessionId}: ${fmt(s.asks)} ask${s.asks === 1 ? '' : 's'}, ${fmt(s.avoidedTokens)} tok avoided, $${s.costAvoidedUsd.toFixed(4)}`,
      );
    });
  }
  lines.push(
    '',
    `corpus resident size avoided ${fmt(r.corpusResidentTokens)} tok: the whole corpus at rest in the vault, a distinct figure from the avoided total above, which counts only what was touched this month`,
    '',
    'methodology: docs/METHODOLOGY.md. All avoided cost and energy figures are',
    'estimates, never measurements: bands are the claim, the base is a midpoint',
    'convenience.',
  );
  return lines.join('\n');
}

/**
 * Statement straight from a corpus's .dcp state: the persistent ledger plus
 * the store's resident size, no server required.
 */
export function statementFromDcp(
  target: string,
  opts: { corpus?: string; month: string; json: boolean },
): string {
  const root = path.resolve(target);
  const dcpDir = path.join(root, '.dcp');
  if (!existsSync(dcpDir)) {
    throw new Error(`cannot read ${root}: no .dcp state directory; run redutok init or vault ingest there first`);
  }
  const ledger = new VaultLedger(path.join(dcpDir, 'ledger.db'));
  const store = openStore(path.join(dcpDir, 'state.db'));
  try {
    const rollup = rollupLines(
      ledger.lines({ month: opts.month }),
      { scope: 'month', month: opts.month },
      {
        corpus: opts.corpus ?? path.basename(root),
        corpusResidentTokens: Math.round(store.residentRawBytes() / 4),
      },
    );
    return opts.json
      ? JSON.stringify(rollup, null, 2)
      : renderMonthlyStatement(rollup, new Date().toISOString());
  } finally {
    ledger.close();
    store.close();
  }
}
