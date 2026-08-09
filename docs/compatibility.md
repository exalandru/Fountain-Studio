# Fountain compatibility and performance evidence

This document records what Fountain Studio **claims** publicly and what
automated tests currently **prove**. It is not a Fountain specification and not
a guarantee of identical pagination or PDF output versus Highland, Final Draft,
or other tools.

Reference syntax overview (external, not copied into this repository):
[fountain.io/syntax](https://fountain.io/syntax/).

## Public claims (README)

| Claim | Classification | Evidence |
| --- | --- | --- |
| Broad Fountain syntax support for standard screenplay workflows | **PARTIAL → defended by tests** | Lexer / parse / inline / PDF unit tests + project corpus `test/corpus/complet.fountain` |
| Plain-text `.fountain` files with companion sidecars | **PROVEN** | Document / bundle / Save As E2E and unit tests |
| “Fully compatible with the Fountain format” (historical) | **INCORRECT as absolute claim** | Removed; no external conformance corpus or cross-app differential oracle in-tree |
| Pixel / pagination identity with third-party Fountain apps | **UNPROVEN** | Not claimed; PDF tests cover Fountain Studio’s own pagination engine |

## Syntax coverage matrix

Layers:

- **Lexer** — line kinds (`test/unit/lexer.test.ts`)
- **Parser** — AST / indexes / offsets (`test/unit/parse.test.ts`, corpus)
- **Inline** — emphasis (`test/unit/inline.test.ts`)
- **Editor** — highlighting / modes (E2E `app.spec.ts`, analysis helpers)
- **Pagination / PDF** — Studio’s engine (`test/unit/pagination.test.ts`, `test/unit/pdf.test.ts`)

| Construct | Lexer | Parser | Editor | PDF | Primary tests |
| --- | --- | --- | --- | --- | --- |
| Scene headings | yes | yes | yes | yes | lexer, parse, pdf |
| Forced scene heading (`.`) | yes | yes | yes | yes | lexer, corpus, pdf |
| Action | yes | yes | yes | yes | lexer, parse, pdf |
| Forced action (`!`) | yes | yes | — | yes | lexer, corpus |
| Character / dialogue | yes | yes | yes | yes | lexer, parse, pdf |
| Forced character (`@`) | yes | yes | — | — | lexer |
| Parentheticals | yes | yes | yes | yes | lexer, pagination, pdf |
| Dual dialogue (`^`) | yes | yes | — | yes | lexer, pdf |
| Lyrics (`~`) | yes | yes | — | yes | lexer, pdf |
| Transitions (`TO:` / `>`) | yes | yes | — | yes | lexer, corpus |
| Centered text | yes | yes | — | yes | lexer, pdf |
| Sections / synopsis | yes | yes | yes | — | lexer, parse, corkboard |
| Title page | yes | yes | yes | yes | lexer, parse, e2e title preview |
| Notes `[[ ]]` | — | yes | yes | opt. | parse, e2e visibility |
| Boneyard `/* */` | — | yes | yes | — | parse, e2e visibility |
| Emphasis `* _` | — | inline | yes | yes | inline, pdf |
| Escaped emphasis | — | inline | — | — | inline |
| Page breaks `===` | yes | yes | — | yes | lexer, pagination |
| Unicode / accents | yes | yes | — | — | lexer, parse, corpus |
| CRLF / LF offsets | yes | — | — | — | lexer `splitLines` |

“—” means no dedicated witness at that layer (the construct may still round-trip as text).

## What is deliberately not proven

- Full external Fountain conformance suite from fountain.io samples (licence / packaging not vendored here).
- Differential equality against another Fountain parser as absolute oracle.
- Production MORE/CONTINUED behaviour (Fountain itself excludes many production features; Studio’s revision system is separate).
- Electron typing latency as a hard public SLA (see performance section).

## Project corpus

`test/corpus/complet.fountain` is an **in-house** French screenplay fixture (project-authored).
It exercises dual dialogue, lyrics, notes, boneyard, forced heading/action, transitions,
centered text, page break, sections/synopses, and accented capitals. Provenance:
authored for Fountain Studio tests — not copied from a third-party corpus.

## Performance evidence

| Measurement | What it covers | What it does **not** cover | Location |
| --- | --- | --- | --- |
| Node `analyzeForEditor` on ~120-page synthetic script | Sync editor analysis CPU | CodeMirror, Electron input, paint, worker | `test/unit/performance.test.ts` |
| Node `parse` on same fixture | Full parse CPU (worker body) | Worker postMessage / scheduling | same |
| Electron typing witness | Keystroke → editor text + next paint; separate worker refresh | Device-independent SLA; CI-comparable absolute ms | `test/e2e/typing-performance.spec.ts` |

Results are environment-dependent. Tests print median / p95 (and p99 when enough samples).
Public wording avoids fixed “always &lt; N ms” guarantees.
