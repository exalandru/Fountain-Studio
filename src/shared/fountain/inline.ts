import type { InlineSpan } from './ast.js';

/**
 * Resolves Fountain emphasis: `*italic*`, `**bold**`, `***bold italic***`,
 * `_underline_`, their combinations, and the `\*` escape.
 *
 * Implementation: rather than a stack parser — which handles crossed nesting such as
 * `_**bold underline**_` poorly — two arrays run parallel to the text: a per-character
 * style mask and a "this character is a marker" flag. Rules are then applied from the
 * longest delimiter to the shortest. Nesting falls out naturally, and absolute offsets
 * stay exact.
 */

const ITALIC = 1;
const BOLD = 2;
const UNDERLINE = 4;

interface Rule {
  marker: string;
  style: number;
}

/** Order matters: `***` must be consumed before `**`, and `**` before `*`. */
const RULES: Rule[] = [
  { marker: '***', style: BOLD | ITALIC },
  { marker: '**', style: BOLD },
  { marker: '*', style: ITALIC },
  { marker: '_', style: UNDERLINE },
];

export function parseInline(text: string, offset = 0): InlineSpan[] {
  const n = text.length;
  const style = new Uint8Array(n);
  const isMarker = new Uint8Array(n);
  const escaped = new Uint8Array(n);

  // Pass 1: escapes. The backslash disappears, and the following character becomes
  // literal so it can never act as a delimiter.
  for (let i = 0; i < n - 1; i++) {
    const next = text[i + 1];
    if (text[i] === '\\' && next !== undefined && '*_\\'.includes(next)) {
      isMarker[i] = 1;
      escaped[i + 1] = 1;
      i++;
    }
  }

  // Pass 2: delimiter pairing, longest marker first.
  for (const rule of RULES) {
    const len = rule.marker.length;
    let searchFrom = 0;

    for (;;) {
      const open = findDelimiter(text, rule.marker, searchFrom, isMarker, escaped);
      if (open === -1) break;

      const close = findDelimiter(text, rule.marker, open + len, isMarker, escaped);
      if (close === -1) break;

      const contentFrom = open + len;
      // An opening delimiter cannot be followed by whitespace, nor a closing one
      // preceded by it: that is how a literal asterisk is written in Fountain.
      const firstChar = text[contentFrom];
      const lastChar = text[close - 1];
      if (
        contentFrom === close ||
        firstChar === undefined ||
        lastChar === undefined ||
        /\s/.test(firstChar) ||
        /\s/.test(lastChar)
      ) {
        searchFrom = open + len;
        continue;
      }

      for (let i = contentFrom; i < close; i++) style[i] = (style[i] ?? 0) | rule.style;
      for (let i = open; i < open + len; i++) isMarker[i] = 1;
      for (let i = close; i < close + len; i++) isMarker[i] = 1;

      searchFrom = close + len;
    }
  }

  // Pass 3: group characters sharing the same style.
  //
  // Grouping crosses removed markers: `Note\*` yields a single span "Note*" rather than
  // two. Deliberate consequence for the offset invariant — `from`/`to` bound the span
  // within the source, markers included, so `text` may be shorter than
  // `source.slice(from, to)`. That is what consumers need: text ready to render, plus
  // bounds to locate the span.
  const spans: InlineSpan[] = [];
  let current: InlineSpan | null = null;

  for (let i = 0; i < n; i++) {
    if (isMarker[i]) continue;
    const s = style[i] ?? 0;

    if (
      current &&
      current.bold === Boolean(s & BOLD) &&
      current.italic === Boolean(s & ITALIC) &&
      current.underline === Boolean(s & UNDERLINE)
    ) {
      current.text += text[i];
      current.to = offset + i + 1;
      continue;
    }

    current = {
      text: text[i] ?? '',
      bold: Boolean(s & BOLD),
      italic: Boolean(s & ITALIC),
      underline: Boolean(s & UNDERLINE),
      from: offset + i,
      to: offset + i + 1,
    };
    spans.push(current);
  }

  return spans;
}

/**
 * Finds `marker` from `from` onwards, skipping positions already consumed by a longer
 * rule or neutralised by an escape.
 */
function findDelimiter(
  text: string,
  marker: string,
  from: number,
  isMarker: Uint8Array,
  escaped: Uint8Array,
): number {
  const len = marker.length;
  let i = from;

  while (i <= text.length - len) {
    const at = text.indexOf(marker, i);
    if (at === -1) return -1;

    let usable = true;
    for (let k = at; k < at + len; k++) {
      if (isMarker[k] || escaped[k]) {
        usable = false;
        break;
      }
    }
    if (usable) return at;
    i = at + 1;
  }
  return -1;
}

/** Text stripped of emphasis — used by statistics and by the AI context. */
export function stripEmphasis(text: string): string {
  return parseInline(text)
    .map((s) => s.text)
    .join('');
}
