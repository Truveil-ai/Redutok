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

/** Text lines from one decoded content stream: every text-showing operator
 * appends to the current line; T*, Td, TD, and ' start a new one. */
function pdfStreamLines(stream: string): string[] {
  const lines: string[] = [];
  let current = '';
  let sawText = false;
  const flush = (): void => {
    if (current !== '') lines.push(current);
    current = '';
  };
  const token =
    /\(((?:\\.|[^\\)])*)\)\s*(Tj|')|\[((?:\\.|[^\]])*)\]\s*TJ|T\*|-?[\d.]+\s+-?[\d.]+\s+T[dD]/g;
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
    } else {
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

const NUMBERED_HEADING = /^(\d+(?:\.\d+)*)[.)]\s+(\S.*)$/;
const ALL_CAPS_HEADING = /^[A-Z][A-Z0-9 ,&'()/-]{2,89}$/;

function detectHeadings(lines: string[], kind: DocKind): DocHeading[] {
  const headings: DocHeading[] = [];
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (kind === 'markdown') {
      const md = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(trimmed);
      if (md !== null) headings.push({ line: i + 1, level: (md[1] as string).length, title: md[2] as string });
      return;
    }
    const numbered = NUMBERED_HEADING.exec(trimmed);
    if (numbered !== null && trimmed.length <= 90 && !trimmed.endsWith('.')) {
      headings.push({
        line: i + 1,
        level: (numbered[1] as string).split('.').length,
        title: trimmed,
      });
      return;
    }
    if (ALL_CAPS_HEADING.test(trimmed) && !/[a-z]/.test(trimmed)) {
      headings.push({ line: i + 1, level: 1, title: trimmed });
    }
  });
  return headings;
}

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
): Promise<DocSection[]> {
  if (extraction.outOfScope !== undefined || extraction.text.trim() === '') return [];
  const lines = extraction.text.split(/\r?\n/);
  const headings =
    extraction.headings !== undefined && extraction.headings.length > 0
      ? extraction.headings
      : detectHeadings(lines, extraction.kind);

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
  for (const bound of bounds) {
    let end = bound.endLine;
    while (end > bound.startLine && (lines[end - 1] ?? '').trim() === '') end -= 1;
    const bodyStart = bound.heading === undefined ? bound.startLine : bound.startLine + 1;
    const body = lines.slice(bodyStart - 1, end).join('\n');
    const headingTitle = bound.heading?.title ?? '';
    const numbered = NUMBERED_HEADING.exec(headingTitle);
    const title =
      bound.heading === undefined
        ? (lines.slice(bound.startLine - 1, end).find((l) => l.trim() !== '') ?? '(preamble)').trim().slice(0, 80)
        : ((numbered?.[2] as string | undefined) ?? headingTitle).trim();
    const llmSummary = await llm.summarize({
      text: body.slice(0, 4000),
      prompt: 'Summarize this document section in one short sentence.',
      timeoutMs: LIMITS.LOCAL_LLM_TIMEOUT_MS,
    });
    const summary = (llmSummary ?? '').split('\n')[0]?.trim() || firstSentence(body) || title;
    const section: DocSection = {
      id: numbered?.[1] ?? `s${sections.length + 1}`,
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

/**
 * The ask-relevant sections of one document: keyword-matched, ranked by
 * match volume, capped, then restored to document order. This is both what
 * the doc-serve distiller includes verbatim and the conclusion-relevant
 * region the prose entity gate holds it to.
 */
export function matchedDocSections(
  text: string,
  sections: DocSection[],
  ask: string | undefined,
  maxSections: number,
): { section: DocSection; text: string }[] {
  if (ask === undefined || ask.trim() === '') return [];
  const keywords = askKeywords(ask);
  if (keywords.length === 0) return [];
  const pattern = new RegExp(keywords.map(escapeRegExp).join('|'), 'gi');
  const scored = sections
    .map((section) => {
      const body = sectionText(text, section);
      return { section, text: body, score: [...body.matchAll(pattern)].length };
    })
    .filter((s) => s.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored
    .slice(0, Math.max(0, maxSections))
    .sort((a, b) => a.section.startLine - b.section.startLine)
    .map(({ section, text: body }) => ({ section, text: body }));
}
