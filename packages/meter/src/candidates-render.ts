import path from 'node:path';
import { readCandidatesFile, type CandidatesFileResult } from '@redutok/shared';

/** Renderer for redutok candidates. Reads the graduation miner's candidates.jsonl. */

export function defaultCandidatesPath(cwd: string = process.cwd()): string {
  return path.join(cwd, '.dcp', 'candidates.jsonl');
}

export function buildCandidatesReport(filePath?: string): CandidatesFileResult {
  return readCandidatesFile(filePath ?? defaultCandidatesPath());
}

function age(iso: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / (24 * 60))}d`;
}

export function renderCandidatesText(result: CandidatesFileResult, now: Date = new Date()): string {
  if (result.missing || result.records.length === 0) {
    return 'No candidates mined yet. The graduation miner runs when a session ends (sidecar up).';
  }
  const observations = result.records.reduce((sum, r) => sum + r.occurrences, 0);
  const lines = [`Redutok candidates: ${result.records.length} candidates, ${observations} observations.`];
  const ranked = [...result.records].sort(
    (a, b) => b.occurrences - a.occurrences || b.lastSeen.localeCompare(a.lastSeen),
  );
  for (const r of ranked) {
    lines.push(
      `${r.type.padEnd(12)} x${String(r.occurrences).padEnd(3)} first seen ${age(r.firstSeen, now)} ago, last seen ${age(r.lastSeen, now)} ago  ${r.lesson ?? r.signature}`,
    );
  }
  if (result.malformed > 0) lines.push(`Malformed lines skipped: ${result.malformed}.`);
  return lines.join('\n');
}
