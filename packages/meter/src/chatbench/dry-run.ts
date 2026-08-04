import { estimateCostBand } from './matrix.js';
import type { CallSpec, ChatbenchConfig } from './types.js';

const fmt = (n: number): string => n.toLocaleString('en-US');
const usd = (n: number): string => `$${n.toFixed(4)}`;

/**
 * Founder-facing preview. Enumerates per-corpus per-arm call counts and
 * token totals, then bounds the spend so the founder can approve or
 * refuse the live run.
 */
export function renderDryRun(
  cfg: ChatbenchConfig,
  matrix: CallSpec[],
  rates: { inputPerMTokUsd: number; outputPerMTokUsd: number },
): string {
  const lines: string[] = [
    `chatbench dry-run (registration ${cfg.registrationId}, model ${cfg.model})`,
    `  matrix size: ${fmt(matrix.length)} calls across ${fmt(cfg.corpora.length)} corpora, ${fmt(cfg.replications)} replications`,
    `  rate: input $${rates.inputPerMTokUsd.toFixed(2)}/MTok, output $${rates.outputPerMTokUsd.toFixed(2)}/MTok`,
    '',
  ];
  let totalMinUsd = 0;
  let totalMaxUsd = 0;
  for (const corpus of cfg.corpora) {
    const corpusRows = matrix.filter((r) => r.corpusId === corpus.id);
    if (corpusRows.length === 0) continue;
    lines.push(`corpus: ${corpus.id}  (${corpus.label})`);
    for (const arm of ['paste', 'vault'] as const) {
      const armRows = corpusRows.filter((r) => r.arm === arm);
      const minIn = armRows.reduce((s, r) => s + r.minInputTokens, 0);
      const maxIn = armRows.reduce((s, r) => s + r.maxInputTokens, 0);
      const maxOut = armRows.reduce((s, r) => s + r.maxOutputTokens, 0);
      let armMinUsd = 0;
      let armMaxUsd = 0;
      for (const r of armRows) {
        const band = estimateCostBand(r, rates.inputPerMTokUsd, rates.outputPerMTokUsd);
        armMinUsd += band.minUsd;
        armMaxUsd += band.maxUsd;
      }
      totalMinUsd += armMinUsd;
      totalMaxUsd += armMaxUsd;
      lines.push(
        `  ${arm}: ${fmt(armRows.length)} calls, input ${fmt(minIn)}-${fmt(maxIn)} tok, output up to ${fmt(maxOut)} tok, cost band ${usd(armMinUsd)}-${usd(armMaxUsd)}`,
      );
    }
    lines.push('');
  }
  lines.push(
    `total cost band: ${usd(totalMinUsd)} - ${usd(totalMaxUsd)}`,
    'note: ' + cfg.dryRun.tokenEstimatorNote,
  );
  return lines.join('\n');
}
