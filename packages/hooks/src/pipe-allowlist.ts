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
# Prefix that invokes the pipe binary. Override per-repo when the bin is not on
# PATH for the tool shell, e.g. invoke: pnpm exec redutok-pipe
invoke: redutok-pipe
allow:
  - rule: typecheck
    pattern: '\\btsc\\b'
  - rule: build
    pattern: '\\bbuild\\b'
  - rule: test
    pattern: '\\b(?:vitest|jest|pytest|mocha|ava|(?:pnpm|npm|yarn|bun)(?: run)? test)\\b'
  - rule: lint
    pattern: '\\b(?:eslint|tslint|(?:pnpm|npm|yarn|bun)(?: run)? lint)\\b'
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

export function parseAllowlist(yamlText: string): PipeAllowlist {
  const doc = (parseYaml(yamlText) ?? {}) as { invoke?: unknown; allow?: unknown; deny?: unknown };
  const invoke = typeof doc.invoke === 'string' && doc.invoke !== '' ? doc.invoke : 'redutok-pipe';
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

export interface RewriteDecision {
  /** The matched allow-rule name, recorded in the audit trail. */
  rule: string;
  /** The command rewritten to run through the pipe. */
  command: string;
}

/**
 * Decides whether a Bash command should be rewritten through the pipe. Returns
 * undefined (leave untouched) when the command is already wrapped, matches a
 * deny rule (side effects / composition), or matches no allow rule.
 */
export function decideRewrite(
  command: string,
  allowlist: PipeAllowlist = SHIPPED,
): RewriteDecision | undefined {
  // Never double-wrap: a command already routed through the pipe would recurse.
  if (command.includes('redutok-pipe') || command.includes(allowlist.invoke)) return undefined;
  // A descriptor merge (`2>&1`, `1>&2`, `>&2`) only re-routes stderr into the
  // same capture the pipe already reads; it is not a file redirect, pipe, or
  // chain, so it is masked before deny testing. Digits are required after the
  // `&` so a `>&file` redirect still trips the deny rule.
  const denyProbe = command.replace(/\d*>&\d+/g, ' ');
  if (allowlist.deny.some((r) => new RegExp(r.pattern, 'i').test(denyProbe))) return undefined;
  const matched = allowlist.allow.find((r) => new RegExp(r.pattern, 'i').test(command));
  if (matched === undefined) return undefined;
  return { rule: matched.rule, command: `${allowlist.invoke} -c ${shellQuote(command)}` };
}
