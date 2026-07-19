import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  loadEnergyFactors,
  loadGridIntensity,
  loadPrices,
  type AuditEvent,
} from '@redutok/shared';
import { buildAuditReport } from './audit-render.js';
import { transcriptRoot } from './claude-compat.js';
import { computeSessionCost, type SessionCost } from './cost.js';
import { computeSessionEnergy, type SessionEnergy } from './energy.js';
import { buildLedger, grandTotal, type SessionLedger } from './ledger.js';
import { parseSessionFile, type ParseCounts } from './parser.js';
import { scoreSession, type SessionScores } from './scoring.js';

export interface Report {
  source: string;
  ledger: SessionLedger;
  grandTotal: number;
  cost: SessionCost;
  energy: SessionEnergy;
  scores: SessionScores;
  parse: ParseCounts;
  audit: AuditEvent[];
  notes: string[];
}

export interface BuildReportOptions {
  pricesPath?: string;
  region?: string;
  /** Override for the sidecar audit trail, default <cwd>/.dcp/audit.jsonl. */
  auditPath?: string;
}

export async function buildReport(
  filePath: string,
  options: BuildReportOptions = {},
): Promise<Report> {
  const parsed = await parseSessionFile(filePath);
  const ledger = buildLedger(parsed, path.basename(filePath, '.jsonl'));
  const prices = loadPrices(options.pricesPath);
  const cost = computeSessionCost(ledger, prices);
  const energy = computeSessionEnergy(
    ledger,
    loadEnergyFactors(),
    loadGridIntensity(),
    options.region,
  );

  const notes: string[] = ['Thinking tokens are priced at the output rate.'];
  const assumedCacheWrite = ledger.totals.cacheWriteAssumedTokens ?? 0;
  if (assumedCacheWrite > 0) {
    notes.push(
      `${fmt(assumedCacheWrite)} of ${fmt(ledger.totals.cacheWrite)} cache-write tokens had no 5-minute/1-hour tier breakdown in the transcript; costed at the higher-cost 1-hour tier by policy (conservative against ourselves), not silently at the cheaper rate.`,
    );
  }
  if (cost.unverifiedSources.length > 0) {
    notes.push(
      `Price rows pending verification (TODO-VERIFY): ${cost.unverifiedSources.join(', ')}. Treat cost as indicative.`,
    );
  }
  if (cost.unpricedModels.length > 0) {
    notes.push(`No price row for: ${cost.unpricedModels.join(', ')}. Their turns are not costed.`);
  }
  notes.push(
    'Energy and carbon figures are estimates from energy_factors.yaml and grid_intensity.yaml, never measurements. Sources are cited on every row; see docs/METHODOLOGY.md for evidence quality.',
  );
  if (energy.unestimatedModels.length > 0) {
    notes.push(
      `No energy factor class for: ${energy.unestimatedModels.join(', ')}. Their turns are excluded from the energy estimate.`,
    );
  }

  // Session audit trail (sidecar side), distinct from the parse audit above.
  // Only events attributed to this transcript's session id count toward the
  // context-efficiency score.
  const sessionAudit = buildAuditReport(ledger.sessionId, options.auditPath).events;
  const scores = scoreSession(ledger, energy, sessionAudit);

  return {
    source: filePath,
    ledger,
    grandTotal: grandTotal(ledger.totals),
    cost,
    energy,
    scores,
    parse: parsed.counts,
    audit: parsed.audit,
    notes,
  };
}

/** Default Claude Code transcript root, owned by the compat shim. */
export function defaultLogRoot(): string {
  return transcriptRoot();
}

/** Newest .jsonl transcript under the given root, or undefined when none exist. */
export function locateLastSessionLog(root: string = defaultLogRoot()): string | undefined {
  let newest: { file: string; mtimeMs: number } | undefined;
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        walk(full);
      } else if (name.endsWith('.jsonl') && (!newest || stats.mtimeMs > newest.mtimeMs)) {
        newest = { file: full, mtimeMs: stats.mtimeMs };
      }
    }
  };
  walk(root);
  return newest?.file;
}

const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');

export function renderText(report: Report): string {
  const { ledger, cost } = report;
  const lines: string[] = [];
  lines.push('Redutok report');
  lines.push(`Session: ${ledger.sessionId}`);
  lines.push(`Source: ${report.source}`);
  lines.push(`Turns: ${ledger.entries.length}`);
  lines.push('');
  lines.push('Tokens');
  lines.push(`  input        ${fmt(ledger.totals.input)}`);
  lines.push(`  output       ${fmt(ledger.totals.output)}`);
  lines.push(`  cache read   ${fmt(ledger.totals.cacheRead)}`);
  lines.push(
    `  cache write  ${fmt(ledger.totals.cacheWrite)}  (5m: ${fmt(ledger.totals.cacheWrite5m ?? 0)}, 1h: ${fmt(ledger.totals.cacheWrite1h ?? 0)})`,
  );
  lines.push(`  thinking     ${fmt(ledger.totals.thinking)}`);
  lines.push(`  total        ${fmt(report.grandTotal)}`);
  lines.push('');
  lines.push(`Estimated cost: ${cost.totalUsd.toFixed(4)} USD (${cost.pricedTurns} priced turns)`);
  const e = report.energy;
  const band = (b: { base: number; low: number; high: number }, unit: string): string =>
    `estimated ${b.base.toFixed(2)} ${unit} (band ${b.low.toFixed(2)} to ${b.high.toFixed(2)} ${unit})`;
  lines.push('');
  lines.push('Energy (estimated, never measured)');
  lines.push(`  ${band(e.wh, 'Wh')}`);
  lines.push(`  ${band(e.gCo2e, 'gCO2e')}, grid region ${e.region} at ${e.gCo2ePerKwh} gCO2e/kWh`);
  lines.push(`  sidecar self-consumption: ${e.sidecarWh} Wh (not yet measured, lands in Phase 3)`);
  lines.push('');
  lines.push('Scores (formulas in docs/SCORING.md)');
  const scoreNames: [keyof SessionScores, string][] = [
    ['contextEfficiency', 'context efficiency'],
    ['outputDiscipline', 'output discipline'],
    ['cacheUtilization', 'cache utilization'],
    ['energyPerOutcome', 'energy per outcome'],
  ];
  for (const [key, label] of scoreNames) {
    const s = report.scores[key];
    if (s === undefined || typeof s === 'object' === false) continue;
    if ('scorable' in s && s.scorable) lines.push(`  ${label.padEnd(20)} ${s.score}  (${s.detail})`);
    else if ('scorable' in s) lines.push(`  ${label.padEnd(20)} not scorable: ${s.reason}`);
  }
  lines.push(
    report.scores.composite === undefined
      ? '  composite            not scorable: no individual score was computable'
      : `  composite            ${report.scores.composite.value} (${report.scores.composite.grade})`,
  );
  const tools = Object.entries(ledger.byTool).sort((a, b) => b[1].calls - a[1].calls);
  if (tools.length > 0) {
    lines.push('');
    lines.push('Per tool (calls, output token share)');
    for (const [tool, attr] of tools) {
      lines.push(`  ${tool.padEnd(12)} ${attr.calls}  ${fmt(attr.outputTokenShare)}`);
    }
  }
  const skipped = report.parse.unknownType + report.parse.malformed;
  if (skipped > 0) {
    lines.push('');
    lines.push(
      `Skipped records: ${report.parse.unknownType} unknown type, ${report.parse.malformed} malformed. Audit events: ${report.audit.length}.`,
    );
  }
  lines.push('');
  for (const note of report.notes) lines.push(`Note: ${note}`);
  return lines.join('\n');
}
