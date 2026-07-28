import { z } from 'zod';

/**
 * Core Delta Context Protocol schemas.
 * Every value that crosses a package boundary is validated with one of these.
 */

export const TokenTallySchema = z
  .object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    cacheRead: z.number().int().nonnegative(),
    cacheWrite: z.number().int().nonnegative(),
    /**
     * Split of cacheWrite by cache TTL tier: 5-minute writes bill at 1.25x
     * input, 1-hour writes at 2x (see prices.yaml). Optional so existing
     * TokenTally values built without a transcript's cache_creation
     * breakdown (older fixtures, hand-built tallies) stay valid; a reader
     * that needs a number treats a missing field as 0. When either is
     * present they must sum to cacheWrite exactly (enforced below) —
     * parser.ts is the sole production writer and only ever sets them
     * together.
     */
    cacheWrite5m: z.number().int().nonnegative().optional(),
    cacheWrite1h: z.number().int().nonnegative().optional(),
    /**
     * Subset of cacheWrite1h whose tier could not be read from the
     * transcript's cache_creation breakdown and was conservatively assumed
     * at the higher-cost 1-hour tier (policy: never silently bill an
     * unknown-tier token at the cheaper rate). 0 when the split is fully
     * known or cacheWrite is 0.
     */
    cacheWriteAssumedTokens: z.number().int().nonnegative().optional(),
    thinking: z.number().int().nonnegative(),
  })
  .refine(
    (t) =>
      t.cacheWrite5m === undefined && t.cacheWrite1h === undefined
        ? true
        : (t.cacheWrite5m ?? 0) + (t.cacheWrite1h ?? 0) === t.cacheWrite,
    { message: 'cacheWrite5m + cacheWrite1h must equal cacheWrite when the tier split is present' },
  );
export type TokenTally = z.infer<typeof TokenTallySchema>;

export const LedgerEntrySchema = z.object({
  sessionId: z.string().min(1),
  turn: z.number().int().positive(),
  timestamp: z.string().datetime(),
  model: z.string().min(1),
  tools: z.array(z.string()).default([]),
  tokens: TokenTallySchema,
  costUsd: z.number().nonnegative().optional(),
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

export const AuditActionSchema = z.enum([
  'drop',
  'truncate',
  'summarize',
  'distill',
  'serve-raw',
  'redact',
  'skip',
  'zoom',
  'rewrite',
  'refuse',
]);
export type AuditAction = z.infer<typeof AuditActionSchema>;

export const AuditEventSchema = z.object({
  id: z.string().min(1),
  timestamp: z.string().datetime(),
  sessionId: z.string().optional(),
  module: z.string().min(1),
  action: AuditActionSchema,
  reason: z.string().min(1),
  inputRef: z.string().optional(),
  outputRef: z.string().optional(),
  bytesIn: z.number().int().nonnegative().optional(),
  bytesOut: z.number().int().nonnegative().optional(),
  details: z.record(z.unknown()).optional(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const CandidateTypeSchema = z.enum(['error-fix', 'zoom-hotspot', 'recurrence']);
export type CandidateType = z.infer<typeof CandidateTypeSchema>;

/**
 * A graduation-miner candidate learning (v4 phase 1: extraction only).
 * Mined post-session from attributed audit events; persisted one per line in
 * .dcp/candidates.jsonl. Nothing here writes to the codex yet.
 */
export const CandidateRecordSchema = z.object({
  id: z.string().min(1),
  type: CandidateTypeSchema,
  /** Stable dedupe key; re-observation across sessions merges on (type, key). */
  key: z.string().min(1),
  /** Rule-derived raw signature; the human-readable fallback when no lesson is drafted. */
  signature: z.string().min(1),
  /** Optional one-sentence lesson drafted by the local-model LlmPass. */
  lesson: z.string().optional(),
  /** Audit event ids backing this candidate. */
  evidence: z.array(z.string()).default([]),
  firstSeen: z.string().datetime(),
  lastSeen: z.string().datetime(),
  /** Increments once per session that re-observes the candidate. */
  occurrences: z.number().int().positive(),
  /** Reserved for the codex-write phase; always null in extraction-only v1. */
  contradiction: z.null().default(null),
  details: z.record(z.unknown()).default({}),
});
export type CandidateRecord = z.infer<typeof CandidateRecordSchema>;

export const DistillProfileSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().optional(),
  match: z
    .object({
      tools: z.array(z.string()).default([]),
      contentType: z.string().optional(),
    })
    .default({}),
  rules: z
    .array(
      z.object({
        kind: z.string().min(1),
        config: z.record(z.unknown()).default({}),
      }),
    )
    .default([]),
  gates: z
    .object({
      entityPreservationMinRatio: z.number().min(0).max(1).default(0.95),
      /** Raw lines matching this regex are the conclusion-relevant region; unset disables the entity gate. */
      relevantLinePattern: z.string().optional(),
      /** Only the first N matching lines form the region (build-log: the first error is the conclusion). */
      relevantLineLimit: z.number().int().positive().optional(),
      /** Double-extraction verdict config; unset disables the verdict gate. */
      verdict: z
        .object({
          primaryPass: z.array(z.string()).default([]),
          primaryFail: z.array(z.string()).default([]),
          secondaryPass: z.array(z.string()).default([]),
          secondaryFail: z.array(z.string()).default([]),
          secondaryPassIfNoFail: z.boolean().default(false),
        })
        .optional(),
      sizeMaxRatio: z.number().positive().optional(),
      minOutputBytes: z.number().int().nonnegative().optional(),
    })
    .default({}),
  llm: z
    .object({
      enabled: z.boolean().default(false),
      model: z.string().optional(),
    })
    .default({ enabled: false }),
});
export type DistillProfile = z.infer<typeof DistillProfileSchema>;

export const LockableTextSchema = z.object({
  text: z.string().min(1),
  locked: z.boolean().default(false),
});

export const CodexFileSchema = z.object({
  version: z.string().min(1),
  project: z.string().min(1),
  generatedAt: z.string().datetime(),
  summary: z.string().optional(),
  architecture: z
    .array(
      z.object({
        id: z.string().min(1),
        decision: z.string().min(1),
        rationale: z.string().default(''),
        locked: z.boolean().default(false),
      }),
    )
    .default([]),
  map: z
    .array(
      z.object({
        path: z.string().min(1),
        role: z.string().default('unclassified'),
        roleSource: z.enum(['rules', 'llm', 'human']).default('rules'),
        keySymbols: z.array(z.string()).default([]),
        locked: z.boolean().default(false),
      }),
    )
    .default([]),
  conventions: z.array(LockableTextSchema).default([]),
  pitfalls: z.array(LockableTextSchema).default([]),
  glossary: z
    .array(
      z.object({
        term: z.string().min(1),
        means: z.string().min(1),
        locked: z.boolean().default(false),
      }),
    )
    .default([]),
  interfaces: z
    .array(
      z.object({
        name: z.string().min(1),
        signature: z.string().min(1),
        file: z.string().optional(),
      }),
    )
    .default([]),
  importGraph: z.record(z.array(z.string())).default({}),
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        hash: z.string().min(1),
        role: z.string().optional(),
      }),
    )
    .default([]),
  locked: z.array(z.string()).default([]),
});
export type CodexFile = z.infer<typeof CodexFileSchema>;

export const CodexLockSchema = z.object({
  version: z.literal(1),
  repoFingerprint: z.string().min(1),
  files: z.record(z.string()),
});
export type CodexLock = z.infer<typeof CodexLockSchema>;

export function emptyTally(): TokenTally {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheWriteAssumedTokens: 0,
    thinking: 0,
  };
}

export function addTally(a: TokenTally, b: TokenTally): TokenTally {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheWrite5m: (a.cacheWrite5m ?? 0) + (b.cacheWrite5m ?? 0),
    cacheWrite1h: (a.cacheWrite1h ?? 0) + (b.cacheWrite1h ?? 0),
    cacheWriteAssumedTokens: (a.cacheWriteAssumedTokens ?? 0) + (b.cacheWriteAssumedTokens ?? 0),
    thinking: a.thinking + b.thinking,
  };
}
