# Quickstart: fresh machine to first graded session

The definition-of-done budget for this path is five minutes on a fresh
machine with node 20+ installed. Timings below are what each step costs at
most on an ordinary connection; they sum comfortably under the budget.

1. Install and wire into your repo (about two minutes, mostly npm):

       cd your-repo
       npx redutok init

   This writes hooks to .claude/settings.local.json, registers the MCP
   server in .mcp.json, appends the protocol block to CLAUDE.md, and
   scaffolds .dcp/. Everything reverts byte-identical with npx redutok
   remove.

2. Start the sidecar and build the codex (about a minute):

       npx redutok up
       npx redutok codex refresh

3. Check the installation (seconds):

       npx redutok doctor

   Expect passes everywhere, a warn for Ollama if you have not installed it
   (rule-based distillation works without it), and remedies on any warn.

4. Approve the MCP server, once (seconds, easy to miss):

   The first Claude Code session in the repo prompts about the project-scope
   MCP server found in .mcp.json. Approve it. This is a one-time, per-user,
   per-repo choice; until it is made the dcp tools are absent and every
   session silently runs vanilla. If the prompt never appeared or was
   declined, run `claude mcp reset-project-choices` inside the repo to be
   asked again, and `claude mcp list` to confirm the redutok server is
   connected. `npx redutok doctor` warns on this exact condition
   (mcp-approval) with the same remedy.

5. Run a Claude Code session in the repo as usual. Large reads, builds, and
   searches now flow through the dcp tools; every compression is audited in
   .dcp/audit.jsonl with a zoom handle to recover raw.

6. Grade it (seconds):

       npx redutok report --last
       npx redutok badge --last

   The report shows tokens by class, estimated cost, energy as banded
   estimates, and the four scores with the A to F composite. The badge SVG
   carries the grade.

Redutok by Truveil.
