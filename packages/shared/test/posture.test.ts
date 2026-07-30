import { describe, expect, it } from 'vitest';
import { LIMITS } from '../src/limits.js';
import { decidePosture, type PostureAssessment } from '../src/posture.js';

const base: PostureAssessment = {
  files: 0,
  sourceBytes: 0,
  learnedEntries: 0,
  pitfallEntries: 0,
  capped: false,
};

describe('decidePosture (docs/POSTURE.md)', () => {
  it('a tiny repo with no graduated knowledge idles', () => {
    expect(decidePosture({ ...base, files: 3, sourceBytes: 2_000 })).toBe('idle');
  });

  it('the idle bounds are inclusive', () => {
    expect(
      decidePosture({
        ...base,
        files: LIMITS.POSTURE.IDLE_MAX_FILES,
        sourceBytes: LIMITS.POSTURE.IDLE_MAX_SOURCE_BYTES,
      }),
    ).toBe('idle');
  });

  it('graduated knowledge lifts a tiny repo to light: earned lessons are always served', () => {
    expect(decidePosture({ ...base, files: 3, sourceBytes: 2_000, learnedEntries: 1 })).toBe('light');
    expect(decidePosture({ ...base, files: 3, sourceBytes: 2_000, pitfallEntries: 1 })).toBe('light');
  });

  it('a mid-size repo runs light', () => {
    expect(decidePosture({ ...base, files: 60, sourceBytes: 500_000 })).toBe('light');
  });

  it('crossing either full threshold engages full governance', () => {
    expect(decidePosture({ ...base, files: LIMITS.POSTURE.LIGHT_MAX_FILES + 1, sourceBytes: 10 })).toBe(
      'full',
    );
    expect(
      decidePosture({ ...base, files: 2, sourceBytes: LIMITS.POSTURE.LIGHT_MAX_SOURCE_BYTES + 1 }),
    ).toBe('full');
  });

  it('graduated knowledge never downgrades a full repo', () => {
    expect(
      decidePosture({ ...base, files: 200, sourceBytes: 5_000_000, learnedEntries: 19 }),
    ).toBe('full');
  });
});
