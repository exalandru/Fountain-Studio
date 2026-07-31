/**
 * Line and scene comparison between two versions of a screenplay.
 *
 * Pure TypeScript (PLAN.md §3.1): the same code compares versions in the renderer and is
 * exercised by Vitest without an Electron harness.
 */

import type { Scene, Screenplay } from '../fountain/ast.js';
import { splitLines } from '../fountain/lexer.js';

export type DiffKind = 'equal' | 'added' | 'removed';

export interface DiffLine {
  kind: DiffKind;
  text: string;
  /** 1-based line number in the earlier version; absent on an added line. */
  beforeLine?: number;
  /** 1-based line number in the later version; absent on a removed line. */
  afterLine?: number;
}

export interface LineDiff {
  lines: DiffLine[];
  added: number;
  removed: number;
  /**
   * True when at least one region diverged past the alignment budget and was reported as
   * a wholesale replacement instead of being aligned line by line.
   */
  coarse: boolean;
}

/**
 * Largest exact-alignment problem we solve, in table cells.
 *
 * The binding constraint is memory: a cell is 4 bytes, so this budget is 16 MB and some
 * tens of milliseconds — affordable for a dialog opened on demand. Two unrelated feature
 * drafts would be 36 million cells and 144 MB, which is why anything past the budget goes
 * through the anchoring below instead.
 */
const CELL_BUDGET = 4_000_000;

function equal(text: string, beforeLine: number, afterLine: number): DiffLine {
  return { kind: 'equal', text, beforeLine, afterLine };
}

function removed(text: string, beforeLine: number): DiffLine {
  return { kind: 'removed', text, beforeLine };
}

function added(text: string, afterLine: number): DiffLine {
  return { kind: 'added', text, afterLine };
}

function at(lines: readonly string[], index: number): string {
  return lines[index] ?? '';
}

/** Emits the whole region as a removal followed by an insertion. */
function coarseRegion(
  a: readonly string[],
  b: readonly string[],
  aOffset: number,
  bOffset: number,
  out: DiffLine[],
): void {
  for (let i = 0; i < a.length; i++) out.push(removed(at(a, i), aOffset + i + 1));
  for (let j = 0; j < b.length; j++) out.push(added(at(b, j), bOffset + j + 1));
}

/** Exact longest-common-subsequence alignment, used once a region fits the budget. */
function alignExactly(
  a: readonly string[],
  b: readonly string[],
  aOffset: number,
  bOffset: number,
  out: DiffLine[],
): void {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        at(a, i) === at(b, j)
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
    }
  }

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (at(a, i) === at(b, j)) {
      out.push(equal(at(a, i), aOffset + i + 1, bOffset + j + 1));
      i++;
      j++;
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
      out.push(removed(at(a, i), aOffset + i + 1));
      i++;
    } else {
      out.push(added(at(b, j), bOffset + j + 1));
      j++;
    }
  }
  while (i < n) {
    out.push(removed(at(a, i), aOffset + i + 1));
    i++;
  }
  while (j < m) {
    out.push(added(at(b, j), bOffset + j + 1));
    j++;
  }
}

interface Anchor {
  a: number;
  b: number;
}

/**
 * Lines that occur exactly once on each side and are common to both.
 *
 * In a screenplay these are mostly scene headings and distinctive action lines, which is
 * why splitting on them cuts an over-budget comparison into small independent regions
 * instead of degrading it. Only an increasing run is kept, so the regions never cross.
 */
function uniqueCommonAnchors(a: readonly string[], b: readonly string[]): Anchor[] {
  const countIn = (lines: readonly string[]) => {
    const counts = new Map<string, number>();
    for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
    return counts;
  };
  const aCounts = countIn(a);
  const bCounts = countIn(b);
  const bIndex = new Map<string, number>();
  for (let j = 0; j < b.length; j++) {
    const line = at(b, j);
    if (bCounts.get(line) === 1) bIndex.set(line, j);
  }

  const anchors: Anchor[] = [];
  let lastB = -1;
  for (let i = 0; i < a.length; i++) {
    const line = at(a, i);
    if (aCounts.get(line) !== 1) continue;
    const j = bIndex.get(line);
    if (j === undefined || j <= lastB) continue;
    // Blank lines are common and carry no signal; anchoring on them would fragment the
    // comparison without helping it.
    if (line.trim().length === 0) continue;
    anchors.push({ a: i, b: j });
    lastB = j;
  }
  return anchors;
}

interface AlignState {
  coarse: boolean;
}

/** Aligns one region exactly when it fits the budget, coarsely when it does not. */
function alignBounded(
  a: readonly string[],
  b: readonly string[],
  aOffset: number,
  bOffset: number,
  out: DiffLine[],
  state: AlignState,
): void {
  if (a.length === 0 && b.length === 0) return;
  if (a.length === 0 || b.length === 0) {
    coarseRegion(a, b, aOffset, bOffset, out);
    return;
  }
  if (a.length * b.length <= CELL_BUDGET) {
    alignExactly(a, b, aOffset, bOffset, out);
    return;
  }
  state.coarse = true;
  coarseRegion(a, b, aOffset, bOffset, out);
}

/**
 * Aligns a region, splitting on unique common lines first when it is too large.
 *
 * Anchoring happens at most once: every resulting region is then either aligned exactly or
 * reported coarsely, so the work is bounded and the recursion cannot run away.
 */
function alignRegion(
  a: readonly string[],
  b: readonly string[],
  aOffset: number,
  bOffset: number,
  out: DiffLine[],
  state: AlignState,
): void {
  if (a.length * b.length <= CELL_BUDGET) {
    alignBounded(a, b, aOffset, bOffset, out, state);
    return;
  }

  const anchors = uniqueCommonAnchors(a, b);
  if (anchors.length === 0) {
    alignBounded(a, b, aOffset, bOffset, out, state);
    return;
  }

  let aCursor = 0;
  let bCursor = 0;
  for (const anchor of anchors) {
    alignBounded(
      a.slice(aCursor, anchor.a),
      b.slice(bCursor, anchor.b),
      aOffset + aCursor,
      bOffset + bCursor,
      out,
      state,
    );
    out.push(equal(at(a, anchor.a), aOffset + anchor.a + 1, bOffset + anchor.b + 1));
    aCursor = anchor.a + 1;
    bCursor = anchor.b + 1;
  }
  alignBounded(
    a.slice(aCursor),
    b.slice(bCursor),
    aOffset + aCursor,
    bOffset + bCursor,
    out,
    state,
  );
}

/**
 * Compares two documents line by line.
 *
 * The common prefix and suffix are taken out first: taking a snapshot, rewriting one scene
 * and comparing — the everyday case — reduces to a few dozen lines of real work.
 */
export function diffLines(before: string, after: string): LineDiff {
  // An empty document has no lines at all. `splitLines` reports one empty line for it,
  // which would show up as a phantom removal when comparing against an empty version.
  const toLines = (text: string) => (text.length === 0 ? [] : splitLines(text).map((l) => l.raw));
  const a = toLines(before);
  const b = toLines(after);
  const lines: DiffLine[] = [];
  const state: AlignState = { coarse: false };

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && at(a, prefix) === at(b, prefix)) prefix++;

  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    at(a, a.length - 1 - suffix) === at(b, b.length - 1 - suffix)
  ) {
    suffix++;
  }

  for (let i = 0; i < prefix; i++) lines.push(equal(at(a, i), i + 1, i + 1));

  alignRegion(
    a.slice(prefix, a.length - suffix),
    b.slice(prefix, b.length - suffix),
    prefix,
    prefix,
    lines,
    state,
  );

  for (let i = 0; i < suffix; i++) {
    const aIndex = a.length - suffix + i;
    const bIndex = b.length - suffix + i;
    lines.push(equal(at(a, aIndex), aIndex + 1, bIndex + 1));
  }

  let addedCount = 0;
  let removedCount = 0;
  for (const line of lines) {
    if (line.kind === 'added') addedCount++;
    else if (line.kind === 'removed') removedCount++;
  }

  return { lines, added: addedCount, removed: removedCount, coarse: state.coarse };
}

export interface DiffHunk {
  lines: DiffLine[];
  /** Lines of unchanged text skipped since the previous hunk. */
  skippedBefore: number;
}

/**
 * Keeps only the changed lines and a little context around them.
 *
 * Two versions of a feature screenplay differ by a handful of lines out of six thousand.
 * Rendering all of them would put six thousand rows in the DOM to show a dozen; collapsing
 * to hunks bounds the view by the size of the *change* rather than of the document.
 */
export function collapseToHunks(lines: readonly DiffLine[], context = 3): DiffHunk[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.kind === 'equal') continue;
    const from = Math.max(0, i - context);
    const to = Math.min(lines.length - 1, i + context);
    for (let j = from; j <= to; j++) keep[j] = true;
  }

  const hunks: DiffHunk[] = [];
  let current: DiffLine[] = [];
  let skipped = 0;
  let pendingSkip = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (keep[i]) {
      if (current.length === 0) skipped = pendingSkip;
      pendingSkip = 0;
      current.push(line);
      continue;
    }
    if (current.length > 0) {
      hunks.push({ lines: current, skippedBefore: skipped });
      current = [];
    }
    pendingSkip++;
  }
  if (current.length > 0) hunks.push({ lines: current, skippedBefore: skipped });
  return hunks;
}

export type SceneChangeKind = 'added' | 'removed' | 'modified' | 'moved';

export interface SceneChange {
  kind: SceneChangeKind;
  /** Scene number in whichever version the scene exists. */
  number: string;
  heading: string;
  /** 1-based position before, absent on an added scene. */
  beforeIndex?: number;
  /** 1-based position after, absent on a removed scene. */
  afterIndex?: number;
}

/** A scene's content, independent of position and of surrounding whitespace. */
function bodySignature(scene: Scene): string {
  // Escaped rather than written as raw bytes: a literal NUL in the file makes every tool
  // that reads it decide it is binary — grep included, which then reports no matches at
  // all — and a reader just sees a space where the separator is.
  return scene.elements.map((element) => `${element.kind}\u0000${element.text}`).join('\u0001');
}

/**
 * Compares two versions scene by scene — the reading that actually matters to a writer.
 *
 * `Scene.id` derives from the heading element alone, so rewriting a scene's body keeps its
 * identity while retitling it produces a new one. A retitled scene therefore reads as a
 * removal plus an addition, which is honest: as far as the document is concerned it is a
 * different scene heading.
 */
export function diffScenes(before: Screenplay, after: Screenplay): SceneChange[] {
  const beforeById = new Map(before.scenes.map((scene) => [scene.id, scene]));
  const afterIds = new Set(after.scenes.map((scene) => scene.id));
  const changes: SceneChange[] = [];

  for (const scene of after.scenes) {
    const previous = beforeById.get(scene.id);
    if (!previous) {
      changes.push({
        kind: 'added',
        number: scene.number,
        heading: scene.heading,
        afterIndex: scene.index,
      });
      continue;
    }
    // A scene that both moved and changed is reported as modified: the rewrite is the
    // stronger signal, and the position shows in the numbers either way.
    if (bodySignature(previous) !== bodySignature(scene)) {
      changes.push({
        kind: 'modified',
        number: scene.number,
        heading: scene.heading,
        beforeIndex: previous.index,
        afterIndex: scene.index,
      });
    } else if (previous.index !== scene.index) {
      changes.push({
        kind: 'moved',
        number: scene.number,
        heading: scene.heading,
        beforeIndex: previous.index,
        afterIndex: scene.index,
      });
    }
  }

  for (const scene of before.scenes) {
    if (afterIds.has(scene.id)) continue;
    changes.push({
      kind: 'removed',
      number: scene.number,
      heading: scene.heading,
      beforeIndex: scene.index,
    });
  }

  return changes;
}
