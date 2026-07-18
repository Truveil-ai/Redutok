import type { Report } from './report.js';

/**
 * SVG badge and one-line share format.
 * The grade is a placeholder until Phase 6 scoring lands; the share line
 * always ends with the product attribution.
 */

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function gradeText(report: Report): string {
  return report.scores.composite === undefined
    ? 'not scorable'
    : `grade ${report.scores.composite.grade}`;
}

export function renderBadgeSvg(report: Report): string {
  const label = 'redutok';
  const value = gradeText(report);
  const labelWidth = 62;
  const valueWidth = 12 + value.length * 7;
  const width = labelWidth + valueWidth;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${esc(`${label}: ${value}`)}">`,
    `  <rect width="${labelWidth}" height="20" fill="#555"/>`,
    `  <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="#9f9f9f"/>`,
    `  <g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle">`,
    `    <text x="${labelWidth / 2}" y="14">${esc(label)}</text>`,
    `    <text x="${labelWidth + valueWidth / 2}" y="14">${esc(value)}</text>`,
    `  </g>`,
    `</svg>`,
  ].join('\n');
}

export function renderShareLine(report: Report): string {
  const total = Math.round(report.grandTotal).toLocaleString('en-US');
  const e = report.energy;
  return (
    `${report.ledger.sessionId}: ${total} tokens, ` +
    `estimated ${e.wh.base.toFixed(2)} Wh (band ${e.wh.low.toFixed(2)} to ${e.wh.high.toFixed(2)}), ` +
    `${gradeText(report)}. Redutok by Truveil`
  );
}
