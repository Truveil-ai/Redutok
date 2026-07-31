# @redutok/vault

The Redutok Vault: an MCP server that exposes the sidecar engines to normal
AI chat clients over streamable HTTP, mounted on a corpus — the `.dcp`
state (store, audit trail, codex, config) that `redutok init` plus
`redutok codex refresh` produce for a repository, or that `vault ingest`
builds for an arbitrary directory of mixed files.

## Ingest

```bash
node packages/vault/dist/main.js ingest /path/to/files --corpus practice
```

Builds the full `.dcp` state for a directory of mixed files so the server
can mount it. Code (`.ts/.js/.py` and friends) goes through the codex and
skeleton mirror exactly as `redutok init` + `codex refresh` would.
Documents — plain text, Markdown, PDF (text extraction), DOCX — are
extracted with node builtins only, structure-mapped (headings, sections,
page or paragraph anchors, one-line summaries via the LlmPass seam with a
first-sentence rule fallback), and stored through the redaction pass as
`doc-serve` artifacts. Scanned-image PDFs and anything else without an
extractable text layer are declared out of scope in the index and the
summary — never silently empty.

Alongside the store the ingest writes:

- `.dcp/documents.json` — the slice index: every document's sections with
  ids, anchors, and summaries, so zoom handles cite like a professional
  would (document, section, page).
- `.dcp/PROVENANCE.json` — source path, sha256, size, extraction method,
  and ingestion date per file, so every dossier citation traces to the
  hashed bytes that were ingested.

Re-ingestion is incremental by hash: unchanged files keep their artifact,
index entry, and timestamps untouched; removed files leave the index.

## Run

```bash
node packages/vault/dist/main.js --corpus axios=/path/to/initialized/repo
```

- `--corpus <path | name=path>` (repeatable) — corpus directories to mount.
- `--port <n>` — HTTP port (default 48650, `0` for ephemeral).
- `--stdio` — newline-delimited JSON-RPC over stdio for local testing.
  There are no headers to carry a bearer, so stdio is trusted-local only.
- `--host <addr> --allow-external` — binding anything but localhost is
  self-host territory: you are exposing the corpus to your network, so you
  own the transport security in front of it. Both flags are required.

Auth: every request except the MCP `initialize` handshake requires
`Authorization: Bearer <agent secret>`, compared in constant time. The
secret comes from `REDUTOK_VAULT_SECRET` or `<corpus>/.dcp/vault.json`
(`{ "secret": "..." }`).

## Tools

- `vault_ask(question, corpus?)` — one bounded exploration (the sidecar's
  exploreGoal at `thorough` budget) returning a dossier: verdict via the
  LlmPass seam with rule fallback, file:line evidence, a zoom handle for
  every elision, and a mandatory accounting block (raw bytes and estimated
  tokens touched versus served, per ask, reconciling with the audit trail).
  On an ingested corpus the documents are searched by section first
  (`doc-search`), the most relevant served ask-relevant (`doc-serve`), and
  the evidence cites document, section, and page (`§3 "Fees and Billing",
  p.2`). The prose entity gates hold those serves to the same discipline as
  code output: dates, defined terms, party names, section numbers, and
  figures in the conclusion-relevant region survive verbatim or the raw is
  served instead.
- `vault_zoom(handle, query?, corpus?)` — byte-recoverable zoom with the
  existing semantics, including the `id` alias and `Fxxxx@hash` file refs.
  On a document artifact, a section reference (`§3`, `3`, or the exact
  title) or a page reference (`page 2`) recovers that slice byte-equal from
  the store.
- `vault_receipt(scope?, day?, month?, json?, corpus?)` — rollups from the
  persistent ledger. Scopes: `session` (default), `day` (YYYY-MM-DD, UTC),
  `month` (YYYY-MM), `corpus` lifetime, and `document` (which documents are
  consumed most, how often, at what avoided cost). Every rollup states
  tokens avoided with artifact backing, cost avoided at the claude-sonnet-5
  input rate from `prices.yaml` with the rate row cited, and Wh and gCO2e
  bands per `docs/METHODOLOGY.md` (context multiplier held at 1.0).
  `json: true` returns the rollup as JSON instead of the human render.

## Ledger

Every ask, zoom, and internal serve appends a line to the per-corpus
ledger at `.dcp/ledger.db` (SQLite, alongside the store): session id,
timestamp, tokens raw versus served, cost avoided at the rate row current
when the line was written (model, rate, and source pinned into the line),
Wh and gCO2e bands, per-document attribution, and the artifact and audit
references backing the line. Serve lines mirror the measured audit events
one-to-one, so ledger and audit reconcile by construction; the ask line on
top records the dossier accounting without double-counting its serves. The
ledger survives server restarts, and an explicit `X-Vault-Session`
identity resumes its ask numbering from it.

Counterfactual honesty, enforced in code and pinned by test: avoided
tokens always compare served size against the raw size of what was
actually touched. The whole-corpus figure appears only under its own
"corpus resident size avoided" label; the two never conflate.

## Monthly statement

```bash
node packages/vault/dist/main.js statement /path/to/corpus --corpus practice --month 2026-07
```

Renders the month's ledger as a statement ready to attach to an internal
report: activity, token totals for what was touched, avoided cost with
the rate row cited, avoided energy with bands, top documents by reads,
top sessions by tokens avoided, the corpus-resident figure under its own
label, and the methodology citation with the estimates-never-measurements
framing. `--month` defaults to the current month (UTC); `--json` emits
the rollup as JSON. Reads `.dcp` state directly; no server required.

## Guardrails

- No outbound network: the vault process serves its inbound socket and
  touches only local files (asserted by test).
- Everything stored or served passes the sidecar's redaction module.
- Fail-open never applies: there is no raw fallback path to a chat client,
  so failures return explicit tool errors.
- Every tool call writes audit events under a vault session id, and
  receipts attribute strictly per session id. An `initialize` carrying an
  `X-Vault-Session` header names the session explicitly
  (`vault-<name>`; malformed values are a 400, never silently ignored);
  without it the id is generated per initialize — over HTTP and over stdio
  alike, there is no shared per-process fallback identity.

## Verify live (zero model cost)

```bash
node scripts/vault-verify.mjs
node scripts/vault-verify-docs.mjs
node scripts/vault-verify-ledger.mjs
```

The first copies the axios fixture, initializes it with the real CLI,
starts the vault, and drives a scripted MCP client through the handshake,
auth rejections, a real ask (asserting ≥10x raw-versus-served), byte-equal
zoom recovery, and a receipt reconciled against the audit trail.

The second assembles the mixed document corpus (checked-in Markdown and
text plus a script-generated multi-page PDF and DOCX), ingests it twice
(proving hash-incrementality), then verifies a cross-document ask cited by
document, section, and page with its accounting block, byte-equal section
recovery via `vault_zoom("§3")`, the prose entity gate blocking a
distillate that drops a date, and receipt attribution to an explicit
`X-Vault-Session`.

The third mounts both fixture corpora on one server and drives a dozen
asks and zooms over two simulated sessions with a server restart
mid-sequence, proving per-session receipts differ and reconcile to the
audit trail, ledger continuity across the restart, correct per-document
ranking, and month-statement totals that match the corpus-lifetime
rollup. It prints the month statement.
