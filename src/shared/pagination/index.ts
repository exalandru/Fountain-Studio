import type { Element } from '../fountain/index.js';

/**
 * Lightweight page grouping used by the live M2 preview.
 *
 * M3 will add production pagination rules such as dialogue continuation markers. This
 * first layer already centralises the monospace arithmetic and page boundaries so the
 * preview is page-virtualised without relying on browser layout measurements.
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

/** Estimated paper lines occupied by one AST element in 12 pt Courier Prime. */
export function estimateElementLines(element: Element): number {
  const width = WIDTH_BY_KIND[element.kind] ?? 61;
  const wrapped = element.text.split('\n').reduce((total, line) => {
    return total + Math.max(1, Math.ceil(characterLength(line) / width));
  }, 0);

  // Screenplay paragraphs have a blank line before cues, headings and transitions.
  const leading =
    element.kind === 'scene_heading' ||
    element.kind === 'character' ||
    element.kind === 'transition'
      ? 1
      : 0;
  return wrapped + leading;
}

function isIncluded(element: Element, options: PreviewPaginationOptions): boolean {
  if (element.kind === 'note' || element.kind === 'boneyard') return false;
  if (element.kind === 'section') return options.includeSections === true;
  if (element.kind === 'synopsis') return options.includeSynopses === true;
  return element.kind !== 'page_break';
}

/**
 * Groups complete elements into approximate pages for the live preview.
 *
 * Elements are intentionally not split yet: exact dialogue splitting, `(MORE)` and
 * `(CONT'D)` belong to M3. Forced page breaks are honoured now because they affect
 * navigation and virtualisation.
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
