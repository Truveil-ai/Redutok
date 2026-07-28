import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  decidePosture,
  type PostureAssessment,
  type SessionPosture,
  LIMITS,
} from '@redutok/shared';
import { INDEXABLE_EXT, INDEX_SKIP_DIRS, readCodex } from './codex.js';

/**
 * SessionStart posture assessment, architecture-v2 pillar 4
 * (docs/POSTURE.md). The walk is bounded by construction: it stops as soon
 * as either full-posture threshold is crossed, so the cost is O(threshold),
 * never O(repo). An operator can pin the posture in .dcp/config.json
 * ({"posture": "full" | "light" | "idle"}), which skips assessment entirely.
 */

export interface PostureDecision {
  posture: SessionPosture;
  assessment: PostureAssessment;
  /** True when .dcp/config.json pinned the posture. */
  pinned: boolean;
}

function pinnedPosture(dcpDir: string): SessionPosture | undefined {
  const configPath = path.join(dcpDir, 'config.json');
  if (!existsSync(configPath)) return undefined;
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as { posture?: unknown };
    return config.posture === 'full' || config.posture === 'light' || config.posture === 'idle'
      ? config.posture
      : undefined;
  } catch {
    return undefined;
  }
}

/** Directory-visit ceiling: past this the walk gives up and the session
 * engages full governance rather than spend SessionStart time crawling. */
const WALK_DIR_CAP = 2_000;

/** Counts indexable source files and bytes, stopping early once a
 * full-posture threshold is crossed. Unreadable entries are skipped: the
 * assessment must never throw a session off the rails. */
function boundedWalk(root: string): {
  files: number;
  sourceBytes: number;
  capped: boolean;
  aborted: boolean;
} {
  const P = LIMITS.POSTURE;
  let files = 0;
  let sourceBytes = 0;
  let capped = false;
  let dirs = 0;
  const walk = (dir: string): void => {
    if (capped) return;
    dirs += 1;
    if (dirs > WALK_DIR_CAP) {
      capped = true;
      return;
    }
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (capped) return;
      if (INDEX_SKIP_DIRS.has(name)) continue;
      const full = path.join(dir, name);
      try {
        const stats = statSync(full);
        if (stats.isDirectory()) walk(full);
        else if (INDEXABLE_EXT.has(path.extname(name)) && stats.size < 1_000_000) {
          files += 1;
          sourceBytes += stats.size;
          if (files > P.LIGHT_MAX_FILES || sourceBytes > P.LIGHT_MAX_SOURCE_BYTES) capped = true;
        }
      } catch {
        // Skip entries that vanish or refuse a stat mid-walk.
      }
    }
  };
  walk(root);
  return { files, sourceBytes, capped, aborted: dirs > WALK_DIR_CAP };
}

export function assessSessionPosture(root: string, dcpDir?: string): PostureDecision {
  const empty: PostureAssessment = {
    files: 0,
    sourceBytes: 0,
    learnedEntries: 0,
    pitfallEntries: 0,
    capped: false,
  };
  const pinned = pinnedPosture(dcpDir ?? path.join(root, '.dcp'));
  if (pinned !== undefined) return { posture: pinned, assessment: empty, pinned: true };

  let learnedEntries = 0;
  let pitfallEntries = 0;
  let indexedFiles: number | undefined;
  try {
    const { codex } = readCodex(root);
    if (codex !== undefined) {
      learnedEntries = codex.learned.length;
      pitfallEntries = codex.pitfalls.length;
      if (codex.files.length > 0) indexedFiles = codex.files.length;
    }
  } catch {
    // An unreadable codex never blocks the session; the walk stands alone.
  }
  const walked = boundedWalk(root);
  const assessment: PostureAssessment = {
    // The indexed count is the primary signal when a codex exists; the
    // bounded walk may have stopped early and undercounted.
    files: Math.max(indexedFiles ?? 0, walked.files),
    sourceBytes: walked.sourceBytes,
    learnedEntries,
    pitfallEntries,
    capped: walked.capped,
  };
  // A walk that gave up (pathological directory count) engages full
  // governance: the fail-open direction is never a wrongly idle session.
  const posture = walked.aborted ? 'full' : decidePosture(assessment);
  return { posture, assessment, pinned: false };
}
