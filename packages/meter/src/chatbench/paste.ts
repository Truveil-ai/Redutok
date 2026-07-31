import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import type { CorpusEntry, PasteAssembly } from './types.js';

/**
 * File extensions the PASTE assembler will embed verbatim. Anything else
 * requires a `pasteExtractedSuffix` shadow, or the assembler throws. Kept
 * conservative so a stray binary never sneaks into the prompt.
 */
const TEXT_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.rst',
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.env',
  '.css',
  '.scss',
  '.html',
  '.d.ts',
  '.py',
  '.sh',
  '.sql',
  '.xml',
]);

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.cache', '.dcp', 'coverage']);

/** Extensionless files that are conventionally plaintext in a repo. */
const TEXT_BASENAMES = new Set([
  'LICENSE',
  'LICENCE',
  'NOTICE',
  'README',
  'CHANGELOG',
  'AUTHORS',
  'CONTRIBUTORS',
  'CODEOWNERS',
  'TODO',
  'COPYING',
  'MAKEFILE',
  'DOCKERFILE',
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
  '.eslintrc',
  '.prettierrc',
  '.npmignore',
  '.nvmrc',
]);

export function assemblePasteMessage(entry: CorpusEntry, repoRoot: string): PasteAssembly {
  const root = join(repoRoot, entry.root);
  const files = listFilesAlphabetical(root);
  const suffix = entry.pasteExtractedSuffix;
  const sourceFiles: PasteAssembly['sourceFiles'] = [];
  const parts: string[] = [];
  for (const abs of files) {
    const rel = relative(root, abs).split(sep).join(posix.sep);
    // Skip shadow files themselves; they are referenced by their principal.
    if (suffix !== '' && rel.endsWith(suffix)) continue;
    const ext = extname(rel);
    const base = basename(rel);
    let text: string;
    let usedShadow = false;
    const isText = TEXT_EXTENSIONS.has(ext) || TEXT_BASENAMES.has(base.toUpperCase());
    if (isText) {
      text = readFileSync(abs, 'utf8');
    } else {
      const shadow = suffix === '' ? '' : abs + suffix;
      if (shadow !== '' && fileExists(shadow)) {
        text = readFileSync(shadow, 'utf8');
        usedShadow = true;
      } else if (isProbablyText(abs)) {
        text = readFileSync(abs, 'utf8');
      } else if (suffix === '') {
        // Corpus without a shadow convention (e.g. a code repo): silently
        // skip binaries like PNGs and lockfiles that a chat user would not
        // paste anyway.
        continue;
      } else {
        // Corpus with a shadow convention (e.g. the docs corpus): every
        // binary must have a shadow, or the fixture is incomplete.
        throw new Error(
          `chatbench PASTE: binary source ${rel} has no ${suffix} shadow and is not utf-8 text`,
        );
      }
    }
    const body = `----- file: ${rel} -----\n${text}\n`;
    parts.push(body);
    sourceFiles.push({ path: rel, bytes: Buffer.byteLength(body, 'utf8'), usedShadow });
  }
  const text = parts.join('\n');
  return { text, sourceFiles, totalBytes: Buffer.byteLength(text, 'utf8') };
}

function basename(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx < 0 ? p : p.slice(idx + 1);
}

/** Cheap binary sniff: a NUL byte in the first 8 KB flags a file as binary. */
function isProbablyText(p: string): boolean {
  try {
    const buf = readFileSync(p);
    const window = buf.subarray(0, Math.min(buf.length, 8192));
    return window.indexOf(0) === -1;
  } catch {
    return false;
  }
}

function fileExists(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function extname(p: string): string {
  const idx = p.lastIndexOf('.');
  return idx < 0 ? '' : p.slice(idx).toLowerCase();
}

/** Recursively list files in a directory, alphabetical by relative path. */
function listFilesAlphabetical(root: string): string[] {
  const acc: string[] = [];
  walk(root, root, acc);
  acc.sort();
  return acc;
}

function walk(root: string, dir: string, acc: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (IGNORED_DIRS.has(name)) continue;
    const abs = join(dir, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(root, abs, acc);
    else if (st.isFile()) acc.push(abs);
  }
}
