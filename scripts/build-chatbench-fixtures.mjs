#!/usr/bin/env node
// Materialise the PDF + DOCX extensions to fixtures/doc-corpus that the
// chatbench needs, plus their pre-extracted plaintext shadows.
//
// The .extracted.txt shadows are the source of truth for the PASTE arm's
// prompt assembly (deterministic byte count, no runtime extractor dep).
// Regenerate whenever the source text below changes; commit the outputs.
//
// Run: node scripts/build-chatbench-fixtures.mjs
// Deps: pdfkit, docx (root devDependencies).

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { Document, Packer, Paragraph, TextRun } from 'docx';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CORPUS_DIR = join(ROOT, 'fixtures', 'doc-corpus');

const ENGAGEMENT_LETTER_TEXT = `MERIDIAN VALUATION ENGAGEMENT LETTER

Section 1. Effective Date
This engagement takes effect on January 15, 2026.

Section 2. Scope of Work
The Practice will prepare a fair market value opinion of the Meridian
intellectual property portfolio, delivered as a signed valuation report
addressed to Meridian's board of directors.

Section 3. Fees and Installments
The fixed fee for the engagement is USD 48,000, payable in twelve equal
monthly installments in accordance with the Practice's Billing Policy.
Installments are invoiced monthly in arrears alongside any allowable
disbursements at cost.

Section 4. Suspension
The Practice may suspend work under this engagement when an invoice is
more than 60 days overdue. Suspension is lifted on payment in full of
the overdue balance together with any accrued late-payment interest at
the Billing Policy rate.

Section 5. Termination
Either party may terminate this engagement on 30 days written notice.
On termination the Practice will deliver all workpapers prepared to date
and issue a final invoice for work performed through the effective
termination date.
`;

const QUALITY_REVIEW_TEXT = `Quality Review Checklist

1. Purpose
This checklist governs the Practice's internal review of every
valuation engagement before the signed report is issued to a client.

2. Concurring Partner Review
Every engagement that yields a Fair Market Value opinion above
USD 10,000,000 requires review and written concurrence by a partner
who is not the engagement partner. Concurrence is recorded in the
engagement workpapers before the report is signed. The threshold is
reviewed annually by the managing partner.

3. Independence Attestation
An independence attestation is refreshed annually for every partner
and manager on the engagement team, and the signed attestation is
archived with the client acceptance record.

4. Client-File Sign-Off
The engagement partner signs off the client file within 30 days of
report issuance. A missed sign-off is escalated to the managing
partner and logged in the quality-review register.

5. Draft-Report Review
Two-partner sign-off is required before any draft report leaves the
Practice, in addition to the concurring review under Section 2 where
that threshold applies.
`;

async function writePdf(path, text) {
  const doc = new PDFDocument({ margin: 54 });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((res) => doc.on('end', res));
  doc.font('Times-Roman').fontSize(12).text(text, { align: 'left' });
  doc.end();
  await done;
  await writeFile(path, Buffer.concat(chunks));
}

async function writeDocx(path, text) {
  const paragraphs = text.split('\n').map(
    (line) => new Paragraph({ children: [new TextRun(line === '' ? ' ' : line)] }),
  );
  const doc = new Document({ sections: [{ children: paragraphs }] });
  const buf = await Packer.toBuffer(doc);
  await writeFile(path, buf);
}

async function main() {
  await mkdir(CORPUS_DIR, { recursive: true });
  const pdfPath = join(CORPUS_DIR, 'engagement-letter.pdf');
  const docxPath = join(CORPUS_DIR, 'quality-review-checklist.docx');
  await writePdf(pdfPath, ENGAGEMENT_LETTER_TEXT);
  await writeFile(`${pdfPath}.extracted.txt`, ENGAGEMENT_LETTER_TEXT, 'utf8');
  await writeDocx(docxPath, QUALITY_REVIEW_TEXT);
  await writeFile(`${docxPath}.extracted.txt`, QUALITY_REVIEW_TEXT, 'utf8');
  console.log('wrote:');
  console.log('  ' + pdfPath);
  console.log('  ' + pdfPath + '.extracted.txt');
  console.log('  ' + docxPath);
  console.log('  ' + docxPath + '.extracted.txt');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
