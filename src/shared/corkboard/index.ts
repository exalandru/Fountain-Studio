/**
 * Rewriting a screenplay from the corkboard: moving a scene, editing a synopsis.
 *
 * Pure TypeScript (PLAN.md §3.1). The corkboard is the only view in the application that
 * *rewrites* the document rather than annotating it, so the cutting and splicing lives here,
 * away from the DOM, where it can be tested against the awkward documents rather than the
 * tidy ones: a scene with no blank line after it, a section heading between two scenes, a
 * file that does not end with a newline.
 *
 * Nothing here knows about CodeMirror. The caller receives offsets in the *original*
 * document and dispatches them as one transaction, which is what makes a move a single undo
 * step.
 */

import type { Range } from '../fountain/index.js';
import type { DocumentEdit } from '../text/index.js';

/** The smallest input this module needs: a scene is a position, not an AST. */
export interface SceneRange {
  range: Range;
}

/** A scene plus the blank lines that follow it — what moves as one piece. */
export interface SceneBlock {
  from: number;
  to: number;
}

export type { DocumentEdit };

export interface SceneMovePlan {
  /** Edits in the coordinates of the original document, never overlapping. */
  changes: DocumentEdit[];
  /** Where the moved heading starts once the edits are applied, for the caret. */
  caret: number;
}

/**
 * The document's own line ending.
 *
 * Detected rather than passed in: a document loaded through `src/main/files/document.ts` is
 * normalised to LF in memory and converted back on save, so a parameter would be one more
 * thing a caller could get wrong. Producing an LF separator inside a CRLF string would leave
 * a mixed document behind, which is exactly the sort of quiet damage this module exists to
 * avoid.
 */
function lineEnding(source: string): string {
  return source.includes('\r\n') ? '\r\n' : '\n';
}

function isSpace(character: string | undefined): boolean {
  return character === ' ' || character === '\t' || character === '\r' || character === '\n';
}

/** Number of line breaks at the end of `text`, counting `\r\n` as one. */
function trailingBreaks(text: string): number {
  let count = 0;
  let index = text.length;
  while (index > 0) {
    const character = text[index - 1];
    if (character === '\n') {
      count++;
      index -= text[index - 2] === '\r' ? 2 : 1;
      continue;
    }
    if (character === ' ' || character === '\t' || character === '\r') {
      index--;
      continue;
    }
    break;
  }
  return count;
}

/**
 * The movable block of every scene, in document order.
 *
 * `Scene.range` stops at the end of the scene's last element (see `buildStructure` in
 * `parse.ts`), so the blank lines separating it from the next scene belong to no one. The
 * block claims them, which is what lets a move keep the document's spacing.
 *
 * The scan stops at the first non-blank character, so a section heading between two scenes
 * stays outside every block and is never carried along. That is deliberate: a card dropped
 * below `# ACT TWO` should join act two, not take the title with it.
 */
export function sceneBlocks(source: string, scenes: readonly SceneRange[]): SceneBlock[] {
  return scenes.map((scene, index) => {
    const limit = scenes[index + 1]?.range.from ?? source.length;
    let to = Math.min(scene.range.to, limit);
    while (to < limit && isSpace(source[to])) to++;
    return { from: scene.range.from, to };
  });
}

/**
 * Moves a scene to a new position, as a pair of edits on the original document.
 *
 * `targetIndex` is the position the scene ends up at, the way `Array#splice` means it. Returns
 * `null` when the indexes are out of range or the order would not change, so the caller has
 * nothing to dispatch.
 *
 * Declared scene numbers (`#12#`) travel with the scene untouched. A declared number is a
 * locked number: a crew refers to it, so it must not follow the running order.
 */
export function planSceneMove(
  source: string,
  scenes: readonly SceneRange[],
  fromIndex: number,
  targetIndex: number,
): SceneMovePlan | null {
  if (!Number.isInteger(fromIndex) || !Number.isInteger(targetIndex)) return null;
  if (fromIndex < 0 || fromIndex >= scenes.length) return null;
  if (targetIndex < 0 || targetIndex >= scenes.length) return null;
  if (fromIndex === targetIndex) return null;

  const blocks = sceneBlocks(source, scenes);
  const moved = blocks[fromIndex];
  const target = blocks[targetIndex];
  if (!moved || !target) return null;

  const eol = lineEnding(source);
  // The scene without its trailing blank lines: the separator is rebuilt at the destination,
  // because how much space it needs depends on what it lands between.
  const body = source.slice(moved.from, moved.to).replace(/[ \t\r\n]+$/, '');
  const insertAt = targetIndex > fromIndex ? target.to : target.from;

  // Both insertion points sit outside the removed range — moving down inserts after at least
  // one whole block, moving up inserts before the block being passed — so the character before
  // `insertAt` is the same before and after the removal, and can be read from `source`.
  const breaksBefore = insertAt === 0 ? 2 : trailingBreaks(source.slice(0, insertAt));
  const prefix = eol.repeat(Math.max(0, 2 - breaksBefore));
  // A scene heading needs a blank line in front of it to be a heading at all, so whatever
  // follows the insertion point gets one. At the end of the document there is nothing to
  // separate from; the file keeps the ending convention it already had.
  const suffix =
    insertAt >= source.length ? (trailingBreaks(source) > 0 ? eol : '') : `${eol}${eol}`;

  const insert = `${prefix}${body}${suffix}`;
  const removalLength = moved.to - moved.from;
  const caret =
    insertAt > moved.to ? insertAt + prefix.length - removalLength : insertAt + prefix.length;

  const removal: DocumentEdit = { from: moved.from, to: moved.to, insert: '' };
  const insertion: DocumentEdit = { from: insertAt, to: insertAt, insert };

  return {
    // Ascending, so a consumer that applies them in order — CodeMirror included — needs no
    // offset arithmetic of its own.
    changes: insertAt < moved.from ? [insertion, removal] : [removal, insertion],
    caret,
  };
}

/**
 * Turns a drop gap into a final position.
 *
 * The interface points at a gap between cards — `gap` is the index of the card the scene
 * should land in front of, and `scenes.length` means the end. Dragging a card forward closes
 * the hole it leaves behind, so every gap past its own position is one too far.
 */
export function gapToTargetIndex(fromIndex: number, gap: number): number {
  return gap > fromIndex ? gap - 1 : gap;
}

export interface SynopsisTarget {
  /** End of the scene's heading line, where a synopsis is inserted when there is none. */
  headingTo: number;
  /** The existing `= …` element, when the scene has one. */
  synopsis: Range | null;
}

/**
 * Writes a scene's synopsis, as one edit.
 *
 * A `=` line holds a single line, so the text is flattened: a synopsis pasted as two
 * paragraphs would otherwise turn its second half into action, silently changing the script.
 * Emptying the text removes the line rather than leaving a bare `=`.
 *
 * Only the first synopsis of a scene is touched — the same one `Scene.synopsis` reports and
 * the card shows. A scene carrying several `=` lines keeps the others.
 */
export function planSynopsisEdit(
  source: string,
  target: SynopsisTarget,
  text: string,
): DocumentEdit | null {
  const eol = lineEnding(source);
  const flattened = text.replace(/\s+/g, ' ').trim();

  if (target.synopsis === null) {
    if (flattened.length === 0) return null;
    return { from: target.headingTo, to: target.headingTo, insert: `${eol}= ${flattened}` };
  }

  const line = `= ${flattened}`;
  if (source.slice(target.synopsis.from, target.synopsis.to) === line) return null;

  if (flattened.length === 0) {
    // The line goes with its own break, so the heading does not end up followed by a blank
    // line that was not there before.
    let to = target.synopsis.to;
    if (source[to] === '\r') to++;
    if (source[to] === '\n') to++;
    return { from: target.synopsis.from, to, insert: '' };
  }

  return { from: target.synopsis.from, to: target.synopsis.to, insert: line };
}
