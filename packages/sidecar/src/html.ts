import path from 'node:path';
import type Parser from 'web-tree-sitter';
import type { DocSection } from './docs.js';
import { declaredSymbols, loadTreeSitter } from './skeleton.js';

/**
 * HTML skeletons. A large .html file used to have no structure-aware path at
 * all: it is not one of the tree-sitter source languages the mirror covered,
 * and it is not prose, so the only thing between a single-file application and
 * the context window was the artifact-size escape hatch, which serves raw.
 *
 * That is the case that hurts most. The common real-world shape is one file
 * carrying its markup, its whole stylesheet and its whole application script,
 * where the markup is a few percent of the bytes and the two inline blocks are
 * all the rest. A map that named the elements but pasted the blocks would save
 * nothing, so the blocks are summarized by what they contain — the symbols a
 * script defines, the rules and selectors a stylesheet carries — and their
 * bodies stay behind the zoom handle.
 *
 * The skeleton is a DocSection list, the same object a prose structure map
 * produces, so rendering, the section/id zoom addressing and the mirror entry
 * shape are shared with docs.ts rather than reimplemented. One difference is
 * deliberate: a document's raw is its extracted text layer, but an HTML file's
 * raw is the file itself. A reader zooming into an application wants the
 * application back, so sections address source lines and recovery is
 * byte-equal against the source.
 */

const HTML_EXTENSIONS = new Set(['.html', '.htm']);

export function isHtmlPath(filePath: string): boolean {
  return HTML_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * Elements that structure a page. Any of these is a landmark wherever it
 * appears; every other element is a landmark only when it carries an id near
 * the top of the tree (LANDMARK_ID_MAX_DEPTH), which is how a hand-written
 * single-file app names the regions it wires up.
 */
const SECTIONING_TAGS = new Set([
  'head',
  'body',
  'header',
  'nav',
  'main',
  'section',
  'article',
  'aside',
  'footer',
  'form',
  'table',
  'dialog',
  'figure',
  'template',
]);

/** Depth at which an id stops meaning "a region of the page". The value nodes
 * of a KPI card carry ids too; those are contents, not landmarks. */
const LANDMARK_ID_MAX_DEPTH = 3;

const HEADING_TAG = /^h([1-6])$/;

/** How many names a block summary lists before it says how many are left. */
const SUMMARY_NAME_LIMIT = 8;
/** Ceiling for a text one-liner, matching the prose summary rule's shape. */
const SUMMARY_TEXT_LIMIT = 160;

type LandmarkKind = 'heading' | 'sectioning' | 'identified' | 'script' | 'style';

interface Landmark {
  /** 1-based line in the source. */
  line: number;
  kind: LandmarkKind;
  level: number;
  title: string;
  /** The element's id attribute, when it has one: the citation id a reader
   * already knows from the markup. */
  elementId?: string;
  /** Precomputed one-liner for blocks whose body the map replaces. */
  summary?: string;
}

/** Which landmark wins when several open on the same source line: the one
 * that tells a reader the most about what follows. */
const KIND_RANK: Record<LandmarkKind, number> = {
  heading: 4,
  script: 3,
  style: 3,
  sectioning: 2,
  identified: 1,
};

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

const truncate = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit - 3).trimEnd()}...`;

/** Visible text of a markup range: tags dropped, entities left as written. */
function visibleText(markup: string): string {
  return collapse(markup.replace(/<[^>]*>/g, ' '));
}

/**
 * The element outline of a markup range, for the sections that carry no text
 * of their own: a wrapper's one-liner is what it is made of. Distinct tags in
 * document order, so "meta, title, link" reads as the shape of a head.
 */
function elementOutline(markup: string): string {
  const tags = [...markup.matchAll(/<([a-zA-Z][\w-]*)/g)].map((m) => (m[1] as string).toLowerCase());
  const distinct = [...new Set(tags)];
  if (distinct.length === 0) return '';
  return `${tags.length} element${tags.length === 1 ? '' : 's'}: ${nameList(distinct)}`;
}

function attributeOf(node: Parser.SyntaxNode, name: string): string | undefined {
  const start = node.namedChild(0);
  if (start === null || (start.type !== 'start_tag' && start.type !== 'self_closing_tag')) {
    return undefined;
  }
  for (let i = 0; i < start.namedChildCount; i += 1) {
    const attribute = start.namedChild(i);
    if (attribute === null || attribute.type !== 'attribute') continue;
    if (attribute.namedChild(0)?.text.toLowerCase() !== name) continue;
    const value = attribute.namedChild(1);
    if (value === null) return '';
    return value.type === 'quoted_attribute_value'
      ? (value.namedChild(0)?.text ?? '')
      : value.text;
  }
  return undefined;
}

function tagNameOf(node: Parser.SyntaxNode): string | undefined {
  const start = node.namedChild(0);
  if (start === null || (start.type !== 'start_tag' && start.type !== 'self_closing_tag')) {
    return undefined;
  }
  const named = start.namedChild(0);
  return named?.type === 'tag_name' ? named.text.toLowerCase() : undefined;
}

/** The raw_text body of a script or style element: everything between its tags. */
function rawTextOf(node: Parser.SyntaxNode): string {
  for (let i = 0; i < node.namedChildCount; i += 1) {
    const child = node.namedChild(i);
    if (child?.type === 'raw_text') return child.text;
  }
  return '';
}

/**
 * Top-level CSS rules and the selectors that open them. A deterministic scan
 * rather than a second grammar: a stylesheet's shape is its brace depth, and
 * everything the summary needs (how many rules, which selectors lead) is
 * readable at depth zero.
 */
export function cssOutline(css: string): { rules: number; selectors: string[] } {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const selectors: string[] = [];
  let depth = 0;
  let buffer = '';
  let rules = 0;
  for (const ch of source) {
    if (ch === '{') {
      const selector = collapse(buffer);
      if (depth === 0 && selector !== '') selectors.push(selector);
      if (selector !== '' && !selector.startsWith('@')) rules += 1;
      depth += 1;
      buffer = '';
    } else if (ch === '}') {
      depth = Math.max(0, depth - 1);
      buffer = '';
    } else {
      buffer += ch;
    }
  }
  return { rules, selectors };
}

function nameList(names: string[]): string {
  const shown = names.slice(0, SUMMARY_NAME_LIMIT);
  const rest = names.length - shown.length;
  return rest === 0 ? shown.join(', ') : `${shown.join(', ')} (+${rest} more)`;
}

/**
 * The one-liner that replaces a script block. JavaScript is parsed for the
 * names it declares — the single most useful thing to know about an inline
 * application script, and the thing a brace-blind scan gets wrong the moment
 * a string literal contains a brace. A block that is not JavaScript (a JSON-LD
 * payload, a template) is described by its type and size instead of being
 * parsed as code it is not.
 */
async function scriptSummary(node: Parser.SyntaxNode): Promise<string> {
  const src = attributeOf(node, 'src');
  const type = (attributeOf(node, 'type') ?? '').toLowerCase();
  const body = rawTextOf(node);
  const lines = body === '' ? 0 : body.split(/\r?\n/).length;
  if (src !== undefined && src !== '') {
    return `external script, src="${src}"${lines > 0 ? `, ${lines} inline lines` : ''}`;
  }
  const isJavaScript =
    type === '' ||
    type === 'module' ||
    /^(?:text|application)\/(?:javascript|ecmascript)$/.test(type);
  if (!isJavaScript) {
    return `${lines} lines of ${type === '' ? 'inline data' : type}`;
  }
  let names: string[] = [];
  try {
    names = await declaredSymbols(body, 'js');
  } catch {
    // A block the parser cannot handle still gets its size and boundary; a
    // summary is never worth failing a skeleton over.
    names = [];
  }
  return names.length === 0
    ? `inline script, ${lines} lines`
    : `inline script, ${lines} lines; defines ${nameList(names)}`;
}

function styleSummary(node: Parser.SyntaxNode): string {
  const body = rawTextOf(node);
  const lines = body === '' ? 0 : body.split(/\r?\n/).length;
  const { rules, selectors } = cssOutline(body);
  const head = `inline style, ${lines} lines, ${rules} rules`;
  return selectors.length === 0 ? head : `${head}; ${nameList(selectors)}`;
}

async function collectLandmarks(source: string): Promise<Landmark[]> {
  const parser = await loadTreeSitter('html');
  try {
    const landmarks: Landmark[] = [];
    // Depth-first in document order, so the landmark list comes out sorted.
    const walk = async (node: Parser.SyntaxNode, depth: number): Promise<void> => {
      for (let i = 0; i < node.namedChildCount; i += 1) {
        const child = node.namedChild(i);
        if (child === null) continue;
        const line = child.startPosition.row + 1;
        if (child.type === 'script_element') {
          const src = attributeOf(child, 'src');
          const type = attributeOf(child, 'type');
          const title =
            src !== undefined && src !== ''
              ? `<script src="${src}">`
              : type === undefined || type === ''
                ? '<script>'
                : `<script type="${type}">`;
          landmarks.push({ line, kind: 'script', level: 2, title, summary: await scriptSummary(child) });
          continue;
        }
        if (child.type === 'style_element') {
          landmarks.push({ line, kind: 'style', level: 2, title: '<style>', summary: styleSummary(child) });
          continue;
        }
        if (child.type === 'element') {
          const tag = tagNameOf(child);
          const id = attributeOf(child, 'id');
          const label = attributeOf(child, 'aria-label');
          const heading = tag === undefined ? null : HEADING_TAG.exec(tag);
          if (tag === 'title') {
            landmarks.push({ line, kind: 'heading', level: 1, title: visibleText(child.text) });
          } else if (heading !== null && heading !== undefined) {
            const entry: Landmark = {
              line,
              kind: 'heading',
              level: Number(heading[1]),
              title: visibleText(child.text),
            };
            if (id !== undefined && id !== '') entry.elementId = id;
            landmarks.push(entry);
          } else if (tag !== undefined && SECTIONING_TAGS.has(tag)) {
            landmarks.push(landmarkFor('sectioning', line, tag, id, label));
          } else if (tag !== undefined && id !== undefined && id !== '' && depth <= LANDMARK_ID_MAX_DEPTH) {
            landmarks.push(landmarkFor('identified', line, tag, id, label));
          }
        }
        await walk(child, depth + 1);
      }
    };
    await walk(parser.parse(source).rootNode, 0);
    return landmarks;
  } finally {
    parser.delete();
  }
}

function landmarkFor(
  kind: LandmarkKind,
  line: number,
  tag: string,
  id: string | undefined,
  label: string | undefined,
): Landmark {
  const opener = id === undefined || id === '' ? `<${tag}>` : `<${tag} id="${id}">`;
  // The accessible name, when the markup states one, is what the author calls
  // this region — and it is the part of the tag a reader recognises.
  const title = label === undefined || label === '' ? opener : `${opener} ${label}`;
  const entry: Landmark = { line, kind, level: 2, title };
  if (id !== undefined && id !== '') entry.elementId = id;
  return entry;
}

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** One landmark per source line: several elements commonly open on one line
 * ("<header id="top"><h1>Title</h1></header>"), and the map's anchor is the
 * line, so the most informative of them is the one that gets to speak. */
function bestPerLine(landmarks: Landmark[]): Landmark[] {
  const byLine = new Map<number, Landmark>();
  for (const landmark of landmarks) {
    const held = byLine.get(landmark.line);
    if (held === undefined || KIND_RANK[landmark.kind] > KIND_RANK[held.kind]) {
      // The winner keeps its own title, but an id from the element that owns
      // the line is the citation a reader would reach for.
      byLine.set(landmark.line, {
        ...landmark,
        ...(landmark.elementId === undefined && held?.elementId !== undefined
          ? { elementId: held.elementId }
          : {}),
      });
    }
  }
  return [...byLine.values()].sort((a, b) => a.line - b.line);
}

export interface HtmlSkeleton {
  sections: DocSection[];
  /**
   * The conclusion-relevant region for the entity gate: the source lines the
   * map promises to carry, which for a page is its headings and its block
   * boundaries. Deliberately not every landmark line — a tag full of layout
   * attributes is not something a map can or should reproduce verbatim, and
   * holding it to that would fail honest maps over class names.
   */
  regionLines: string[];
}

/**
 * The page's structure map: one section per landmark, each running to the line
 * before the next, so the sections partition the file and any one of them is a
 * byte-exact slice of the source.
 */
export async function buildHtmlSkeleton(source: string): Promise<HtmlSkeleton> {
  const lines = source.split('\n');
  const landmarks = bestPerLine(await collectLandmarks(source));
  if (landmarks.length === 0) return { sections: [], regionLines: [] };

  const sections: DocSection[] = [];
  const seenIds = new Map<string, number>();
  const uniqueId = (id: string): string => {
    const n = (seenIds.get(id) ?? 0) + 1;
    seenIds.set(id, n);
    return n === 1 ? id : `${id}-${n}`;
  };

  const push = (
    startLine: number,
    endLine: number,
    landmark: Landmark | undefined,
  ): void => {
    const bodyStart = landmark === undefined ? startLine : startLine + 1;
    const body = lines.slice(bodyStart - 1, endLine).join('\n');
    const title =
      landmark === undefined
        ? '(preamble)'
        : truncate(landmark.title === '' ? '(untitled)' : landmark.title, 80);
    const base =
      landmark?.elementId !== undefined && landmark.elementId !== ''
        ? landmark.elementId
        : slugify(title) || `s${sections.length + 1}`;
    sections.push({
      id: uniqueId(base.slice(0, 60)),
      title,
      level: landmark?.level ?? 1,
      startLine,
      endLine,
      summary:
        landmark?.summary ??
        (truncate(visibleText(body), SUMMARY_TEXT_LIMIT) || elementOutline(body) || title),
    });
  };

  const first = landmarks[0] as Landmark;
  if (first.line > 1) push(1, first.line - 1, undefined);
  landmarks.forEach((landmark, i) => {
    const end = (landmarks[i + 1]?.line ?? lines.length + 1) - 1;
    push(landmark.line, end, landmark);
  });

  const regionLines = landmarks
    .filter((l) => l.kind === 'heading' || l.kind === 'script' || l.kind === 'style')
    .map((l) => lines[l.line - 1] ?? '')
    .filter((l) => l.trim() !== '');
  return { sections, regionLines };
}
