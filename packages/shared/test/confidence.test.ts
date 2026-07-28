import { describe, expect, it } from 'vitest';
import {
  candidateConfidence,
  isEligibleForGraduation,
  isBelowWithdrawal,
  LIMITS,
  CandidateRecordSchema,
  type CandidateRecord,
} from '../src/index.js';

const NOW = new Date('2026-07-29T12:00:00.000Z');

function record(overrides: Partial<CandidateRecord> = {}): CandidateRecord {
  return CandidateRecordSchema.parse({
    id: 'cand-test',
    type: 'zoom-hotspot',
    key: 'zoom-hotspot:source/index.js',
    signature: 'distillate of source/index.js required zooming back to raw',
    evidence: [],
    firstSeen: '2026-07-19T12:00:00.000Z',
    lastSeen: NOW.toISOString(),
    occurrences: 1,
    ...overrides,
  });
}

describe('candidateConfidence', () => {
  it('saturates with occurrence count: 2 fresh occurrences reach the graduation threshold', () => {
    expect(candidateConfidence(record({ occurrences: 1 }), NOW)).toBeCloseTo(1 - 0.5 ** 0.5, 5);
    expect(candidateConfidence(record({ occurrences: 2 }), NOW)).toBeCloseTo(0.5, 5);
    expect(candidateConfidence(record({ occurrences: 7 }), NOW)).toBeGreaterThan(0.9);
    expect(candidateConfidence(record({ occurrences: 1000 }), NOW)).toBeLessThanOrEqual(1);
  });

  it('halves with recency: a record last seen one half-life ago scores half its fresh value', () => {
    const halfLifeAgo = new Date(
      NOW.getTime() - LIMITS.GRADUATION.RECENCY_HALF_LIFE_DAYS * 24 * 3600 * 1000,
    ).toISOString();
    const fresh = candidateConfidence(record({ occurrences: 4 }), NOW);
    const stale = candidateConfidence(record({ occurrences: 4, lastSeen: halfLifeAgo }), NOW);
    expect(stale).toBeCloseTo(fresh / 2, 5);
  });

  it('subtracts a fixed penalty per contradiction and clamps to [0, 1]', () => {
    const base = candidateConfidence(record({ occurrences: 7 }), NOW);
    const one = candidateConfidence(record({ occurrences: 7, contradiction: 1 }), NOW);
    expect(base - one).toBeCloseTo(LIMITS.GRADUATION.CONTRADICTION_PENALTY, 5);
    expect(candidateConfidence(record({ occurrences: 1, contradiction: 9 }), NOW)).toBe(0);
  });

  it('treats the reserved null contradiction exactly like zero', () => {
    expect(candidateConfidence(record({ contradiction: null }), NOW)).toBe(
      candidateConfidence(record({ contradiction: 0 }), NOW),
    );
  });
});

describe('graduation and withdrawal thresholds', () => {
  it('a candidate crossing GRADUATE_MIN_CONFIDENCE is eligible; below it is not', () => {
    expect(isEligibleForGraduation(record({ occurrences: 2 }), NOW)).toBe(true);
    expect(isEligibleForGraduation(record({ occurrences: 1 }), NOW)).toBe(false);
  });

  it('only candidate-status records are eligible', () => {
    expect(isEligibleForGraduation(record({ occurrences: 5, status: 'graduated' }), NOW)).toBe(false);
    expect(isEligibleForGraduation(record({ occurrences: 5, status: 'withdrawn' }), NOW)).toBe(false);
  });

  it('withdrawal needs contradiction evidence: pure time decay never withdraws', () => {
    const monthsAgo = new Date(NOW.getTime() - 60 * 24 * 3600 * 1000).toISOString();
    const decayed = record({ occurrences: 2, status: 'graduated', lastSeen: monthsAgo });
    expect(candidateConfidence(decayed, NOW)).toBeLessThan(
      LIMITS.GRADUATION.WITHDRAW_BELOW_CONFIDENCE,
    );
    expect(isBelowWithdrawal(decayed, NOW)).toBe(false);
  });

  it('a weakly supported graduated entry withdraws on its first contradiction; a strong one survives', () => {
    const weak = record({ occurrences: 2, status: 'graduated', contradiction: 1 });
    const strong = record({ occurrences: 7, status: 'graduated', contradiction: 1 });
    expect(isBelowWithdrawal(weak, NOW)).toBe(true);
    expect(isBelowWithdrawal(strong, NOW)).toBe(false);
    expect(isBelowWithdrawal(record({ occurrences: 7, status: 'graduated', contradiction: 3 }), NOW)).toBe(true);
  });
});

describe('CandidateRecord graduation fields', () => {
  it('accepts extraction-era records: null contradiction, no status, no confidence', () => {
    const parsed = CandidateRecordSchema.parse({
      id: 'cand-old',
      type: 'error-fix',
      key: 'error-fix:build-log:sig',
      signature: 'sig',
      firstSeen: '2026-07-19T12:00:00.000Z',
      lastSeen: '2026-07-19T12:00:00.000Z',
      occurrences: 1,
      contradiction: null,
      details: {},
    });
    expect(parsed.status).toBe('candidate');
    expect(parsed.contradiction).toBeNull();
    expect(parsed.confidence).toBeUndefined();
  });

  it('round-trips graduated bookkeeping: status, contradiction count, confidence, timestamps', () => {
    const parsed = CandidateRecordSchema.parse(
      record({
        status: 'graduated',
        contradiction: 2,
        confidence: 0.41,
        graduatedAt: '2026-07-29T12:00:00.000Z',
      }),
    );
    expect(parsed.status).toBe('graduated');
    expect(parsed.contradiction).toBe(2);
    expect(parsed.confidence).toBeCloseTo(0.41);
    expect(parsed.graduatedAt).toBe('2026-07-29T12:00:00.000Z');
  });
});

describe('LIMITS.GRADUATION contract', () => {
  it('holds the documented formula constants and thresholds', () => {
    expect(LIMITS.GRADUATION.OCCURRENCE_HALF_SATURATION).toBe(2);
    expect(LIMITS.GRADUATION.RECENCY_HALF_LIFE_DAYS).toBe(14);
    expect(LIMITS.GRADUATION.CONTRADICTION_PENALTY).toBe(0.25);
    expect(LIMITS.GRADUATION.GRADUATE_MIN_CONFIDENCE).toBe(0.5);
    expect(LIMITS.GRADUATION.WITHDRAW_BELOW_CONFIDENCE).toBe(0.3);
    expect(LIMITS.GRADUATION.LEARNED_SECTION_MAX_TOKENS).toBeGreaterThan(0);
  });
});
