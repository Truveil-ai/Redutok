import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const readme = readFileSync(path.join(repoRoot, 'README.md'), 'utf8');

describe('README claim hygiene', () => {
  it('contains no forbidden claim phrases outside labelled context', () => {
    expect(readme.toLowerCase()).not.toContain('measured savings');
    for (const line of readme.split('\n')) {
      const lower = line.toLowerCase();
      if (lower.includes('guaranteed')) {
        expect(lower, `unlabelled guarantee: ${line}`).toContain('nothing here is guaranteed');
      }
      if (lower.includes('100x') || /\b\d+x\b/.test(lower)) {
        const labelled =
          lower.includes('fixture-measured') ||
          lower.includes('fixture size') ||
          lower.includes('| ') ||
          lower.includes('not session-level');
        expect(labelled, `unlabelled ratio claim: ${line}`).toBe(true);
      }
    }
  });

  it('keeps the house style and the attribution', () => {
    expect(readme).not.toMatch(/[—!]|\p{Extended_Pictographic}/u);
    expect(readme.trimEnd().endsWith('Redutok by Truveil.')).toBe(true);
  });
});
