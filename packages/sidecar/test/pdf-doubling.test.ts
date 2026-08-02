import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore plain-mjs fixture generator, no type declarations
import { makeRawStreamPdf } from '../../../scripts/doc-fixtures.mjs';
import { buildStructureMap, extractDocument } from '../src/docs.js';
import { NoopLlmPass } from '../src/llm.js';

/**
 * Clipped double-draw de-duplication (field failure, corpus idf 2026-08-02:
 * page 14 extracted "claimm is directedd" and "Claim 100" for "Claim 10").
 *
 * The cause is in the document, not the CMap: page 14 paints every glyph
 * that straddles a clip-region boundary TWICE, once inside each clip, at the
 * same baseline and within a tenth of a point of the same x. A renderer
 * shows one because each draw is clipped; a position-blind extractor
 * concatenates both. pypdf 6.10.2 doubles them too, so the reference
 * extraction is a volume baseline here, not the expected text.
 */

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const noop = new NoopLlmPass();

/** The page-14 operator shape, verbatim in form: a whole-word show, then the
 * straddling glyph drawn once per clip region, then the rest of the line. */
function doubledLineStream(): string {
  const show = (x: number, y: number, text: string): string =>
    `BT\n/TT0 11 Tf\n1 0 0 1 ${x} ${y} Tm\n(${text}) Tj\nET`;
  const clipped = (clip: string, x: number, y: number, text: string): string =>
    `q\n${clip} re\nW n\n${show(x, y, text)}\nQ`;
  return [
    show(72.12, 195.42, 'The clai'),
    clipped('72.12 192.72 42.24 13.5', 111.18, 195.42, 'm'),
    clipped('114.36 192.72 57.18 13.5', 111.06, 195.42, 'm'),
    show(120.3, 195.42, ' is directe'),
    clipped('163.8 192.72 42.24 13.5', 167.04, 195.42, 'd'),
    clipped('167.1 192.72 57.18 13.5', 166.92, 195.42, 'd'),
    show(172.92, 195.42, ' to a statutory category.'),
    show(72.12, 215.22, 'Claim 1'),
    clipped('72.12 212.52 42.24 13.5', 110.4, 215.22, '0'),
    clipped('110.5 212.52 57.18 13.5', 110.28, 215.22, '0'),
    show(116.28, 215.22, ': Ineligible'),
    // A genuine repeated character advances by a glyph width, never by a
    // tenth of a point: "1000" must survive intact.
    show(72.12, 235.02, 'Claim 1'),
    show(78.0, 235.02, '0'),
    show(83.88, 235.02, '0'),
    show(89.76, 235.02, '0'),
  ].join('\n');
}

describe('a glyph painted once per clip region is extracted once', () => {
  let dir: string;
  let file: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'pdf-doubling-'));
    file = path.join(dir, 'clipped.pdf');
    writeFileSync(file, makeRawStreamPdf([doubledLineStream()]));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('recovers the words, not doubled letters', async () => {
    const { text } = await extractDocument(file);
    expect(text).toContain('The claim is directed to a statutory category.');
    expect(text).not.toContain('claimm');
    expect(text).not.toContain('directedd');
  });

  it('keeps a number that only looks like a doubled glyph', async () => {
    const { text } = await extractDocument(file);
    expect(text).toContain('Claim 10: Ineligible');
    expect(text).not.toContain('Claim 100:');
    // Four shows spaced a real glyph width apart are four real characters.
    expect(text).toContain('Claim 1000');
  });
});

describe('USPTO page 14 (real fixture) extracts clean', () => {
  const pdf = path.join(fixtures, 'uspto-101-p14.pdf');
  let text: string;

  beforeAll(async () => {
    text = (await extractDocument(pdf)).text;
  });

  it('reads the running header the other pages carry', () => {
    expect(text).toContain('Examples: Abstract Ideas');
    expect(text).not.toContain('Exampless');
    expect(text).not.toContain('Abstractt');
  });

  it('reads the body prose without doubled letters', () => {
    expect(text).toContain('In this invention, as seen in Fig. 1 reproduced below');
    expect(text).toContain('a device profile is created based on');
    for (const doubled of ['innvention', 'sseen', 'reproducedd', 'ddevice', 'profilee', 'bbased']) {
      expect(text, `page 14 must not contain "${doubled}"`).not.toContain(doubled);
    }
  });

  it('reads the claim heading and its analysis line', () => {
    expect(text).toContain('Claim 10');
    expect(text).not.toContain('Claim 100');
    expect(text).toContain('The claim is directed');
    expect(text).not.toContain('claimm');
  });

  it('sections the page under the enumeration a citation uses', async () => {
    const extraction = await extractDocument(pdf);
    const sections = await buildStructureMap(extraction, noop);
    const claim = sections.find((s) => s.id === 'claim-10');
    expect(claim, `sections: ${sections.map((s) => s.id).join(', ')}`).toBeDefined();
  });

  it('carries the ink of the pypdf reference, minus the doubled glyphs', () => {
    const ref = readFileSync(path.join(fixtures, 'uspto-101-p14.ref.txt'), 'utf8')
      .split('\n')
      .filter((l) => !l.startsWith('#'))
      .join('\n');
    const ink = (s: string): number => s.replace(/\s+/g, '').length;
    const ours = ink(text);
    const theirs = ink(ref);
    // pypdf doubles the clipped glyphs, so a correct extraction is strictly
    // lighter — but only by those glyphs, never by whole words.
    expect(ours).toBeLessThan(theirs);
    expect(ours).toBeGreaterThan(Math.floor(theirs * 0.9));
  });
});
