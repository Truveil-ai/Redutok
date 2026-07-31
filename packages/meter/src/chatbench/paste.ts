import type { CorpusEntry, PasteAssembly } from './types.js';

/**
 * Assemble the PASTE arm's first user message from a corpus directory.
 * Binary files with a `pasteExtractedSuffix` sibling use the shadow;
 * plaintext files (.md, .txt, .ts, .js) are embedded verbatim. Ordering
 * is deterministic (alphabetical, files-before-dirs at each depth).
 */
export function assemblePasteMessage(_entry: CorpusEntry, _repoRoot: string): PasteAssembly {
  throw new Error('chatbench:assemblePasteMessage not implemented');
}
