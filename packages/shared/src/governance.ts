/**
 * Whether governance is actually engaged, and the words for saying so.
 *
 * Fail-open is the law (docs/POSTURE.md): a dead sidecar means every hook
 * answers allow and the session runs vanilla. Fail-open must not mean
 * fail-silent. A 392-turn field session ran entirely ungoverned because the
 * sidecar had died and left its pidfile behind; nothing said so until doctor
 * was run afterwards. The condition is classified once at SessionStart, said
 * once in the injected context, and recorded so the receipt can name it as
 * the reason nothing was governed.
 *
 * The wording lives here, in one place, because two surfaces say it: the
 * SessionStart notice and the Stop receipt must not disagree about why.
 */

export type GovernanceCondition =
  /** The sidecar answered /health for this repo. */
  | 'ok'
  /** No pidfile at all: the sidecar was never started for this repo. */
  | 'no-pidfile'
  /** A pidfile names a pid that no longer exists: the sidecar died. */
  | 'stale-pidfile'
  /** The pid is alive but /health did not answer: hung, or wrong port. */
  | 'unreachable'
  /** Healthy, but serving a different repo root (a shared default port). */
  | 'foreign-daemon';

/** What SessionStart did about a stale pidfile. */
export type RestartOutcome =
  /** Spawned, and the sidecar came up healthy for this repo. */
  | 'succeeded'
  /** Spawned, and it did not become healthy within the wait budget. */
  | 'failed'
  /** Not attempted: this exact stale pidfile was already tried once. */
  | 'skipped';

export interface GovernanceStatus {
  condition: GovernanceCondition;
  /** True only when the sidecar is answering for this repo. */
  active: boolean;
  /** The bare cause, no remedy attached: the receipt reuses it verbatim. */
  detail: string;
  /** Present only when a stale pidfile prompted an auto-restart. */
  restart?: RestartOutcome;
}

export interface ConditionFacts {
  pid?: number;
  port?: number;
  /** The repo root a foreign daemon reported serving. */
  foreignRoot?: string;
}

/** The cause in one clause, with the evidence that identified it. */
export function describeCondition(
  condition: GovernanceCondition,
  facts: ConditionFacts = {},
): string {
  const pid = facts.pid ?? 0;
  const port = facts.port ?? 0;
  switch (condition) {
    case 'ok':
      return `the sidecar is running on port ${port}`;
    case 'no-pidfile':
      return 'the sidecar was never started for this repo (no pidfile in .dcp)';
    case 'stale-pidfile':
      return `the sidecar died and left a stale pidfile behind (pid ${pid} no longer exists)`;
    case 'unreachable':
      return `the sidecar did not answer on port ${port} (pid ${pid} is alive but its health probe timed out)`;
    case 'foreign-daemon':
      return `port ${port} is held by a daemon serving a different repo (${facts.foreignRoot ?? 'unknown'})`;
  }
}

/** The remedy, per condition: what the user types to get governance back. */
function remedyFor(condition: GovernanceCondition): string {
  return condition === 'unreachable' ? 'redutok down, then redutok up' : 'redutok up';
}

/**
 * The single line SessionStart injects. Undefined when governance is engaged
 * and nothing happened worth reporting: a working session pays no tokens for
 * this. A successful auto-restart still says one line, because the user
 * should learn their sidecar had died even though it is running again.
 */
export function governanceNotice(status: GovernanceStatus): string | undefined {
  if (status.active) {
    if (status.restart !== 'succeeded') return undefined;
    return `Redutok: the sidecar had died (${status.detail}); it was restarted automatically and governance is active for this session. Redutok by Truveil`;
  }
  const attempted =
    status.restart === 'failed'
      ? ' An automatic restart was attempted and it did not come up.'
      : status.restart === 'skipped'
        ? ' An automatic restart was already attempted once for this pidfile and is not retried.'
        : '';
  return `Redutok governance is OFF for this session: ${status.detail}. Nothing will be distilled, rewritten, or governed until it is running — every read and command passes through raw.${attempted} Restart it with: ${remedyFor(status.condition)}. Redutok by Truveil`;
}

/**
 * The reason line for the Stop receipt: why the session governed nothing.
 * Undefined when governance was engaged, so a governed-but-empty session
 * keeps its own existing explanation.
 */
export function governanceReceiptReason(status: GovernanceStatus): string | undefined {
  if (status.active) return undefined;
  return `governance was off for the whole session: ${status.detail}`;
}
