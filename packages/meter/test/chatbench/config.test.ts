import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  computeConfigHash,
  loadChatbenchConfig,
  loadQuestionSet,
} from '../../src/chatbench/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..', '..', '..');
const configPath = path.join(repoRoot, 'bench', 'chatbench.yaml');
const docsQuestionsPath = path.join(repoRoot, 'bench', 'chatbench', 'docs.yaml');
const codeQuestionsPath = path.join(repoRoot, 'bench', 'chatbench', 'code.yaml');

describe('loadChatbenchConfig', () => {
  it('reads the pre-registered file and validates required fields', () => {
    const cfg = loadChatbenchConfig(configPath);
    expect(cfg.kind).toBe('chatbench');
    expect(cfg.registrationId).toBe('chatbench-v1b-2026-08-01');
    expect(cfg.replications).toBe(3);
    expect(cfg.corpora.map((c) => c.id).sort()).toEqual(['code', 'docs']);
    expect(cfg.grader.parityFloor).toBe(0.75);
    expect(cfg.receiptReconciliation.subtractCodexInSystem).toBe(true);
    expect(cfg.immutable.excludeFields).toEqual(['failures']);
  });
});

describe('loadQuestionSet', () => {
  it('reads both question sets with 10 questions each', () => {
    const docs = loadQuestionSet(docsQuestionsPath);
    const code = loadQuestionSet(codeQuestionsPath);
    expect(docs.corpus).toBe('docs');
    expect(code.corpus).toBe('code');
    expect(docs.questions).toHaveLength(10);
    expect(code.questions).toHaveLength(10);
    for (const q of [...docs.questions, ...code.questions]) {
      expect(q.id).toMatch(/^q\d+$/);
      expect(q.prompt.length).toBeGreaterThan(20);
      expect(q.needles.length).toBeGreaterThan(0);
    }
  });

  it('follow-up questions declare dependsOn', () => {
    const docs = loadQuestionSet(docsQuestionsPath);
    const followUps = docs.questions.filter((q) => q.category === 'follow-up');
    expect(followUps.length).toBeGreaterThanOrEqual(2);
    for (const fu of followUps) expect(fu.dependsOn).toMatch(/^q\d+$/);
  });
});

describe('computeConfigHash', () => {
  it('is stable when only failures[] changes (excludeFields honoured)', () => {
    const cfg = loadChatbenchConfig(configPath);
    const before = computeConfigHash(cfg);
    const mutated = { ...cfg, failures: [{ note: 'appended post-run' }] };
    const after = computeConfigHash(mutated);
    expect(after).toBe(before);
  });

  it('changes when any other field changes', () => {
    const cfg = loadChatbenchConfig(configPath);
    const before = computeConfigHash(cfg);
    const mutated = { ...cfg, replications: cfg.replications + 1 };
    const after = computeConfigHash(mutated);
    expect(after).not.toBe(before);
  });

  it('is a sha256 hex string', () => {
    const cfg = loadChatbenchConfig(configPath);
    expect(computeConfigHash(cfg)).toMatch(/^[0-9a-f]{64}$/);
  });
});
