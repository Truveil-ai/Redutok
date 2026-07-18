import { describe, expect, it } from 'vitest';
import { LIMITS } from '@redutok/shared';
import {
  entityPreservationGate,
  extractEntities,
  runGates,
  sizeSanityGate,
  verdictFidelityGate,
  type GateConfig,
} from '../src/gates.js';

const RAW_BUILD_LOG = [
  'compiling 42 files',
  'src/report.ts:118:5 - error TS2304: Cannot find name "grandTotal".',
  'build failed with 1 error in 3.4s',
  'noise line about caching',
].join('\n');

describe('extractEntities', () => {
  it('extracts paths with line numbers, versions, quoted symbols, and numerics', () => {
    const entities = extractEntities(
      'src/report.ts:118:5 error TS2304 "grandTotal" version 1.2.3 exit code 1',
    );
    expect(entities).toContain('src/report.ts:118');
    expect(entities).toContain('1.2.3');
    expect(entities).toContain('grandTotal');
    expect(entities).toContain('TS2304');
  });
});

describe('entityPreservationGate', () => {
  const config = { relevantLinePattern: 'error|fail', minRatio: 1 };

  it('passes when every entity from relevant raw lines appears in the distillate', () => {
    const distilled =
      'VERDICT: fail. src/report.ts:118:5 TS2304 "grandTotal". 1 error in 3.4s';
    expect(entityPreservationGate(RAW_BUILD_LOG, distilled, config).passed).toBe(true);
  });

  it('fails when the distillate drops the file path', () => {
    const result = entityPreservationGate(RAW_BUILD_LOG, 'VERDICT: fail, TS2304 somewhere', config);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('src/report.ts:118');
  });
});

describe('verdictFidelityGate', () => {
  const config = {
    primaryPass: ['\\bbuild succeeded\\b'],
    primaryFail: ['\\bbuild failed\\b'],
    secondaryPass: ['\\b0 errors?\\b'],
    secondaryFail: ['\\b[1-9]\\d* errors?\\b'],
  };

  it('passes when both independent extractions agree and the distillate matches', () => {
    const result = verdictFidelityGate(RAW_BUILD_LOG, 'VERDICT: fail. build failed, 1 error', config);
    expect(result.passed).toBe(true);
  });

  it('fails when the two extractions disagree on the raw artifact', () => {
    const contradictory = 'build succeeded\nfinished with 3 errors';
    const result = verdictFidelityGate(contradictory, 'VERDICT: pass, build succeeded', config);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('disagree');
  });

  it('fails when the distillate flips the verdict', () => {
    const result = verdictFidelityGate(RAW_BUILD_LOG, 'VERDICT: pass. build succeeded, 0 errors', config);
    expect(result.passed).toBe(false);
  });
});

describe('sizeSanityGate', () => {
  it('enforces the 40% ceiling from limits.ts', () => {
    expect(LIMITS.SIZE_SANITY_MAX_RATIO).toBe(0.4);
    const raw = 'x'.repeat(1000);
    expect(sizeSanityGate(raw, 'y'.repeat(400), {}).passed).toBe(true);
    expect(sizeSanityGate(raw, 'y'.repeat(401), {}).passed).toBe(false);
  });
});

describe('runGates', () => {
  const config: GateConfig = {
    entity: { relevantLinePattern: 'error|fail', minRatio: 1 },
    verdict: {
      primaryPass: ['\\bbuild succeeded\\b'],
      primaryFail: ['\\bbuild failed\\b'],
      secondaryPass: ['\\b0 errors?\\b'],
      secondaryFail: ['\\b[1-9]\\d* errors?\\b'],
    },
    size: {},
  };

  it('aggregates all gates and reports each result', () => {
    const distilled = 'VERDICT: fail. src/report.ts:118:5 TS2304 "grandTotal". build failed, 1 error in 3.4s';
    const report = runGates(RAW_BUILD_LOG.repeat(3), distilled, config);
    expect(report.passed).toBe(true);
    expect(report.results.map((r) => r.gate).sort()).toEqual([
      'entity-preservation',
      'size-sanity',
      'verdict-fidelity',
    ]);
  });

  it('fails overall when any single gate fails', () => {
    const report = runGates(RAW_BUILD_LOG, RAW_BUILD_LOG, config);
    expect(report.passed).toBe(false);
    expect(report.results.find((r) => r.gate === 'size-sanity')?.passed).toBe(false);
  });
});
