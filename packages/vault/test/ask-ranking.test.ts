import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore plain-mjs fixture generator, no type declarations
import { makePdf } from '../../../scripts/doc-fixtures.mjs';
import { mountCorpus, type Corpus } from '../src/corpus.js';
import { runIngest } from '../src/ingest.js';
import { newVaultSession, vaultAsk } from '../src/tools.js';
import { monorepoRoot } from './helpers.js';

/**
 * End-to-end regression for the idf-corpus retrieval failure (memory:
 * vault-ask-retrieval-gap): every phrasing that named USPTO Example 21 must
 * surface §21 of the right document, against a decoy document dense in the
 * generic terms (claim, eligibility, abstract) that used to win.
 */

let root: string;
let corpus: Corpus;
let corpora: Map<string, Corpus>;

beforeAll(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'vault-ask-ranking-'));
  writeFileSync(
    path.join(root, 'uspto-examples.pdf'),
    makePdf({
      title: 'Subject Matter Eligibility Examples',
      pageBreaks: [1],
      sections: [
        {
          heading: '2. Diagnostic Method Using A Blue Noise Mask',
          paragraphs: [
            'The claim recites detecting eligibility of a sample using a blue noise mask. Eligibility analysis: the claim is directed to an abstract idea. Claim after claim, the eligibility discussion repeats eligibility, abstract, and claim.',
          ],
        },
        {
          heading: '21. Transmission Of Stock Quote Data',
          paragraphs: [
            'Background: a system transmits stock quote data to a remote subscriber device.',
            'In SimpleAir, Inc. v. Sony Ericsson Mobile Communications AB, the Federal Circuit considered analogous claims to transmitting data alerts.',
            'Claim 1 is ineligible because it recites the abstract idea of delivering information.',
            'Claim 2 is eligible: the stock quote alert eligibility limitation integrates the idea into a practical application by activating the subscriber device on the alert threshold.',
          ],
        },
      ],
    }),
  );
  writeFileSync(
    path.join(root, 'bio-disclosure.txt'),
    [
      '1. Sequencing Disclosure',
      'This disclosure describes claim eligibility for a biotech abstract. Claim eligibility,',
      'claim eligibility, abstract claim, eligibility of the claim, and more eligibility talk.',
      'Every line repeats eligibility and claim and abstract and data to win a frequency contest.',
      'Stock phrases about quote handling appear here too: stock, quote, stock, quote, alert.',
    ].join('\n'),
    'utf8',
  );
  mkdirSync(path.join(root, '.dcp'));
  writeFileSync(
    path.join(root, '.dcp', 'config.json'),
    `${JSON.stringify({ port: 48642, profilesDir: path.join(monorepoRoot, 'profiles') }, null, 2)}\n`,
    'utf8',
  );
  await runIngest(root, { corpus: 'idf-regression' });
  corpus = mountCorpus(root, { name: 'idf-regression' });
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

/** The evidence bullet lines of a rendered dossier. */
const evidenceLines = (text: string): string[] =>
  text.split('\n').filter((l) => l.startsWith('- ') && !l.startsWith('- vault_zoom'));

describe('vault_ask targets a section named by the question', () => {
  const phrasings = [
    'What does Example 21 hold about stock quote alert eligibility?',
    'Summarize §21 of the eligibility examples.',
    'What is the holding in the section titled Transmission Of Stock Quote Data?',
    'stock quote alert eligibility',
  ];

  it.each(phrasings)('surfaces §21 of uspto-examples.pdf for: %s', async (question) => {
    const session = newVaultSession(`ask-ranking-${phrasings.indexOf(question)}`);
    const text = await vaultAsk(corpora, session, { question });
    const evidence = evidenceLines(text);
    expect(evidence.length).toBeGreaterThan(0);
    // The top evidence cites the right document and the right section.
    expect(evidence[0]).toContain('uspto-examples.pdf');
    expect(evidence[0]).toContain('§21');
    expect(text).toContain('Transmission Of Stock Quote Data');
  });

  it('the section ingested with the enumeration id the asks target', () => {
    const entry = corpus.documents.find((d) => d.path === 'uspto-examples.pdf');
    expect(entry?.sections.map((s) => s.id)).toContain('21');
  });
});
