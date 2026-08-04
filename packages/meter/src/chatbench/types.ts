/**
 * Types shared across the chatbench module. Chatbench pits the vault (a
 * Project simulation) against the way chat users actually work on a
 * corpus: paste the docs, then ask questions. Kept isolated in a single
 * subdirectory so nothing about Anthropic-API calls leaks into meter's
 * core code paths.
 */

/** Frozen registration as stored in bench/chatbench.yaml. */
export interface ChatbenchConfig {
  version: number;
  registrationId: string;
  kind: 'chatbench';
  model: string;
  apiKeyEnv: string;
  replications: number;
  maxTokensPerTurn: number;
  temperature: number;
  seed: number;
  corpora: CorpusEntry[];
  grader: GraderConfig;
  headline: HeadlineConfig;
  receiptReconciliation: ReceiptReconciliationConfig;
  dod: string[];
  failures: unknown[];
  immutable: ImmutabilityConfig;
  dryRun: { emitCallMatrix: boolean; tokenEstimatorNote: string };
}

export interface CorpusEntry {
  id: string;
  label: string;
  root: string;
  pasteExtractedSuffix: string;
  questions: string;
  minInputReductionMedianX: number;
}

export interface GraderConfig {
  kind: 'needle-fraction';
  parityFloor: number;
}

export interface HeadlineConfig {
  medianInputTokenReduction: Record<string, { minX: number }>;
  minParityRate: number;
  minTotalCostReductionX: Record<string, number>;
}

export interface ReceiptReconciliationConfig {
  maxRelativeError: number;
  subtractCodexInSystem: boolean;
}

export interface ImmutabilityConfig {
  hashAlgorithm: 'sha256';
  excludeFields: string[];
}

/** A single loaded question set (bench/chatbench/{docs,code}.yaml). */
export interface QuestionSet {
  corpus: string;
  questions: Question[];
}

export interface Question {
  id: string;
  category: string;
  prompt: string;
  needles: string[];
  dependsOn?: string;
}

/** PASTE arm's first-message assembly. */
export interface PasteAssembly {
  /** The text embedded in the first user message. */
  text: string;
  /** Per-source-file accounting so we can prove what went in. */
  sourceFiles: { path: string; bytes: number; usedShadow: boolean }[];
  /** Total byte length of `text` (utf-8). */
  totalBytes: number;
}

/**
 * The Anthropic Messages-API surface we depend on. Kept minimal so tests
 * can supply a mock and the meter package does not need @anthropic-ai/sdk
 * as a hard dep. The real driver script wires the sdk to this interface.
 */
export interface AnthropicLike {
  messages: {
    create: (req: MessagesCreateRequest) => Promise<MessagesResponse>;
  };
}

export interface MessagesCreateRequest {
  model: string;
  max_tokens: number;
  temperature?: number;
  system?: string | Array<{ type: 'text'; text: string }>;
  messages: MessageInput[];
  tools?: ToolDefinition[];
}

export interface MessageInput {
  role: 'user' | 'assistant';
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; input: unknown }
        | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
      >;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: unknown;
}

export interface MessagesResponse {
  id: string;
  model: string;
  role: 'assistant';
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  >;
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/** Per-question record after both arms have run. */
export interface QuestionRecord {
  questionId: string;
  arm: 'paste' | 'vault';
  rep: number;
  answer: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  score: number;
  parity: boolean;
  toolCallCount?: number;
}

/** Grader result for a single (question, arm) pair. */
export interface GraderResult {
  score: number;
  matched: string[];
  missed: string[];
  parity: boolean;
}

/** Receipt reconciliation math result. */
export interface ReconciliationResult {
  measuredAvoidedTokens: number;
  receiptAvoidedTokens: number;
  codexInSystemTokens: number;
  relativeError: number;
  withinBand: boolean;
}

/** One row in the dry-run call matrix (per (arm, corpus, question, rep)). */
export interface CallSpec {
  arm: 'paste' | 'vault';
  corpusId: string;
  questionId: string;
  rep: number;
  /** Estimated tokens the call carries in the request (bytes/4 basis). */
  minInputTokens: number;
  maxInputTokens: number;
  /** Estimated tokens the call may produce, capped at maxTokensPerTurn. */
  maxOutputTokens: number;
}
