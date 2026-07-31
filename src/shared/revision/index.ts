/**
 * Production revisions: what changed since the locked draft, and how a locked screenplay is
 * numbered.
 *
 * Pure TypeScript (PLAN.md §3.1).
 *
 * Once a screenplay is shooting it stops being a text one rewrites freely and becomes a
 * reference a crew works from. Scene 42 must stay 42 even if a scene is inserted before it,
 * page 12 must stay page 12, and a reader holding last week's pages must see at a glance what
 * moved. Everything here serves those three promises; none of it changes the screenplay's
 * meaning, only how it is numbered and marked.
 */

import { diffLines } from '../diff/index.js';
import type { Element, Scene } from '../fountain/index.js';
import type { DocumentEdit } from '../text/index.js';

/**
 * Revision colours, in the order productions issue them.
 *
 * White is the original draft, so it is the absence of a revision rather than one; the cycle
 * of coloured pages starts at blue.
 */
export const REVISION_COLOURS = [
  'white',
  'blue',
  'pink',
  'yellow',
  'green',
  'goldenrod',
  'buff',
  'salmon',
  'cherry',
] as const;

export type RevisionColour = (typeof REVISION_COLOURS)[number];

export function isRevisionColour(value: unknown): value is RevisionColour {
  return REVISION_COLOURS.includes(value as RevisionColour);
}

/**
 * The paper each colour stands for, for a tinted page and for the swatch beside its name.
 *
 * One table, used by the PDF renderer and by the export dialog: two would drift, and a page
 * that prints in a different blue than the one the dialog promised is worse than no colour at
 * all. Pale on purpose — black text stays above 12:1 on every one of them, and a page nobody
 * can read serves nobody.
 */
export const REVISION_PAPER: Readonly<Record<RevisionColour, string>> = {
  white: '#ffffff',
  blue: '#cfe0f5',
  pink: '#f9d7e3',
  yellow: '#fbf3c2',
  green: '#d6ecd8',
  goldenrod: '#f2dfa4',
  buff: '#f3e4cf',
  salmon: '#fbdcd2',
  cherry: '#f4c9d1',
} as const;

/** The next colour to issue, wrapping past the last one back to blue. */
export function nextRevisionColour(current: RevisionColour): RevisionColour {
  const index = REVISION_COLOURS.indexOf(current);
  const next = REVISION_COLOURS[index + 1];
  // White never comes back: a second pass through the cycle re-uses the coloured pages, which
  // is what a long production actually does — double blue, double pink.
  return next ?? 'blue';
}

// ── What changed ────────────────────────────────────────────────────────────

/**
 * Lines of the current version (1-based) that differ from the locked draft.
 *
 * A deletion is marked too, on the line it closed onto. That is why a revised page sometimes
 * carries an asterisk beside text that reads unchanged — the reader is being told something
 * used to be there, which is exactly what they need to know.
 */
export function revisedLines(baseline: string, current: string): Set<number> {
  const marked = new Set<number>();
  if (baseline.length === 0) return marked;

  const { lines } = diffLines(baseline, current);
  let lastAfter = 0;
  for (const line of lines) {
    if (line.kind === 'added' && line.afterLine !== undefined) {
      marked.add(line.afterLine);
      lastAfter = line.afterLine;
      continue;
    }
    if (line.kind === 'removed') {
      // The line that took its place, or the last line when the removal was at the end.
      marked.add(lastAfter + 1);
      continue;
    }
    if (line.afterLine !== undefined) lastAfter = line.afterLine;
  }
  return marked;
}

/**
 * Where each line of the locked draft sits in the current version.
 *
 * Keyed by 1-based line number in the baseline. A line that survived maps to its new position;
 * a line that was deleted maps to the position it collapsed onto, so an anchor placed on it
 * still lands somewhere sensible instead of being dropped.
 */
export function alignLines(baseline: string, current: string): Map<number, number> {
  const alignment = new Map<number, number>();
  if (baseline.length === 0) return alignment;

  const { lines } = diffLines(baseline, current);
  let lastAfter = 0;
  for (const line of lines) {
    if (line.kind === 'added') {
      if (line.afterLine !== undefined) lastAfter = line.afterLine;
      continue;
    }
    if (line.beforeLine === undefined) continue;
    if (line.kind === 'equal' && line.afterLine !== undefined) {
      alignment.set(line.beforeLine, line.afterLine);
      lastAfter = line.afterLine;
      continue;
    }
    alignment.set(line.beforeLine, lastAfter + 1);
  }
  return alignment;
}

/** Indexes into `elements` of every element holding at least one revised line. */
export function revisedElements(
  elements: readonly Element[],
  lines: ReadonlySet<number>,
): Set<number> {
  const revised = new Set<number>();
  if (lines.size === 0) return revised;

  elements.forEach((element, index) => {
    // `Element.line` is 0-based; the diff counts from 1.
    const first = element.line + 1;
    const last = first + Math.max(1, element.lineCount) - 1;
    for (let line = first; line <= last; line++) {
      if (lines.has(line)) {
        revised.add(index);
        return;
      }
    }
  });
  return revised;
}

// ── Scene numbering ─────────────────────────────────────────────────────────

/**
 * Letters used for inserted scenes, `I` and `O` left out.
 *
 * `I2` and `12` are the same glyphs to a tired eye on a call sheet, and `O` reads as zero.
 * Productions have skipped both for as long as they have lettered scenes.
 */
const SCENE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

/** `A`, `B`, … `Z`, then `AA`, `BB`: doubling rather than counting past Z. */
function sceneLetter(position: number): string {
  const letter = SCENE_LETTERS[position % SCENE_LETTERS.length] ?? 'Z';
  const repeats = Math.floor(position / SCENE_LETTERS.length) + 1;
  return letter.repeat(repeats);
}

/**
 * The number each scene should carry.
 *
 * `lock` numbers every scene 1…n, which is what locking a draft means. `letters` leaves every
 * declared number exactly as it is and only names the scenes that have none: a run inserted
 * before scene 2 becomes A2, B2, C2 in reading order — the letter belongs to the number that
 * follows, as production numbers them. Scenes added past the last declared number simply carry
 * on in integers, since nothing after them needs protecting.
 */
export function sceneNumbering(scenes: readonly Scene[], mode: 'lock' | 'letters'): string[] {
  if (mode === 'lock') return scenes.map((_scene, index) => String(index + 1));

  const numbers: string[] = new Array<string>(scenes.length).fill('');
  let highest = 0;
  for (const scene of scenes) {
    const declared = Number(scene.declaredNumber);
    if (scene.declaredNumber !== undefined && Number.isInteger(declared)) {
      highest = Math.max(highest, declared);
    }
  }

  let index = 0;
  while (index < scenes.length) {
    const scene = scenes[index];
    if (!scene) break;
    if (scene.declaredNumber !== undefined) {
      numbers[index] = scene.declaredNumber;
      index++;
      continue;
    }

    // A run of unnumbered scenes: they all hang off the next declared number.
    let end = index;
    while (end < scenes.length && scenes[end]?.declaredNumber === undefined) end++;
    const following = scenes[end]?.declaredNumber;

    for (let position = index; position < end; position++) {
      if (following === undefined) {
        highest++;
        numbers[position] = String(highest);
      } else {
        numbers[position] = `${sceneLetter(position - index)}${following}`;
      }
    }
    index = end;
  }

  return numbers;
}

/** Replaces the `#…#` of a heading line, or appends one, keeping any trailing whitespace. */
function numberedHeading(source: string, number: string): string {
  if (/\s+#[^#\r\n]+#\s*$/.test(source)) {
    return source.replace(/\s+#[^#\r\n]+#(\s*)$/, ` #${number}#$1`);
  }
  const trailing = /\s+$/.exec(source)?.[0] ?? '';
  return `${source.replace(/\s+$/, '')} #${number}#${trailing}`;
}

/**
 * Writes the numbering into the screenplay, as one edit per heading that changes.
 *
 * The numbers live in the document (`#A2#`), which is what Fountain is for and what makes every
 * other view follow for free: `Scene.number` already prefers a declared number, so the
 * navigator, the timeline, the corkboard, the statistics and the PDF all show A2 without a line
 * of code.
 */
export function planSceneNumbering(
  source: string,
  scenes: readonly Scene[],
  mode: 'lock' | 'letters',
): DocumentEdit[] {
  const numbers = sceneNumbering(scenes, mode);
  return scenes.flatMap((scene, index) => {
    const heading = scene.elements[0];
    const number = numbers[index];
    if (!heading || number === undefined || number.length === 0) return [];
    const current = source.slice(heading.range.from, heading.range.to);
    const next = numberedHeading(current, number);
    return next === current
      ? []
      : [{ from: heading.range.from, to: heading.range.to, insert: next }];
  });
}

// ── Page labels ─────────────────────────────────────────────────────────────

/**
 * A locked page's label: `12`, then `12A` and `12B` for what overflows it.
 *
 * Pages grow and shrink between revisions, and a page that grows must not push every page
 * after it. The letters are what buy that: page 13 stays page 13.
 */
export function pageLabel(base: number, overflow: number): string {
  if (overflow <= 0) return String(base);
  return `${base}${sceneLetter(overflow - 1)}`;
}
