import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * The command allowlist for the pipe rewrite (v3 pillar A, component 2). Only
 * read-only, log-producing command shapes are rewritten to run through
 * redutok-pipe, which distills their output in place. The shipped defaults are
 * the documented YAML below; a repo overrides them by dropping a
 * pipe-allowlist.yaml into its .dcp directory. A malformed override falls back
 * to the shipped defaults rather than disabling the backstop.
 */

export const SHIPPED_ALLOWLIST_YAML = `# Redutok pipe allowlist (v3 pillar A). Command shapes matched by an \`allow\`
# rule are rewritten to run through redutok-pipe, which distills their output in
# place. A command matching any \`deny\` rule is never rewritten, even if it also
# matches an \`allow\` rule: deny is for side effects and for anything that runs
# more than the single read-only invocation (redirections, pipes, command
# chains, deletes, installs, VCS mutations). Patterns are JavaScript regular
# expressions, tested case-insensitively against the raw command string.
version: 1
# Prefix that invokes the pipe. The committed launcher resolves the installed
# package through the repo's dependency chain (REDUTOK_HOME override honored)
# and fails open by running the wrapped command raw — no PATH assumptions.
# The 2026-07-30 rep-1 run proved the old \`redutok-pipe\` bin form exits 127
# in any repo where the bin is not linked. Override per-repo via
# .dcp/pipe-allowlist.yaml if a different invocation is ever needed.
invoke: node .claude/redutok/pipe.mjs
allow:
  - rule: typecheck
    pattern: '\\btsc\\b'
  - rule: build
    pattern: '\\bbuild\\b'
  - rule: test
    pattern: '\\b(?:vitest|jest|pytest|mocha|ava|(?:pnpm|npm|yarn|bun)(?: run)? test)\\b'
  - rule: lint
    pattern: '\\b(?:eslint|tslint|(?:pnpm|npm|yarn|bun)(?: run)? lint)\\b'
  # Plain node invocations of test-or-verify-shaped scripts (s02 regression,
  # 2026-07-30 N=3): a repo's own \`node scripts/verify-*.mjs\` check is a
  # read-only, verdict-producing command exactly like a test runner, but no
  # runner name appears in it. The filename must start with verify, test, or
  # check so arbitrary node scripts (side-effectful by default) stay untouched.
  - rule: node-script
    pattern: '\\bnode\\s+(?:[\\w.\\\\/-]+[\\\\/])?(?:verify|test|check)[\\w.-]*\\.[cm]?js\\b'
deny:
  - rule: shell-composition
    pattern: '[><;|]|&&|\\|\\||\\$\\(|\\x60'
  - rule: mutation
    pattern: '\\b(?:rm|rmdir|mv|cp|del|erase|install|publish|push|commit|reset|clean|checkout|mkdir)\\b'
`;

export interface AllowlistRule {
  rule: string;
  pattern: string;
}

export interface PipeAllowlist {
  invoke: string;
  allow: AllowlistRule[];
  deny: AllowlistRule[];
}

function toRules(arr: unknown): AllowlistRule[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((r) => r as { rule?: unknown; pattern?: unknown })
    .filter(
      (r): r is AllowlistRule => typeof r.rule === 'string' && typeof r.pattern === 'string',
    );
}

/** Fallback invoke for an override that omits one: the same portable
 * launcher form the shipped list uses, never a PATH-dependent bin name. */
export const DEFAULT_PIPE_INVOKE = 'node .claude/redutok/pipe.mjs';

export function parseAllowlist(yamlText: string): PipeAllowlist {
  const doc = (parseYaml(yamlText) ?? {}) as { invoke?: unknown; allow?: unknown; deny?: unknown };
  const invoke = typeof doc.invoke === 'string' && doc.invoke !== '' ? doc.invoke : DEFAULT_PIPE_INVOKE;
  return { invoke, allow: toRules(doc.allow), deny: toRules(doc.deny) };
}

const SHIPPED = parseAllowlist(SHIPPED_ALLOWLIST_YAML);

/** Loads the per-repo override from .dcp/pipe-allowlist.yaml, else the shipped defaults. */
export function loadAllowlist(dcpDir: string): PipeAllowlist {
  const file = path.join(dcpDir, 'pipe-allowlist.yaml');
  if (!existsSync(file)) return SHIPPED;
  try {
    return parseAllowlist(readFileSync(file, 'utf8'));
  } catch {
    return SHIPPED;
  }
}

/** Single-quote a string for a POSIX shell so redutok-pipe receives it verbatim. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Single-quote for PowerShell, whose literal strings escape ' by doubling. */
export function shellQuotePowerShell(s: string): string {
  return `'${s.replace(/'/g, `''`)}'`;
}

/** The shell dialect the rewritten command will be parsed by; picks the
 * quoting only — allow and deny rules apply to the command string
 * identically (the rep-1 PowerShell escape ran the same verify script). */
export type RewriteShell = 'posix' | 'powershell';

export interface RewriteDecision {
  /** The matched allow-rule name, recorded in the audit trail. */
  rule: string;
  /** The command rewritten to run through the pipe. */
  command: string;
}

/**
 * A single leading `cd <dir> && ` prefix. Like the descriptor-merge masking
 * below, this is not composition in the deny rules' sense: it only positions
 * the one read-only invocation that follows, and the s02 bench sessions
 * (2026-07-30 N=3) showed models reaching for exactly this shape in temp
 * working copies. Only one prefix is recognized — a second `cd` or any other
 * chain segment in the tail still trips the shell-composition deny — and the
 * prefix stays outside the wrap so the pipe binary inherits the intended cwd.
 */
const CD_PREFIX = /^\s*cd\s+(?:"[^"]*"|'[^']*'|[^\s&|;<>"']+)\s*&&\s*/;

/**
 * Decides whether a Bash command should be rewritten through the pipe. Returns
 * undefined (leave untouched) when the command is already wrapped, matches a
 * deny rule (side effects / composition), or matches no allow rule.
 */
export function decideRewrite(
  command: string,
  allowlist: PipeAllowlist = SHIPPED,
  shell: RewriteShell = 'posix',
): RewriteDecision | undefined {
  // Never double-wrap: a command already routed through the pipe would recurse.
  if (command.includes('redutok-pipe') || command.includes(allowlist.invoke)) return undefined;
  const prefix = CD_PREFIX.exec(command)?.[0] ?? '';
  const tail = command.slice(prefix.length);
  // A descriptor merge (`2>&1`, `1>&2`, `>&2`) only re-routes stderr into the
  // same capture the pipe already reads; it is not a file redirect, pipe, or
  // chain, so it is masked before deny testing. Digits are required after the
  // `&` so a `>&file` redirect still trips the deny rule.
  const denyProbe = tail.replace(/\d*>&\d+/g, ' ');
  if (allowlist.deny.some((r) => new RegExp(r.pattern, 'i').test(denyProbe))) return undefined;
  const matched = allowlist.allow.find((r) => new RegExp(r.pattern, 'i').test(tail));
  if (matched === undefined) return undefined;
  const quote = shell === 'powershell' ? shellQuotePowerShell : shellQuote;
  return { rule: matched.rule, command: `${prefix}${allowlist.invoke} -c ${quote(tail)}` };
}
