import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import type { ChatbenchConfig, QuestionSet } from './types.js';

export function loadChatbenchConfig(path: string): ChatbenchConfig {
  const raw = readFileSync(path, 'utf8');
  const cfg = parse(raw) as ChatbenchConfig;
  requireField(cfg, 'kind', 'chatbench');
  requireArray(cfg, 'corpora', 1);
  if (typeof cfg.replications !== 'number' || cfg.replications < 1) {
    throw new Error(`chatbench: replications must be a positive integer (got ${String(cfg.replications)})`);
  }
  if (typeof cfg.maxTokensPerTurn !== 'number' || cfg.maxTokensPerTurn < 1) {
    throw new Error('chatbench: maxTokensPerTurn must be a positive integer');
  }
  if (typeof cfg.grader?.parityFloor !== 'number') {
    throw new Error('chatbench: grader.parityFloor must be a number');
  }
  if (cfg.receiptReconciliation === undefined || typeof cfg.receiptReconciliation.maxRelativeError !== 'number') {
    throw new Error('chatbench: receiptReconciliation.maxRelativeError required');
  }
  if (cfg.immutable === undefined || !Array.isArray(cfg.immutable.excludeFields)) {
    throw new Error('chatbench: immutable.excludeFields must be an array');
  }
  // failures is allowed to be missing on freshly authored files.
  if (!Array.isArray(cfg.failures)) cfg.failures = [];
  return cfg;
}

export function loadQuestionSet(path: string): QuestionSet {
  const raw = readFileSync(path, 'utf8');
  const set = parse(raw) as QuestionSet;
  if (typeof set.corpus !== 'string' || set.corpus === '') {
    throw new Error(`question set ${path}: corpus field required`);
  }
  if (!Array.isArray(set.questions) || set.questions.length === 0) {
    throw new Error(`question set ${path}: questions[] required and non-empty`);
  }
  for (const q of set.questions) {
    if (typeof q.id !== 'string' || q.id === '') throw new Error(`question set ${path}: every question needs an id`);
    if (typeof q.prompt !== 'string' || q.prompt === '') throw new Error(`question ${q.id}: prompt required`);
    if (!Array.isArray(q.needles) || q.needles.length === 0) {
      throw new Error(`question ${q.id}: needles[] required and non-empty`);
    }
    if (typeof q.category !== 'string') throw new Error(`question ${q.id}: category required`);
  }
  return set;
}

/**
 * Deterministic sha256 over the config with `excludeFields` removed at the
 * top level. Keys are sorted at every nesting depth so key order in yaml
 * does not affect the hash.
 */
export function computeConfigHash(config: ChatbenchConfig): string {
  const exclude = new Set(config.immutable.excludeFields);
  const scrubbed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config as unknown as Record<string, unknown>)) {
    if (exclude.has(k)) continue;
    scrubbed[k] = v;
  }
  return createHash('sha256').update(canonicalStringify(scrubbed)).digest('hex');
}

function canonicalStringify(v: unknown): string {
  if (v === null || v === undefined) return JSON.stringify(v);
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalStringify).join(',') + ']';
  const keys = Object.keys(v as object).sort();
  const parts = keys.map(
    (k) => JSON.stringify(k) + ':' + canonicalStringify((v as Record<string, unknown>)[k]),
  );
  return '{' + parts.join(',') + '}';
}

function requireField<T extends object>(cfg: T, key: keyof T, expected: string): void {
  if ((cfg as Record<string, unknown>)[key as string] !== expected) {
    throw new Error(`chatbench: ${String(key)} must equal "${expected}"`);
  }
}

function requireArray<T extends object>(cfg: T, key: keyof T, minLength: number): void {
  const v = (cfg as Record<string, unknown>)[key as string];
  if (!Array.isArray(v) || v.length < minLength) {
    throw new Error(`chatbench: ${String(key)} must be an array of length >= ${minLength}`);
  }
}
