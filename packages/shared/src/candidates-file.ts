import { existsSync, readFileSync } from 'node:fs';
import { CandidateRecordSchema, type CandidateRecord } from './schemas.js';

/**
 * Reader for .dcp/candidates.jsonl, the graduation miner's candidate store.
 * Lives in shared so the meter can render candidates without depending on the
 * sidecar package. Tolerant like the audit reader: malformed lines are
 * counted, not thrown.
 */

export interface CandidatesFileResult {
  records: CandidateRecord[];
  malformed: number;
  missing: boolean;
}

export function readCandidatesFile(filePath: string): CandidatesFileResult {
  if (!existsSync(filePath)) return { records: [], malformed: 0, missing: true };
  const records: CandidateRecord[] = [];
  let malformed = 0;
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (line.trim() === '') continue;
    try {
      records.push(CandidateRecordSchema.parse(JSON.parse(line)));
    } catch {
      malformed += 1;
    }
  }
  return { records, malformed, missing: false };
}
