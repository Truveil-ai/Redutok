# Chatbench (Session 5)

Chatbench measures the Vault against the way people actually use a chat
client with documents: paste the corpus into the first message, then ask
questions across a multi-turn conversation. It is the table the launch's
headline number cites, so it runs under house law:

- Criteria are pre-registered in `chatbench.yaml` **before any live run**.
- Once a live run has recorded a result under a `registrationId`, that
  file's hash freezes (`immutable.excludeFields` limits post-run edits to
  `failures[]` only).
- No movement of thresholds after live. Adjustments only exist between
  registration authoring and the first live run.

## Arms

**PASTE** — the corpus documents are embedded in the first user message
(binaries replaced by their `.extracted.txt` shadow so token counts are
deterministic and match what a chat client produces after attachment
extraction). Follow-up questions ride the same conversation with no
vault tools.

**VAULT** — the Project simulation. The system prompt carries the
emitted `vault_codex` block plus the Redutok Skill text. The model
reaches the corpus through a local, in-process tool-use loop
(`packages/meter/src/chatbench/vault-loop.ts`) that proxies `vault_ask`
and `vault_zoom` against the real vault server; the tool-result content
is fed back on each turn.

Same model, same questions in the same order, N replications per
`(arm, corpus)`.

## Corpora

- `docs` — `fixtures/chatbench-docs/` (MD + TXT + TS + PDF + DOCX).
  Small valuation-practice fixture; the docs headline ratio is
  intentionally modest.
- `code` — `fixtures/repos/axios/`. Roughly 550 KB of source; the code
  headline ratio is comfortably ahead of the pre-registered floor.

## Metrics

- **Headline**: median PASTE-input-tokens / VAULT-input-tokens per
  question, at grader parity, plus total-conversation cost reduction.
  Input tokens come from the Anthropic API `usage` field (ground truth).
- **Reconciliation**: the vault receipt's `avoidedTokens` for the VAULT
  conversation is reconciled against the measured PASTE-minus-VAULT
  input delta, with the codex-in-system tokens subtracted first (they
  are served, not avoided).
- **Grader**: `needle-fraction` — each `needles[]` entry contributes
  equally to a per-question score in [0, 1]; parity is `score >= 0.75`.

## Definition of Done

See `dod:` in `chatbench.yaml`. In brief: both corpora clear their
median-reduction floor, parity holds on ≥ 85% of questions per corpus,
total-cost reduction clears the per-corpus floor, and every VAULT rep
reconciles within `receiptReconciliation.maxRelativeError` (25%). Any
arm error voids the affected `(question, corpus, rep)` and requires a
rerun of that triple.

## Running

```bash
pnpm --filter redutok build
node scripts/chatbench.mjs --dry-run     # matrix + cost band, no calls
node scripts/chatbench.mjs --prep-check  # + one mocked end-to-end pass
```

Live mode is not wired in the current commit: the driver falls back to a
prep-check and prints a note pointing at the two functions
(`runPasteTurn`, `runVaultLoop`) that would be handed a real
`@anthropic-ai/sdk` client. Wiring live requires adding the SDK and an
`ANTHROPIC_API_KEY` in the env; the founder approves the spend from the
dry-run cost band before that switch is flipped.

## Fixture builder

`scripts/build-chatbench-fixtures.mjs` regenerates the PDF, DOCX, and
`.extracted.txt` shadows in `fixtures/chatbench-docs/` from source text
embedded in the script. Only re-run when the fixture source changes;
outputs are committed so the runtime is dep-free.
