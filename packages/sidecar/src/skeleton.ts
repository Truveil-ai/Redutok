import { createRequire } from 'node:module';
import path from 'node:path';
import Parser from 'web-tree-sitter';

/**
 * File skeletons via tree-sitter (wasm build, no native toolchain needed on
 * Windows). Signatures and docstrings survive; bodies are elided.
 */

export type SkeletonLanguage = 'ts' | 'js' | 'py';

/**
 * Grammars this build loads. HTML is not a SkeletonLanguage — a page has no
 * signature list, it has a document structure (html.ts) — but it comes out of
 * the same pinned wasm set, so the loader is shared rather than duplicated.
 */
export type ParserLanguage = SkeletonLanguage | 'html';

const require = createRequire(import.meta.url);
let initialized = false;
const languages = new Map<ParserLanguage, Parser.Language>();

async function loadLanguage(lang: ParserLanguage): Promise<Parser.Language> {
  if (!initialized) {
    await Parser.init();
    initialized = true;
  }
  const cached = languages.get(lang);
  if (cached !== undefined) return cached;
  const wasmDir = path.join(path.dirname(require.resolve('tree-sitter-wasms/package.json')), 'out');
  const file = {
    ts: 'tree-sitter-typescript.wasm',
    js: 'tree-sitter-javascript.wasm',
    py: 'tree-sitter-python.wasm',
    html: 'tree-sitter-html.wasm',
  }[lang];
  const language = await Parser.Language.load(path.join(wasmDir, file));
  languages.set(lang, language);
  return language;
}

/** A parser with the grammar already set. The caller owns it and must delete
 * it; the loaded Language itself is cached and shared. */
export async function loadTreeSitter(lang: ParserLanguage): Promise<Parser> {
  const language = await loadLanguage(lang);
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}

const DECLARATION_TYPES = new Set([
  'function_declaration',
  'class_declaration',
  'abstract_class_declaration',
  'interface_declaration',
  'type_alias_declaration',
  'enum_declaration',
  'method_definition',
  'lexical_declaration',
  'variable_declaration',
  'function_definition',
  'class_definition',
  'decorated_definition',
]);

function firstLineOf(nodeText: string): string {
  const line = nodeText.split(/\r?\n/, 1)[0] ?? '';
  return line.replace(/\s*[{]\s*$/, '').trimEnd();
}

function pythonDocstring(node: Parser.SyntaxNode): string | undefined {
  const body = node.childForFieldName('body');
  const first = body?.firstNamedChild;
  if (first?.type === 'expression_statement' && first.firstChild?.type === 'string') {
    return first.firstChild.text.split(/\r?\n/, 1)[0];
  }
  return undefined;
}

/** Whole-word match of any kept symbol against a declaration's first line. */
function keepsDeclaration(firstLine: string, keepSymbols: readonly string[]): boolean {
  return keepSymbols.some((symbol) =>
    new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(firstLine),
  );
}

function walk(
  node: Parser.SyntaxNode,
  lang: SkeletonLanguage,
  depth: number,
  out: string[],
  keepSymbols: readonly string[],
): void {
  for (let i = 0; i < node.namedChildCount; i += 1) {
    const child = node.namedChild(i);
    if (child === null) continue;
    let target = child;
    if (child.type === 'export_statement' || child.type === 'decorated_definition') {
      target = child.namedChild(child.namedChildCount - 1) ?? child;
    }
    if (DECLARATION_TYPES.has(target.type)) {
      const indent = '  '.repeat(depth);
      if (keepsDeclaration(firstLineOf(child.text), keepSymbols)) {
        // Skeleton enrichment (docs/GRADUATION.md): a graduated zoom hotspot
        // keeps this declaration's full body in the skeleton.
        const [first, ...rest] = child.text.split(/\r?\n/);
        out.push(`${indent}${first ?? ''}`, ...rest);
        continue;
      }
      out.push(`${indent}${firstLineOf(child.text)} ...`);
      if (lang === 'py') {
        const doc = pythonDocstring(target);
        if (doc !== undefined) out.push(`${indent}  ${doc}`);
      }
      if (
        depth < 1 &&
        ['class_declaration', 'abstract_class_declaration', 'class_definition', 'interface_declaration'].includes(
          target.type,
        )
      ) {
        const body = target.childForFieldName('body');
        if (body !== null && body !== undefined) walk(body, lang, depth + 1, out, keepSymbols);
      }
    }
  }
}

/**
 * The names a source block declares at its top level. What a one-line summary
 * of an inline script needs (html.ts): the symbols it defines, in source
 * order, without the bodies. Parsed rather than scanned, because a brace-blind
 * scan mistakes the first brace inside a string literal for a block.
 */
export async function declaredSymbols(source: string, lang: SkeletonLanguage): Promise<string[]> {
  const parser = await loadTreeSitter(lang);
  try {
    const root = parser.parse(source).rootNode;
    const names: string[] = [];
    for (let i = 0; i < root.namedChildCount; i += 1) {
      const child = root.namedChild(i);
      if (child === null) continue;
      const target =
        child.type === 'export_statement' || child.type === 'decorated_definition'
          ? (child.namedChild(child.namedChildCount - 1) ?? child)
          : child;
      if (!DECLARATION_TYPES.has(target.type)) continue;
      if (target.type === 'lexical_declaration' || target.type === 'variable_declaration') {
        for (let j = 0; j < target.namedChildCount; j += 1) {
          const declarator = target.namedChild(j);
          if (declarator?.type !== 'variable_declarator') continue;
          const name = declarator.childForFieldName('name')?.text;
          if (name !== undefined && name !== '') names.push(name);
        }
        continue;
      }
      const name = target.childForFieldName('name')?.text;
      if (name !== undefined && name !== '') names.push(name);
    }
    return [...new Set(names)];
  } finally {
    parser.delete();
  }
}

export async function fileSkeleton(
  source: string,
  lang: SkeletonLanguage,
  keepSymbols: readonly string[] = [],
): Promise<string> {
  const parser = await loadTreeSitter(lang);
  const tree = parser.parse(source);
  const out: string[] = [];
  const importLines = source.split(/\r?\n/).filter((l) => /^\s*(import|from)\b/.test(l)).length;
  if (importLines > 0) out.push(`[${importLines} import lines omitted]`);
  walk(tree.rootNode, lang, 0, out, keepSymbols);
  parser.delete();
  return out.join('\n');
}

export function languageForPath(filePath: string): SkeletonLanguage | undefined {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.ts' || ext === '.tsx' || ext === '.mts') return 'ts';
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs' || ext === '.jsx') return 'js';
  if (ext === '.py') return 'py';
  return undefined;
}
