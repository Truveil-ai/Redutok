import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  loadEnergyFactors,
  loadGridIntensity,
  loadPrices,
  type AuditEvent,
} from '@redutok/shared';
import { buildAuditReport } from './audit-render.js';
import { projectTranscriptDir, transcriptRoot } from './claude-compat.js';
import { computeSessionCost, type SessionCost } from './cost.js';
import { computeSessionEnergy, type SessionEnergy } from './energy.js';
import { buildLedger, grandTotal, type SessionLedger } from './ledger.js';
import { parseSessionFile, type ParseCounts } from './parser.js';
import {
  computeSessionSavings,
  renderSavingsLines,
  type SessionSavings,
} from './savings.js';
import { renderCompositeValue, scoreSession, type SessionScores } from './scoring.js';

export interface Report {
  source: string;
  ledger: SessionLedger;
  grandTotal: number;
  cost: SessionCost;
  energy: SessionEnergy;
  scores: SessionScores;
  parse: ParseCounts;
  /**
   * Sidecar audit trail events attributed to this session: the same array
   * scoring reads, so every audit count on the report agrees with the scores.
   */
  audit: AuditEvent[];
  /**
   * What the session saved, from the same computation the receipt reads
   * (savings.ts). The report is what a user actually runs, so it has to
   * answer the question the receipt was answering on its own.
   */
  savings: SessionSavings;
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

  // Session audit trail (sidecar side). Only events attributed to this
  // transcript's session id count toward the context-efficiency score, and the
  // same array is surfaced as report.audit so rendered counts cannot diverge
  // from what scoring saw. Parse skips are reported via parse counts, not here.
  const sessionAudit = buildAuditReport(ledger.sessionId, options.auditPath).events;
  const scores = scoreSession(ledger, energy, sessionAudit);
  const savings = computeSessionSavings({
    ledger,
    audit: sessionAudit,
    contextEfficiency: scores.contextEfficiency,
    prices,
    factors: loadEnergyFactors(),
    grid: loadGridIntensity(),
    region: options.region,
  });

  return {
    source: filePath,
    ledger,
    grandTotal: grandTotal(ledger.totals),
    cost,
    energy,
    scores,
    parse: parsed.counts,
    audit: sessionAudit,
    savings,
    notes,
  };
}

/** Default Claude Code transcript root, owned by the compat shim. */
export function defaultLogRoot(): string {
  return transcriptRoot();
}

export interface LastSessionOptions {
  /**
   * Search every project's transcripts rather than only this one. Off by
   * default: `--last` inside a project used to mean "the newest transcript
   * anywhere", so it could report a session belonging to a different project
   * with nothing in the output to say it had.
   */
  allProjects?: boolean;
  /** Working directory whose project is searched; defaults to the process cwd. */
  cwd?: string;
  /** Transcript root; defaults to the compat shim's. */
  root?: string;
}

/**
 * The newest .jsonl transcript of the current project, or of every project
 * when widened. Undefined when the chosen scope holds none: the caller
 * reports that rather than falling back to a wider scope, because a silent
 * widening is exactly the behaviour this replaced.
 */
export function locateLastSessionLog(options: LastSessionOptions = {}): string | undefined {
  const root = options.root ?? defaultLogRoot();
  if (options.allProjects === true) return newestTranscriptUnder(root);
  // A subdirectory belongs to the project that encloses it, and sessions are
  // keyed to the directory claude was launched from, so the nearest ancestor
  // holding sessions is this project. Without the walk, running redutok from
  // packages/meter inside its own repo reports no session at all. The search
  // never leaves the directory's own ancestry, so it cannot reach sideways
  // into an unrelated project.
  for (const dir of selfAndAncestors(options.cwd ?? process.cwd())) {
    const found = newestTranscriptUnder(projectTranscriptDir(dir, root));
    if (found !== undefined) return found;
  }
  return undefined;
}

/** A directory and every directory above it, nearest first. */
function selfAndAncestors(from: string): string[] {
  const out: string[] = [];
  let dir = path.resolve(from);
  for (;;) {
    out.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) return out;
    dir = parent;
  }
}

/** Newest .jsonl transcript under the given root, or undefined when none exist. */
export function newestTranscriptUnder(root: string): string | undefined {
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
      : `  composite            ${renderCompositeValue(report.scores.composite)}`,
  );
  lines.push('');
  lines.push('Savings (estimates, see docs/METHODOLOGY.md)');
  lines.push(...renderSavingsLines(report.savings));
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
