Delta Context Protocol (DCP)
Architecture Blueprint v1.0 — Open Source Release for Claude Code
Tagline: Send the diff, not the world.
Mission: Cut agentic AI token consumption by 10 to 100x, and prove the energy saved, with a fully auditable, local-first, open-source layer for Claude Code.
Product: Redutok by Truveil
License: MIT
1. Design Principles

1. Never re-send what the model already understands. Understanding is persisted, versioned, and referenced. Context is a workspace, not a transcript.
2. Local watts before datacenter watts. Every token that can be processed by a small local model must never reach frontier-scale attention. Edge preprocessing is structurally greener because attention cost scales superlinearly with context length.
3. Governed compression, never blind compression. Every distillation decision is logged with inputs, outputs, ratios, and quality-gate results. There is always a zoom-in escape hatch. Compression without provenance is a liability; compression with an audit trail is a feature.
4. Zero position in the request path for v1. No proxy, no API keys held, no man-in-the-middle. Everything runs through Claude Code's official extension surfaces: hooks, MCP tools, and CLAUDE.md. If the sidecar dies mid-session, the session continues at full uncompressed fidelity.
5. Graceful degradation. Every layer works without the layer below it. No Ollama installed: rule-based distillation still delivers savings. No codex yet: sessions still meter and distill.
6. Claims are reproducible or they are not made. The benchmark harness ships in the repo. Headline: 10 to 30x typical, past 100x on context-heavy sessions. Never an unqualified 100x.

2. System Overview
Five deliverable components, one install:
ComponentFormRolesidecarLocal daemon (Node/TypeScript)Runs L1-L3 engines, state store, audit log, Ollama clientmcpMCP server (stdio, bundled in sidecar)Exposes codex-aware tools to Claude CodehooksHook pack (settings.json + scripts)Intercepts lifecycle events; enforces the protocolprotocolCLAUDE.md block + output schemasTeaches the model the L3/L4 rulesmeterCLIMeasures, grades, badges, benchmarks (before/after proof)
Data flow: Claude Code session connects to the sidecar via hooks (SessionStart, PreToolUse, PostToolUse, PreCompact, Stop, SessionEnd) and MCP tools (dcp__read, dcp__run, dcp__search, dcp__zoom, dcp__state). The sidecar contains four engines (Codex L1, Distiller L2, Delta L3, Meter and Green Ledger) backed by a SQLite state store and an append-only audit log, with an Ollama client for local-model passes and a rule engine as the no-LLM fallback. The meter CLI reads local JSONL session logs plus prices and energy factors to produce session reports, grades, SVG badges, and benchmark results.
Install: `npx redutok init` inside a repo. It writes `.claude/settings.json` hook entries, registers the MCP server, appends the protocol block to CLAUDE.md, builds the initial codex, and starts the sidecar on demand.
3. Layer 1 — The Codebase Codex
Problem it kills: cold-start exploration. A fresh session burns 50k-150k tokens rediscovering the repository. The codex replaces that with a 1.5k-3k token load.
3.1 Codex artifact
`.dcp/codex.yaml`, versioned, committed to git (team-shared understanding), plus `.dcp/codex.lock` (content hashes per file for delta detection).
Schema (v1) sections: codex_version, generated timestamp, repo_fingerprint (merkle root of tracked files), summary (one paragraph), architecture (list of id + decision + rationale), map (path + role + key_symbols per directory), conventions (list of strings), pitfalls (list of strings), interfaces (symbol + file + signature + contract), glossary (term + means), and files (generated hash-indexed list: id like F0142, path, sha256 hash, skeleton_tokens count; this section enables the delta protocol and stays sidecar-side, never injected).
3.2 Generation pipeline

1. Structural pass (no LLM): tree-sitter AST walk produces the file map, symbol index, signatures, import graph. Deterministic, fast, language-plugin based (TS/JS and Python first).
2. Semantic pass (local LLM): the sidecar feeds each module's skeleton to the local model to draft role, conventions, pitfalls, summary. Chunked, bounded, offline.
3. Frontier polish (optional, one-time, user-approved): a single Claude call to refine the semantic layer. Cost disclosed up front, off by default.
4. Human layer: architecture, glossary, and pitfalls accept hand-written entries marked locked: true that generation never overwrites.

3.3 Incremental maintenance
PostToolUse(Edit|Write) hook notifies the sidecar; changed files are re-skeletonized and re-hashed asynchronously. Optional git hook refreshes on branch switch. Semantic entries refresh lazily, only when a file's structural hash drift exceeds a threshold. The codex is an appreciating asset: every session makes the next one cheaper.
3.4 Injection
SessionStart hook loads codex.yaml (minus the files index) into context, prefixed: "You have a verified codex of this repository. Trust it. Do not re-explore structure that the codex covers. Use dcp tools to read code."
4. Layer 2 — Local Distillation Sidecar
Problem it kills: tool-output bloat, typically 60-70% of session tokens.
4.1 Interception mechanics
Two complementary paths, both using official surfaces:
Path A, MCP-first (primary). The protocol block instructs Claude to use dcp__read, dcp__run, dcp__search instead of raw Read/Bash/Grep for anything potentially large. These tools return distilled artifacts by design.
Path B, hook enforcement (backstop). A PreToolUse hook on Read|Bash|Grep|Glob estimates the output size of the pending call (file size on disk; command classified by a rule table); small and safe passes untouched; large is redirected via updatedInput (PreToolUse's official input-rewrite field) to the equivalent dcp tool, or blocked with exit code 2 and a stderr message telling the model exactly which dcp tool to call instead. The model always knows it received a distilled artifact; nothing is silently altered.
4.2 Distillation routing table
Every artifact is classified and routed to a profile:
Artifact classProfile outputTarget ratioBuild/compile logVERDICT: status, first error, file:line, one-line cause30-80xTest outputVERDICT + failing test names + assertion diffs only20-60xSource file readSKELETON: signatures + docstrings + target symbol in full5-20xDiff/patchRaw below threshold (already dense); summarized above1-3xSearch resultsRanked hits, path:line + 1-line context, cap N5-15xDirectory listingCodex-aware: only entries absent from codex map10-40xPackage/registry outputVersions + resolution result only20-50xGeneric stdoutHead/tail + local-model summary of middle5-15x
Each profile is a small yaml spec in profiles/: deterministic extraction rules first, then an optional local-model pass with a per-class prompt, then quality gates.
4.3 Quality gates
A distilled artifact is emitted only if all gates pass, else the raw artifact (or a lighter profile) is served:

1. Entity preservation: every file path, line number, symbol name, version string, and numeric literal in the conclusion-relevant region of the raw artifact must appear verbatim in the distillate, checked deterministically by extraction-set comparison, never by the LLM.
2. Verdict fidelity: for logs and tests, pass/fail status is extracted twice (regex and LLM) and must agree.
3. Size sanity: distillate must be at most 40% of raw; if not, serve raw.
4. Latency budget: local model hard timeout (default 2500ms); on timeout, rule-engine output ships instead. The session never waits on the sidecar.

4.4 The escape hatch (zoom-in)
Every distilled artifact carries a handle of the form: [dcp:artifact aX7f, raw 14213 tok to 96 tok, zoom: dcp__zoom("aX7f", query?)]. dcp__zoom returns the raw artifact or a query-focused slice. The model is instructed: if the distillate lacks the detail you need, zoom before guessing. Raw artifacts are retained for the session in the state store, so zooming never re-executes anything.
4.5 Security posture
The distiller runs a redaction pass (keys, tokens, .env patterns) before anything is stored; raw retention of redacted spans is opt-in. A PreToolUse deny-list for sensitive paths ships as a default. Everything is local; nothing leaves the machine except what Claude Code itself sends.
5. Layer 3 — Delta Context Protocol
Problem it kills: replay. History and unchanged files re-sent every turn.

1. Stable references. Files are addressed by codex ID + hash (F0142@a3b1). A file already served this session is never re-served; a changed file is served as a unified diff against the last served hash. The sidecar tracks per-session served-state in the state store.
2. Rolling state summary. The sidecar maintains session_state.md (600 tokens max): task, decisions taken, files touched, open questions, current plan step. Updated by the local model after significant turns, triggered by PostToolUse and Stop hooks. Rule fallback: last-actions list.
3. Compaction alliance. PreCompact hook injects the rolling state + codex reference into the compaction so native auto-compaction preserves DCP state; on resume, SessionStart(source=compact) re-injects the protocol block. DCP feeds the native compactor, never fights it.
4. Session splitting advisor. The meter watches marginal cost per turn; when context bloat makes turns expensive, it suggests: "Split point detected. redutok handoff will open a fresh session pre-loaded with codex + state instead of carrying the full transcript." The handoff command writes the handoff file and prints the resume command.

Working-set model: the context window is treated as [codex] + [rolling state] + [active working set, full-fidelity code being edited] + [distilled periphery]. The sidecar keeps the working set small and everything else referential.
6. Layer 4 — Output Discipline
Problem it kills: the expensive side. Output tokens price at 4-8x input; uncapped extended thinking multiplies it.

1. Diff-only edits. Protocol block + Stop hook check: full-file rewrites above a size threshold are flagged back to the model via exit-code-2 feedback ("emit a patch instead").
2. Structured verdicts. For analysis and review tasks, the protocol requests fixed schemas (finding, location, severity, fix) instead of essay prose.
3. Thinking budget classifier. UserPromptSubmit hook: a rules-first (local-model optional) classifier tags the prompt trivial, standard, or hard and injects an advisory budget hint. Advisory in v1; the meter measures adherence so data justifies stronger enforcement later.
4. Verbosity governor. Protocol sets response conventions (no restating file contents, no narrating tool calls). The meter scores adherence per session, feeding the grade.

7. Metering, Energy, and the Green Ledger
7.1 Token ledger
The meter parses Claude Code's local JSONL transcripts: per-turn input, output, cache-read, cache-write, thinking tokens, per-tool attribution, per-session and per-project rollups. Pricing is a versioned prices.yaml, user-updatable, no hardcoded numbers.
7.2 Energy and carbon estimation
energy_factors.yaml: per-model-class Wh per token factors with a source citation on every row (TokenPowerBench-class benchmarks, ML.ENERGY leaderboard), a context-length multiplier curve reflecting attention superlinearity, and stated uncertainty bands. Grid intensity: gCO2e per kWh by region in grid_intensity.yaml, conservative global default, user-configurable. The sidecar's own local consumption is measured and charged against the savings. docs/METHODOLOGY.md carries the full estimation model, assumptions, and limitations, stating in bold that these are estimates, never measurements.
7.3 The audit trail
Append-only audit.jsonl: every distillation (artifact class, profile, raw and distilled token counts, gates passed, zoom-backs), every redirect, every zoom, every governor intervention. `redutok audit <session>` renders it. A high zoom-back rate on a profile automatically softens that profile, and the tuning decision itself is logged.
Session attribution: Claude Code passes the transcript session id to hooks but not to MCP servers, so the SessionStart and PostToolUse hooks register the active session id with the sidecar (a sessionId field on /notify), and the sidecar stamps it on every artifact and audit event it writes; zoom events inherit the session of the artifact they recover. Fallback when no session is registered (hooks not installed, or no hook has fired since the sidecar started): the caller-provided sessionId, then "unknown". Registration is in-memory and last-writer-wins; hooks re-register on every matched tool use, so a restarted sidecar regains attribution on the next tool call.
7.4 Grades and badges
Four scores per session, A-F composite: Context Efficiency (useful vs redundant input), Output Discipline, Cache Utilization, Energy per Outcome. Outputs: terminal report, SVG badge for READMEs, and a one-line share format ending "Redutok by Truveil".
8. Benchmark Harness
bench/tasks/: 10-15 reproducible tasks on pinned open-source repos (bug fix, refactor, test generation, exploration Q&A) in small, medium, large tiers. Runner executes each task twice headless, vanilla Claude Code vs Redutok-enabled, same model, N repetitions. Metrics: tokens (all classes), USD, estimated Wh and gCO2e, wall time, and task success via task-specific assertions (tests pass, diff applies, answer matches rubric). Savings without success are reported prominently as failures. Results publish to bench/RESULTS.md with raw logs; runner is `redutok bench --all`. Public claims are drawn only from this harness.
9. Failure-Mode Matrix
ConditionBehaviorSidecar not runningHooks no-op fast (50ms timeout); session runs vanilla; meter still works post-hocOllama absent or slowRule engine only; profiles marked llm optional stay active; roughly 5-8x retainedDistillate fails a gateRaw served; event loggedModel repeatedly zooms a classProfile auto-softens; loggedCodex stale vs diskHash mismatch detected; file served raw + async re-indexCompaction firesPreCompact preserves state; protocol re-injected on resumeUser uninstalls`redutok remove` cleanly reverts settings.json and the CLAUDE.md block
10. Definition of Done for v1.0 Public

1. All phase acceptance criteria in BUILD.md green in CI.
2. bench/RESULTS.md shows median at least 10x with at least 95% task-success parity, from committed raw logs.
3. METHODOLOGY.md citations verified by founder, no TODO-VERIFY remaining.
4. Trademark knockout on REDUTOK cleared; npm name and GitHub org registered.
5. Fresh-machine install test: `npx redutok init` to first graded session in under five minutes.
