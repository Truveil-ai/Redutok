import { LIMITS } from '@redutok/shared';

/**
 * Quality gates, architecture 4.3. All deterministic, no LLM anywhere.
 * A distillate ships only if every configured gate passes; otherwise the raw
 * artifact is served and the failure audited by the caller.
 */

export interface GateResult {
  gate: string;
  passed: boolean;
  detail: string;
}

export interface GateReport {
  passed: boolean;
  results: GateResult[];
}

export interface EntityGateConfig {
  /** Raw lines matching this regex are the conclusion-relevant region. */
  relevantLinePattern: string;
  /** Fraction of extracted entities that must appear verbatim in the distillate. */
  minRatio: number;
}

export interface VerdictGateConfig {
  primaryPass: string[];
  primaryFail: string[];
  secondaryPass: string[];
  secondaryFail: string[];
}

export interface SizeGateConfig {
  maxRatio?: number;
}

export interface GateConfig {
  entity?: EntityGateConfig;
  verdict?: VerdictGateConfig;
  size?: SizeGateConfig;
}

const ENTITY_PATTERNS: RegExp[] = [
  // File paths, optionally with :line (trailing :column is trimmed to :line).
  /[A-Za-z0-9_@./\\-]+\.[a-z]{1,6}(?::\d+)?/g,
  // Version strings.
  /\bv?\d+\.\d+\.\d+[-.\w]*\b/g,
  // Error codes and exception-ish identifiers.
  /\b(?:TS|E|ERR_)[A-Z0-9_]*\d[A-Z0-9_]*\b/g,
  // Quoted symbol names.
  /["'`]([A-Za-z_$][A-Za-z0-9_$]*)["'`]/g,
  // Numeric literals.
  /\b\d+(?:\.\d+)?\b/g,
];

export function extractEntities(text: string): string[] {
  const entities = new Set<string>();
  for (const pattern of ENTITY_PATTERNS) {
    for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
      entities.add(match[1] ?? (match[0] as string));
    }
  }
  return [...entities];
}

export function entityPreservationGate(
  raw: string,
  distilled: string,
  config: EntityGateConfig,
): GateResult {
  const relevant = new RegExp(config.relevantLinePattern, 'i');
  const region = raw
    .split(/\r?\n/)
    .filter((line) => relevant.test(line))
    .join('\n');
  const entities = extractEntities(region);
  if (entities.length === 0) {
    return { gate: 'entity-preservation', passed: true, detail: 'no entities in relevant region' };
  }
  const missing = entities.filter((e) => !distilled.includes(e));
  const ratio = (entities.length - missing.length) / entities.length;
  const passed = ratio >= config.minRatio;
  return {
    gate: 'entity-preservation',
    passed,
    detail: passed
      ? `${entities.length - missing.length}/${entities.length} entities preserved`
      : `missing entities: ${missing.slice(0, 5).join(', ')} (${missing.length} of ${entities.length})`,
  };
}

type Verdict = 'pass' | 'fail' | 'unknown';

function verdictFrom(text: string, passPatterns: string[], failPatterns: string[]): Verdict {
  const hit = (patterns: string[]): boolean => patterns.some((p) => new RegExp(p, 'im').test(text));
  const passed = hit(passPatterns);
  const failed = hit(failPatterns);
  if (failed && !passed) return 'fail';
  if (passed && !failed) return 'pass';
  return 'unknown';
}

export function verdictFidelityGate(
  raw: string,
  distilled: string,
  config: VerdictGateConfig,
): GateResult {
  const primary = verdictFrom(raw, config.primaryPass, config.primaryFail);
  const secondary = verdictFrom(raw, config.secondaryPass, config.secondaryFail);
  if (primary === 'unknown' || secondary === 'unknown' || primary !== secondary) {
    return {
      gate: 'verdict-fidelity',
      passed: false,
      detail: `extractions disagree or are inconclusive on raw: primary=${primary}, secondary=${secondary}`,
    };
  }
  const distilledVerdict = verdictFrom(
    distilled,
    [...config.primaryPass, ...config.secondaryPass, '\\bVERDICT: pass\\b'],
    [...config.primaryFail, ...config.secondaryFail, '\\bVERDICT: fail\\b'],
  );
  const passed = distilledVerdict === primary;
  return {
    gate: 'verdict-fidelity',
    passed,
    detail: passed
      ? `verdict ${primary} agreed by both extractions and the distillate`
      : `raw verdict ${primary} but distillate reads ${distilledVerdict}`,
  };
}

export function sizeSanityGate(raw: string, distilled: string, config: SizeGateConfig): GateResult {
  const maxRatio = config.maxRatio ?? LIMITS.SIZE_SANITY_MAX_RATIO;
  const rawBytes = Buffer.byteLength(raw, 'utf8');
  const distilledBytes = Buffer.byteLength(distilled, 'utf8');
  const passed = rawBytes === 0 ? false : distilledBytes / rawBytes <= maxRatio;
  return {
    gate: 'size-sanity',
    passed,
    detail: `${distilledBytes}B of ${rawBytes}B (max ratio ${maxRatio})`,
  };
}

export function runGates(raw: string, distilled: string, config: GateConfig): GateReport {
  const results: GateResult[] = [];
  if (config.entity !== undefined) results.push(entityPreservationGate(raw, distilled, config.entity));
  if (config.verdict !== undefined) results.push(verdictFidelityGate(raw, distilled, config.verdict));
  if (config.size !== undefined) results.push(sizeSanityGate(raw, distilled, config.size));
  return { passed: results.every((r) => r.passed), results };
}
