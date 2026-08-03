import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const readme = readFileSync(path.join(repoRoot, 'README.md'), 'utf8');

// A ratio is only citable next to the scope it was measured at. Any line
// carrying an Nx figure must name one of these, or sit inside a table whose
// header carries it.
const RATIO_LABELS = [
  'fixture-measured',
  'fixture size',
  'not session-level',
  'per-artifact',
  'live audit',
  'session level',
  'field session',
  'pre-registered bar',
  '| ',
];

describe('README claim hygiene', () => {
  it('contains no forbidden claim phrases outside labelled context', () => {
    expect(readme.toLowerCase()).not.toContain('measured savings');
    expect(readme.toLowerCase()).not.toContain('proven savings');
    for (const line of readme.split('\n')) {
      const lower = line.toLowerCase();
      if (lower.includes('guaranteed')) {
        expect(lower, `unlabelled guarantee: ${line}`).toContain('nothing here is guaranteed');
      }
      if (lower.includes('100x') || /\b\d+x\b/.test(lower)) {
        const labelled = RATIO_LABELS.some((label) => lower.includes(label));
        expect(labelled, `unlabelled ratio claim: ${line}`).toBe(true);
      }
      // The 10x Definition of Done has never been met. A line citing it must
      // say so; meeting it is a deliberate edit here, not a silent one.
      if (lower.includes('10x')) {
        expect(lower, `10x cited without its verdict: ${line}`).toContain('not met');
      }
    }
  });

  // Sentence-level checks. Wrapping splits a claim across lines, so these read
  // the flowed text and look at one sentence at a time.
  const sentences = readme
    .replace(/\s+/g, ' ')
    .split(/(?<=\.) /)
    .map((s) => s.toLowerCase());

  it('never presents a cost avoided figure as anything but an estimate', () => {
    for (const sentence of sentences) {
      if (sentence.includes('usd') && sentence.includes('avoided')) {
        expect(sentence, `unestimated cost-avoided claim: ${sentence}`).toContain('estimat');
      }
    }
  });

  it('never presents energy or carbon as measured', () => {
    // Nothing in this project measures energy. Every Wh and CO2 figure is a
    // banded estimate, and the README has to say so wherever it mentions one.
    for (const sentence of sentences) {
      if (sentence.includes('co2') || sentence.includes('watt-hour')) {
        const hedged = sentence.includes('band') || sentence.includes('estimat');
        expect(hedged, `energy stated as measured: ${sentence}`).toBe(true);
      }
    }
  });

  /**
   * This guard used to require the README to say the npm package was a
   * placeholder wherever it told you to npx it. redutok@0.1.0 is published, so
   * that warning is now false -- but the hazard it guarded against is not
   * gone, it moved: `npx redutok init` on its own still writes a setup that
   * cannot run, because npx executes from a temp cache the launchers can never
   * resolve. Same rule, current hazard: never hand out the npx instruction
   * without the install that makes it work.
   */
  it('pairs every npx redutok init instruction with installing into the project', () => {
    if (readme.includes('npx redutok init')) {
      expect(readme).toContain('npm install --save-dev redutok');
    }
    expect(readme, 'the placeholder warning is stale; 0.1.0 is published').not.toContain(
      'placeholder release',
    );
  });

  it('never claims a chat-savings multiple before the chatbench has run', () => {
    // Wrapping is a formatting choice; the sentence has to survive it.
    const flowed = readme.replace(/\s+/g, ' ');
    expect(flowed).toContain('No chat-savings multiple is claimed until it runs.');
  });

  it('states where the tool does not help', () => {
    expect(readme).toContain('Where Redutok does not help');
  });

  it('keeps the house style and the attribution', () => {
    expect(readme).not.toMatch(/[—!]|\p{Extended_Pictographic}/u);
    expect(readme.trimEnd().endsWith('Redutok by Truveil.')).toBe(true);
  });
});
