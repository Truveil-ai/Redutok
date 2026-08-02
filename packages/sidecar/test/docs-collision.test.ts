import { describe, expect, it } from 'vitest';
import {
  buildStructureMap,
  extractDocument,
  resolveSectionRefs,
  runningHeaders,
  parseSectionRefs,
  scoreSections,
  type DocSection,
} from '../src/docs.js';
import { NoopLlmPass } from '../src/llm.js';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore plain-mjs fixture generator, no type declarations
import { makeCollidingExamplesPdf } from '../../../scripts/doc-fixtures.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Heading-collision disambiguation (field failure, corpus idf 2026-08-02):
 * the USPTO examples PDF numbers its examples from 1 in every part, so
 * "Example 5" names Digital Image Processing under Examples: Abstract Ideas
 * AND Genetically Modified Bacterium under Nature-Based Products. Both tie
 * at the reference tier, and the tie used to fall to body keyword volume —
 * which the bacterium's eligibility boilerplate wins. A collision must be
 * resolved on document part context, and disclosed when the ask does not
 * discriminate.
 */

let cached: { text: string; sections: DocSection[] } | undefined;

async function collidingDoc(): Promise<{ text: string; sections: DocSection[] }> {
  if (cached !== undefined) return cached;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'docs-collision-'));
  const file = path.join(dir, 'uspto-collisions.pdf');
  writeFileSync(file, makeCollidingExamplesPdf());
  const extraction = await extractDocument(file);
  const sections = await buildStructureMap(extraction, new NoopLlmPass());
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  cached = { text: extraction.text, sections };
  return cached;
}

const byId = (sections: DocSection[], id: string): DocSection => {
  const found = sections.find((s) => s.id === id);
  if (found === undefined) throw new Error(`no section ${id} in [${sections.map((s) => s.id).join(', ')}]`);
  return found;
};

describe('running page headers become section part context', () => {
  it('keeps a header repeated across pages and drops one-off first lines', async () => {
    const { text } = await collidingDoc();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'docs-collision-pages-'));
    const file = path.join(dir, 'uspto-collisions.pdf');
    writeFileSync(file, makeCollidingExamplesPdf());
    const extraction = await extractDocument(file);
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    expect(extraction.text).toBe(text);
    const headers = runningHeaders(extraction.text, extraction.pages ?? []);
    expect(headers.get(1)).toBe('Examples: Abstract Ideas');
    expect(headers.get(3)).toBe('Examples: Abstract Ideas');
    expect(headers.get(4)).toBe('Nature-Based Products');
    expect(headers.get(5)).toBe('Nature-Based Products');
  });

  it('stamps each section with the part its page belongs to', async () => {
    const { sections } = await collidingDoc();
    expect(byId(sections, '5').context).toBe('Examples: Abstract Ideas');
    expect(byId(sections, '5-2').context).toBe('Nature-Based Products');
    expect(byId(sections, '3').context).toBe('Examples: Abstract Ideas');
    expect(byId(sections, '3-2').context).toBe('Nature-Based Products');
  });
});

describe('resolveSectionRefs disambiguates a colliding enumeration', () => {
  it('reports every candidate for a bare reference and chooses document order', async () => {
    const { sections } = await collidingDoc();
    const ask = 'What is the analysis in Example 5 about claim eligibility?';
    const [resolution] = resolveSectionRefs(sections, parseSectionRefs(ask), ask);
    expect(resolution).toBeDefined();
    expect(resolution?.candidates.map((c) => c.id)).toEqual(['5', '5-2']);
    // The un-suffixed id is the document's first Example 5 — the reading a
    // professional means by a bare "Example 5".
    expect(resolution?.chosen.id).toBe('5');
    expect(resolution?.chosen.title).toBe('Digital Image Processing');
    // Nothing in the ask separated the two, so the choice is disclosed.
    expect(resolution?.discriminated).toBe(false);
  });

  it('lets part context in the ask pick the other candidate', async () => {
    const { sections } = await collidingDoc();
    const ask = 'What does Example 5 of the Nature-Based Products examples hold?';
    const [resolution] = resolveSectionRefs(sections, parseSectionRefs(ask), ask);
    expect(resolution?.chosen.id).toBe('5-2');
    expect(resolution?.discriminated).toBe(true);
  });

  it('lets the section title in the ask pick a candidate', async () => {
    const { sections } = await collidingDoc();
    const ask = 'Example 5, the genetically modified bacterium';
    const [resolution] = resolveSectionRefs(sections, parseSectionRefs(ask), ask);
    expect(resolution?.chosen.id).toBe('5-2');
    expect(resolution?.discriminated).toBe(true);
  });

  it('reports a single-candidate reference as unambiguous', async () => {
    const { sections } = await collidingDoc();
    const ask = 'Example 1 malicious code';
    const [resolution] = resolveSectionRefs(sections, parseSectionRefs(ask), ask);
    expect(resolution?.candidates).toHaveLength(1);
    expect(resolution?.discriminated).toBe(true);
  });
});

describe('scoreSections ranks the chosen candidate above its collisions', () => {
  it('outranks a keyword-dense colliding section on identity, not volume', async () => {
    const { text, sections } = await collidingDoc();
    const ask = 'What is the analysis in Example 5 about claim eligibility?';
    const scored = scoreSections(text, sections, ask);
    const chosen = scored.find((s) => s.section.id === '5');
    const other = scored.find((s) => s.section.id === '5-2');
    expect(chosen?.tier).toBe('ref');
    expect(other?.tier).toBe('ref');
    // The pre-fix ordering: the bacterium's boilerplate wins on body volume.
    expect((other?.bodyScore ?? 0)).toBeGreaterThan(chosen?.bodyScore ?? 0);
    // The fix: reference rank decides between two reference matches.
    expect(chosen?.refRank).toBeGreaterThan(other?.refRank ?? 0);
    const ranked = [...scored].sort(
      (a, b) => b.refRank - a.refRank || b.bodyScore - a.bodyScore,
    );
    expect(ranked[0]?.section.id).toBe('5');
  });
});
