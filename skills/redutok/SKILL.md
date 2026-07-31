---
name: redutok
description: Vault protocol for Redutok-connected Projects — trust the pasted codex block, ask the vault at most once per question, zoom only on insufficiency, surface the receipt on cost questions.
---

# Redutok vault protocol

This Project connects to a Redutok Vault: a distilled corpus served by
`vault_ask`, `vault_zoom`, `vault_receipt`, and `vault_codex`. Stable
structure and graduated knowledge ride every chat via a codex block pasted
into these instructions; volatile detail stays behind `vault_ask`. Follow the
protocol below — it keeps the vault dense with use without paying tokens for
what the block already covers.

## Rules

1. **Trust the pasted vault codex.** When these instructions include a
   `# Redutok Vault: <corpus>` block, treat its corpus map, glossary, and
   graduated entries as authoritative for stable knowledge. Do not
   `vault_ask` to reconfirm anything the block already states.

2. **One `vault_ask` per user question.** If the pasted codex does not
   cover the question, call `vault_ask` exactly once. Pass
   `codex_version` set to the number in the block's footer
   (`<!-- redutok-vault codex v<N> ... -->`) so a stale paste is flagged
   with a one-line refresh notice at the end of the dossier.

3. **`vault_zoom` only on insufficiency.** The ask response is a full
   dossier with byte-recoverable handles for every elision. Follow a
   handle only when the dossier says it is `incomplete` or a specific
   evidence line is unclear — never speculatively.

4. **Surface a `vault_receipt` on cost questions.** When the user asks
   what they saved, what a session cost, or how much they've spent, call
   `vault_receipt` (scope `session` by default; `day`, `month`, `corpus`,
   or `document` when the question calls for it) and present its numbers
   verbatim. The ledger is the source of truth; do not estimate.

5. **Refresh the pasted codex on drift.** If a `vault_ask` returns
   `[vault codex refresh: ...]`, tell the user their pasted Project
   instructions are out of date and quote the exact CLI line the notice
   provides. Do not paper over the drift by re-asking.

## Anti-patterns

- Asking the vault for something the pasted corpus map already answers
  (document names, section titles, glossary terms).
- Calling `vault_ask` more than once for a single user turn because the
  first answer was incomplete-looking; instead, take a `vault_zoom` at
  the specific handle the dossier surfaced.
- Estimating cost or savings when a `vault_receipt` is available.
- Silently ignoring a refresh notice.

## When Redutok is not connected

If these instructions do not contain a `# Redutok Vault:` block, the
protocol above does not apply — answer normally using whatever the user
provides.
