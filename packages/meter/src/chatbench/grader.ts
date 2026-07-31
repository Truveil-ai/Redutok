import type { GraderResult, Question } from './types.js';

/**
 * needle-fraction grader. Each needle contributes equally to a per-question
 * score in [0, 1]; matching is case-insensitive substring on a whitespace-
 * normalised copy of the answer. `parity` is true when score >= parityFloor.
 */
export function scoreNeedle(_question: Question, _answer: string, _parityFloor: number): GraderResult {
  throw new Error('chatbench:scoreNeedle not implemented');
}
