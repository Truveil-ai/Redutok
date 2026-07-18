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

4. Run a Claude Code session in the repo as usual. Large reads, builds, and
   searches now flow through the dcp tools; every compression is audited in
   .dcp/audit.jsonl with a zoom handle to recover raw.

5. Grade it (seconds):

       npx redutok report --last
       npx redutok badge --last

   The report shows tokens by class, estimated cost, energy as banded
   estimates, and the four scores with the A to F composite. The badge SVG
   carries the grade.

Redutok by Truveil.
