import { describe, expect, it } from 'vitest';
import { entityPreservationGate, extractProseEntities, runGates } from '../src/gates.js';

/**
 * Prose adaptation of the entity-preservation discipline: dates, defined
 * terms, party names, section references, and figures in the
 * conclusion-relevant region must survive verbatim. Extraction is the same
 * deterministic regex-set approach as the code patterns.
 */

const REGION = [
  'This engagement letter is entered into between Truveil Advisory LLP (the',
  '"Practice") and Meridian Instruments Ltd (the "Client"), effective',
  'March 15, 2026 (the "Effective Date").',
  'The fixed fee for the Meridian valuation engagement is USD 12,500 per',
  'Section 3, and the WACC is estimated at 11.4% as at 2026-03-31.',
].join('\n');

describe('prose entity extraction', () => {
  it('extracts dates, defined terms, party names, section refs, and figures', () => {
    const entities = extractProseEntities(REGION);
    expect(entities).toContain('March 15, 2026');
    expect(entities).toContain('2026-03-31');
    expect(entities).toContain('Effective Date');
    expect(entities).toContain('Meridian Instruments Ltd');
    expect(entities).toContain('Truveil Advisory LLP');
    expect(entities).toContain('Section 3');
    expect(entities).toContain('USD 12,500');
    expect(entities).toContain('11.4%');
  });
});

describe('prose entity gate over an explicit region', () => {
  it('passes when the distillate carries every region entity verbatim', () => {
    const result = entityPreservationGate('irrelevant raw', REGION, {
      region: REGION,
      patternSet: 'prose',
      minRatio: 1,
    });
    expect(result.passed).toBe(true);
  });

  it('blocks a distillate that drops a date', () => {
    const missingDate = REGION.replace('March 15, 2026', 'a date in early 2026');
    const result = entityPreservationGate('irrelevant raw', missingDate, {
      region: REGION,
      patternSet: 'prose',
      minRatio: 1,
    });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('March 15, 2026');
  });

  it('feeds the report through runGates like any other gate', () => {
    const report = runGates('raw', REGION.replace('USD 12,500', 'a five-figure fee'), {
      entity: { region: REGION, patternSet: 'prose', minRatio: 1 },
    });
    expect(report.passed).toBe(false);
    expect(report.results[0]?.gate).toBe('entity-preservation');
  });
});
