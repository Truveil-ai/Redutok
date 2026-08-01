#!/usr/bin/env node
/**
 * One-time fixture slicer: cuts real pages out of a source PDF into a small
 * committed fixture, preserving the original bytes of every object the
 * extraction layer touches — page dicts, content streams, Type0/CID font
 * dictionaries (kept inside their original compressed /ObjStm containers so
 * the ObjStm code path is exercised), and ToUnicode CMap streams.
 *
 * Provenance of packages/sidecar/test/fixtures/uspto-101-p40-43.pdf:
 *   node scripts/slice-pdf-fixture.mjs "<path to USPTO 101_examples_1to36.pdf>" \
 *     40 43 packages/sidecar/test/fixtures/uspto-101-p40-43.pdf
 * Source: USPTO "Subject Matter Eligibility Examples" (public domain, US
 * government work), the July 2015 Update pages carrying Example 21 whose
 * body is typeset in CID fonts as hex strings — the field case for the
 * hex-text extraction fix.
 *
 * The classic xref table only lists the uncompressed objects; ObjStm members
 * are reachable the same way the sidecar reads them (scanning + expansion).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { inflateSync } from 'node:zlib';

const [src, fromPageArg, toPageArg, out] = process.argv.slice(2);
if (out === undefined) {
  console.error('usage: slice-pdf-fixture.mjs <src.pdf> <fromPage> <toPage> <out.pdf>');
  process.exit(1);
}
const fromPage = Number(fromPageArg);
const toPage = Number(toPageArg);

const raw = readFileSync(src).toString('latin1');

const objects = new Map(); // id -> body (verbatim latin1)
for (const m of raw.matchAll(/(\d+)\s+0\s+obj\b([\s\S]*?)endobj/g)) objects.set(Number(m[1]), m[2]);

function streamOf(body) {
  const at = body.indexOf('stream');
  if (at === -1) return undefined;
  const start = body.indexOf('\n', at) + 1;
  const end = body.lastIndexOf('endstream');
  if (start === 0 || end === -1 || end <= start) return undefined;
  let data = body.slice(start, end);
  if (data.endsWith('\n')) data = data.slice(0, -1);
  if (data.endsWith('\r')) data = data.slice(0, -1);
  const dict = body.slice(0, at);
  if (/\/Filter/.test(dict)) {
    if (!/\/FlateDecode/.test(dict)) return undefined;
    try {
      return inflateSync(Buffer.from(data, 'latin1')).toString('latin1');
    } catch {
      return undefined;
    }
  }
  return data;
}

// Map every ObjStm member id to its container, and surface member bodies.
const memberBodies = new Map(); // member id -> body text
const containerOf = new Map(); // member id -> ObjStm id
for (const [id, body] of objects) {
  if (!/\/Type\s*\/ObjStm\b/.test(body)) continue;
  const n = Number(/\/N\s+(\d+)/.exec(body)?.[1]);
  const first = Number(/\/First\s+(\d+)/.exec(body)?.[1]);
  const data = streamOf(body);
  if (data === undefined || !Number.isFinite(n) || !Number.isFinite(first)) continue;
  const header = data.slice(0, first).trim().split(/\s+/).map(Number);
  for (let i = 0; i < n; i += 1) {
    const objNum = header[2 * i];
    const offset = header[2 * i + 1];
    const nextOffset = i + 1 < n ? header[2 * (i + 1) + 1] : data.length - first;
    if (!memberBodies.has(objNum)) {
      memberBodies.set(objNum, data.slice(first + offset, first + nextOffset));
      containerOf.set(objNum, id);
    }
  }
}

// Page objects in document order (fallback scan order, as the sidecar reads them).
const pageIds = [];
for (const [id, body] of objects) {
  if (/\/Type\s*\/Page\b/.test(body) && !pageIds.includes(id)) pageIds.push(id);
}
const wanted = pageIds.slice(fromPage - 1, toPage);
if (wanted.length !== toPage - fromPage + 1) {
  console.error(`found ${pageIds.length} pages, cannot slice ${fromPage}-${toPage}`);
  process.exit(1);
}

// Transitive closure of indirect references, never following /Parent (which
// would drag in the whole page tree).
const needed = new Set();
const queue = [...wanted];
while (queue.length > 0) {
  const id = queue.pop();
  if (needed.has(id)) continue;
  needed.add(id);
  const body = objects.get(id) ?? memberBodies.get(id);
  if (body === undefined) continue;
  // Follow refs in the dictionary only — raw stream bytes would produce
  // phantom "N 0 R" matches and drag in unrelated objects.
  const streamAt = body.indexOf('stream');
  const dict = streamAt === -1 ? body : body.slice(0, streamAt);
  const withoutParent = dict.replace(/\/Parent\s+\d+\s+0\s+R/g, '');
  for (const m of withoutParent.matchAll(/(\d+)\s+0\s+R/g)) queue.push(Number(m[1]));
}

// Emit: uncompressed objects verbatim; ObjStm containers for member objects.
const emit = new Set();
for (const id of needed) {
  if (objects.has(id)) emit.add(id);
  else if (containerOf.has(id)) emit.add(containerOf.get(id));
}

const parts = [];
const offsets = new Map();
let cursor = 0;
const push = (s) => {
  parts.push(s);
  cursor += s.length;
};
push('%PDF-1.6\n%\xE2\xE3\xCF\xD3\n');
for (const id of [...emit].sort((a, b) => a - b)) {
  offsets.set(id, cursor);
  push(`${id} 0 obj${objects.get(id)}endobj\n`);
}
// Minimal catalog + pages tree for tools that read the trailer.
const maxId = Math.max(...emit);
const pagesId = maxId + 1;
const catalogId = maxId + 2;
offsets.set(pagesId, cursor);
push(`${pagesId} 0 obj\n<</Type /Pages /Kids [${wanted.map((id) => `${id} 0 R`).join(' ')}] /Count ${wanted.length}>>\nendobj\n`);
offsets.set(catalogId, cursor);
push(`${catalogId} 0 obj\n<</Type /Catalog /Pages ${pagesId} 0 R>>\nendobj\n`);

const xrefAt = cursor;
const size = catalogId + 1;
let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
for (let id = 1; id < size; id += 1) {
  xref += offsets.has(id)
    ? `${String(offsets.get(id)).padStart(10, '0')} 00000 n \n`
    : '0000000000 65535 f \n';
}
push(xref);
push(`trailer\n<</Size ${size} /Root ${catalogId} 0 R>>\nstartxref\n${xrefAt}\n%%EOF\n`);

mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, Buffer.from(parts.join(''), 'latin1'));
console.log(`${out}: ${cursor} bytes, pages ${fromPage}-${toPage} (${wanted.join(',')}), ${emit.size + 2} objects`);
