import type { Annotation } from './ast.js';

/**
 * Neutralises boneyard blocks (slash-star … star-slash) and notes `[[ … ]]` before lexing.
 *
 * Implementation choice: instead of *removing* those regions — which would require an
 * offset mapping between cleaned and source text, a classic source of position bugs —
 * every character is replaced with a space while **line breaks are preserved**.
 * Consequently `masked.length === source.length` and line numbers are unchanged, so
 * every position the lexer computes is directly valid in the source document. There is
 * no mapping to maintain.
 *
 * A line that ends up entirely masked becomes blank, hence a block separator — which
 * matches the idea that these regions are invisible when printed.
 */
export interface MaskResult {
  masked: string;
  annotations: Annotation[];
}

interface Delimiter {
  open: string;
  close: string;
  kind: 'note' | 'boneyard';
}

const DELIMITERS: Delimiter[] = [
  { open: '/*', close: '*/', kind: 'boneyard' },
  { open: '[[', close: ']]', kind: 'note' },
];

/** Replaces a range with spaces, preserving line breaks. */
function blank(chars: string[], from: number, to: number): void {
  for (let i = from; i < to; i++) {
    if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
  }
}

export function maskAnnotations(source: string): MaskResult {
  // split('') rather than [...source]: we need UTF-16 code units, consistent with
  // String.length and indexOf, otherwise offsets drift at the first emoji.
  const chars = source.split('');
  const annotations: Annotation[] = [];

  // Offset-to-line lookup table, built once.
  let line = 0;
  const lineAt = new Int32Array(source.length + 1);
  for (let i = 0; i < source.length; i++) {
    lineAt[i] = line;
    if (source[i] === '\n') line++;
  }
  lineAt[source.length] = line;

  let i = 0;
  while (i < source.length) {
    let found: Delimiter | undefined;
    for (const d of DELIMITERS) {
      if (source.startsWith(d.open, i)) {
        found = d;
        break;
      }
    }

    if (!found) {
      i++;
      continue;
    }

    const contentStart = i + found.open.length;
    const closeAt = source.indexOf(found.close, contentStart);
    const unterminated = closeAt === -1;
    const end = unterminated ? source.length : closeAt + found.close.length;

    annotations.push({
      kind: found.kind,
      text: source.slice(contentStart, unterminated ? source.length : closeAt),
      range: { from: i, to: end },
      line: lineAt[i] ?? 0,
      unterminated,
    });

    blank(chars, i, end);
    i = end;
  }

  return { masked: chars.join(''), annotations };
}
