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
  /** The document part this section sits in, from the running page header
   * ("Nature-Based Products"). The only in-document signal separating two
   * sections that carry the same enumeration or even the same title. */
  context?: string;
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
 * One font resource as the text extractor needs it: whether hex strings are
 * 2-byte CIDs (Type0 composite fonts) and the ToUnicode CMap when present.
 */
interface PdfFont {
  wide: boolean;
  toUnicode?: Map<number, string>;
}

/** A ToUnicode CMap's bfchar/bfrange entries; destinations are UTF-16BE. */
function pdfParseCMap(cmap: string): Map<number, string> {
  const map = new Map<number, string>();
  const decodeDst = (hex: string): string => {
    let out = '';
    for (let i = 0; i + 4 <= hex.length; i += 4) {
      out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    }
    // A malformed single-byte destination still means that code point.
    if (out === '' && hex.length >= 2) out = String.fromCharCode(parseInt(hex.slice(0, 2), 16));
    return out;
  };
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of (block[1] as string).matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(parseInt(pair[1] as string, 16), decodeDst(pair[2] as string));
    }
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const range =
      /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[((?:\s*<[0-9A-Fa-f]+>)+)\s*\])/g;
    for (const trip of (block[1] as string).matchAll(range)) {
      const lo = parseInt(trip[1] as string, 16);
      const hi = parseInt(trip[2] as string, 16);
      if (trip[3] !== undefined) {
        const dst = decodeDst(trip[3]);
        const last = dst.charCodeAt(dst.length - 1);
        for (let code = lo; code <= hi; code += 1) {
          map.set(code, dst.slice(0, -1) + String.fromCharCode(last + (code - lo)));
        }
      } else if (trip[4] !== undefined) {
        [...trip[4].matchAll(/<([0-9A-Fa-f]+)>/g)].forEach((item, index) => {
          map.set(lo + index, decodeDst(item[1] as string));
        });
      }
    }
  }
  return map;
}

/**
 * The /Font resources of one page, resolved to PdfFont entries by resource
 * name. Font dictionaries commonly live inside compressed /ObjStm containers
 * (pdfObjectBodies surfaces them) and hex-string text is unreadable without
 * them; a font without a usable ToUnicode CMap still records its width so
 * hex payloads are consumed at the right stride.
 */
function pdfPageFonts(
  objects: Map<number, string>,
  pageBody: string,
  cache: Map<number, PdfFont>,
): Map<string, PdfFont> {
  const fonts = new Map<string, PdfFont>();
  // /Font only ever appears inside /Resources, so scan the page dictionary
  // directly rather than isolating the (arbitrarily nested) Resources dict;
  // resolve one level of indirection for /Resources-as-ref and /Font-as-ref.
  const dictOf = (body: string): string | undefined => {
    const flat = /\/Font\s*<<((?:\s*\/[\w.]+\s+\d+\s+0\s+R)*)\s*>>/.exec(body)?.[1];
    if (flat !== undefined) return flat;
    // /Font as an indirect ref: the referenced object body is the dict.
    const ref = /\/Font\s+(\d+)\s+0\s+R/.exec(body)?.[1];
    return ref === undefined ? undefined : objects.get(Number(ref));
  };
  const resourcesRef = /\/Resources\s+(\d+)\s+0\s+R/.exec(pageBody)?.[1];
  const fontDict =
    dictOf(pageBody) ??
    (resourcesRef === undefined ? undefined : dictOf(objects.get(Number(resourcesRef)) ?? '')) ??
    '';
  for (const entry of fontDict.matchAll(/\/([\w.]+)\s+(\d+)\s+0\s+R/g)) {
    const id = Number(entry[2]);
    let font = cache.get(id);
    if (font === undefined) {
      const body = objects.get(id) ?? '';
      font = { wide: /\/Subtype\s*\/Type0\b/.test(body) };
      const toUnicodeRef = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(body)?.[1];
      if (toUnicodeRef !== undefined) {
        const cmap = pdfStreamOf(objects.get(Number(toUnicodeRef)) ?? '');
        if (cmap !== undefined) font.toUnicode = pdfParseCMap(cmap);
      }
      cache.set(id, font);
    }
    fonts.set(entry[1] as string, font);
  }
  return fonts;
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
 *
 * Strings come in two shapes. Literal (...) strings decode bytewise as
 * before. Hex <...> strings — the whole §21 body of the field PDF, typeset
 * in Type0/CID fonts — decode through the font selected by the last Tf:
 * 2-byte CIDs through the font's ToUnicode CMap for wide fonts (a CID with
 * no mapping contributes nothing; silence beats garbage), single bytes with
 * ToUnicode fallback to latin1 otherwise.
 */
/** How far two draws of the same text may sit apart and still be one glyph
 * painted twice. Observed on the field document: 0.06-0.12pt. A genuine
 * repeated character advances by its glyph width, several points at any
 * readable size. */
const REPAINT_EPSILON = 0.5;

function pdfStreamLines(stream: string, fonts?: Map<string, PdfFont>): string[] {
  const lines: string[] = [];
  let current = '';
  let sawText = false;
  let font: PdfFont | undefined;
  // Baseline state: y in user space, scale from the last Tm's d component.
  let baselineY: number | undefined;
  let scale = 12;
  // Position state for clipped repaints: the text-origin x carried through
  // Tm and Td, whether an operator placed it since the last show, the
  // previous show actually emitted, and whether we are inside a clip region.
  let penX: number | undefined;
  let placed = false;
  let xScale = 12;
  let lastShow: { x: number; y: number | undefined; text: string } | undefined;
  let lastShowClipped = false;
  const clips: boolean[] = [];
  const inClip = (): boolean => clips.includes(true);
  /**
   * Whether this show only repaints ink the page already carries.
   *
   * Field failure (corpus idf, 2026-08-02): page 14 of the USPTO examples
   * PDF extracted "claimm is directedd" and "Claim 100" for "Claim 10". The
   * producer paints each line as unclipped runs, then re-paints every glyph
   * that straddles a clip-region boundary inside its own `q <rect> re W n`
   * block. A renderer shows the glyph once — each draw is clipped to its own
   * sliver — while a position-blind extractor concatenates every draw.
   *
   * Three shapes, all observed on page 14:
   *   - the straddling glyph drawn once per neighbouring clip, at the same
   *     baseline and within a tenth of a point of the same x ("m", then "m "
   *     — the repaint may carry its own trailing space, which is kept);
   *   - a clipped single glyph repeating the LAST character of the run that
   *     just painted it, inside that run's span (": Abstract" then "t");
   *   - a clipped single glyph repeating the FIRST character of the run that
   *     paints it next, at the same x ("i", then "into ") — caught after the
   *     fact, by taking the glyph back off the line.
   * Real repeated characters advance by a glyph width, several points at any
   * readable size, so no shape can swallow genuine text.
   */
  const sameInk = (a: string, b: string): boolean => a.trim() !== '' && a.trim() === b.trim();
  const show = (text: string): void => {
    // Only a show whose origin an operator has just placed can be compared:
    // consecutive shows with no positioning between them advance the pen by
    // the glyphs themselves, a width this extractor does not know.
    const x = placed ? penX : undefined;
    placed = false;
    const near = (at: number, to: number): boolean => Math.abs(at - to) <= REPAINT_EPSILON;
    if (x !== undefined && lastShow !== undefined && lastShow.y === baselineY) {
      if (sameInk(lastShow.text, text) && near(x, lastShow.x)) {
        // The same ink twice. Keep any whitespace the repaint adds: it
        // separates this word from the next, and dropping it joins them.
        const extra = text.startsWith(lastShow.text) ? text.slice(lastShow.text.length) : '';
        if (extra !== '' && extra.trim() === '') {
          current += extra;
          lastShow = { x, y: baselineY, text };
        }
        return;
      }
      if (
        inClip() &&
        text.length === 1 &&
        lastShow.text.endsWith(text) &&
        x > lastShow.x &&
        x < lastShow.x + lastShow.text.length * scale
      ) {
        return;
      }
      // Deliberately NOT extended to a run ending in whitespace. The
      // producer also leaves a blank where a clipped glyph sits ("that
      // describ " then a clipped "b", for "that describes"), which looks
      // identical to a run whose last word simply ends in the same letter
      // ("vention, as " then a clipped "s", for "as seen"). Telling those
      // apart needs the glyph widths of a proportional font, which this
      // extractor does not have; guessing corrupts correct text.
      if (
        lastShowClipped &&
        lastShow.text.trim().length === 1 &&
        near(x, lastShow.x) &&
        text.startsWith(lastShow.text)
      ) {
        // The clipped glyph came first; the run that repaints it is the one
        // to keep, so take the glyph back off the line.
        current = current.slice(0, current.length - lastShow.text.length);
      }
    }
    if (x !== undefined) {
      lastShow = { x, y: baselineY, text };
      lastShowClipped = inClip();
    }
    current += text;
    sawText = true;
  };
  const flush = (): void => {
    if (current !== '') lines.push(current);
    current = '';
  };
  const decodeHex = (hex: string): string => {
    const digits = hex.replace(/\s+/g, '');
    const padded = digits.length % 2 === 1 ? `${digits}0` : digits;
    let out = '';
    if (font?.wide === true) {
      for (let i = 0; i + 4 <= padded.length; i += 4) {
        out += font.toUnicode?.get(parseInt(padded.slice(i, i + 4), 16)) ?? '';
      }
    } else {
      for (let i = 0; i + 2 <= padded.length; i += 2) {
        const code = parseInt(padded.slice(i, i + 2), 16);
        out += font?.toUnicode?.get(code) ?? String.fromCharCode(code);
      }
    }
    return out;
  };
  const token =
    /\(((?:\\.|[^\\)])*)\)\s*(Tj|')|<([0-9A-Fa-f\s]*)>\s*(Tj|')|\[((?:\\.|[^\]])*)\]\s*TJ|\/([\w.]+)\s+-?[\d.]+\s+Tf|T\*|(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Tm|(-?[\d.]+)\s+(-?[\d.]+)\s+T[dD]|(q)\b|(Q)\b|(W)\s+n\b/g;
  for (const match of stream.matchAll(token)) {
    if (match[1] !== undefined) {
      if (match[2] === "'") flush();
      show(pdfDecodeString(match[1]));
    } else if (match[3] !== undefined) {
      if (match[4] === "'") flush();
      show(decodeHex(match[3]));
    } else if (match[5] !== undefined) {
      let text = '';
      for (const part of match[5].matchAll(/\(((?:\\.|[^\\)])*)\)|<([0-9A-Fa-f\s]*)>/g)) {
        text += part[1] !== undefined ? pdfDecodeString(part[1]) : decodeHex(part[2] as string);
      }
      show(text);
    } else if (match[6] !== undefined) {
      font = fonts?.get(match[6]);
    } else if (match[7] !== undefined) {
      // Tm: absolute text matrix [a b c d e f]; e is the x origin, f the
      // baseline y.
      const a = Number(match[7]);
      const d = Number(match[10]);
      const x = Number(match[11]);
      const y = Number(match[12]);
      if (Number.isFinite(d) && d !== 0) scale = Math.abs(d);
      if (Number.isFinite(a) && a !== 0) xScale = Math.abs(a);
      if (baselineY !== undefined && Math.abs(y - baselineY) > 0.6 * scale) flush();
      baselineY = y;
      penX = Number.isFinite(x) ? x : undefined;
      placed = true;
    } else if (match[13] !== undefined) {
      // Td/TD: relative move in text space, scaled by the text matrix — the
      // producer positions continuation runs this way, so the pen must follow
      // it or a repaint of such a run's last glyph goes unrecognised.
      const tx = Number(match[13]);
      const ty = Number(match[14]);
      if (Math.abs(ty) > 0.6) flush();
      if (baselineY !== undefined) baselineY += ty * scale;
      if (penX !== undefined && Number.isFinite(tx)) penX += tx * xScale;
      placed = true;
    } else if (match[15] !== undefined) {
      clips.push(false);
    } else if (match[16] !== undefined) {
      clips.pop();
    } else if (match[17] !== undefined) {
      // W n: the pending path becomes the clip of the innermost q block.
      if (clips.length > 0) clips[clips.length - 1] = true;
    } else {
      // T*: next line, always.
      flush();
      penX = undefined;
      placed = false;
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
  // Modern producers tuck non-stream dictionaries — fonts above all — into
  // compressed /ObjStm containers, invisible to the scan above. Surface the
  // members; streams cannot nest inside an ObjStm, so one pass suffices.
  for (const [, body] of [...objects]) {
    if (!/\/Type\s*\/ObjStm\b/.test(body)) continue;
    const count = Number(/\/N\s+(\d+)/.exec(body)?.[1]);
    const first = Number(/\/First\s+(\d+)/.exec(body)?.[1]);
    const data = pdfStreamOf(body);
    if (data === undefined || !Number.isFinite(count) || !Number.isFinite(first)) continue;
    const header = data.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < count; i += 1) {
      const id = header[2 * i] as number;
      const at = first + (header[2 * i + 1] as number);
      const end = i + 1 < count ? first + (header[2 * (i + 1) + 1] as number) : data.length;
      if (!objects.has(id) && Number.isFinite(id) && Number.isFinite(at)) {
        objects.set(id, data.slice(at, end));
      }
    }
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
  const kidIds: number[] = [];
  const scanIds: number[] = [];
  for (const [id, body] of objects) {
    if (/\/Type\s*\/Pages\b/.test(body)) {
      const kids = /\/Kids\s*\[([^\]]*)\]/.exec(body)?.[1] ?? '';
      for (const kid of kids.matchAll(/(\d+)\s+0\s+R/g)) kidIds.push(Number(kid[1]));
    } else if (/\/Type\s*\/Page\b/.test(body)) {
      scanIds.push(id);
    }
  }
  // A readable Kids array is the authoritative page order; the scan order is
  // the fallback for files whose page tree we cannot see. Never both — a
  // page reached both ways would be extracted twice.
  const pageIds = [...new Set(kidIds.length > 0 ? kidIds : scanIds)];
  const orderedPages = pageIds.filter((id) => {
    const body = objects.get(id);
    return body !== undefined && /\/Type\s*\/Page\b/.test(body);
  });
  const pages: DocPage[] = [];
  const allLines: string[] = [];
  const fontCache = new Map<number, PdfFont>();
  for (const [index, id] of orderedPages.entries()) {
    const body = objects.get(id) as string;
    const contentRefs = [
      ...(/\/Contents\s*\[([^\]]*)\]/.exec(body)?.[1] ?? /\/Contents\s+(\d+\s+0\s+R)/.exec(body)?.[1] ?? '').matchAll(
        /(\d+)\s+0\s+R/g,
      ),
    ].map((m) => Number(m[1]));
    const fonts = pdfPageFonts(objects, body, fontCache);
    const lines: string[] = [];
    for (const ref of contentRefs) {
      const stream = pdfStreamOf(objects.get(ref) ?? '');
      if (stream !== undefined) lines.push(...pdfStreamLines(stream, fonts));
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
 * so the extracted text itself changes for fragmented PDFs. v4: hex-string
 * text decodes through Type0 ToUnicode CMaps (ObjStm-resident fonts
 * surfaced), recovering CID-typeset bodies that previously extracted as
 * whitespace. v5: sections carry the running page header as part context, so
 * a repeated enumeration can be told apart by the part it sits in. v6: a
 * glyph re-painted inside a clip region is extracted once, so text that
 * straddles clip boundaries reads as written. v7: a Markdown line that is
 * entirely bold counts as a heading, so documents converted out of word
 * processors and PDFs map to their real structure instead of to the handful
 * of ATX headings they happen to carry.
 */
export const DETECTOR_VERSION = 7;

/**
 * A Markdown line that is entirely bold, the heading form of every document
 * converted out of a word processor or a PDF. Requires the emphasis to open
 * the line and close it, so an inline bold phrase never matches.
 */
const BOLD_LINE_HEADING = /^\*\*\s*(\S[^*]*?)\s*\*\*[:.]?$/;

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
      if (md !== null) {
        headings.push({ line: i + 1, level: (md[1] as string).length, title: md[2] as string });
        return;
      }
      // A whole line in bold, standing alone, is a heading in every document
      // converted from a word processor or a PDF. The field case is NIST AI
      // 600-1: 2,499 lines carrying four ATX headings and all of its real
      // structure in bold lines, which mapped to four sections covering the
      // entire document. Length-guarded like the plain-text detectors so a
      // bold sentence inside a paragraph does not qualify.
      const bold = BOLD_LINE_HEADING.exec(trimmed);
      if (bold !== null && (bold[1] as string).trim().length <= 100) {
        headings.push({ line: i + 1, level: 2, title: (bold[1] as string).trim() });
      }
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

/** Header lines carry no information when they are page furniture. */
const RUNNING_HEADER_NOISE = /^[\s\d.,;:|/\\-]*$/;
/** A running header repeated on fewer pages than this is just a first line. */
const MIN_RUNNING_HEADER_PAGES = 3;

/**
 * The running page header of each page, when the document has one: the first
 * non-empty line of a page, kept only where the same line leads at least
 * three pages. A paginated corpus states its own part structure this way
 * ("Examples: Abstract Ideas" for pages 1-20, "Nature-Based Products" for
 * 21-37), and that part is the signal that separates the two Example 5s the
 * flat section list cannot tell apart (field failure, corpus idf
 * 2026-08-02). Documents without repeated headers simply get no context.
 */
export function runningHeaders(text: string, pages: DocPage[]): Map<number, string> {
  const lines = text.split(/\r?\n/);
  const firstLines = new Map<number, string>();
  const counts = new Map<string, number>();
  for (const page of pages) {
    const first = lines
      .slice(page.startLine - 1, page.endLine)
      .find((l) => l.trim() !== '')
      ?.trim()
      .replace(/\s+/g, ' ');
    if (first === undefined || first.length > 80 || RUNNING_HEADER_NOISE.test(first)) continue;
    firstLines.set(page.page, first);
    counts.set(first, (counts.get(first) ?? 0) + 1);
  }
  const headers = new Map<number, string>();
  for (const [page, first] of firstLines) {
    if ((counts.get(first) ?? 0) >= MIN_RUNNING_HEADER_PAGES) headers.set(page, first);
  }
  return headers;
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
  const headers = runningHeaders(extraction.text, extraction.pages ?? []);
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
    const context = page === undefined ? undefined : headers.get(page);
    // A section that IS the running header carries no context of its own.
    if (context !== undefined && context !== title) section.context = context;
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
/**
 * The rendered structure map: a document's skeleton, one citation line per
 * section carrying the id, title, anchor and one-line summary. Shared by the
 * doc-skeleton distiller (which has a stored artifact and so can offer a zoom
 * handle) and the offline mirror refresh (which cannot), so a document's
 * skeleton reads the same however it was built.
 */
export function renderStructureMap(options: {
  filePath?: string;
  sections: DocSection[];
  pages?: DocPage[];
  /** Pre-formatted recovery hint, e.g. `zoom: dcp__zoom("a1b2c3", query?)`. */
  zoomHint: string;
  maxSections?: number;
  /**
   * Byte budget the map should fit. A heavily sectioned document (the field
   * PDF: 171 sections over an 85KB text layer) produces a map that is itself
   * bulky, and a map that does not shrink the artifact has no reason to be
   * served. Rather than refuse outright, the per-section summaries are
   * dropped and the section list kept, which is the part that carries
   * navigation; the drop is disclosed inline.
   *
   * There is deliberately no third step that drops sections. Every section
   * the map lists, it lists faithfully — that is what lets the prose entity
   * gate hold at ratio 1. A document whose bare section list still will not
   * fit is one that is mostly headings, so there is no body to elide and
   * nothing to save: it is served raw, which is the honest outcome.
   */
  maxBytes?: number;
}): string {
  const { sections, pages, zoomHint } = options;
  if (sections.length === 0) return '';
  const shown = sections.slice(0, options.maxSections ?? 400);

  const render = (count: number, withSummaries: boolean): string => {
    const kept = shown.slice(0, count);
    const out: string[] = [
      `document ${options.filePath ?? '(unnamed)'}: ${sections.length} sections${
        pages === undefined ? '' : `, ${pages.length} pages`
      }`,
      `[full document elided, ${zoomHint}; a section id or title recovers that section byte-exact]`,
    ];
    for (const section of kept) {
      const line = `§${section.id} ${section.title} (${sectionAnchor(section)})`;
      out.push(withSummaries ? `${line} — ${section.summary}` : line);
    }
    if (!withSummaries) {
      out.push('[dcp: per-section summaries omitted to fit the serve budget]');
    }
    const omitted = sections.length - kept.length;
    if (omitted > 0) {
      out.push(`[dcp: omitted ${omitted} further sections, ${zoomHint}]`);
    }
    return out.join('\n');
  };

  const fits = (text: string): boolean =>
    options.maxBytes === undefined || Buffer.byteLength(text, 'utf8') <= options.maxBytes;

  const full = render(shown.length, true);
  if (fits(full)) return full;
  // Terse: the section list without summaries. When even this is over budget
  // the caller's size gate refuses it and the document is served raw.
  return render(shown.length, false);
}

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

/**
 * How one reference in an ask resolved against a document that repeats its
 * enumeration (field failure, corpus idf 2026-08-02: "Example 5" matches six
 * sections across four parts of the USPTO examples PDF). Every candidate is
 * kept so the caller can disclose the collision instead of resolving it
 * silently.
 */
export interface RefResolution {
  ref: SectionRef;
  /** Every section the reference matches, in document order. */
  candidates: DocSection[];
  chosen: DocSection;
  /** Whether the ask itself picked the chosen candidate. False means the
   * choice fell back to document order and the reader must be told. */
  discriminated: boolean;
}

/** Ask words that agree with a candidate's own title or part context. */
function contextAgreement(section: DocSection, ask: string): number {
  const askWords = new Set(normWords(ask));
  const own = [...new Set(normWords(`${section.title} ${section.context ?? ''}`))].filter(
    (w) => !HEADING_STOPWORDS.has(w) && w.length > 1,
  );
  return own.filter((w) => askWords.has(w)).length;
}

/**
 * Resolve each reference against the sections it matches. A reference that
 * matches once is simply that section. A reference that matches several is
 * decided by what the ask itself says — the part it names ("Nature-Based
 * Products"), or the title it names ("genetically modified bacterium") — and
 * only when the ask says nothing discriminating does it fall back to
 * document order, which is what a bare "Example 5" means: the first one.
 * Body keyword volume never decides between two reference matches; that is
 * exactly how the eligibility boilerplate of a later example used to win.
 */
export function resolveSectionRefs(
  sections: DocSection[],
  refs: SectionRef[],
  ask: string,
): RefResolution[] {
  const resolutions: RefResolution[] = [];
  for (const ref of refs) {
    const candidates = sections.filter((s) => sectionMatchesRef(s, ref));
    const first = candidates[0];
    if (first === undefined) continue;
    if (candidates.length === 1) {
      resolutions.push({ ref, candidates, chosen: first, discriminated: true });
      continue;
    }
    // The reference phrase itself ("Example 5") is common to every candidate,
    // so it must not count as agreement; score on what is left of the ask.
    const rest = ask.replace(new RegExp(escapeRegExp(ref.raw), 'gi'), ' ');
    const scored = candidates.map((section) => ({
      section,
      agreement: contextAgreement(section, rest),
    }));
    const best = scored.reduce((a, b) => (b.agreement > a.agreement ? b : a));
    const runnerUp = scored
      .filter((s) => s.section !== best.section)
      .reduce((n, s) => Math.max(n, s.agreement), 0);
    const discriminated = best.agreement > 0 && best.agreement > runnerUp;
    resolutions.push({
      ref,
      candidates,
      chosen: discriminated ? best.section : first,
      discriminated,
    });
  }
  return resolutions;
}

export interface SectionScore {
  section: DocSection;
  tier: SectionTier;
  /** Keyword match volume over the section body — the tie-breaker, never the ranking. */
  bodyScore: number;
  /** 2 for the section a reference resolved to, 1 for a colliding candidate
   * it did not, 0 for no reference match. Ranks above body volume so a
   * repeated enumeration is decided on identity. */
  refRank: number;
  text: string;
}

/** Every section scored against the ask: identity tier first, body volume second. */
export function scoreSections(
  text: string,
  sections: DocSection[],
  ask: string,
  refs: SectionRef[] = parseSectionRefs(ask),
  resolutions: RefResolution[] = resolveSectionRefs(sections, refs, ask),
): SectionScore[] {
  const keywords = askKeywords(ask);
  const pattern =
    keywords.length === 0 ? undefined : new RegExp(keywords.map(escapeRegExp).join('|'), 'gi');
  const chosen = new Set(resolutions.map((r) => r.chosen));
  return sections.map((section) => {
    const body = sectionText(text, section);
    const isRef = refs.some((r) => sectionMatchesRef(section, r));
    const tier: SectionTier = isRef ? 'ref' : headingMatch(section.title, ask);
    const bodyScore = pattern === undefined ? 0 : [...body.matchAll(pattern)].length;
    const refRank = !isRef ? 0 : chosen.has(section) ? 2 : 1;
    return { section, tier, bodyScore, refRank, text: body };
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
  scored.sort(
    (a, b) =>
      TIER_RANK[b.tier] - TIER_RANK[a.tier] || b.refRank - a.refRank || b.bodyScore - a.bodyScore,
  );
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
  /** How each reference in the ask resolved inside this document, including
   * the candidates it collided with. */
  resolutions: RefResolution[];
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
    const resolutions = resolveSectionRefs(entry.sections, refs, ask);
    const scores = scoreSections(artifact.raw, entry.sections, ask, refs, resolutions);
    const docHits = byPath.get(entry.path) ?? [];
    const tier = scores.reduce<SectionTier>(
      (best, s) => (TIER_RANK[s.tier] > TIER_RANK[best] ? s.tier : best),
      'none',
    );
    if (docHits.length === 0 && TIER_RANK[tier] === 0) continue;
    ranked.push({ entry, hits: docHits, scores, tier, resolutions });
  }
  const bodyTotal = (d: RankedDocument): number => d.scores.reduce((n, s) => n + s.bodyScore, 0);
  // A document holding the section a reference resolved to outranks one that
  // merely holds a same-numbered namesake.
  const chosenRefs = (d: RankedDocument): number => d.scores.filter((s) => s.refRank === 2).length;
  ranked.sort(
    (a, b) =>
      TIER_RANK[b.tier] - TIER_RANK[a.tier] ||
      chosenRefs(b) - chosenRefs(a) ||
      b.hits.length - a.hits.length ||
      bodyTotal(b) - bodyTotal(a) ||
      a.entry.path.localeCompare(b.entry.path),
  );
  return ranked;
}
