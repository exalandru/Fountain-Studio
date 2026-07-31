import type { Element, ElementKind, Range, Screenplay } from '../fountain/index.js';
import { pageLabel } from '../revision/index.js';

/**
 * Lightweight page grouping used by the live M2 preview.
 *
 * Retained as a compatibility helper for focused M2 tests. The application preview,
 * PDF and statistics all use `paginateScreenplay` below.
 */

/** 11in paper minus 1in top/bottom margins at the preview's 16px line height. */
export const PREVIEW_LINES_PER_PAGE = 54;

export interface PreviewPaginationOptions {
  includeSections?: boolean;
  includeSynopses?: boolean;
}

export interface PreviewPage {
  index: number;
  range: { from: number; to: number };
  /** Indexes into the worker's `elements` array. */
  elementIndexes: number[];
  estimatedLines: number;
}

const WIDTH_BY_KIND: Partial<Record<Element['kind'], number>> = {
  action: 61,
  scene_heading: 61,
  character: 38,
  dialogue: 35,
  parenthetical: 26,
  lyrics: 35,
  transition: 16,
  centered: 61,
  section: 61,
  synopsis: 61,
};

function characterLength(value: string): number {
  return Array.from(value).length;
}

/**
 * The text of an element as it is actually printed.
 *
 * `Element.text` keeps the emphasis markers — `_underlined_`, `**bold**` — because the editor
 * needs them. Paper does not: a page models what a reader sees, so wrapping and counting on the
 * marker-bearing text would both over-count the lines and, in the PDF, print the markers.
 * `Element.inline` is the same text with emphasis resolved, and it is what the renderer styles
 * against, so using it here keeps the two in step character for character.
 */
function printedText(element: Element): string {
  if (element.inline.length === 0) return element.text;
  return element.inline.map((span) => span.text).join('');
}

/** Estimated paper lines occupied by one AST element in 12 pt Courier Prime. */
export function estimateElementLines(element: Element): number {
  const width = WIDTH_BY_KIND[element.kind] ?? 61;
  const wrapped = printedText(element)
    .split('\n')
    .reduce((total, line) => {
      return total + Math.max(1, Math.ceil(characterLength(line) / width));
    }, 0);

  // Distinct screenplay blocks retain the blank source line that separates them.
  const leading = ['dialogue', 'parenthetical', 'lyrics'].includes(element.kind) ? 0 : 1;
  return wrapped + leading;
}

function isIncluded(element: Element, options: PreviewPaginationOptions): boolean {
  if (element.kind === 'note' || element.kind === 'boneyard') return false;
  if (element.kind === 'section') return options.includeSections === true;
  if (element.kind === 'synopsis') return options.includeSynopses === true;
  return element.kind !== 'page_break';
}

/**
 * Groups complete elements into approximate pages for compatibility checks.
 */
export function paginatePreview(
  elements: readonly Element[],
  options: PreviewPaginationOptions = {},
): PreviewPage[] {
  const pages: PreviewPage[] = [];
  let indexes: number[] = [];
  let estimatedLines = 0;
  let from = 0;
  let to = 0;

  const flush = (nextFrom?: number) => {
    if (indexes.length === 0 && pages.length > 0) {
      from = nextFrom ?? from;
      return;
    }

    pages.push({
      index: pages.length,
      range: { from, to: Math.max(from, to) },
      elementIndexes: indexes,
      estimatedLines,
    });
    indexes = [];
    estimatedLines = 0;
    from = nextFrom ?? to;
  };

  for (let index = 0; index < elements.length; index++) {
    const element = elements[index];
    if (!element) continue;

    if (element.kind === 'page_break') {
      to = element.range.from;
      flush(element.range.to);
      continue;
    }
    if (!isIncluded(element, options)) continue;

    const lines = estimateElementLines(element);
    if (indexes.length > 0 && estimatedLines + lines > PREVIEW_LINES_PER_PAGE) {
      flush(element.range.from);
    }

    if (indexes.length === 0) from = element.range.from;
    indexes.push(index);
    estimatedLines += lines;
    to = element.range.to;
  }

  if (indexes.length > 0 || pages.length === 0) flush();
  return pages;
}

// ── Production pagination ───────────────────────────────────────────────────

export type PageFormat = 'letter' | 'a4';

export const PAGE_LINES: Readonly<Record<PageFormat, number>> = {
  letter: PREVIEW_LINES_PER_PAGE,
  a4: 58,
};

export type PageItemKind = ElementKind | 'more' | 'continued';

export interface PaginationItem {
  kind: PageItemKind;
  text: string;
  lines: string[];
  /** Index into `Screenplay.elements`; null for continuation markers. */
  elementIndex: number | null;
  range: Range | null;
  sceneIndex: number | null;
  /** Blank screenplay lines inserted before this item. */
  leadingLines: number;
}

export interface ScreenplayPage {
  index: number;
  items: PaginationItem[];
  usedLines: number;
  range: Range;
  elementIndexes: number[];
  /**
   * The label a reader sees: `12`, or `12A` for a page that overflowed a locked one. Without
   * locking it is always `String(index + 1)`.
   */
  number: string;
  /** Index of the locked page this one opens, `null` for a page that overflowed. */
  lockIndex: number | null;
}

export interface PaginationResult {
  format: PageFormat;
  linesPerPage: number;
  pages: ScreenplayPage[];
  /** Page index for each scene index, used by stats and the timeline. */
  scenePages: number[];
}

export interface PaginationOptions {
  format?: PageFormat;
  includeSections?: boolean;
  includeSynopses?: boolean;
  includeNotes?: boolean;
  /**
   * Source lines (1-based) that must each open a page, in document order.
   *
   * This is how a production keeps page 12 on page 12: the pages of the locked draft are
   * pinned, and only what no longer fits between two pins moves — onto `12A` rather than onto
   * page 13. Absent, pagination flows from the top as it always has.
   */
  lockedPageStarts?: readonly number[];
}

function wrapLine(line: string, width: number): string[] {
  const characters = Array.from(line);
  if (characters.length <= width) return [line];

  const output: string[] = [];
  let rest = line;
  while (Array.from(rest).length > width) {
    const candidate = Array.from(rest).slice(0, width).join('');
    const boundary = candidate.search(/\s+\S*$/);
    const cut = boundary > Math.floor(width * 0.45) ? boundary : candidate.length;
    output.push(Array.from(rest).slice(0, cut).join('').trimEnd());
    rest = Array.from(rest).slice(cut).join('').trimStart();
  }
  output.push(rest);
  return output;
}

export function wrapElement(element: Element): string[] {
  const width = WIDTH_BY_KIND[element.kind] ?? 61;
  return printedText(element)
    .split('\n')
    .flatMap((line) => wrapLine(line, width));
}

function includedForProduction(element: Element, options: PaginationOptions): boolean {
  if (element.kind === 'boneyard') return false;
  if (element.kind === 'note') return options.includeNotes === true;
  if (element.kind === 'section') return options.includeSections === true;
  if (element.kind === 'synopsis') return options.includeSynopses === true;
  return element.kind !== 'page_break';
}

/**
 * Turns locked page starts, given as source lines, into the elements that must open a page.
 *
 * A locked start lands on the first element at or after its line: the line itself may have been
 * deleted since, and what matters is where the page begins now, not that the exact line survived.
 *
 * Two starts can resolve to the same element once a page's whole content is cut. Only the first
 * keeps the element — the earlier page keeps the text, and the later number simply does not
 * appear in the issued set, which is the truth of a page that was cut.
 */
function resolveAnchors(
  elements: readonly Element[],
  starts: readonly number[],
): Map<number, number> {
  const anchors = new Map<number, number>();
  if (starts.length === 0) return anchors;

  const taken = new Set<number>();
  let search = 0;
  starts.forEach((start, lockIndex) => {
    // `Element.line` is 0-based; a locked start counts from 1.
    const target = start - 1;
    while (search < elements.length && (elements[search]?.line ?? 0) < target) search++;
    if (search >= elements.length) return;
    if (taken.has(search)) return;
    taken.add(search);
    anchors.set(search, lockIndex);
  });
  return anchors;
}

/**
 * Gives every page the label a reader sees.
 *
 * A page that opens a locked one takes its number. A page that overflowed between two locked
 * ones takes a letter — `12A` — so that page 13 stays page 13. Past the last locked page there
 * is nothing left to protect, so the numbering simply carries on in integers: those are pages
 * added at the end, and nobody is holding a later one.
 */
function labelPages(pages: ScreenplayPage[], lockedCount: number): void {
  const lastLocked = pages.reduce(
    (last, page, index) => (page.lockIndex === null ? last : index),
    -1,
  );
  let base = 0;
  let overflow = 0;
  let sequential = lockedCount;

  pages.forEach((page, index) => {
    if (page.lockIndex !== null) {
      base = page.lockIndex + 1;
      overflow = 0;
      page.number = String(base);
      return;
    }
    // Before the first locked page, or past the last one: plain numbers. `base` of zero would
    // otherwise produce a nonsense `0A`.
    if (base === 0) {
      page.number = String(index + 1);
      return;
    }
    if (index > lastLocked) {
      sequential++;
      page.number = String(sequential);
      return;
    }
    overflow++;
    page.number = pageLabel(base, overflow);
  });
}

/**
 * Production screenplay pagination shared by preview, PDF and statistics.
 *
 * It uses integer monospace arithmetic only. No browser measurement enters the result,
 * which keeps exported page counts identical on every platform.
 */
export function paginateScreenplay(
  screenplay: Pick<Screenplay, 'elements' | 'scenes'>,
  options: PaginationOptions = {},
): PaginationResult {
  const format = options.format ?? 'a4';
  const linesPerPage = PAGE_LINES[format];
  const pages: ScreenplayPage[] = [];
  let items: PaginationItem[] = [];
  let usedLines = 0;

  const sceneByElement = new Map<string, number>();
  screenplay.scenes.forEach((scene, sceneIndex) => {
    for (const element of scene.elements) sceneByElement.set(element.id, sceneIndex);
  });

  const anchors = resolveAnchors(screenplay.elements, options.lockedPageStarts ?? []);
  /** The locked page the page being built opens, if any. */
  let currentLock: number | null = null;

  const flush = () => {
    if (items.length === 0) return;
    const real = items.filter(
      (item): item is PaginationItem & { range: Range; elementIndex: number } =>
        item.range !== null && item.elementIndex !== null,
    );
    const indexes = [...new Set(real.map((item) => item.elementIndex))];
    pages.push({
      index: pages.length,
      items,
      usedLines,
      range: {
        from: real[0]?.range.from ?? 0,
        to: real.at(-1)?.range.to ?? real[0]?.range.from ?? 0,
      },
      elementIndexes: indexes,
      // Filled in once every page is known: a label depends on what comes after it.
      number: '',
      lockIndex: currentLock,
    });
    items = [];
    usedLines = 0;
    currentLock = null;
  };

  const remaining = () => linesPerPage - usedLines;
  const ensure = (required: number) => {
    if (items.length > 0 && required > remaining()) flush();
  };
  const add = (
    kind: PageItemKind,
    text: string,
    lines: string[],
    elementIndex: number | null,
    range: Range | null,
    sceneIndex: number | null,
    leadingLines = 0,
  ) => {
    const leading = items.length === 0 ? 0 : leadingLines;
    items.push({ kind, text, lines, elementIndex, range, sceneIndex, leadingLines: leading });
    usedLines += leading + lines.length;
  };
  const addContinuedCue = (speaker: string, sceneIndex: number | null) => {
    const text = `${speaker} (CONT'D)`;
    add('continued', text, [text], null, null, sceneIndex);
  };

  for (let index = 0; index < screenplay.elements.length; index++) {
    const element = screenplay.elements[index];
    if (!element) continue;

    if (element.kind === 'page_break') {
      flush();
      continue;
    }
    if (!includedForProduction(element, options)) continue;

    const anchor = anchors.get(index);
    if (anchor !== undefined) {
      flush();
      currentLock = anchor;
    }

    const sceneIndex = sceneByElement.get(element.id) ?? null;
    const lines = wrapElement(element);
    const leading = ['dialogue', 'parenthetical', 'lyrics'].includes(element.kind) ? 0 : 1;

    if (element.kind === 'scene_heading') {
      // A scene heading must retain at least two rendered lines below it.
      ensure(leading + lines.length + 2);
      add(element.kind, element.text, lines, index, element.range, sceneIndex, leading);
      continue;
    }

    if (element.kind === 'character') {
      const parenthetical =
        screenplay.elements[index + 1]?.kind === 'parenthetical'
          ? screenplay.elements[index + 1]
          : null;
      const dialogueOffset = parenthetical ? 2 : 1;
      const dialogue =
        screenplay.elements[index + dialogueOffset]?.kind === 'dialogue'
          ? screenplay.elements[index + dialogueOffset]
          : null;
      const required =
        leading +
        lines.length +
        (parenthetical ? wrapElement(parenthetical).length : 0) +
        (dialogue ? 1 : 0);
      ensure(required);
      add(element.kind, element.text, lines, index, element.range, sceneIndex, leading);
      continue;
    }

    if (element.kind === 'parenthetical') {
      const next = screenplay.elements[index + 1];
      ensure(lines.length + (next?.kind === 'dialogue' ? 1 : 0));
      add(element.kind, element.text, lines, index, element.range, sceneIndex);
      continue;
    }

    if (element.kind === 'dialogue') {
      let pending = [...lines];
      let continued = false;
      const speaker = element.speaker ?? 'CHARACTER';

      while (pending.length > 0) {
        if (continued && items.length === 0) addContinuedCue(speaker, sceneIndex);
        const available = remaining();

        if (pending.length <= available) {
          add(element.kind, pending.join('\n'), pending, index, element.range, sceneIndex);
          pending = [];
        } else if (available >= 2) {
          const fragment = pending.splice(0, available - 1);
          add(element.kind, fragment.join('\n'), fragment, index, element.range, sceneIndex);
          add('more', '(MORE)', ['(MORE)'], null, null, sceneIndex);
          flush();
          continued = true;
        } else {
          flush();
          continued = true;
        }
      }
      continue;
    }

    // Long action and lyrics blocks may split without dialogue continuation markers.
    const pending = [...lines];
    let first = true;
    while (pending.length > 0) {
      const itemLeading = first ? leading : 0;
      ensure(itemLeading + 1);
      const capacity = Math.max(1, remaining() - (items.length === 0 ? 0 : itemLeading));
      const fragment = pending.splice(0, capacity);
      add(
        element.kind,
        fragment.join('\n'),
        fragment,
        index,
        element.range,
        sceneIndex,
        itemLeading,
      );
      if (pending.length > 0) flush();
      first = false;
    }
  }

  flush();
  if (pages.length === 0) {
    pages.push({
      index: 0,
      items: [],
      usedLines: 0,
      range: { from: 0, to: 0 },
      elementIndexes: [],
      number: '1',
      lockIndex: null,
    });
  }
  labelPages(pages, anchors.size);

  const scenePages = screenplay.scenes.map((_scene, sceneIndex) => {
    const page = pages.find((candidate) =>
      candidate.items.some((item) => item.sceneIndex === sceneIndex),
    );
    return page?.index ?? 0;
  });

  return { format, linesPerPage, pages, scenePages };
}
