import { describe, expect, it } from 'vitest';
import { scoreNeedle } from '../../src/chatbench/index.js';
import type { Question } from '../../src/chatbench/index.js';

const q: Question = {
  id: 'q1',
  category: 'single-doc-lookup',
  prompt: 'anything',
  needles: ['1.5', 'month'],
};

describe('scoreNeedle', () => {
  it('scores fraction of needles matched', () => {
    const r = scoreNeedle(q, 'The rate is 1.5% per month, per policy.', 0.75);
    expect(r.score).toBe(1);
    expect(r.matched).toEqual(['1.5', 'month']);
    expect(r.missed).toEqual([]);
    expect(r.parity).toBe(true);
  });

  it('is case-insensitive on the needle side', () => {
    const q2: Question = { ...q, needles: ['CANCELED', 'Cancel/CanceledError'] };
    const r = scoreNeedle(q2, 'axios throws canceledError from lib/cancel/canceledError.js', 0.75);
    expect(r.score).toBe(1);
  });

  it('normalises whitespace runs so line-wrapped text still matches', () => {
    const q3: Question = { ...q, needles: ['section 4'] };
    const r = scoreNeedle(q3, 'It cites Section\n\n    4  of the letter.', 0.75);
    expect(r.matched).toEqual(['section 4']);
  });

  it('flags parity=false below the floor', () => {
    const r = scoreNeedle(q, 'no relevant tokens here', 0.75);
    expect(r.score).toBe(0);
    expect(r.parity).toBe(false);
  });

  it('half score with one of two needles matched', () => {
    const r = scoreNeedle(q, 'the interest is 1.5% but the period is unspecified', 0.75);
    expect(r.score).toBe(0.5);
    expect(r.matched).toEqual(['1.5']);
    expect(r.missed).toEqual(['month']);
    expect(r.parity).toBe(false);
  });
});
