# Redutok Skill

Behavioral rules for a claude.ai Project connected to a Redutok Vault.

## Install

1. Emit the codex for your corpus:
   ```
   redutok-vault codex <path-to-corpus> --corpus <name>
   ```
2. Paste the entire output into your claude.ai Project instructions.
3. Copy `SKILL.md` into a skill on your workspace (either upload the file
   or paste its contents). Claude uses the frontmatter's `description` to
   decide when the skill applies; the body teaches the vault protocol.

## Budget

`SKILL.md` is intentionally under ~450 tokens so it fits the platform's
skill budget with room to spare. It never contains repository-specific
content — that lives in the pasted codex block, which enforces its own
`LIMITS.VAULT_CODEX.MAX_TOKENS` ceiling.

## Refresh

When a `vault_ask` response ends with
`[vault codex refresh: pasted block is v<N>; current v<M> — ...]`,
re-emit the codex and repaste it into Project instructions. The skill
teaches Claude to surface this notice verbatim rather than paper over the
drift.
