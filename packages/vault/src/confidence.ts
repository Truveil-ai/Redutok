import { askKeywords, parseSectionRefs, type Dossier, type HeadingMatch } from '@redutok/sidecar';

/**
 * Retrieval confidence, the accounting-honesty counterpart to the reduction
 * figure (field failure vault-ask-retrieval-gap: 200-500x reduction reported
 * on six consecutive wrong answers). Deterministic, computed from what the
 * ask actually resolved: heading-match strength, section references resolved,
 * question-term coverage of the evidence, and whether the internal
 * exploration finished. Reduction measures compression; this measures
 * whether the dossier is even about the question.
 */

export type ConfidenceBand = 'high' | 'medium' | 'low';

export interface AskConfidence {
  band: ConfidenceBand;
  headingMatch: HeadingMatch;
  /** Section references named by the question, and how many resolved. */
  sectionRefs: number;
  resolvedRefs: number;
  /** Significant question terms, and how many appear in the evidence. */
  termsMatched: number;
  termsTotal: number;
  incomplete: boolean;
  /** Plain-language grounds for a non-high band, for the dossier notice. */
  reasons: string[];
}

export function assessAskConfidence(question: string, dossier: Dossier): AskConfidence {
  const refs = parseSectionRefs(question);
  const sectionRefs = dossier.retrieval?.sectionRefs.length ?? refs.length;
  const resolvedRefs = dossier.retrieval?.resolvedRefs ?? 0;
  const headingMatch = dossier.retrieval?.headingMatch ?? 'none';
  const terms = [...new Set([...askKeywords(question), ...refs.map((r) => r.number)])];
  const evidenceText = dossier.evidence
    .map((e) => `${e.file} ${e.snippet} ${e.why}`)
    .join('\n')
    .toLowerCase();
  const termsMatched = terms.filter((t) => evidenceText.includes(t.toLowerCase())).length;
  const termsTotal = terms.length;
  const coverage = termsTotal === 0 ? 1 : termsMatched / termsTotal;
  const incomplete = dossier.incomplete !== undefined;

  const reasons: string[] = [];
  let band: ConfidenceBand;
  if (dossier.evidence.length === 0) {
    band = 'low';
    reasons.push('no evidence was found for the question');
  } else if (sectionRefs > 0 && resolvedRefs === 0) {
    band = 'low';
    reasons.push(
      `the question names ${sectionRefs} section reference(s) but none resolved to a section in the corpus`,
    );
  } else {
    const anchored = resolvedRefs > 0 || headingMatch === 'exact' || headingMatch === 'strong';
    if (anchored && coverage >= 0.5) band = 'high';
    else if (!anchored && headingMatch === 'none' && coverage < 0.5) band = 'low';
    else band = 'medium';
    if (!anchored && headingMatch === 'none') reasons.push('no section heading matches the question');
    if (coverage < 0.5) {
      reasons.push(`only ${termsMatched} of ${termsTotal} question terms appear in the evidence`);
    }
  }
  // A reference that matched several sections was answered from one of them.
  // resolvedRefs counts it fully resolved, which alone would read as high
  // confidence on a section the reader never asked for (field failure,
  // corpus idf 2026-08-02), so an undiscriminated collision holds the band
  // down and says why.
  const undiscriminated = (dossier.ambiguity ?? []).filter((a) => !a.discriminated);
  if (undiscriminated.length > 0) {
    if (band === 'high') band = 'medium';
    for (const a of undiscriminated) {
      reasons.push(
        `"${a.ref}" matches ${a.candidates.length + 1} sections in ${a.document} and the question named nothing that separates them`,
      );
    }
  }
  if (incomplete) {
    band = band === 'high' ? 'medium' : 'low';
    reasons.push('the internal exploration ended incomplete');
  }
  return { band, headingMatch, sectionRefs, resolvedRefs, termsMatched, termsTotal, incomplete, reasons };
}

/**
 * The plain-language warning that leads a low-confidence dossier. It exists
 * to break the one dishonest reading: a green reduction ratio presented
 * above a wrong answer.
 */
export function renderLowConfidenceNotice(c: AskConfidence): string {
  const grounds = c.reasons.length === 0 ? 'the retrieval signals are weak' : c.reasons.join('; ');
  return (
    `[retrieval confidence: LOW — ${grounds}. Treat this dossier as a lead, not an answer: ` +
    `the reduction figure below measures compression, not retrieval quality. Verify with ` +
    `vault_zoom on a section reference, or rephrase the question naming the exact section.]`
  );
}

/** The accounting-block line: the band plus the inputs that produced it. */
export function renderConfidenceLine(c: AskConfidence): string {
  const refPart = c.sectionRefs === 0 ? '' : `; ${c.resolvedRefs}/${c.sectionRefs} section refs resolved`;
  return (
    `  confidence   ${c.band} (heading match ${c.headingMatch}; ` +
    `${c.termsMatched}/${c.termsTotal} question terms in evidence${refPart}; ` +
    `dossier ${c.incomplete ? 'incomplete' : 'complete'})`
  );
}
