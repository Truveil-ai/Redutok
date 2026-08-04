#!/usr/bin/env node
// chatbench driver — orchestrates the PASTE vs VAULT run described in
// bench/chatbench.yaml. Supports two safe modes and one live mode:
//
//   --dry-run     Enumerate the full call matrix, print a per-corpus
//                 per-arm cost band, and exit. No network calls.
//   --prep-check  Same as --dry-run, plus an end-to-end pass over a
//                 mocked Anthropic client (both arms, one question)
//                 exercising the grader and the receipt reconciliation.
//   (no flag)     Live run against the Anthropic API. Requires
//                 ANTHROPIC_API_KEY in the env; refuses to start without.
//                 NOT wired in this commit — the driver falls back to
//                 --prep-check and prints an explicit "no live run" note.
//
// Usage:
//   node scripts/chatbench.mjs --dry-run
//   node scripts/chatbench.mjs --prep-check
//
// Rates: Sonnet 5 list price ($3 / MTok input, $15 / MTok output) is
// hard-coded here for the cost-band estimate; the meter's price table is
// authoritative post-run.

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeConfigHash,
  enumerateMatrix,
  loadChatbenchConfig,
  loadQuestionSet,
  newMockClient,
  reconcileReceipt,
  renderDryRun,
  runPasteTurn,
  runVaultLoop,
  scoreNeedle,
} from '../packages/meter/dist/chatbench/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const RATES = { inputPerMTokUsd: 3, outputPerMTokUsd: 15 };

function parseArgs(argv) {
  const args = { mode: 'live', configPath: 'bench/chatbench.yaml' };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') args.mode = 'dry-run';
    else if (a === '--prep-check') args.mode = 'prep-check';
    else if (a === '--config') {
      i += 1;
      args.configPath = argv[i];
    } else if (a === '--help' || a === '-h') {
      args.mode = 'help';
    } else {
      throw new Error(`chatbench: unknown arg ${a}`);
    }
  }
  return args;
}

function loadAll(configPath) {
  const cfg = loadChatbenchConfig(join(ROOT, configPath));
  const sets = new Map();
  for (const c of cfg.corpora) {
    sets.set(c.id, loadQuestionSet(join(ROOT, c.questions)));
  }
  return { cfg, sets };
}

async function runPrepCheck(cfg, sets) {
  console.log('');
  console.log('prep-check (mocked API): end-to-end pass over one docs question');
  console.log('  no network call is made; both arms use canned responses');
  const questionSet = sets.get('docs');
  const q = questionSet.questions[0];

  // PASTE arm: one turn, canned answer that hits both needles.
  const pasteAnswer = 'Per the billing policy, invoices unpaid after 30 days accrue interest at 1.5% per month.';
  const pasteClient = newMockClient([
    {
      id: 'mock-paste-1',
      model: cfg.model,
      role: 'assistant',
      content: [{ type: 'text', text: pasteAnswer }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 4200, output_tokens: 30 },
    },
  ]);
  const pasteOut = await runPasteTurn(pasteClient, cfg.model, [], q.prompt, {
    maxTokensPerTurn: cfg.maxTokensPerTurn,
    temperature: cfg.temperature,
  });
  const pasteScore = scoreNeedle(q, pasteOut.assistantText, cfg.grader.parityFloor);
  console.log(`  PASTE:  input ${pasteOut.usage.inputTokens} tok  output ${pasteOut.usage.outputTokens} tok  score ${pasteScore.score.toFixed(2)}  parity=${pasteScore.parity}`);

  // VAULT arm: model calls vault_ask, then answers.
  const vaultDossier = 'Per billing-policy.md §Late Payment: interest is 1.5% per month after the 30-day due window. [vault accounting: ...]';
  const vaultAnswer = 'The interest rate is 1.5% per month, per the billing policy.';
  const vaultClient = newMockClient([
    {
      id: 'mock-vault-1',
      model: cfg.model,
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tu_ask_1', name: 'vault_ask', input: { question: q.prompt } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 2730, output_tokens: 45 },
    },
    {
      id: 'mock-vault-2',
      model: cfg.model,
      role: 'assistant',
      content: [{ type: 'text', text: vaultAnswer }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 3010, output_tokens: 25 },
    },
  ]);
  const vaultOut = await runVaultLoop(
    vaultClient,
    cfg.model,
    '# Redutok Vault: docs\n(mock codex + skill; ~2700 tok in real runs)',
    [],
    q.prompt,
    {
      vaultAsk: () => vaultDossier,
      vaultZoom: () => 'unused-in-prep-check',
    },
    { maxTokensPerTurn: cfg.maxTokensPerTurn, temperature: cfg.temperature },
  );
  const vaultScore = scoreNeedle(q, vaultOut.assistantText, cfg.grader.parityFloor);
  console.log(`  VAULT:  input ${vaultOut.usage.inputTokens} tok  output ${vaultOut.usage.outputTokens} tok  turns ${vaultOut.turns}  toolCalls ${vaultOut.toolCallCount}  score ${vaultScore.score.toFixed(2)}  parity=${vaultScore.parity}`);

  // Receipt reconciliation on synthetic figures: assume the vault
  // receipt reports the raw touched bytes across the ask, minus the
  // dossier bytes served. For this synthetic call we make it agree.
  const codexInSystemTokens = 2700;
  const synthReceiptAvoidedTokens = pasteOut.usage.inputTokens - (vaultOut.usage.inputTokens - codexInSystemTokens);
  const rec = reconcileReceipt(
    pasteOut.usage.inputTokens,
    vaultOut.usage.inputTokens,
    codexInSystemTokens,
    Math.max(0, synthReceiptAvoidedTokens),
    cfg.receiptReconciliation,
  );
  console.log(`  RECON:  measured ${rec.measuredAvoidedTokens} tok  receipt ${rec.receiptAvoidedTokens} tok  relErr ${rec.relativeError.toFixed(4)}  band=${rec.withinBand ? 'within' : 'OUTSIDE'}`);

  if (!pasteScore.parity || !vaultScore.parity) {
    console.log('  WARN: mocked answers below parity floor — check the canned responses.');
  }
  if (!rec.withinBand) {
    console.log('  WARN: synthetic reconciliation missed the band — fix reconcileReceipt math.');
  }
  return { pasteScore, vaultScore, rec };
}

function help() {
  console.log('chatbench — Redutok chat-bench driver');
  console.log('');
  console.log('Usage:');
  console.log('  node scripts/chatbench.mjs --dry-run');
  console.log('  node scripts/chatbench.mjs --prep-check');
  console.log('  node scripts/chatbench.mjs --config <path>');
  console.log('');
  console.log('Live mode (no flag) is not enabled in this commit; use --prep-check.');
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.mode === 'help') return help();
  const { cfg, sets } = loadAll(args.configPath);
  const configHash = computeConfigHash(cfg);
  console.log(`chatbench: registration ${cfg.registrationId}, config hash ${configHash.slice(0, 12)}...`);

  const matrix = enumerateMatrix(cfg, sets, ROOT);
  console.log('');
  console.log(renderDryRun(cfg, matrix, RATES));

  if (args.mode === 'prep-check') {
    await runPrepCheck(cfg, sets);
  }
  if (args.mode === 'live') {
    console.log('');
    console.log('LIVE mode: not enabled in this commit. Falling back to a prep-check.');
    console.log('To wire live, add @anthropic-ai/sdk, instantiate the client, and pass it to');
    console.log('the same runPasteTurn / runVaultLoop functions the prep-check exercises.');
    await runPrepCheck(cfg, sets);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
