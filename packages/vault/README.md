# @redutok/vault

The Redutok Vault: an MCP server that exposes the sidecar engines to normal
AI chat clients over streamable HTTP, mounted on an existing corpus — the
`.dcp` state (store, audit trail, codex, config) that `redutok init` plus
`redutok codex refresh` already produce.

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
- `vault_zoom(handle, query?, corpus?)` — byte-recoverable zoom with the
  existing semantics, including the `id` alias and `Fxxxx@hash` file refs.
- `vault_receipt(scope?, corpus?)` — `session` (default) or `corpus`
  lifetime rollups: tokens avoided with artifact backing, cost avoided at
  the claude-sonnet-5 input rate from `prices.yaml`, Wh and gCO2e bands per
  `docs/METHODOLOGY.md` (context multiplier held at 1.0).

## Guardrails

- No outbound network: the vault process serves its inbound socket and
  touches only local files (asserted by test).
- Everything stored or served passes the sidecar's redaction module.
- Fail-open never applies: there is no raw fallback path to a chat client,
  so failures return explicit tool errors.
- Every tool call writes audit events under a vault session id derived from
  the MCP session (`vault-<Mcp-Session-Id>`; per-ask ids `#askN`).

## Verify live (zero model cost)

```bash
node scripts/vault-verify.mjs
```

Copies the axios fixture, initializes it with the real CLI, starts the
vault, and drives a scripted MCP client through the handshake, auth
rejections, a real ask (asserting ≥10x raw-versus-served), byte-equal zoom
recovery, and a receipt reconciled against the audit trail.
