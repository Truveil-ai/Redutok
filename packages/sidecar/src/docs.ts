import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';
import { LIMITS } from '@redutok/shared';
import type { LlmPass } from './llm.js';
import type { Store } from './store.js';

/**
 * Document engine, Vault Session 2: extraction, structure maps, and the
 * per-corpus document index for prose corpora (plain text, Markdown, PDF
 * text layers, DOCX). Everything here is deterministic except the one-line
 * section summaries, which go through the LlmPass seam with a first-sentence
 * rule fallback. PDF and DOCX parsing are hand-rolled over node builtins in
 * the house style: text-layer extraction only, and a document we cannot
 * extract is declared out of scope, never silently empty.
 */

export interface DocPage {
  page: number;
  startLine: number;
  endLine: number;
}

export interface DocHeading {
  line: number;
  level: number;
  title: string;
}

export interface DocSection {
  /** Citation id: the heading's own numbering ("3", "2.1") or a positional s<N>. */
  id: string;
  title: string;
  level: number;
  /** 1-based inclusive line range in the extracted text, heading line included. */
  startLine: number;
  endLine: number;
  page?: number;
  summary: string;
}

export type DocKind = 'markdown' | 'text' | 'pdf' | 'docx';

export interface DocExtraction {
  kind: DocKind;
  method: string;
  text: string;
  pages?: DocPage[];
  headings?: DocHeading[];
  /** Set when the file is a recognized document but its text cannot be
   * extracted (scanned-image PDF, unsupported stream filter, broken zip). */
  outOfScope?: string;
}

const DOC_KIND_BY_EXT = new Map<string, DocKind>([
  ['.md', 'markdown'],
  ['.markdown', 'markdown'],
  ['.txt', 'text'],
  ['.text', 'text'],
  ['.pdf', 'pdf'],
  ['.docx', 'docx'],
]);

export function isDocumentPath(filePath: string): boolean {
  return DOC_KIND_BY_EXT.has(path.extname(filePath).toLowerCase());
}

// --- PDF text layer ---

function pdfDecodeString(body: string): string {
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i] as string;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = body[i + 1] ?? '';
    i += 1;
    if (next === 'n') out += '\n';
    else if (next === 'r') out += '\r';
    else if (next === 't') out += '\t';
    else if (next === 'b') out += '\b';
    else if (next === 'f') out += '\f';
    else if (/[0-7]/.test(next)) {
      let octal = next;
      while (octal.length < 3 && /[0-7]/.test(body[i + 1] ?? '')) {
        octal += body[i + 1];
        i += 1;
      }
      out += String.fromCharCode(parseInt(octal, 8));
    } else out += next; // \\, \(, \) and any escaped literal
  }
  return out;
}

/**
 * Text lines from one decoded content stream, reassembled into LOGICAL lines
 * by baseline. Real-world producers (the USPTO 101 examples PDF is the field
 * case) emit one visual line as several text-showing fragments: a label
 * "(1. )Tj" then a continuation positioned by "1.5 0 Td" (ty = 0, same
 * baseline), or separate BT/ET blocks whose Tm shares the same y. Treating
 * every positioning operator as a newline shredded those into fragments no
 * heading detector could match.
 *
 * The joining rule: a positioning operator starts a new line only when it
 * moves the baseline by more than 0.6em (Tm: |Δy| in user space against the
 * vertical scale; Td/TD: |ty| in text space). Same-baseline fragments are
 * concatenated verbatim — the glyph strings already carry their own spacing,
 * and mid-word splits ("/Gen" + "erating") must join unspaced. T* and '
 * always advance a line. The 0.6em threshold keeps superscript rises (≈0.33em)
 * inline while real line advances (≥1em leading) still break.
 */
function pdfStreamLines(stream: string): string[] {
  const lines: string[] = [];
  let current = '';
  let sawText = false;
  // Baseline state: y in user space, scale from the last Tm's d component.
  let baselineY: number | undefined;
  let scale = 12;
  const flush = (): void => {
    if (current !== '') lines.push(current);
    current = '';
  };
  const token =
    /\(((?:\\.|[^\\)])*)\)\s*(Tj|')|\[((?:\\.|[^\]])*)\]\s*TJ|T\*|(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Tm|(-?[\d.]+)\s+(-?[\d.]+)\s+T[dD]/g;
  for (const match of stream.matchAll(token)) {
    if (match[1] !== undefined) {
      if (match[2] === "'") flush();
      current += pdfDecodeString(match[1]);
      sawText = true;
    } else if (match[3] !== undefined) {
      for (const part of match[3].matchAll(/\(((?:\\.|[^\\)])*)\)/g)) {
        current += pdfDecodeString(part[1] as string);
      }
      sawText = true;
    } else if (match[4] !== undefined) {
      // Tm: absolute text matrix [a b c d e f]; f is the baseline y.
      const d = Number(match[7]);
      const y = Number(match[9]);
      if (Number.isFinite(d) && d !== 0) scale = Math.abs(d);
      if (baselineY !== undefined && Math.abs(y - baselineY) > 0.6 * scale) flush();
      baselineY = y;
    } else if (match[10] !== undefined) {
      // Td/TD: relative move in text space; ty is scaled by the matrix.
      const ty = Number(match[11]);
      if (Math.abs(ty) > 0.6) flush();
      if (baselineY !== undefined) baselineY += ty * scale;
    } else {
      // T*: next line, always.
      flush();
    }
  }
  flush();
  return sawText ? lines : [];
}

function pdfObjectBodies(raw: string): Map<number, string> {
  const objects = new Map<number, string>();
  for (const match of raw.matchAll(/(\d+)\s+0\s+obj\b([\s\S]*?)endobj/g)) {
    objects.set(Number(match[1]), match[2] as string);
  }
  return objects;
}

function pdfStreamOf(body: string): string | undefined {
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
    if (!/\/FlateDecode/.test(dict)) return undefined; // unsupported filter
    try {
      return inflateSync(Buffer.from(data, 'latin1')).toString('latin1');
    } catch {
      return undefined;
    }
  }
  return data;
}

function extractPdf(buffer: Buffer): DocExtraction {
  const raw = buffer.toString('latin1');
  const objects = pdfObjectBodies(raw);
  const pageIds: number[] = [];
  for (const [id, body] of objects) {
    if (/\/Type\s*\/Pages\b/.test(body)) {
      const kids = /\/Kids\s*\[([^\]]*)\]/.exec(body)?.[1] ?? '';
      for (const kid of kids.matchAll(/(\d+)\s+0\s+R/g)) pageIds.push(Number(kid[1]));
    } else if (/\/Type\s*\/Page\b/.test(body) && !pageIds.includes(id)) {
      // Fallback for files without a Kids array we can read.
      pageIds.push(id);
    }
  }
  const orderedPages = pageIds.filter((id) => {
    const body = objects.get(id);
    return body !== undefined && /\/Type\s*\/Page\b/.test(body);
  });
  const pages: DocPage[] = [];
  const allLines: string[] = [];
  for (const [index, id] of orderedPages.entries()) {
    const body = objects.get(id) as string;
    const contentRefs = [
      ...(/\/Contents\s*\[([^\]]*)\]/.exec(body)?.[1] ?? /\/Contents\s+(\d+\s+0\s+R)/.exec(body)?.[1] ?? '').matchAll(
        /(\d+)\s+0\s+R/g,
      ),
    ].map((m) => Number(m[1]));
    const lines: string[] = [];
    for (const ref of contentRefs) {
      const stream = pdfStreamOf(objects.get(ref) ?? '');
      if (stream !== undefined) lines.push(...pdfStreamLines(stream));
    }
    if (lines.length === 0) continue;
    pages.push({ page: index + 1, startLine: allLines.length + 1, endLine: allLines.length + lines.length });
    allLines.push(...lines);
  }
  const text = allLines.join('\n');
  if (text.trim() === '') {
    return {
      kind: 'pdf',
      method: 'pdf-text',
      text: '',
      outOfScope:
        'no extractable text layer (a scanned-image or unsupported-filter PDF); v1 extraction covers embedded text only',
    };
  }
  return { kind: 'pdf', method: 'pdf-text', text, pages };
}

// --- DOCX (zip + word/document.xml) ---

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

function zipEntries(buffer: Buffer): ZipEntry[] | undefined {
  const tail = buffer.subarray(Math.max(0, buffer.length - 65_557));
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return undefined;
  const count = tail.readUInt16LE(eocd + 10);
  let at = tail.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n += 1) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== 0x02014b50) return undefined;
    const nameLen = buffer.readUInt16LE(at + 28);
    const extraLen = buffer.readUInt16LE(at + 30);
    const commentLen = buffer.readUInt16LE(at + 32);
    entries.push({
      name: buffer.subarray(at + 46, at + 46 + nameLen).toString('utf8'),
      method: buffer.readUInt16LE(at + 10),
      compressedSize: buffer.readUInt32LE(at + 20),
      localOffset: buffer.readUInt32LE(at + 42),
    });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function zipRead(buffer: Buffer, entry: ZipEntry): Buffer | undefined {
  const at = entry.localOffset;
  if (at + 30 > buffer.length || buffer.readUInt32LE(at) !== 0x04034b50) return undefined;
  const nameLen = buffer.readUInt16LE(at + 26);
  const extraLen = buffer.readUInt16LE(at + 28);
  const start = at + 30 + nameLen + extraLen;
  const data = buffer.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) {
    try {
      return inflateRawSync(data);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

const XML_ENTITIES = new Map([
  ['&amp;', '&'],
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&apos;', "'"],
]);

const xmlDecode = (s: string): string =>
  s.replace(/&(?:amp|lt|gt|quot|apos);|&#x?[0-9a-fA-F]+;/g, (entity) => {
    const known = XML_ENTITIES.get(entity);
    if (known !== undefined) return known;
    const code = entity.startsWith('&#x')
      ? parseInt(entity.slice(3, -1), 16)
      : parseInt(entity.slice(2, -1), 10);
    return Number.isNaN(code) ? entity : String.fromCodePoint(code);
  });

function extractDocx(buffer: Buffer): DocExtraction {
  const entries = zipEntries(buffer);
  const documentEntry = entries?.find((e) => e.name === 'word/document.xml');
  const xmlBuffer = documentEntry === undefined ? undefined : zipRead(buffer, documentEntry);
  if (xmlBuffer === undefined) {
    return {
      kind: 'docx',
      method: 'docx-xml',
      text: '',
      outOfScope: 'word/document.xml could not be read (not a DOCX, or an unsupported zip layout)',
    };
  }
  const xml = xmlBuffer.toString('utf8');
  const lines: string[] = [];
  const headings: DocHeading[] = [];
  for (const paragraph of xml.matchAll(/<w:p[\s>][\s\S]*?<\/w:p>|<w:p\/>/g)) {
    const p = paragraph[0];
    const text = [...p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
      .map((m) => xmlDecode(m[1] as string))
      .join('');
    lines.push(text);
    const style = /<w:pStyle[^>]*w:val="([^"]+)"/.exec(p)?.[1];
    if (style !== undefined && text.trim() !== '') {
      const level = /^Heading(\d)$/.exec(style)?.[1];
      if (level !== undefined) headings.push({ line: lines.length, level: Number(level), title: text.trim() });
      else if (style === 'Title') headings.push({ line: lines.length, level: 1, title: text.trim() });
    }
  }
  const text = lines.join('\n');
  if (text.trim() === '') {
    return {
      kind: 'docx',
      method: 'docx-xml',
      text: '',
      outOfScope: 'document.xml carries no paragraph text',
    };
  }
  const extraction: DocExtraction = { kind: 'docx', method: 'docx-xml', text };
  if (headings.length > 0) extraction.headings = headings;
  return extraction;
}

export function extractDocument(absPath: string): DocExtraction {
  const kind = DOC_KIND_BY_EXT.get(path.extname(absPath).toLowerCase());
  if (kind === undefined) throw new Error(`${absPath} is not a v1 document type`);
  if (kind === 'pdf') return extractPdf(readFileSync(absPath));
  if (kind === 'docx') return extractDocx(readFileSync(absPath));
  return { kind, method: 'utf8-text', text: readFileSync(absPath, 'utf8') };
}

// --- Structure maps ---

/**
 * Bumped whenever detectHeadings' pattern set or slug rule changes in a way
 * that could produce different sections for the same input bytes. runIngest
 * stamps this on every fresh DocumentIndexEntry, and re-ingest treats a stale
 * value as an invalidation trigger even when the source hash is unchanged —
 * so old corpora upgrade to the new structure without a manual --force flag
 * and without losing the ledger (which lives beside documents.json, not
 * inside it). v3: pdfStreamLines joins baseline fragments into logical lines,
 * so the extracted text itself changes for fragmented PDFs.
 */
export const DETECTOR_VERSION = 3;

const NUMBERED_HEADING = /^(\d+(?:\.\d+)*)[.)]\s+(\S.*)$/;
/**
 * The USPTO 101 examples PDF is the canonical case: "Example 1", "Claim 3",
 * "Part One" as their own lines, sometimes with a colon subtitle. Anchored
 * ^...$ against the trimmed line so a body sentence like "See Example 1 for
 * details" cannot slip past — the whole trimmed line must be just the label
 * (with optional short subtitle).
 */
const NAMED_ITEM_HEADING =
  /^(Example|Claim|Part|Section|Chapter|Appendix|Figure|Table|Exhibit|Case|Note)\s+([0-9]+|[IVXLCDM]+|One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|Eleven|Twelve)(?:\s*[:.\-—]\s*(.+))?$/i;
const LETTERED_HEADING = /^\(?([A-Z])[.)]\s+(\S.*)$/;
const ALL_CAPS_HEADING = /^[A-Z][A-Z0-9 ,&'()/-]{2,89}$/;
/**
 * A short standalone Title Case line (2–8 words, no trailing punctuation) is
 * treated as a heading. Small connective words are allowed between capitalised
 * ones so "Analysis of Prior Art" and "Notice to the Reader" match; the strict
 * character class rejects body sentences that end in "." or "," or contain
 * lowercase-initial content words outside the connector list.
 */
const TITLE_CASE_HEADING =
  /^[A-Z][a-z0-9-]+(?:\s+(?:[A-Z][a-z0-9-]+|of|the|and|for|to|in|a|an|on|at|by|with|from|or|as|but|vs)){1,7}$/;

export interface StructureMapOptions {
  /**
   * Per-document heading patterns supplied by the corpus config, tried before
   * the built-in detectors so a corpus owner can teach the ingester bespoke
   * shapes without patching the code. A match on the trimmed line makes the
   * whole line a level-1 heading.
   */
  extraHeadingPatterns?: RegExp[];
}

function detectHeadings(
  lines: string[],
  kind: DocKind,
  options: StructureMapOptions = {},
): DocHeading[] {
  const headings: DocHeading[] = [];
  const extras = options.extraHeadingPatterns ?? [];
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    if (kind === 'markdown') {
      const md = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(trimmed);
      if (md !== null) headings.push({ line: i + 1, level: (md[1] as string).length, title: md[2] as string });
      return;
    }
    // Heading heuristic length guard: a heading is a short standalone line,
    // not a body sentence that happens to start with a matching prefix.
    if (trimmed.length > 100) return;

    for (const extra of extras) {
      if (extra.test(trimmed)) {
        headings.push({ line: i + 1, level: 1, title: trimmed });
        return;
      }
    }

    const numbered = NUMBERED_HEADING.exec(trimmed);
    // Lowercase guard: with logical-line joining, list items arrive as full
    // lines ("3. continue scanning until ...") that would otherwise pass; a
    // real numbered heading's title never starts lowercase.
    if (numbered !== null && !trimmed.endsWith('.') && !/^[a-z]/.test(numbered[2] as string)) {
      headings.push({
        line: i + 1,
        level: (numbered[1] as string).split('.').length,
        title: trimmed,
      });
      return;
    }
    if (NAMED_ITEM_HEADING.test(trimmed)) {
      headings.push({ line: i + 1, level: 2, title: trimmed });
      return;
    }
    const lettered = LETTERED_HEADING.exec(trimmed);
    if (lettered !== null && !trimmed.endsWith('.')) {
      headings.push({ line: i + 1, level: 3, title: trimmed });
      return;
    }
    if (ALL_CAPS_HEADING.test(trimmed) && !/[a-z]/.test(trimmed)) {
      headings.push({ line: i + 1, level: 1, title: trimmed });
      return;
    }
    if (TITLE_CASE_HEADING.test(trimmed)) {
      headings.push({ line: i + 1, level: 2, title: trimmed });
    }
  });
  return headings;
}

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const isExtraHeading = (line: string, extras: RegExp[] | undefined): boolean => {
  if (extras === undefined || extras.length === 0) return false;
  return extras.some((p) => p.test(line));
};

function firstSentence(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return '';
  const sentence = /^[\s\S]*?[.!?](?=\s|$)/.exec(collapsed)?.[0] ?? collapsed;
  return sentence.length > 240 ? `${sentence.slice(0, 237)}...` : sentence;
}

function pageOf(pages: DocPage[] | undefined, line: number): number | undefined {
  return pages?.find((p) => line >= p.startLine && line <= p.endLine)?.page;
}

/**
 * The document skeleton equivalent: flat sections from headings (style-based
 * when the format carries styles, detected otherwise), each with a one-line
 * summary via the LlmPass seam and the first-sentence rule as fallback.
 */
export async function buildStructureMap(
  extraction: DocExtraction,
  llm: LlmPass,
  options: StructureMapOptions = {},
): Promise<DocSection[]> {
  if (extraction.outOfScope !== undefined || extraction.text.trim() === '') return [];
  const lines = extraction.text.split(/\r?\n/);
  const headings =
    extraction.headings !== undefined && extraction.headings.length > 0
      ? extraction.headings
      : detectHeadings(lines, extraction.kind, options);

  interface Bound {
    heading?: DocHeading;
    startLine: number;
    endLine: number;
  }
  const bounds: Bound[] = [];
  const firstHeadingLine = headings[0]?.line ?? lines.length + 1;
  if (lines.slice(0, firstHeadingLine - 1).some((l) => l.trim() !== '')) {
    bounds.push({ startLine: 1, endLine: firstHeadingLine - 1 });
  }
  headings.forEach((heading, i) => {
    bounds.push({
      heading,
      startLine: heading.line,
      endLine: (headings[i + 1]?.line ?? lines.length + 1) - 1,
    });
  });

  const sections: DocSection[] = [];
  // Semantic ids collide occasionally (two "Example 1"s in different parts,
  // an outline that repeats "A."); suffix the second and later with -2, -3
  // so citations stay unambiguous without silently dropping a section.
  const seenIds = new Map<string, number>();
  const uniqueId = (id: string): string => {
    const n = (seenIds.get(id) ?? 0) + 1;
    seenIds.set(id, n);
    return n === 1 ? id : `${id}-${n}`;
  };
  for (const bound of bounds) {
    let end = bound.endLine;
    while (end > bound.startLine && (lines[end - 1] ?? '').trim() === '') end -= 1;
    const bodyStart = bound.heading === undefined ? bound.startLine : bound.startLine + 1;
    const body = lines.slice(bodyStart - 1, end).join('\n');
    const headingTitle = bound.heading?.title ?? '';
    const numbered = NUMBERED_HEADING.exec(headingTitle);
    const named = NAMED_ITEM_HEADING.exec(headingTitle);
    const lettered = LETTERED_HEADING.exec(headingTitle);

    // Title rule: NUMBERED and LETTERED strip their prefix so the id carries
    // the enumeration and the title carries the semantic name. NAMED_ITEM,
    // ALL_CAPS, and TITLE_CASE keep the full line as the title because the
    // label ("Example 1") is itself the reader's citation, not a prefix.
    const title =
      bound.heading === undefined
        ? (lines.slice(bound.startLine - 1, end).find((l) => l.trim() !== '') ?? '(preamble)').trim().slice(0, 80)
        : numbered !== null
          ? (numbered[2] as string).trim()
          : lettered !== null && named === null
            ? (lettered[2] as string).trim()
            : headingTitle.trim();

    let baseId: string;
    if (bound.heading === undefined) {
      baseId = `s${sections.length + 1}`;
    } else if (numbered !== null) {
      baseId = numbered[1] as string;
    } else if (named !== null) {
      baseId = `${(named[1] as string).toLowerCase()}-${(named[2] as string).toLowerCase()}`;
    } else if (lettered !== null) {
      baseId = (lettered[1] as string).toLowerCase();
    } else if (isExtraHeading(headingTitle, options.extraHeadingPatterns)) {
      // A per-doc override matched: slug the whole heading so the citation id
      // is legible ("uspto-2019-ex-01") rather than a positional s<N>.
      const slug = slugify(headingTitle);
      baseId = slug === '' ? `s${sections.length + 1}` : slug.slice(0, 60);
    } else {
      // ALL_CAPS and TITLE_CASE: legible titles already, but no natural
      // enumeration — keep positional s<N> ids so callers who key on them
      // (existing corpora, tests) stay stable across the detector upgrade.
      baseId = `s${sections.length + 1}`;
    }

    const llmSummary = await llm.summarize({
      text: body.slice(0, 4000),
      prompt: 'Summarize this document section in one short sentence.',
      timeoutMs: LIMITS.LOCAL_LLM_TIMEOUT_MS,
    });
    const summary = (llmSummary ?? '').split('\n')[0]?.trim() || firstSentence(body) || title;
    const section: DocSection = {
      id: uniqueId(baseId),
      title,
      level: bound.heading?.level ?? 1,
      startLine: bound.startLine,
      endLine: end,
      summary,
    };
    const page = pageOf(extraction.pages, bound.startLine);
    if (page !== undefined) section.page = page;
    sections.push(section);
  }
  return sections;
}

/** The byte-exact slice contract: a cited range recovers exactly these lines
 * of the stored text, joined with \n. */
export function sectionText(text: string, range: { startLine: number; endLine: number }): string {
  return text
    .split(/\r?\n/)
    .slice(range.startLine - 1, range.endLine)
    .join('\n');
}

/** Anchor a section the way a professional cites it: page when the format
 * has pages, paragraph (line) anchor otherwise. */
export function sectionAnchor(section: DocSection): string {
  return section.page === undefined ? `¶${section.startLine}` : `p.${section.page}`;
}

// --- Per-corpus document index (the slice index) ---

export interface DocumentIndexEntry {
  path: string;
  sha256: string;
  bytes: number;
  kind: DocKind;
  method: string;
  ingestedAt: string;
  artifactId?: string;
  outOfScope?: string;
  pages?: DocPage[];
  sections: DocSection[];
  /** The DETECTOR_VERSION under which sections were built. A stale value on
   * re-ingest triggers a full re-extract even when the source hash matches. */
  detectorVersion?: number;
}

export interface DocumentIndex {
  version: '1';
  corpus: string;
  generatedAt: string;
  documents: DocumentIndexEntry[];
}

const INDEX_FILE = 'documents.json';

export function readDocumentIndex(dcpDir: string): DocumentIndex | undefined {
  const file = path.join(dcpDir, INDEX_FILE);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, 'utf8')) as DocumentIndex;
}

export function writeDocumentIndex(dcpDir: string, index: DocumentIndex): void {
  writeFileSync(path.join(dcpDir, INDEX_FILE), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
}

// --- Cross-document section search ---

export interface DocHit {
  path: string;
  artifactId: string;
  section: DocSection;
  /** 1-based line in the document's stored extracted text. */
  line: number;
  text: string;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Keyword hits across the stored extracted text of every indexed document,
 * each hit resolved to its containing section. The store is the source of
 * truth (redacted text), so hits can never leak what redaction removed.
 */
export function searchDocumentSections(
  store: Store,
  entries: DocumentIndexEntry[],
  keywords: string[],
): DocHit[] {
  if (keywords.length === 0) return [];
  const pattern = new RegExp(keywords.map(escapeRegExp).join('|'), 'i');
  const hits: DocHit[] = [];
  for (const entry of entries) {
    if (entry.artifactId === undefined) continue;
    const artifact = store.getArtifact(entry.artifactId);
    if (artifact === undefined) continue;
    const lines = artifact.raw.split(/\r?\n/);
    for (const section of entry.sections) {
      for (let line = section.startLine; line <= Math.min(section.endLine, lines.length); line += 1) {
        const text = lines[line - 1] ?? '';
        if (pattern.test(text)) {
          hits.push({ path: entry.path, artifactId: entry.artifactId, section, line, text: text.trim() });
        }
      }
    }
  }
  return hits;
}

const ASK_STOPWORDS = new Set([
  'this', 'that', 'with', 'from', 'into', 'what', 'where', 'when', 'how', 'does', 'the', 'and',
  'for', 'are', 'has', 'have', 'your', 'their', 'over', 'each', 'must', 'its', 'was', 'were',
]);

export function askKeywords(ask: string): string[] {
  return [
    ...new Set(
      ask
        .split(/[^A-Za-z0-9_-]+/)
        .filter((t) => t.length >= 4)
        .map((t) => t.toLowerCase())
        .filter((t) => !ASK_STOPWORDS.has(t)),
    ),
  ];
}

// --- Section references and heading-aware ranking ---

/**
 * Section identity in the ask path (field failure vault-ask-retrieval-gap:
 * six asks naming "Example 21" lost to keyword-frequency decoys because "21"
 * fell under the 4-char keyword floor and headings carried no weight). A
 * parsed reference targets its section directly; a heading match outranks
 * any body-similarity score.
 */

export interface SectionRef {
  /** Label half, lowercased ("example", "claim"); absent for bare/generic refs. */
  label?: string;
  /** Enumeration half, lowercased ("21", "2.1", "iv", "two"). */
  number: string;
  /** The phrase as written in the ask, for display. */
  raw: string;
}

const WORD_NUMBERS = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve';
/** Labels that name a section generically rather than a labeled kind. */
const GENERIC_REF_LABELS = new Set(['section', 'sec']);
const REF_LABEL = new RegExp(
  `\\b(example|claim|part|section|sec|chapter|appendix|figure|table|exhibit|case|note)\\s+(\\d+(?:\\.\\d+)*|[ivxlcdm]+\\b|${WORD_NUMBERS})\\b`,
  'gi',
);
const REF_MARK = /§\s*([A-Za-z0-9][\w.-]*)/g;
const ID_HALVES = new RegExp(`^(?:([a-z]+)-)?(\\d+(?:\\.\\d+)*|[ivxlcdm]+|${WORD_NUMBERS})(?:-\\d+)?$`);

/** Explicit section references in an ask: "Example 21", "§21", "section 21". */
export function parseSectionRefs(ask: string): SectionRef[] {
  const refs: SectionRef[] = [];
  for (const m of ask.matchAll(REF_LABEL)) {
    const label = (m[1] as string).toLowerCase();
    const number = (m[2] as string).toLowerCase();
    refs.push(GENERIC_REF_LABELS.has(label) ? { number, raw: m[0] } : { label, number, raw: m[0] });
  }
  for (const m of ask.matchAll(REF_MARK)) {
    const id = (m[1] as string).toLowerCase();
    const halves = ID_HALVES.exec(id);
    const label = halves?.[1];
    if (halves === null) refs.push({ number: id, raw: m[0] });
    else if (label !== undefined && !GENERIC_REF_LABELS.has(label))
      refs.push({ label, number: halves[2] as string, raw: m[0] });
    else refs.push({ number: halves[2] as string, raw: m[0] });
  }
  const seen = new Set<string>();
  return refs.filter((r) => {
    const key = `${r.label ?? ''}#${r.number}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Whether a reference targets a section. Numbers must agree; labels must
 * agree only when both sides carry one — the real corpus mixes "21. Title"
 * ids with "Example 21" phrasings, so a labeled ref matches an unlabeled id.
 */
export function sectionMatchesRef(section: DocSection, ref: SectionRef): boolean {
  const halves = ID_HALVES.exec(section.id.toLowerCase());
  if (halves === null) {
    // Positional/slug ids carry no enumeration: match on the title carrying
    // the reference phrase verbatim ("Example 21 – ..." under an s<N> id).
    return section.title.toLowerCase().includes(ref.raw.toLowerCase());
  }
  const label = halves[1];
  if ((halves[2] as string) !== ref.number) return false;
  return ref.label === undefined || label === undefined || ref.label === label;
}

export type HeadingMatch = 'exact' | 'strong' | 'partial' | 'none';

const HEADING_STOPWORDS = new Set([
  'of', 'the', 'and', 'for', 'to', 'in', 'a', 'an', 'on', 'at', 'by', 'with', 'from', 'or', 'as', 'but', 'vs',
]);

const normWords = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== '');

/**
 * Heading-match strength of one section title against the ask: exact (the
 * ask contains the whole title), strong (every significant title word
 * appears), partial (at least two, or the only one), none.
 */
export function headingMatch(title: string, ask: string): HeadingMatch {
  const significant = normWords(title).filter((w) => !HEADING_STOPWORDS.has(w));
  if (significant.length === 0) return 'none';
  const askNorm = ` ${normWords(ask).join(' ')} `;
  if (askNorm.includes(` ${normWords(title).join(' ')} `)) return 'exact';
  const askWords = new Set(normWords(ask));
  const matched = significant.filter((w) => askWords.has(w)).length;
  if (matched === significant.length && significant.length >= 2) return 'strong';
  if (matched >= 2 || (significant.length === 1 && matched === 1)) return 'partial';
  return 'none';
}

/** Ranking tier of a section for an ask; 'ref' means explicitly enumerated. */
export type SectionTier = 'ref' | HeadingMatch;

export const TIER_RANK: Record<SectionTier, number> = { ref: 4, exact: 3, strong: 2, partial: 1, none: 0 };

export interface SectionScore {
  section: DocSection;
  tier: SectionTier;
  /** Keyword match volume over the section body — the tie-breaker, never the ranking. */
  bodyScore: number;
  text: string;
}

/** Every section scored against the ask: identity tier first, body volume second. */
export function scoreSections(
  text: string,
  sections: DocSection[],
  ask: string,
  refs: SectionRef[] = parseSectionRefs(ask),
): SectionScore[] {
  const keywords = askKeywords(ask);
  const pattern =
    keywords.length === 0 ? undefined : new RegExp(keywords.map(escapeRegExp).join('|'), 'gi');
  return sections.map((section) => {
    const body = sectionText(text, section);
    const tier: SectionTier = refs.some((r) => sectionMatchesRef(section, r))
      ? 'ref'
      : headingMatch(section.title, ask);
    const bodyScore = pattern === undefined ? 0 : [...body.matchAll(pattern)].length;
    return { section, tier, bodyScore, text: body };
  });
}

/**
 * The ask-relevant sections of one document: ranked by section identity
 * (reference and heading matches) before body match volume, capped, then
 * restored to document order. This is both what the doc-serve distiller
 * includes verbatim and the conclusion-relevant region the prose entity
 * gate holds it to.
 */
export function matchedDocSections(
  text: string,
  sections: DocSection[],
  ask: string | undefined,
  maxSections: number,
): { section: DocSection; text: string }[] {
  if (ask === undefined || ask.trim() === '') return [];
  const scored = scoreSections(text, sections, ask).filter(
    (s) => TIER_RANK[s.tier] > 0 || s.bodyScore > 0,
  );
  scored.sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier] || b.bodyScore - a.bodyScore);
  return scored
    .slice(0, Math.max(0, maxSections))
    .sort((a, b) => a.section.startLine - b.section.startLine)
    .map(({ section, text: body }) => ({ section, text: body }));
}

export interface RankedDocument {
  entry: DocumentIndexEntry;
  hits: DocHit[];
  scores: SectionScore[];
  /** Highest section tier in this document. */
  tier: SectionTier;
}

/**
 * Corpus-aware cross-document ranking: a document whose section identity
 * matches the ask outranks any document that merely accumulates keyword
 * hits, and a document reachable only by enumeration (zero keyword hits)
 * still ranks. Hit count and body volume break ties, path keeps it stable.
 */
export function rankDocuments(
  store: Store,
  entries: DocumentIndexEntry[],
  ask: string,
  hits: DocHit[],
): RankedDocument[] {
  const refs = parseSectionRefs(ask);
  const byPath = new Map<string, DocHit[]>();
  for (const h of hits) byPath.set(h.path, [...(byPath.get(h.path) ?? []), h]);
  const ranked: RankedDocument[] = [];
  for (const entry of entries) {
    if (entry.artifactId === undefined) continue;
    const artifact = store.getArtifact(entry.artifactId);
    if (artifact === undefined) continue;
    const scores = scoreSections(artifact.raw, entry.sections, ask, refs);
    const docHits = byPath.get(entry.path) ?? [];
    const tier = scores.reduce<SectionTier>(
      (best, s) => (TIER_RANK[s.tier] > TIER_RANK[best] ? s.tier : best),
      'none',
    );
    if (docHits.length === 0 && TIER_RANK[tier] === 0) continue;
    ranked.push({ entry, hits: docHits, scores, tier });
  }
  const bodyTotal = (d: RankedDocument): number => d.scores.reduce((n, s) => n + s.bodyScore, 0);
  ranked.sort(
    (a, b) =>
      TIER_RANK[b.tier] - TIER_RANK[a.tier] ||
      b.hits.length - a.hits.length ||
      bodyTotal(b) - bodyTotal(a) ||
      a.entry.path.localeCompare(b.entry.path),
  );
  return ranked;
}
