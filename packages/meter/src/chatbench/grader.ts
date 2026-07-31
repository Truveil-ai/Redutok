import type { GraderResult, Question } from './types.js';

/**
 * needle-fraction grader. Each needle contributes equally to a per-question
 * score in [0, 1]; matching is case-insensitive substring on a whitespace-
 * normalised copy of the answer. `parity` is true when score >= parityFloor.
 */
export function scoreNeedle(question: Question, answer: string, parityFloor: number): GraderResult {
  const normAnswer = normalise(answer);
  const matched: string[] = [];
  const missed: string[] = [];
  for (const n of question.needles) {
    if (normAnswer.includes(normalise(n))) matched.push(n);
    else missed.push(n);
  }
  const score = question.needles.length === 0 ? 0 : matched.length / question.needles.length;
  return { score, matched, missed, parity: score >= parityFloor };
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}
