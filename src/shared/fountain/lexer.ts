import type { ElementKind } from './ast.js';

/**
 * Line-by-line classification of Fountain text.
 *
 * This module is shared by both consumers of highlighting (PLAN.md §3.2): the editor's
 * synchronous colouring and the full parser running in a worker. One implementation
 * means no possible divergence between what the author sees highlighted and what the
 * sidebar, the PDF or the AI consider to be the screenplay's structure.
 *
 * The expected input is the **masked** text (see mask.ts): boneyard and notes already
 * neutralised, offsets identical to the source document.
 */

export type LineKind = ElementKind | 'empty' | 'title_page_key' | 'title_page_value';

export interface LexedLine {
  kind: LineKind;
  /** Absolute offsets of the line in the source document, line break excluded. */
  from: number;
  to: number;
  /** Zero-based line index. */
  line: number;
  /** Raw line, exactly as it appears in the document. */
  raw: string;
  /** Useful text: syntax markers and surrounding whitespace removed. */
  text: string;
  /** True when a forcing character was used (`.` `!` `@` `>` `~`). */
  forced: boolean;

  /** `section`: 1..6. */
  depth?: number;
  /** `scene_heading`: number declared between `#`, without the hashes. */
  sceneNumber?: string;
  /** `character`: name cleaned of its extensions and of the `^`. */
  character?: string;
  /** `character`: parenthesised extensions, e.g. `(V.O.) (CONT'D)`. */
  extensions?: string;
  /** `character`: block marked `^` — right column of a dual dialogue. */
  dual?: boolean;
  /** `title_page_key`: key normalised to lower case. */
  key?: string;
}

const SCENE_PREFIX = /^(INT\.?\/EXT|I\/E|INT|EXT|EST)\b[.\s]?/i;
const TRANSITION_SUFFIX = /\bTO:$/;
/**
 * Common transitions that do not end in `TO:`, recognised as exceptions.
 *
 * Fountain content rather than interface text, so French forms are listed alongside the
 * English ones regardless of the interface language.
 */
const BARE_TRANSITIONS = new Set([
  'FADE OUT.',
  'FADE OUT',
  'CUT TO BLACK.',
  'CUT TO BLACK',
  'FADE TO BLACK.',
  'FADE TO BLACK',
  'FIN',
  'THE END',
  'GÉNÉRIQUE FIN',
]);
const TITLE_KEY = /^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9 _-]*):(.*)$/;

/** True when the text is upper case and contains at least one letter. */
export function isUpperCase(text: string): boolean {
  if (!/\p{L}/u.test(text)) return false;
  return text === text.toLocaleUpperCase('fr-FR');
}

interface CharacterParts {
  name: string;
  extensions: string;
  dual: boolean;
}

/**
 * Breaks up a character line: `JULIE (V.O.) ^` →
 * `{ name: 'JULIE', extensions: '(V.O.)', dual: true }`.
 */
export function splitCharacter(text: string): CharacterParts {
  let rest = text.trim();
  let dual = false;

  if (rest.endsWith('^')) {
    dual = true;
    rest = rest.slice(0, -1).trimEnd();
  }

  const extensions: string[] = [];
  for (;;) {
    const match = /\(([^()]*)\)\s*$/.exec(rest);
    if (!match) break;
    extensions.unshift(`(${match[1]})`);
    rest = rest.slice(0, match.index).trimEnd();
  }

  return { name: rest.trim(), extensions: extensions.join(' '), dual };
}

/** True when the line could be a character cue, ignoring context constraints. */
function looksLikeCharacter(text: string): boolean {
  const { name } = splitCharacter(text);
  if (name.length === 0) return false;
  // A scene heading is upper case too: it must not be mistaken for a character.
  if (SCENE_PREFIX.test(name)) return false;
  return isUpperCase(name);
}

interface State {
  inTitlePage: boolean;
  /** The current block is a dialogue block (we are under a character cue). */
  inDialogue: boolean;
  /** A title-page key is awaiting possible indented values. */
  pendingTitleKey: boolean;
}

/**
 * Splits the document into lines with their absolute offsets.
 * Handles LF and CRLF without shifting positions.
 */
export function splitLines(text: string): Array<{ raw: string; from: number; to: number }> {
  const out: Array<{ raw: string; from: number; to: number }> = [];
  let from = 0;

  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === '\n') {
      let to = i;
      if (to > from && text[to - 1] === '\r') to--;
      out.push({ raw: text.slice(from, to), from, to });
      from = i + 1;
      if (i === text.length) break;
    }
  }

  // A document ending in a line break yields a final empty line, which is correct:
  // it acts as a block separator.
  return out;
}

export function lexDocument(masked: string): LexedLine[] {
  const lines = splitLines(masked);
  const result: LexedLine[] = [];

  const state: State = {
    // A title page can only begin at the very start of the document.
    inTitlePage: startsWithTitlePage(lines),
    inDialogue: false,
    pendingTitleKey: false,
  };

  for (let i = 0; i < lines.length; i++) {
    const entry = lines[i];
    if (!entry) continue;
    const nextRaw = lines[i + 1]?.raw ?? '';
    const prevRaw = i > 0 ? (lines[i - 1]?.raw ?? '') : '';

    result.push(
      classify({
        raw: entry.raw,
        from: entry.from,
        to: entry.to,
        line: i,
        prevEmpty: i === 0 || prevRaw.trim().length === 0,
        nextEmpty: nextRaw.trim().length === 0,
        atStart: i === 0,
        state,
      }),
    );
  }

  return result;
}

/** A title page exists only if the first non-empty line is a `Key: Value` pair. */
function startsWithTitlePage(lines: Array<{ raw: string }>): boolean {
  for (const { raw } of lines) {
    if (raw.trim().length === 0) continue;
    const match = TITLE_KEY.exec(raw.trim());
    if (!match) return false;
    // `INT. KITCHEN - DAY` must not be taken for a title-page key.
    return !SCENE_PREFIX.test(raw.trim());
  }
  return false;
}

interface ClassifyInput {
  raw: string;
  from: number;
  to: number;
  line: number;
  prevEmpty: boolean;
  nextEmpty: boolean;
  atStart: boolean;
  state: State;
}

function classify(input: ClassifyInput): LexedLine {
  const { raw, from, to, line, prevEmpty, nextEmpty, state } = input;
  const trimmed = raw.trim();

  const base = { from, to, line, raw, forced: false };

  // ── Empty line: closes the current block, and the title page if open ──
  if (trimmed.length === 0) {
    state.inDialogue = false;
    state.pendingTitleKey = false;
    if (state.inTitlePage) state.inTitlePage = false;
    return { ...base, kind: 'empty', text: '' };
  }

  // ── Title page ──
  if (state.inTitlePage) {
    const match = TITLE_KEY.exec(trimmed);
    if (match && match[1] !== undefined) {
      const value = (match[2] ?? '').trim();
      state.pendingTitleKey = value.length === 0;
      return {
        ...base,
        kind: 'title_page_key',
        key: match[1].trim().toLowerCase(),
        text: value,
      };
    }
    if (state.pendingTitleKey || /^\s+\S/.test(raw)) {
      return { ...base, kind: 'title_page_value', text: trimmed };
    }
    // Neither a key nor an indented value: the title page ends here.
    state.inTitlePage = false;
  }

  // ── Page break: before synopsis, otherwise `===` would be read as `=` ──
  if (/^={3,}$/.test(trimmed)) {
    state.inDialogue = false;
    return { ...base, kind: 'page_break', text: trimmed };
  }

  // ── Section ──
  const section = /^(#{1,6})(.*)$/.exec(trimmed);
  if (section && section[1] !== undefined) {
    state.inDialogue = false;
    return {
      ...base,
      kind: 'section',
      depth: section[1].length,
      text: (section[2] ?? '').trim(),
    };
  }

  // ── Synopsis ──
  if (trimmed.startsWith('=')) {
    state.inDialogue = false;
    return { ...base, kind: 'synopsis', text: trimmed.slice(1).trim(), forced: true };
  }

  // ── Explicit forcing ──
  if (trimmed.startsWith('!')) {
    state.inDialogue = false;
    return { ...base, kind: 'action', text: trimmed.slice(1), forced: true };
  }

  if (trimmed.startsWith('.') && !trimmed.startsWith('..')) {
    state.inDialogue = false;
    return { ...base, ...parseSceneHeading(trimmed.slice(1).trim()), forced: true };
  }

  if (trimmed.startsWith('@')) {
    const parts = splitCharacter(trimmed.slice(1));
    state.inDialogue = true;
    return {
      ...base,
      kind: 'character',
      text: trimmed.slice(1).trim(),
      character: parts.name,
      extensions: parts.extensions,
      dual: parts.dual,
      forced: true,
    };
  }

  if (trimmed.startsWith('~')) {
    return { ...base, kind: 'lyrics', text: trimmed.slice(1).trim(), forced: true };
  }

  // ── Centered text: `> text <` ──
  if (trimmed.startsWith('>') && trimmed.endsWith('<')) {
    state.inDialogue = false;
    return {
      ...base,
      kind: 'centered',
      text: trimmed.slice(1, -1).trim(),
      forced: true,
    };
  }

  if (trimmed.startsWith('>')) {
    state.inDialogue = false;
    return { ...base, kind: 'transition', text: trimmed.slice(1).trim(), forced: true };
  }

  // ── Natural scene heading ──
  if (SCENE_PREFIX.test(trimmed) && prevEmpty) {
    state.inDialogue = false;
    return { ...base, ...parseSceneHeading(trimmed) };
  }

  // ── Dialogue block in progress ──
  if (state.inDialogue) {
    if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
      return { ...base, kind: 'parenthetical', text: trimmed };
    }
    return { ...base, kind: 'dialogue', text: trimmed };
  }

  // ── Natural transition: UPPER CASE ending in `TO:` ──
  if (
    prevEmpty &&
    nextEmpty &&
    isUpperCase(trimmed) &&
    (TRANSITION_SUFFIX.test(trimmed) || BARE_TRANSITIONS.has(trimmed))
  ) {
    return { ...base, kind: 'transition', text: trimmed };
  }

  // ── Character: upper case, blank line before, content after ──
  if (prevEmpty && !nextEmpty && looksLikeCharacter(trimmed)) {
    const parts = splitCharacter(trimmed);
    state.inDialogue = true;
    return {
      ...base,
      kind: 'character',
      text: trimmed,
      character: parts.name,
      extensions: parts.extensions,
      dual: parts.dual,
    };
  }

  // ── Default: action. Indentation is preserved. ──
  return { ...base, kind: 'action', text: raw.trimEnd() };
}

/** Extracts the `#1A#` scene number and the heading text. */
function parseSceneHeading(text: string): {
  kind: 'scene_heading';
  text: string;
  sceneNumber?: string;
} {
  const match = /#([^#\s][^#]*)#\s*$/.exec(text);
  if (match && match[1] !== undefined) {
    return {
      kind: 'scene_heading',
      text: text.slice(0, match.index).trim(),
      sceneNumber: match[1].trim(),
    };
  }
  return { kind: 'scene_heading', text };
}
