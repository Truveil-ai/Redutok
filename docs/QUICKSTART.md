# Quickstart: fresh machine to first graded session

The definition-of-done budget for this path is five minutes on a fresh
machine with node 20 or newer installed. Timings below are what each step
costs at most on an ordinary connection; they sum comfortably under the
budget.

1. Install Redutok into the repository you want to govern (about a minute):

       cd /path/to/your-repo
       npm install --save-dev redutok

   Into the project, not globally and not through `npx` alone. The hooks and
   the MCP server run from small generated launchers under `.claude/redutok/`,
   and those resolve redutok from this project's own `node_modules` every
   time they fire. `npx` executes from a temporary cache that is never part of
   the project, so a bare `npx redutok init` would write launchers that cannot
   find the package: the MCP server dies at startup and every hook silently
   no-ops. Step 2 refuses rather than let that happen. If the install has to
   live elsewhere, point `REDUTOK_HOME` at the directory holding it.

2. Wire it in (seconds):

       npx redutok init .

   This writes hooks to `.claude/settings.local.json`, registers the MCP
   server in `.mcp.json`, appends the protocol block to CLAUDE.md, and
   scaffolds `.dcp/` with the committed launchers under `.claude/redutok/`.
   It is idempotent and preserves your own entries. Everything reverts
   byte-identical with `npx redutok remove`.

3. Start the sidecar and build the codex (about a minute):

       npx redutok up
       npx redutok codex refresh

4. Check the installation (seconds):

       npx redutok doctor

   Ten checks, each pass, warn, or fail with a remedy. Warns are normal and
   not blockers: Ollama unreachable means semantic passes fall back to rules,
   and a stale codex means run the refresh above. Read the remedy column
   rather than the count.

   Any `fail` means the setup will not work, and `hooks` and `mcp-launcher`
   are the two to read first: both run the same resolution the launchers do,
   so they are what tells you the difference between a working install and a
   well-formed but inert one. `npm install --save-dev redutok` is the remedy
   when either reports that the launcher cannot resolve the package.

5. Approve the MCP server, once (seconds, easy to miss):

   The first Claude Code session in the repository prompts about the
   project-scope MCP server found in `.mcp.json`. Approve it. This is a
   one-time, per-user, per-repository choice; until it is made the dcp tools
   are absent. If the prompt never appeared or was declined, run
   `claude mcp reset-project-choices` inside the repository to be asked
   again, and `claude mcp list` to confirm the server is connected.
   `redutok doctor` reports this exact condition as `mcp-approval` with the
   same remedy.

6. Run a Claude Code session in the repository as usual.

   You do not call anything. A large Read is answered with a skeleton
   through that same Read, so it never costs an extra turn; build, test, and
   lint output is distilled in place and ends with a zoom handle; the dcp
   tools remain available for multi-file exploration and for recovering raw.
   Every compression is written to `.dcp/audit.jsonl` with a handle that
   recovers the original byte for byte.

   One expected case: a small repository engages the idle posture and runs
   effectively vanilla by design, so a first session on a tiny project shows
   little or nothing. See [POSTURE.md](POSTURE.md) for the thresholds.

7. Grade it (seconds):

       npx redutok report --last
       npx redutok badge --last

   The report shows tokens by class, estimated cost, energy as banded
   estimates, and the four scores with the A to F composite. The badge SVG
   carries the grade. `npx redutok candidates` shows what the session's miner
   learned, and `npx redutok audit <session-id>` renders the trail behind
   every figure.

For documents rather than code, see the Vault in
[../packages/vault/README.md](../packages/vault/README.md): ingest a folder,
mount it, and reach it from a chat client over MCP.

Redutok by Truveil.
