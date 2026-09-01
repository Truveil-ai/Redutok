# Running the redutok CLI

The CLI lives in the redutok package with bin names redutok and rtk.
Build first: pnpm install and pnpm -r build from the repo root.

Three ways to invoke it:

1. pnpm exec, from the repo root. The root workspace depends on
   redutok, so pnpm links the bin into node_modules/.bin:

       pnpm exec redutok --help
       pnpm exec redutok report --last

2. Root script, also from the repo root:

       pnpm redutok --help
       pnpm redutok status

3. Global link, to get a plain redutok on PATH everywhere:

       cd packages/meter
       pnpm link --global
       redutok --help

   The real package name is redutok; pnpm link --global registers its
   redutok and rtk bins. Windows note: pnpm creates .CMD shims in the pnpm
   global bin directory. Run pnpm setup once if that directory is not on
   PATH yet, then reopen the terminal. No admin rights are needed; the shims
   live under the user profile, not Program Files.

## One-time MCP server approval in Claude Code

redutok init registers the dcp MCP server in project-scope .mcp.json, and
Claude Code gates project-scope servers behind a one-time per-user approval:
the first session in the repo asks whether to use the servers from .mcp.json.
Until that approval is given (it is recorded in ~/.claude.json under the
project's enabledMcpjsonServers), the dcp__read/run/search/zoom/state tools
never appear and sessions run vanilla, even with the sidecar up and hooks
registered. If the prompt was missed or declined, run
`claude mcp reset-project-choices` inside the repo to be prompted again, and
verify with `claude mcp list`. `redutok doctor` surfaces this state as the
mcp-approval check; the companion mcp-launcher check catches the other
silent-failure mode, a launcher that cannot resolve the installed packages.

## How you know governance is actually on

Every hook fails open: when the sidecar is unreachable the hooks answer allow,
nothing is rewritten, and the session runs vanilla. That is deliberate, and it
used to be silent. A 392-turn field session ran entirely ungoverned because
the sidecar had died and left its pidfile behind, and nothing said so until
redutok doctor was run afterwards.

SessionStart now classifies the condition once and, when governance is off,
leads the injected context with a single line naming the cause and the
remedy. The conditions it distinguishes are: no pidfile (a sidecar was never
started here), a stale pidfile (one whose process no longer exists, so the
sidecar crashed), unreachable (the process is alive but its health probe
timed out), and a foreign daemon (the port is held by a daemon serving a
different repository). The condition is written into
.dcp/session-posture.json, and the Stop receipt reads it back so a session
that governed nothing names the dead sidecar as the reason rather than
leaving "nothing was governed this session" to be read as "nothing needed
governing".

A stale pidfile is the one condition that is unambiguously a crash, so
SessionStart attempts a single automatic restart for it and reports the
outcome in the same line. The attempt is claimed in .dcp/sidecar-restart.json
and keyed to the dead pid and port, so a daemon that dies during startup
cannot drive a restart loop and reopening a session against the same corpse
spawns nothing. The other conditions are left alone: nothing starts a sidecar
in a repository where you never asked for one, nothing spawns a rival against
a process that is still alive, and another repository's daemon is not ours to
restart. Those cases print the remedy and you run it.

## Where redutok init writes its entries, and why

Hook entries go to .claude/settings.local.json, not settings.json. Claude
Code treats settings.local.json as personal, untracked configuration, so a
shared team repository is never contaminated by another developer's tooling
choices; each developer opts in by running redutok init once. The entries and
the committed launcher scripts under .claude/redutok/ contain no absolute
paths: launchers resolve the installed packages at runtime through the
repository's own dependency chain (repo, then redutok, then the hooks
or mcp package), with the REDUTOK_HOME environment variable as an override
for global installs. Hook launchers fail open (exit 0) when resolution fails,
so a clone without the packages installed loses nothing but the savings.
.mcp.json and the CLAUDE.md protocol block are portable and safe to commit.
This repository dogfoods its own install, so its managed files are committed;
settings.local.json here predates the convention and stays tracked.
Per-machine runtime state (port, resolved profiles directory, pidfile, store,
audit log) lives in .dcp/, which is gitignored, with two exceptions:
.dcp/codex.yaml and .dcp/codex.lock are committed. The codex is team-shared
understanding of the repository and travels with it, so every clone cold
starts with the same verified map; per-machine state never does. The
.gitignore pattern is .dcp/* with explicit negations for those two files.
