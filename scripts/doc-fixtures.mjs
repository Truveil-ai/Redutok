// Deterministic generators for the binary halves of the doc-corpus fixture:
// a multi-section, multi-page PDF and a DOCX, built byte-by-byte from node
// builtins so no document library enters the dependency tree and repeated
// generation is hash-stable (fixed zip timestamps, no randomness). A third
// generator makes a text-free "scanned" PDF for the out-of-scope path.
//
//   node scripts/doc-fixtures.mjs <target-dir>
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const pdfEscape = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

const wrap = (text, width = 100) => {
  const words = text.split(/\s+/).filter((w) => w !== '');
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line !== '' && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line === '' ? word : `${line} ${word}`;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
};

/**
 * A page's content stream: one Tj per text line, T* between lines, so any
 * Tj/T*-aware extractor recovers the exact line sequence.
 */
function pageStream(lines) {
  const ops = ['BT', '/F1 11 Tf', '14 TL', '72 740 Td'];
  lines.forEach((line, i) => {
    if (i > 0) ops.push('T*');
    ops.push(`(${pdfEscape(line)}) Tj`);
  });
  ops.push('ET');
  return ops.join('\n');
}

function assemblePdf(pageStreams) {
  const objects = [];
  const pageCount = pageStreams.length;
  const kidIds = pageStreams.map((_s, i) => 4 + i * 2);
  objects.push({ id: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' });
  objects.push({
    id: 2,
    body: `<< /Type /Pages /Kids [${kidIds.map((k) => `${k} 0 R`).join(' ')}] /Count ${pageCount} >>`,
  });
  objects.push({ id: 3, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' });
  pageStreams.forEach((stream, i) => {
    const pageId = 4 + i * 2;
    objects.push({
      id: pageId,
      body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`,
    });
    objects.push({
      id: pageId + 1,
      body: `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    });
  });

  let out = '%PDF-1.4\n';
  const offsets = new Map();
  for (const obj of objects) {
    offsets.set(obj.id, Buffer.byteLength(out, 'latin1'));
    out += `${obj.id} 0 obj\n${obj.body}\nendobj\n`;
  }
  const xrefAt = Buffer.byteLength(out, 'latin1');
  const maxId = objects.length;
  out += `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maxId; id += 1) {
    out += `${String(offsets.get(id)).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/**
 * Multi-page text PDF: sections are laid out in order and each entry of
 * `pageBreaks` starts a new page before the section at that index.
 */
export function makePdf({ title, sections, pageBreaks = [] }) {
  const pages = [[]];
  if (title !== undefined) pages[0].push(title, '');
  sections.forEach((section, i) => {
    if (pageBreaks.includes(i)) pages.push([]);
    const page = pages[pages.length - 1];
    page.push(section.heading, '');
    for (const paragraph of section.paragraphs) page.push(...wrap(paragraph), '');
  });
  return assemblePdf(pages.map(pageStream));
}

/** A PDF whose only content is vector drawing: no text operators at all,
 * standing in for a scanned-image document. */
export function makeScannedPdf() {
  return assemblePdf(['0.2 0.2 0.7 rg\n72 600 468 120 re\nf\n72 400 468 120 re\nf']);
}

// --- DOCX: a stored (uncompressed) zip with fixed timestamps. ---

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function storedZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(0, 10); // time (fixed for determinism)
    local.writeUInt16LE(0x21, 12); // date (fixed: 1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);
    central.push({ nameBuf, crc, size: data.length, offset });
    offset += local.length + nameBuf.length + data.length;
  }
  const centralChunks = [];
  let centralSize = 0;
  for (const entry of central) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4); // version made by
    header.writeUInt16LE(20, 6); // version needed
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10); // method: stored
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0x21, 14);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(entry.size, 20);
    header.writeUInt32LE(entry.size, 24);
    header.writeUInt16LE(entry.nameBuf.length, 28);
    header.writeUInt32LE(entry.offset, 42);
    centralChunks.push(header, entry.nameBuf);
    centralSize += header.length + entry.nameBuf.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...centralChunks, eocd]);
}

const xmlEscape = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

/** Sections become Heading1 paragraphs followed by body paragraphs. */
export function makeDocx({ title, sections }) {
  const paragraphs = [];
  const heading = (text, style) =>
    `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
  const body = (text) =>
    `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
  if (title !== undefined) paragraphs.push(heading(title, 'Title'));
  for (const section of sections) {
    paragraphs.push(heading(section.heading, 'Heading1'));
    for (const paragraph of section.paragraphs) paragraphs.push(body(paragraph));
  }
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.join('')}</w:body></w:document>`;
  return storedZip([
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(RELS, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(document, 'utf8') },
  ]);
}

/** The doc-corpus binary fixtures, written into dir. */
export function writeDocFixtures(dir) {
  mkdirSync(dir, { recursive: true });
  const engagementLetter = makeDocx({
    title: 'Engagement Letter',
    sections: [
      {
        heading: '1. Parties and Purpose',
        paragraphs: [
          'This engagement letter is entered into between Truveil Advisory LLP (the "Practice") and Meridian Instruments Ltd (the "Client"), effective March 15, 2026 (the "Effective Date").',
          'The Practice will provide the valuation services described in Section 2 for the purposes of financial reporting.',
        ],
      },
      {
        heading: '2. Scope of Services',
        paragraphs: [
          'The Practice will estimate the fair market value of the Client\'s ordinary shares as at 2026-03-31 and deliver a written valuation report.',
          'The scope excludes tax advice, audit procedures, and any update after the report date.',
        ],
      },
      {
        heading: '3. Fees and Billing',
        paragraphs: [
          'The fixed fee for the Meridian valuation engagement is USD 12,500, invoiced under the Billing Policy in monthly installments.',
          'Disbursements are billed at cost. Amounts unpaid after 30 days accrue interest at 1.5% per month.',
        ],
      },
      {
        heading: '4. Term and Termination',
        paragraphs: [
          'Either party may terminate on 14 days written notice. Fees for work performed to the termination date remain payable.',
        ],
      },
    ],
  });
  const valuationReport = makePdf({
    title: 'Valuation Report: Meridian Instruments Ltd',
    pageBreaks: [2],
    sections: [
      {
        heading: '1. Executive Summary',
        paragraphs: [
          'This report states our conclusion of the fair market value of the ordinary shares of Meridian Instruments Ltd as at 2026-03-31, prepared under the engagement letter dated March 15, 2026.',
        ],
      },
      {
        heading: '2. Methodology',
        paragraphs: [
          'We applied the income approach as the primary method, with a discounted cash flow over a five-year projection period, corroborated by the guideline public company method.',
        ],
      },
      {
        heading: '3. Discount Rate',
        paragraphs: [
          'The weighted average cost of capital (WACC) is estimated at 11.4%, built up from a risk-free rate of 4.2%, an equity risk premium of 5.0%, and a size premium of 3.1%.',
        ],
      },
      {
        heading: '4. Conclusion of Value',
        paragraphs: [
          'In our opinion the fair market value of Meridian Instruments Ltd as at 2026-03-31 is USD 2,300,000. This conclusion assumes the workpapers supporting the analysis are retained per the retention schedule.',
        ],
      },
    ],
  });
  writeFileSync(path.join(dir, 'engagement-letter.docx'), engagementLetter);
  writeFileSync(path.join(dir, 'valuation-report.pdf'), valuationReport);
  writeFileSync(path.join(dir, 'scanned-notes.pdf'), makeScannedPdf());
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  const target = process.argv[2];
  if (target === undefined) {
    console.error('usage: node scripts/doc-fixtures.mjs <target-dir>');
    process.exitCode = 1;
  } else {
    writeDocFixtures(target);
    console.log(`doc fixtures written to ${target}`);
  }
}
