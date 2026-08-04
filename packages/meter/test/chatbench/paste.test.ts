import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assemblePasteMessage, loadChatbenchConfig } from '../../src/chatbench/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..', '..', '..');
const configPath = path.join(repoRoot, 'bench', 'chatbench.yaml');

describe('assemblePasteMessage', () => {
  it('assembles the docs corpus using extracted shadows for PDF+DOCX', () => {
    const cfg = loadChatbenchConfig(configPath);
    const docs = cfg.corpora.find((c) => c.id === 'docs')!;
    const asm = assemblePasteMessage(docs, repoRoot);

    const shadowUsed = asm.sourceFiles.filter((s) => s.usedShadow).map((s) => s.path);
    expect(shadowUsed.some((p) => p.endsWith('engagement-letter.pdf'))).toBe(true);
    expect(shadowUsed.some((p) => p.endsWith('quality-review-checklist.docx'))).toBe(true);
    const paths = asm.sourceFiles.map((s) => s.path);
    expect(paths.some((p) => p.endsWith('billing-policy.md'))).toBe(true);
    expect(paths.some((p) => p.endsWith('glossary.md'))).toBe(true);
    expect(paths.some((p) => p.endsWith('retention-schedule.txt'))).toBe(true);
    expect(paths.some((p) => p.endsWith('fee-calculator.ts'))).toBe(true);

    // Every source file's text ends up in the message.
    expect(asm.text).toContain('1.5% per month');
    expect(asm.text).toContain('twelve equal monthly installments');
    expect(asm.text).toContain('USD 10,000,000');
    expect(asm.text).toContain('at least one installment month is required');

    // Byte total is the utf-8 length of the assembled text.
    expect(asm.totalBytes).toBe(Buffer.byteLength(asm.text, 'utf8'));
  });

  it('is deterministic across calls', () => {
    const cfg = loadChatbenchConfig(configPath);
    const docs = cfg.corpora.find((c) => c.id === 'docs')!;
    const a = assemblePasteMessage(docs, repoRoot);
    const b = assemblePasteMessage(docs, repoRoot);
    expect(a.text).toBe(b.text);
    expect(a.totalBytes).toBe(b.totalBytes);
  });

  it('never embeds the raw binary bytes of a PDF or DOCX', () => {
    const cfg = loadChatbenchConfig(configPath);
    const docs = cfg.corpora.find((c) => c.id === 'docs')!;
    const asm = assemblePasteMessage(docs, repoRoot);
    // A PDF header appearing literally would mean we embedded the binary.
    expect(asm.text.startsWith('%PDF')).toBe(false);
    expect(asm.text).not.toContain('%PDF-1.');
    // A DOCX starts with the PK zip magic; likewise a signal of an accidental
    // binary embed. Legitimate prose wouldn't contain this specific pattern.
    expect(asm.text).not.toContain('PK');
  });

  it('assembles the code corpus (axios) as raw source', () => {
    const cfg = loadChatbenchConfig(configPath);
    const code = cfg.corpora.find((c) => c.id === 'code')!;
    const asm = assemblePasteMessage(code, repoRoot);
    // Axios has many files; the assembly should be much larger than the docs.
    expect(asm.totalBytes).toBeGreaterThan(50_000);
    // A stable landmark from the vendored source.
    expect(asm.text).toContain('createInstance');
  });
});
