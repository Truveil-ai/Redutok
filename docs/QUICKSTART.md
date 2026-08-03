# Quickstart: fresh machine to first graded session

The definition-of-done budget for this path is five minutes on a fresh
machine with node 20 or newer installed. Timings below are what each step
costs at most on an ordinary connection; they sum comfortably under the
budget.

1. Build Redutok (about two minutes, mostly the install):

       git clone https://github.com/Truveil-ai/Redutok
       cd Redutok
       pnpm install
       pnpm -r build

   The npm name carries a placeholder release, `redutok@0.0.1`, published to
   hold the name. The working build is `0.1.0` in this repository and is not
   published yet, so `npx redutok` fetches the placeholder rather than the
   tool. The package is packaging-ready (`files` whitelist, prepack gate,
   and a test that installs the packed tarballs into a temp directory).
   Until the release publish, invoke the CLI by path. Everything below
   writes `redutok` for
   `node <redutok>/packages/meter/dist/cli.js`.

2. Wire it into the repository you want to govern (seconds):

       redutok init /path/to/your-repo

   This writes hooks to `.claude/settings.local.json`, registers the MCP
   server in `.mcp.json`, appends the protocol block to CLAUDE.md, and
   scaffolds `.dcp/` with the committed launchers under `.claude/redutok/`.
   It is idempotent and preserves your own entries. Everything reverts
   byte-identical with `redutok remove`.

3. Start the sidecar and build the codex (about a minute):

       cd /path/to/your-repo
       redutok up
       redutok codex refresh

4. Check the installation (seconds):

       redutok doctor

   Ten checks, each pass, warn, or fail with a remedy. Warns are normal and
   not blockers: Ollama unreachable means semantic passes fall back to rules,
   and a stale codex means run the refresh above. Read the remedy column
   rather than the count.

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

       redutok report --last
       redutok badge --last

   The report shows tokens by class, estimated cost, energy as banded
   estimates, and the four scores with the A to F composite. The badge SVG
   carries the grade. `redutok candidates` shows what the session's miner
   learned, and `redutok audit <session-id>` renders the trail behind every
   figure.

For documents rather than code, see the Vault in
[../packages/vault/README.md](../packages/vault/README.md): ingest a folder,
mount it, and reach it from a chat client over MCP.

Redutok by Truveil.
