# Prose skeletons

Redutok's skeleton mirror began as a code feature: tree-sitter parses a source
file, signatures and docstrings survive, bodies are elided behind a zoom
handle. Every other file type passed through raw.

That is not how real projects are shaped. A field install on a documents repo
read a 263KB Markdown, a 186KB Markdown and a 1.2MB PDF entirely raw in one
session, because none of the three had a skeleton path at all. The most
common large artifacts in a working repository are prose.

The Vault already had the machinery for this — extraction, heading detection,
sections, page anchors, per-section one-liners — and it lives in the sidecar,
so the repo tool uses the same code rather than a second implementation.

## What a prose skeleton is

A document's skeleton is its **structure map**: one citation line per section
carrying the section id, its title, its anchor (`p.12` when the document is
paginated, `A340` otherwise) and a one-line summary. The body is elided behind
a zoom handle.

```
document sources/uae_pdpl.pdf: 171 sections, 27 pages
[full document elided, zoom: dcp__zoom("a4b18c9", query?); a section id or title recovers that section byte-exact]
§s1 Federal Decree-Law No. 45 of 2021 (p.1) — Federal Decree-Law No. 45 of 2021.
§s3 Applicability of the Decree Law (p.2) — The provisions of this Decree Law shall apply to...
```

Summaries come from the `LlmPass` seam with a deterministic first-sentence
rule as the fallback, so a repo with no local model still gets a usable map.

Covered types: Markdown, plain text, PDF and DOCX. A PDF's raw is its
extracted text layer, not its container bytes — that is what a read puts in
context, what the map is computed over, and therefore what zoom returns.

HTML is mapped by the same renderer through its own builder and profile, since
a page's structure is elements rather than prose headings and its raw is the
source itself. See [HTML.md](HTML.md).

## Where it applies

Three paths reach the same builder:

- the offline mirror refresh (`redutok codex refresh`, file-change notifies),
- the daemon's on-demand preparation, when the hook meets an oversized
  artifact nothing has indexed yet (see [POSTURE.md](POSTURE.md)),
- `/serve-file`, so `dcp__read` on a document returns a map.

## Guarantees, and where they stop

The `doc-skeleton` profile carries the Vault's prose entity set at ratio 1.
With no ask there is no conclusion-relevant region, so the region is the
document's own **heading lines**: every section a reader could cite has to
survive into the map verbatim.

A map that does not shrink the artifact has no reason to be served, so it is
rendered to fit the profile's size gate. When the annotated map is over
budget the per-section summaries are dropped and the section list kept; the
drop is disclosed in the map itself.

There is deliberately **no** step that drops sections. Every section the map
lists, it lists faithfully, which is what lets the entity gate hold at ratio
1. A document whose bare section list still will not fit is one that is mostly
headings: there is no body to elide and nothing to save, so it is served raw.
That is the honest outcome, not a failure.

A document with no detectable headings yields a single positional section
covering the whole file. That is not a map of anything, so no entry is
written and the document is read raw.

## Heading detection

Markdown uses ATX headings, and — since detector version 7 — a line that is
entirely bold. Documents converted out of a word processor or a PDF carry
their structure that way: NIST AI 600-1 is 2,499 lines with four ATX
headings, and mapped to four sections spanning the whole document until bold
lines counted.

Plain text and PDF use the detector set the Vault built for them: numbered
headings, named items (`Example 21`, `Claim 3`, `Part One`), lettered
outlines, ALL-CAPS lines and Title Case banners, with per-document overrides
available through `.dcp/config.json`.

`DETECTOR_VERSION` is stored on every index entry. A stale version
invalidates an entry even when the source hash matches, so existing corpora
re-map on the next ingest without a manual flag.

## Measured on the field documents

| document                 |     raw | skeleton |  ratio | sections     |
| ------------------------ | ------: | -------: | -----: | ------------ |
| DIFC reg-10 (Markdown)   |  268 KB |    18 KB |  14.7x | 84           |
| NIST AI 600-1 (Markdown) |  189 KB |   4.3 KB |  43.7x | 19 (was 4)   |
| UAE PDPL (PDF)           | 1.31 MB |  11.7 KB | 112.1x | 171, 27 pages|

The PDF was refused outright before the map learned to fit its budget.

Redutok by Truveil.
