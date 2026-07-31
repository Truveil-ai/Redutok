import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LIMITS } from '@redutok/shared';
import { estimateTokens } from '@redutok/sidecar';
import type { Corpus } from './corpus.js';
import { loadReferenceRates, type ReferenceRates } from './rates.js';
import { readVaultGraduated, type VaultGraduatedEntry } from './miner.js';

/**
 * The vault codex emission (Session 4, zero-turn channel): a compact
 * Markdown block for pasting into claude.ai Project instructions. Stable
 * corpus knowledge rides every chat at platform-cached prices; the block
 * teaches the model the vault protocol behaviorally, then names the corpus
 * map, glossary, and graduated learned entries so a first ask does not have
 * to walk the corpus again to answer trivia the codex already covers.
 *
 * Discipline: hard token budget from LIMITS.VAULT_CODEX, with the same
 * lowest-confidence-first exclusion pattern buildInjection uses on learned
 * entries. Version stamp + corpus content hash in a footer line so a stale
 * pasted block is detectable end-to-end (see vault_ask staleness handshake).
 */

const CODEX_STATE_FILE = 'vault-codex.json';

const PROTOCOL_LINES: string[] = [
  '1. Trust this codex block for stable structure and graduated knowledge; do not re-derive it.',
  '2. For volatile detail, call `vault_ask` at most once per question; pass `codex_version` from the footer so a stale block is flagged.',
  '3. Follow a `vault_zoom` handle only when the ask dossier says the answer is incomplete.',
  '4. When the user asks about cost or savings, surface a `vault_receipt` — the ledger is the source of truth.',
];

export interface CodexEmission {
  text: string;
  version: number;
  textHash: string;
  corpus: string;
  emittedAt: string;
  rateRow: ReferenceRates;
  includedGraduated: string[];
  excludedGraduated: string[];
}

export interface CodexState {
  version: number;
  /** Hash of the corpus inputs (docs, glossary, graduated); drives version bumps. */
  contentHash: string;
  /** Hash of the rendered text; changes with any rendering tweak. */
  textHash: string;
  emittedAt: string;
  corpus: string;
}

export interface EmitOptions {
  /** Hard budget for the whole rendered block. Defaults to LIMITS.VAULT_CODEX.MAX_TOKENS. */
  maxTokens?: number;
  /** Sub-budget for the graduated section. Defaults to LIMITS.VAULT_CODEX.GRADUATED_MAX_TOKENS. */
  graduatedMaxTokens?: number;
}

export function readCodexState(dcpDir: string): CodexState | undefined {
  const p = path.join(dcpDir, CODEX_STATE_FILE);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as CodexState;
  } catch {
    return undefined;
  }
}

function writeCodexState(dcpDir: string, state: CodexState): void {
  writeFileSync(path.join(dcpDir, CODEX_STATE_FILE), JSON.stringify(state, null, 2) + '\n', 'utf8');
}

function sha16(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/** One-liner for a document from its first section title or its path. */
function documentOneLiner(entry: Corpus['documents'][number]): string {
  const first = entry.sections?.[0];
  if (first?.title !== undefined && first.title !== '') return first.title;
  return path.basename(entry.path);
}

function renderCorpusMap(corpus: Corpus): string[] {
  const lines: string[] = ['## Corpus map', ''];
  if (corpus.documents.length === 0) {
    lines.push('_no ingested documents; ask against source files by identifier or path._');
  } else {
    for (const doc of corpus.documents) {
      if (doc.outOfScope !== undefined) continue;
      const sections = (doc.sections ?? [])
        .slice(0, 6)
        .map((s) => `§${s.id}`)
        .join(', ');
      const suffix = sections === '' ? '' : ` — sections: ${sections}`;
      lines.push(`- \`${doc.path}\` — ${documentOneLiner(doc)}${suffix}`);
    }
  }
  return lines;
}

function renderGlossary(corpus: Corpus): string[] {
  const terms = corpus.codex?.glossary ?? [];
  if (terms.length === 0) return [];
  const lines: string[] = ['', '## Glossary', ''];
  for (const t of terms.slice(0, 40)) {
    lines.push(`- **${t.term}** — ${t.means}`);
  }
  return lines;
}

interface GraduatedRenderResult {
  block: string[];
  included: string[];
  excluded: string[];
}

function renderGraduated(entries: VaultGraduatedEntry[], budget: number): GraduatedRenderResult {
  const sorted = [...entries].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  const kept: VaultGraduatedEntry[] = [...sorted];
  const excluded: VaultGraduatedEntry[] = [];
  const render = (list: VaultGraduatedEntry[]): string[] => {
    const lines: string[] = ['', '## Graduated knowledge', ''];
    for (const e of list) {
      const conf = e.confidence === undefined ? '' : ` (confidence ${e.confidence.toFixed(2)})`;
      const where =
        e.document === undefined
          ? ''
          : e.sections.length === 0
            ? ` — \`${e.document}\``
            : ` — \`${e.document}\` §${e.sections.join(', §')}`;
      lines.push(`- **${e.kind}**${where}: ${e.oneLiner}${conf}`);
    }
    return lines;
  };
  while (kept.length > 0 && estimateTokens(render(kept).join('\n')) > budget) {
    const popped = kept.pop();
    if (popped !== undefined) excluded.push(popped);
  }
  if (kept.length === 0) return { block: [], included: [], excluded: excluded.map((e) => e.candidate) };
  return {
    block: render(kept),
    included: kept.map((e) => e.candidate),
    excluded: excluded.map((e) => e.candidate),
  };
}

function corpusHashInput(corpus: Corpus, graduated: VaultGraduatedEntry[]): string {
  const docs = corpus.documents
    .map((d) => `${d.path}|${(d.sections ?? []).map((s) => s.id).join(',')}`)
    .sort()
    .join('\n');
  const glossary = (corpus.codex?.glossary ?? [])
    .map((g) => `${g.term}::${g.means}`)
    .sort()
    .join('\n');
  const grad = graduated
    .map((g) => `${g.candidate}::${g.oneLiner}::${g.confidence ?? 0}`)
    .sort()
    .join('\n');
  return `docs\n${docs}\nglossary\n${glossary}\ngraduated\n${grad}`;
}

export function emitCodex(corpus: Corpus, options: EmitOptions = {}): CodexEmission {
  const maxTokens = options.maxTokens ?? LIMITS.VAULT_CODEX.MAX_TOKENS;
  const graduatedMax = options.graduatedMaxTokens ?? LIMITS.VAULT_CODEX.GRADUATED_MAX_TOKENS;
  const rateRow = loadReferenceRates();
  const graduated = readVaultGraduated(corpus.dcpDir).entries;
  const gRender = renderGraduated(graduated, graduatedMax);

  const contentHashInput = corpusHashInput(corpus, graduated);
  const contentHash = sha16(contentHashInput);
  const prior = readCodexState(corpus.dcpDir);
  const priorPreservesContent = prior !== undefined && prior.contentHash === contentHash;
  const version = priorPreservesContent ? prior.version : (prior?.version ?? 0) + 1;
  const emittedAt = priorPreservesContent
    ? prior.emittedAt
    : new Date().toISOString();

  const header: string[] = [
    `# Redutok Vault: ${corpus.name}`,
    '',
    'Behavioral protocol:',
    ...PROTOCOL_LINES,
    '',
  ];
  const body: string[] = [
    ...header,
    ...renderCorpusMap(corpus),
    ...renderGlossary(corpus),
    ...gRender.block,
  ];
  const excludedNote =
    gRender.excluded.length > 0
      ? [
          '',
          `_${gRender.excluded.length} graduated ${gRender.excluded.length === 1 ? 'entry' : 'entries'} excluded to fit the graduated budget (lowest-confidence first)._`,
        ]
      : [];
  const footerLine = `<!-- redutok-vault codex v${version} hash=${contentHash} corpus=${corpus.name} model=${rateRow.referenceModel} generated=${emittedAt} -->`;

  let text = [...body, ...excludedNote, '', footerLine].join('\n');

  // Whole-block ceiling: if still over, degrade further by dropping the
  // lowest-confidence graduated entries (already the least-load-bearing
  // section, per the codex.ts DEGRADE_ORDER discipline).
  const stillIncluded = [...gRender.included];
  const stillExcluded = [...gRender.excluded];
  while (estimateTokens(text) > maxTokens && stillIncluded.length > 0) {
    const dropped = stillIncluded.pop();
    if (dropped !== undefined) stillExcluded.push(dropped);
    const survivors = graduated.filter((g) => stillIncluded.includes(g.candidate));
    const reRender = renderGraduated(survivors, graduatedMax);
    const reBody = [
      ...header,
      ...renderCorpusMap(corpus),
      ...renderGlossary(corpus),
      ...reRender.block,
    ];
    const reNote =
      stillExcluded.length > 0
        ? [
            '',
            `_${stillExcluded.length} graduated ${stillExcluded.length === 1 ? 'entry' : 'entries'} excluded to fit the graduated budget (lowest-confidence first)._`,
          ]
        : [];
    text = [...reBody, ...reNote, '', footerLine].join('\n');
  }

  const textHash = sha16(text);
  const state: CodexState = { version, contentHash, textHash, emittedAt, corpus: corpus.name };
  // Persist only when either the version changed or a prior state is absent;
  // otherwise the file already agrees and a rewrite would only churn mtime.
  if (
    prior === undefined ||
    prior.version !== version ||
    prior.contentHash !== contentHash ||
    prior.textHash !== textHash
  ) {
    writeCodexState(corpus.dcpDir, state);
  }
  return {
    text,
    version,
    textHash,
    corpus: corpus.name,
    emittedAt,
    rateRow,
    includedGraduated: stillIncluded,
    excludedGraduated: stillExcluded,
  };
}
