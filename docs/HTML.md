# HTML skeletons

An HTML file had no structure-aware path. It is not one of the tree-sitter
source languages the mirror covered, and it is not prose, so a large `.html`
read met only the artifact-size escape hatch, which serves raw. The file type
most likely to arrive as one enormous artifact was the one type nothing could
shrink.

The common real-world shape is the single-file application: one file carrying
its markup, its whole stylesheet and its whole application script, where the
markup is a few percent of the bytes and the two inline blocks are all the
rest. A map that named the elements and pasted the blocks would save nothing,
so those blocks are summarized by what they contain and their bodies stay
behind the zoom handle.

## What an HTML skeleton is

The same object a prose skeleton is: a **structure map**, one citation line
per section carrying the section id, its title, its line anchor and a one-line
summary. `html.ts` builds the sections; `renderStructureMap` in `docs.ts`
renders them, so the rendering, the section-id zoom addressing and the mirror
entry shape are shared rather than reimplemented.

```
document app/index.html: 20 sections
[full document elided, zoom: dcp__zoom("a4b18c9", query?); a section id or title recovers that section byte-exact]
§head <head> (¶3) — 2 elements: meta
§style <style> (¶8) — inline style, 246 lines, 50 rules; :root, @media (prefers-color-scheme: dark), *, html, body, a, .page (+43 more)
§viewTabs <nav id="viewTabs"> Views (¶263) — Revenue Pipeline Retention Gross margin
§bookings-by-quarter Bookings by quarter (¶323) — 1 element: svg
§script <script> (¶357) — inline script, 258 lines; defines QUARTERS, ACCOUNTS, HISTORY, state, el, formatMoney, formatPercent, formatDate (+13 more)
§script-type-application-ld-json <script type="application/ld+json"> (¶616) — 9 lines of application/ld+json
```

Measured on the fixture that produced it (`revenue-dashboard.html`, 626 lines,
20,063 bytes): the map is 2,051 bytes, 10.2% of the source.

## What becomes a section

Landmarks, in document order, each section running to the line before the
next, so the sections partition the file exactly and any one of them is a
byte-exact slice of the source:

- **headings**: `<h1>`–`<h6>` and `<title>`, titled by their own text;
- **sectioning elements**: `head`, `body`, `header`, `nav`, `main`, `section`,
  `article`, `aside`, `footer`, `form`, `table`, `dialog`, `figure`,
  `template`, wherever they appear;
- **identified elements**: any element carrying an `id` within three levels of
  the root, which is how a hand-written page names the regions it wires up.
  Deeper ids are contents, not landmarks: the value nodes of a KPI card carry
  ids too;
- **`<script>` and `<style>` blocks**, always, at any depth.

Several elements commonly open on one line (`<header id="top"><h1>Title</h1>
</header>`). The map's anchor is the line, so the most informative landmark on
it speaks: heading, then block, then sectioning element, then bare id. The id
of the element that owns the line is kept as the citation id, so `§top` still
addresses it.

Citation ids come from the element's own `id` when it has one, else a slug of
the title, else a positional `s<N>`. A repeated id is suffixed `-2`, `-3`, so
a citation is never ambiguous.

## Script and style blocks

These are the point of the exercise, so they are the two summaries that are
structural rather than textual.

A **script** block is summarized by the names it declares:
`inline script, 258 lines; defines QUARTERS, ACCOUNTS, HISTORY, state, el,
formatMoney (+15 more)`. The names come from the tree-sitter JavaScript
grammar, not a scan — a brace-blind scan mistakes the first brace inside a
string literal for a block. A block that is not JavaScript (a JSON-LD payload,
an inline template) is described by its type and size instead of being parsed
as code it is not, and a block with a `src` is named by its source.

A **style** block is summarized by its rule count and its leading top-level
selectors: `inline style, 246 lines, 50 rules; :root, @media
(prefers-color-scheme: dark), *, html, body (+45 more)`. A stylesheet's shape
is its brace depth, and everything the summary needs is readable at depth
zero, so this one is a deterministic scan.

## Guarantees, and where they stop

The raw of an HTML file **is the file**. This is the one deliberate difference
from prose, where a document's raw is its extracted text layer: a reader
zooming into an application wants the application back, not stripped text. So
sections address source lines, `dcp__zoom` on the handle returns the source
byte for byte, and `dcp__zoom(handle, "style")` returns that block exactly as
written.

The `html-skeleton` profile carries the prose entity set at ratio 1. The
conclusion-relevant region is supplied by the builder rather than derived: it
is the **heading and block-boundary lines**, not every landmark line. A prose
section starts on its own heading line, so the default rule is exactly the
map's promise; an HTML landmark starts on a tag full of layout attributes the
map neither carries nor should, and holding it to that would fail honest maps
over class names. What the map promises for a page is that its headings and
its block boundaries survive, and that is what the gate checks.

The size gate is unchanged at ratio 0.4. A page whose map cannot beat its
source — a short page, or one that is mostly markup with no body to elide — is
served raw, exactly as it was before this profile existed. A file with fewer
than two landmarks gets no entry at all.

## Where it applies

The same three paths the prose skeleton reaches ([PROSE.md](PROSE.md)):

- the offline mirror refresh (`redutok codex refresh`, file-change notifies),
- the daemon's on-demand preparation, when the hook meets an oversized
  artifact nothing has indexed yet (see [POSTURE.md](POSTURE.md)),
- `/serve-file`, so `dcp__read` on a page returns a map.

Covered extensions: `.html`, `.htm`.
