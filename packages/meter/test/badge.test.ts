import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderBadgeSvg, renderShareLine } from '../src/badge.js';
import { buildReport } from '../src/report.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.join(here, '..', '..', '..', 'fixtures', 'sessions', name);

describe('renderBadgeSvg', () => {
  it('produces a well-formed svg with the grade placeholder', async () => {
    const svg = renderBadgeSvg(await buildReport(fixture('small.jsonl')));
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('redutok');
    // Real composite grade from Phase 6B scoring.
    expect(svg).toMatch(/grade [A-F]/);
    expect(svg).not.toMatch(/[—!]|\p{Extended_Pictographic}/u);
  });
});

describe('renderShareLine', () => {
  it('carries totals, the estimated band, and ends with the required suffix', async () => {
    const line = renderShareLine(await buildReport(fixture('small.jsonl')));
    expect(line).toContain('20,100 tokens');
    expect(line).toContain('estimated 6.03 Wh (band 2.01 to 20.10)');
    expect(line).toMatch(/grade [A-F]/);
    expect(line.endsWith('Redutok by Truveil')).toBe(true);
    expect(line).not.toMatch(/[—!]|\p{Extended_Pictographic}/u);
    expect(line.includes('\n')).toBe(false);
  });
});
