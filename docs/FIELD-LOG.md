# Field log: the Vault on a real patent corpus

Every fix in this log came from one professional using the Vault for real
work, not from a test suite. The order below is the order the defects
surfaced. Each entry states what the user saw, what was actually wrong, and
where the fix lives.

Nothing here was found by the tests that shipped with the feature. That is
the point of writing it down.

## The corpus

Corpus `idf`, two documents, mounted from a local directory and reached over
the MCP stdio transport from a chat client.

| document                      |     bytes | extraction | structure                              |
| ----------------------------- | --------: | ---------- | -------------------------------------- |
| USPTO 101_examples_1to36.pdf  | 1,310,756 | pdf-text   | 109 pages, 175 sections at detector v6 |
| Disclosure Bio Interview.docx |    14,084 | docx-xml   | 1 section                              |

The PDF is the USPTO's subject-matter-eligibility examples, a 109-page
document that renumbers its examples from 1 inside every part, mixes literal
and Type0 hex-encoded text, and is typeset by a producer that repaints
clipped glyphs. The DOCX is an invention disclosure. Both are hashed into
`.dcp/PROVENANCE.json` at ingest, so every citation traces to the bytes that
were read.

This corpus was not chosen to be difficult. It was the work in front of the
user. Every defect below is what a 109-page real-world PDF does to a document
pipeline that had only been tested on fixtures it generated itself.

## 1. Silent corpus defaulting

**Symptom.** `vault_receipt` with no corpus argument reported an empty
ledger, while the session's actual work sat untouched in another mount. An
empty result was indistinguishable from a wrong-target result. Earlier in the
same session, every handle a dossier offered failed `vault_zoom` with "no
artifact in the store".

**Diagnosis.** Both were the same bug wearing two masks. The chat client's
config mounted `fixtures` before `idf`, and any call that omitted the corpus
argument silently defaulted to the first mount. The artifacts were byte-intact
in `idf`'s store the whole time. The correlation with a recent re-ingest was
coincidental: the second mount had been added at the same time. Diagnosing
the zoom failure as re-ingest invalidation would have been wrong and would
have sent the fix into the wrong layer entirely.

**Fix.** Two rounds. First, `vault_zoom` learned to resolve a handle across
every mounted corpus, refusing by name when several corpora hold the same
random id, and `vault_ask` gained a guard that drops any handle whose artifact
is absent before rendering a dossier, so a dossier can never offer a dead
handle (commit `8bc5095`, PR #25).

Then the class was eliminated rather than the instance. Every unspecified-corpus
path was audited; the single defaulting site was `pickCorpus`, reached by
three tools plus the bearer-secret resolver (commit `f2ae5a2`, PR #26):

| path                       | unspecified corpus, several mounted                         |
| -------------------------- | ----------------------------------------------------------- |
| `vault_ask`, `vault_codex` | refuse, listing the mounted names                           |
| `vault_receipt`            | one attributed receipt per mount                            |
| `vault_zoom`               | resolve across mounts; a miss names the corpora searched    |
| bearer secret              | read across every mount, disagreeing mounts refused by name |

A single mounted corpus still serves unnamed calls. The tests reproduce the
field failure by mounting in the order that produced it.

## 2. PDF heading blindness

**Symptom.** The corpus map could not list the document's numbered examples.
Asking about a specific example meant zooming blindly.

**Diagnosis.** Heading detection knew `1. `, `1.2 `, and ALL-CAPS lines. A
document whose structure is carried by "Example 21", "Claim 3", "Part One",
lettered outlines, and Title Case banners collapsed into generic positional
preambles. The document had structure; the ingester could not see it.

**Fix.** Commit `577cc81`, PR #21. Named-item headings (Example, Claim, Part,
Section, Chapter, Appendix, Figure, Table, Exhibit, Case, Note, with arabic,
roman, or word-form numbers), lettered headings, and Title Case banners, with
semantic ids (`example-1`, `claim-3`, `part-one`) and a collision suffix so
repeated labels across parts do not overwrite each other. Corpus owners can
teach bespoke shapes per document through `.dcp/config.json` without patching
the detector; an invalid pattern is dropped with a warning rather than
bricking the ingest.

`DETECTOR_VERSION` became a stored, checked value: a stale version invalidates
an entry even when the source hash matches, so existing corpora upgrade on
the next ingest without a manual flag, and the ledger beside the index is left
alone.

Sections on the field document went from 119 to 271 at that detector version,
with 65 semantic claim entries and 2 part entries where there had been none.

**Declared gap, in the same commit.** Zero Example headings were recovered.
The commit said so instead of reporting the win alone. The reason went into
the next entry.

## 3. Line-fragment reassembly

**Symptom.** The follow-on from the declared gap: "Example 1: Isolating and
Removing Malicious Code" never matched any pattern, because that string never
existed as a token.

**Diagnosis.** The PDF emits one visual line as several text-showing
fragments, in two modes confirmed by dumping the real streams: same-baseline
`Td` continuation, which splits even mid-word ("/Gen" then "erating"), and
separate `BT`/`ET` blocks whose `Tm` shares a y coordinate. A tokenizer that
treats each show as a line sees fragments, not headings.

**Fix.** Commit `d5f33ec`, PR #22. `pdfStreamLines` tracks the baseline and
flushes a line only when the vertical move exceeds 0.6 em, so superscript
rises of about a third of an em stay inline while real line advances still
break. Same-baseline fragments concatenate verbatim; the glyph strings carry
their own spacing.

One guard rider came with it: joined lines arrive as full list items
("3. continue scanning until ..."), which would pass numbered-heading
detection. A numbered heading's title never starts lowercase, so those stay
body text.

Result on the field document: 77 numbered example and claim sections landed
with semantic ids, and a section's slice from the stored artifact is
byte-equal to a fresh extract and redact of the source PDF.

## 4. Retrieval ranking

**Symptom.** Six differently phrased asks naming USPTO Example 21 all
returned the wrong section.

**Diagnosis.** Two compounding causes. "21" fell under the four-character
keyword floor, so the enumeration in the question carried no weight at all,
and headings carried no ranking weight either. Ranking was body keyword
volume, and eligibility boilerplate is dense, so keyword-frequency decoys won
every time.

**Fix.** Commit `9a06cbb`, PR #23. Explicit enumerations in the ask
("Example 21", "§21", "section 21") resolve directly to section ids. Heading
matches rank in exact, strong, and partial tiers above any body keyword
volume, so a named section survives the serve cap against denser decoys.
Cross-document ordering became corpus-aware: section identity first, hit
count second, so a document reachable only by enumeration still ranks. A
pure-reference goal is no longer answered with "too vague to search".

Regression tests use the real failing headings rather than invented ones.

## 5. Heading collisions

**Symptom.** An ask for "Example 5" answered from Genetically Modified
Bacterium on page 27 instead of Digital Image Processing on page 13.

**Diagnosis.** The document renumbers from 1 in every part, so "Example 5"
matches six sections across four parts. All six tied at the reference tier
after fix 4, and the tie fell through to body keyword volume, which the later
example's boilerplate wins. Fixing ranking had converted a keyword failure
into a tie-break failure.

**Fix.** Commit `957f546`, PR #26. Sections carry the part they sit in, read
from the repeated first line of each page and kept only when it leads at
least three pages. A reference returns every candidate it matches, and the
tie is decided by what the ask says, the part it names or the title it names,
falling back to document order, which is what a bare "Example 5" means. Body
volume never decides between two reference matches.

An undecided collision is disclosed rather than guessed: the dossier names
the section it answered from and every namesake with its part, and the
confidence band is held below high with that as the stated reason.

## 6. The accounting reported success through six retrieval misses

**Symptom.** During the six wrong answers in entry 4, the dossier's accounting
block reported 200x to 500x reduction on every one of them. The compression
metric stayed green through every miss.

**Diagnosis.** This is the most serious finding in the log, and it is not a
retrieval bug. The accounting was arithmetically correct: those asks really
did touch that much raw and serve that little. The defect is that a number
measuring compression was positioned where a reader would read it as a
measure of whether the answer was right. A receipt that looks best exactly
when retrieval fails hardest is worse than no receipt.

**Fix.** Commit `1e47b12`, PR #23. A deterministic confidence band, high,
medium, or low, computed from heading-match strength, section references
resolved, question-term coverage of the evidence, and dossier completeness.
No scores, no model call. A low band renders a plain-language notice above
the dossier body, naming its grounds and stating outright that the reduction
figure measures compression and not retrieval quality. The reduction line
itself now carries "compression only, never answer quality". Bands are
recorded on every ledger line, ask, serve, and zoom, and the receipt reports
asks by band.

The rule this encodes: a savings number must never be able to look good
because the tool failed.

## 7. Handle durability across re-ingest

**Symptom.** After a detector-version bump and re-ingest, could an old handle
still be trusted? The field failure in entry 1 had first been read as
evidence that it could not.

**Diagnosis.** It could, and the correlation was misleading. Re-ingestion
never touches stored artifacts; handle ids are random rather than derived
from the detector, so a bump cannot invalidate them.

**Fix.** Commit `8bc5095`, PR #25 turned the belief into invariant tests: a
pre-upgrade handle zooms byte-equal after a re-ingest with a detector bump,
and every handle an ask emits resolves in the store. Live verification on the
field corpus recovered 2 of 2 fresh and 9 of 9 historic handles.

The same PR closed a related broken promise (commit `4722a6f`): a zoom query
could dead-end with "no lines matching", could silently drop matches past a
200-line cap, and could not reach a source document through the search-hits
artifact, which is often the only handle a failed ask leaves behind. A query
now narrows but never gates. When nothing matches, the full raw artifact
serves with a notice. Matches beyond the cap get an explicit elision marker
with the omitted count instead of a silent truncation.

## 8. CID hex-string body text

**Symptom.** Example 21's intro extracted cleanly, but its body, the
hypothetical claims and the Step 2A and 2B analysis on pages 40 to 42,
extracted as whitespace.

**Diagnosis.** Those pages typeset body text in Type0 and CID fonts as hex
strings. The literal-only tokenizer dropped them entirely, and the surviving
literal fragments were the spaces between words. The fonts and their
ToUnicode CMaps sit inside compressed object-stream containers the object
scan could not see either. Scope: 41 of 109 pages. The loss predated the
line-joining pass, so it was not a regression from entry 3.

**Fix.** Commit `64e56ff`, PR #24, entirely in the deterministic extraction
layer. Object-stream members are surfaced, each page's fonts resolve to
widths and CMaps, and hex strings decode through the ToUnicode CMap for Type0
fonts, with unmapped CIDs contributing silence rather than garbage. Page
ordering now prefers a readable page tree outright, so a page reachable both
ways is no longer extracted twice. The fixture is the real pages sliced
byte-verbatim with their containers intact.

## 9. Clipped-glyph doubling

**Symptom.** Page 14 extracted "claimm is directedd" and "Claim 100" where
the document says "Claim 10". A section id of `claim-100` cannot be cited.

**Diagnosis.** Not the CMap path from entry 8. Page 14 uses literal strings
under a TrueType font, and the producer paints each line as unclipped runs
and then repaints every glyph straddling a clip-region boundary inside its
own clip block. A renderer shows the glyph once, because each draw is clipped
to its own sliver. An extractor blind to x position and clipping concatenates
both.

**pypdf 6.10.2 reproduces the doubling verbatim.** Any future verification
that treats a pypdf reference as ground truth for this document will validate
the bug. The reference fixture is a volume baseline only.

**Fix.** Commit `7e8a783`, PR #26. The extractor carries the text origin
through both positioning operators, tracks clip depth, and drops a show that
only repaints ink already on the line, in the three shapes observed on the
page. Only a show an operator has just placed is eligible, so consecutive
shows that advance the pen by their own glyphs are never compared. A
genuinely repeated character advances by a glyph width, several points at any
readable size, so "Claim 1000" stays intact next to the "Claim 10" that used
to read "Claim 100".

Verification was a re-audit of all 109 pages, comparing every word against
the form the rest of the document uses:

|        | suspected doubled words | pages affected | page 14 |
| ------ | ----------------------: | -------------: | ------: |
| before |                     162 |             14 |     147 |
| after  |                      14 |             12 |       0 |

All 14 survivors are real words the heuristic flags ("iii", "feed", "off",
"filled"), present in the before run too.

## 10. The chatbench corpus-refusal interaction, caught by analysis

**Symptom.** None. This one was found on paper.

**Diagnosis.** Entry 1's fix makes `vault_ask` refuse when the corpus is
unspecified and several corpora are mounted. The chatbench harness (pull
request 20) drives its VAULT arm through a tool loop whose `vault_ask` schema
declares `corpus` optional, and its matrix runs two corpora. If a live run
were driven against a server with both mounted, every model-issued ask that
omitted the corpus argument would be refused, and the pre-registered rule
says a single arm error voids that triple and forces a rerun.

The dry-run cost band for the full matrix is 15 to 20 USD. Finding this after
the run would have meant paying it twice.

**Resolution.** Recorded here as a wiring precondition rather than patched
into an unmerged branch: when chatbench live mode is wired, the VAULT arm must
mount exactly one corpus per server, or pass the corpus argument explicitly
on every tool call. The interaction is a direct consequence of eliminating
silent defaulting, and eliminating silent defaulting was the right call. A
tool that quietly answers from the wrong corpus is worse than a tool that
refuses.

## The residual that was measured and deliberately left

Page 14 carries a second artifact, distinct from entry 9. The producer
sometimes leaves a blank where a clipped glyph sits, so a word arrives split:
"describ bes" for "describes", "dev vice" for "device", "relatin ng" for
"relating". Three instances, page 14 only.

The obvious fix, treating a run's trailing whitespace as belonging to the
repaint, was implemented and measured. It corrects "describes" and it corrupts
"as seen" into "aseen", because a run whose last word legitimately ends in the
letter that the next clipped run repaints is indistinguishable from a split
word without the glyph widths of a proportional font. The extractor does not
have those widths.

The change was reverted. The boundary is documented in the code rather than
papered over with a heuristic that damages correct text. Do not re-attempt it
without real font metrics from the width array or the embedded font program.

One further residual is open and untouched: page 62 of 109 extracts as no
page at all, a pre-existing gap from entry 8's work. Extraction reports 108 of
109 pages, and the index says so rather than implying completeness.

## The session receipt

One working session on this corpus, read from the corpus ledger at
`.dcp/ledger.db`, session `vault-stdio-3ba5a316`:

| quantity                    |     value |
| --------------------------- | --------: |
| asks                        |        13 |
| serve and zoom ledger lines |        52 |
| raw tokens touched          | 3,258,423 |
| tokens served               |   222,813 |
| tokens avoided              | 3,037,338 |
| ratio touched over served   |     14.6x |
| estimated cost avoided      |  9.11 USD |

Retrieval confidence across the 13 asks: 3 high, 10 medium, 0 low.

Every figure counts only what the session actually touched. The whole
corpus at rest is a separate line in the statement under its own label,
because a corpus you never read is not a saving. The cost figure is an
estimate at the claude-sonnet-5 input rate from `prices.yaml`, with the rate
row and its source pinned into every ledger line at the moment it was
written.

Two honest details from the same ledger. Of the 3,037,338 tokens avoided,
2,091,428 are attributable to the PDF and zero to the DOCX: the 14 KB
disclosure is smaller than the slices served around it, so the Vault saves
nothing on it, and the per-document rollup says so rather than averaging it
away. And the estimate is the input rate applied to tokens that a chat client
would otherwise have carried in its context. It is what the work would have
cost to paste, not a refund.

Redutok by Truveil.
