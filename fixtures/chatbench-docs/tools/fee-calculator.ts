/**
 * Installment schedule for a fixed-fee engagement: the code half of the
 * mixed doc-corpus fixture, so ingestion exercises the source path (codex,
 * skeleton mirror) alongside the document extractors.
 */

export interface Installment {
  month: number;
  amountUsd: number;
}

/** Split a fixed fee into equal monthly installments, remainder on the last. */
export function installmentSchedule(totalUsd: number, months: number): Installment[] {
  if (months < 1) throw new Error('at least one installment month is required');
  const base = Math.floor((totalUsd / months) * 100) / 100;
  const schedule: Installment[] = [];
  for (let month = 1; month <= months; month += 1) {
    schedule.push({ month, amountUsd: base });
  }
  const last = schedule[schedule.length - 1];
  if (last !== undefined) {
    last.amountUsd = Math.round((totalUsd - base * (months - 1)) * 100) / 100;
  }
  return schedule;
}

/** Late-payment interest at the Billing Policy rate of 1.5% per month. */
export function lateInterest(balanceUsd: number, monthsLate: number): number {
  return Math.round(balanceUsd * 0.015 * monthsLate * 100) / 100;
}
