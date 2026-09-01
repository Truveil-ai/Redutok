import type { GovernanceStatus } from './governance.js';
import { LIMITS } from './limits.js';

/**
 * Session posture, architecture-v2 pillar 4 (docs/POSTURE.md): governance
 * engages proportionally to what it can earn. The decision is pure rules over
 * a repo-size and artifact-weight assessment taken at SessionStart; the
 * thresholds are product tuning constants in LIMITS.POSTURE.
 */

export type SessionPosture = 'full' | 'light' | 'idle';

export interface PostureAssessment {
  /** Indexed file count when a codex exists, else the bounded-walk count. */
  files: number;
  /** Total source bytes from the bounded walk (indexable files only). */
  sourceBytes: number;
  learnedEntries: number;
  pitfallEntries: number;
  /** True when the walk stopped early because a full-posture threshold was already crossed. */
  capped: boolean;
}

export function decidePosture(a: PostureAssessment): SessionPosture {
  const P = LIMITS.POSTURE;
  if (a.files > P.LIGHT_MAX_FILES || a.sourceBytes > P.LIGHT_MAX_SOURCE_BYTES) return 'full';
  // Graduated or human-curated knowledge is cheap to inject and the product
  // of observed friction: its presence always keeps the session at least
  // light, so a tiny repo that has earned lessons still receives them.
  const hasKnowledge = a.learnedEntries + a.pitfallEntries > 0;
  if (!hasKnowledge && a.files <= P.IDLE_MAX_FILES && a.sourceBytes <= P.IDLE_MAX_SOURCE_BYTES) {
    return 'idle';
  }
  return 'light';
}

/** The record SessionStart persists to .dcp/session-posture.json for the
 * per-turn hooks and the Stop receipt. */
export interface SessionPostureRecord extends PostureAssessment {
  sessionId: string;
  posture: SessionPosture;
  /** True when .dcp/config.json pinned the posture, skipping assessment. */
  pinned: boolean;
  decidedAt: string;
  /**
   * Whether the sidecar was actually reachable when the session opened. The
   * posture record is already the session-level fact the Stop receipt reads,
   * so the governance condition rides with it rather than in a second file.
   * Absent on records written before this field existed; a reader must treat
   * absence as "unknown", never as "governance was on".
   */
  governance?: GovernanceStatus;
}
