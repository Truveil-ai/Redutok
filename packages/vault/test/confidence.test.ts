import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore plain-mjs fixture generator, no type declarations
import { makePdf } from '../../../scripts/doc-fixtures.mjs';
import { assessAskConfidence } from '../src/confidence.js';
import { mountCorpus, type Corpus } from '../src/corpus.js';
import { runIngest } from '../src/ingest.js';
import {
  buildVaultReceipt,
  newVaultSession,
  renderVaultReceipt,
  vaultAsk,
  vaultZoom,
} from '../src/tools.js';
import { monorepoRoot } from './helpers.js';

/**
 * Accounting honesty (field failure vault-ask-retrieval-gap): six wrong
 * answers each reported 200-500x reduction. Reduction is compression, not
 * quality — every dossier now carries a deterministic retrieval-confidence
 * assessment, every ledger line records the band, and the receipt reports
 * asks by band.
 */

let root: string;
let corpus: Corpus;
let corpora: Map<string, Corpus>;

beforeAll(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'vault-confidence-'));
  writeFileSync(
    path.join(root, 'uspto-examples.pdf'),
    makePdf({
      title: 'Subject Matter Eligibility Examples',
      sections: [
        {
          heading: '2. Diagnostic Method Using A Blue Noise Mask',
          paragraphs: [
            'The claim recites detecting eligibility of a sample using a blue noise mask. Eligibility analysis: the claim is directed to an abstract idea.',
          ],
        },
        {
          heading: '21. Transmission Of Stock Quote Data',
          paragraphs: [
            'In SimpleAir, Inc. v. Sony Ericsson Mobile Communications AB, the Federal Circuit considered analogous claims to transmitting data alerts.',
            'Claim 2 is eligible: the stock quote alert eligibility limitation integrates the idea into a practical application by activating the subscriber device on the alert threshold.',
          ],
        },
      ],
    }),
  );
  mkdirSync(path.join(root, '.dcp'));
  writeFileSync(
    path.join(root, '.dcp', 'config.json'),
    `${JSON.stringify({ port: 48642, profilesDir: path.join(monorepoRoot, 'profiles') }, null, 2)}\n`,
    'utf8',
  );
  await runIngest(root, { corpus: 'confidence-test' });
  corpus = mountCorpus(root, { name: 'confidence-test' });
  corpora = new Map([[corpus.name, corpus]]);
}, 60_000);

afterAll(() => {
  corpus.store.close();
  corpus.ledger.close();
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // leave it to the OS temp cleaner
  }
});

describe('a deliberately mismatched ask yields a low-confidence dossier', () => {
  it('renders the plain-language notice at the top, regardless of reduction', async () => {
    const session = newVaultSession('confidence-mismatch');
    const text = await vaultAsk(corpora, session, {
      question: 'What does Example 99 conclude about quantum basket weaving?',
    });
    // The notice leads the dossier...
    expect(text.split('\n')[0]).toContain('retrieval confidence: LOW');
    // ...and names the failure in plain language, not a score.
    expect(text).toMatch(/measures compression, not retrieval quality/);
    // The accounting block still reports a reduction figure: the point is
    // that a green ratio must never be readable as answer quality.
    expect(text).toContain('[vault accounting: ask');
    expect(text).toMatch(/confidence\s+low/);
  });

  it('a well-targeted ask reports high confidence and no notice', async () => {
    const session = newVaultSession('confidence-match');
    const text = await vaultAsk(corpora, session, {
      question: 'What does Example 21 hold about stock quote alert eligibility?',
    });
    expect(text).not.toContain('retrieval confidence: LOW');
    expect(text).toMatch(/confidence\s+high/);
  });
});

describe('every ledger line records its confidence band', () => {
  it('ask and serve lines carry the ask band; zoom lines grade the query', async () => {
    const session = newVaultSession('confidence-ledger');
    await vaultAsk(corpora, session, {
      question: 'What does Example 99 conclude about quantum basket weaving?',
    });
    const entry = corpus.documents.find((d) => d.path === 'uspto-examples.pdf');
    if (entry?.artifactId === undefined) throw new Error('fixture not ingested');
    vaultZoom(corpora, session, { handle: entry.artifactId, query: '§21' });
    vaultZoom(corpora, session, { handle: entry.artifactId, query: 'zebra-nonsense-term' });
    const lines = corpus.ledger.lines({ sessionId: session.id });
    const asks = lines.filter((l) => l.kind === 'ask');
    const serves = lines.filter((l) => l.kind === 'serve');
    const zooms = lines.filter((l) => l.kind === 'zoom');
    expect(asks.length).toBe(1);
    expect(asks[0]?.confidence).toBe('low');
    expect(serves.length).toBeGreaterThan(0);
    for (const serve of serves) expect(serve.confidence).toBe('low');
    expect(zooms.map((z) => z.confidence)).toEqual(['high', 'low']);
  });
});

describe('the receipt reports asks by confidence band', () => {
  it('rollup and rendering carry the band counts', async () => {
    const session = newVaultSession('confidence-receipt');
    await vaultAsk(corpora, session, {
      question: 'What does Example 99 conclude about quantum basket weaving?',
    });
    await vaultAsk(corpora, session, {
      question: 'What does Example 21 hold about stock quote alert eligibility?',
    });
    const rollup = buildVaultReceipt(corpus, session.id);
    expect(rollup.asksByConfidence.low).toBeGreaterThanOrEqual(1);
    expect(rollup.asksByConfidence.high).toBeGreaterThanOrEqual(1);
    const rendered = renderVaultReceipt(rollup);
    expect(rendered).toMatch(/asks by confidence\s+\d+ high \/ \d+ medium \/ \d+ low/);
  });
});

describe('assessAskConfidence is deterministic on dossier inputs', () => {
  it('unresolved section references force low confidence whatever the evidence volume', () => {
    const confidence = assessAskConfidence('What does Example 99 say?', {
      verdict: 'plausible-sounding text',
      evidence: [
        { file: 'a.pdf', line: 1, snippet: 'example example example', why: '§s1 "Examples"' },
      ],
      zoomHandles: [],
      stepsTaken: 3,
      distillationRatio: 400,
      retrieval: { sectionRefs: ['Example 99'], resolvedRefs: 0, headingMatch: 'partial' },
    });
    expect(confidence.band).toBe('low');
    expect(confidence.reasons.join(' ')).toContain('none resolved');
  });

  it('an empty-evidence dossier is low; a resolved-ref covered dossier is high', () => {
    const empty = assessAskConfidence('anything at all', {
      verdict: '',
      evidence: [],
      zoomHandles: [],
      stepsTaken: 1,
      distillationRatio: 0,
    });
    expect(empty.band).toBe('low');
    const good = assessAskConfidence('What does Example 21 hold about stock quote alert eligibility?', {
      verdict: 'answered',
      evidence: [
        {
          file: 'uspto-examples.pdf',
          line: 8,
          snippet: '21. Transmission Of Stock Quote Data',
          why: '§21 "Transmission Of Stock Quote Data", p.2 — heading match (ref)',
        },
        {
          file: 'uspto-examples.pdf',
          line: 13,
          snippet: 'Claim 2 is eligible: the stock quote alert eligibility limitation',
          why: '§21 "Transmission Of Stock Quote Data", p.2',
        },
      ],
      zoomHandles: [],
      stepsTaken: 3,
      distillationRatio: 40,
      retrieval: { sectionRefs: ['Example 21'], resolvedRefs: 1, headingMatch: 'exact' },
    });
    expect(good.band).toBe('high');
  });

  it('an incomplete dossier demotes one band', () => {
    const demoted = assessAskConfidence('What does Example 21 hold about stock quote alert eligibility?', {
      verdict: 'answered',
      evidence: [
        {
          file: 'uspto-examples.pdf',
          line: 8,
          snippet: '21. Transmission Of Stock Quote Data',
          why: '§21 "Transmission Of Stock Quote Data", p.2 — heading match (ref)',
        },
        {
          file: 'uspto-examples.pdf',
          line: 13,
          snippet: 'Claim 2 is eligible: the stock quote alert eligibility limitation',
          why: '§21 "Transmission Of Stock Quote Data", p.2',
        },
      ],
      zoomHandles: [],
      stepsTaken: 3,
      distillationRatio: 40,
      incomplete: { reason: 'wall-clock budget exceeded', continuationHint: 'raise budget' },
      retrieval: { sectionRefs: ['Example 21'], resolvedRefs: 1, headingMatch: 'exact' },
    });
    expect(demoted.band).toBe('medium');
  });
});
