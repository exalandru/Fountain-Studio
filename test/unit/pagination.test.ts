import { describe, expect, it } from 'vitest';
import { parse } from '../../src/shared/fountain/index.js';
import {
  estimateElementLines,
  paginateScreenplay,
  paginatePreview,
  PAGE_LINES,
  PREVIEW_LINES_PER_PAGE,
} from '../../src/shared/pagination/index.js';

describe('live preview pagination', () => {
  it('uses the screenplay width assigned to each element kind', () => {
    const screenplay = parse(`INT. ROOM - DAY

ALICE
${'word '.repeat(20)}
`);
    const dialogue = screenplay.elements.find((element) => element.kind === 'dialogue');
    expect(dialogue).toBeDefined();
    expect(estimateElementLines(dialogue!)).toBeGreaterThan(1);
  });

  it('creates additional pages after the 55-line body', () => {
    const paragraphs = Array.from(
      { length: PREVIEW_LINES_PER_PAGE + 5 },
      (_, index) => `Action ${index + 1}.`,
    ).join('\n\n');
    const screenplay = parse(paragraphs);
    const pages = paginatePreview(screenplay.elements);

    expect(pages).toHaveLength(2);
    expect(pages[0]?.estimatedLines).toBe(PREVIEW_LINES_PER_PAGE);
    expect(pages[1]?.elementIndexes).toHaveLength(5);
  });

  it('honours forced page breaks', () => {
    const screenplay = parse('First action.\n\n===\n\nSecond action.\n');
    const pages = paginatePreview(screenplay.elements);

    expect(pages).toHaveLength(2);
    expect(pages[0]?.range.to).toBeLessThan(pages[1]?.range.from ?? 0);
  });

  it('excludes sections and synopses by default but can include them', () => {
    const screenplay = parse('# Act one\n\n= Opening\n\nINT. ROOM - DAY\n');
    const hidden = paginatePreview(screenplay.elements);
    const visible = paginatePreview(screenplay.elements, {
      includeSections: true,
      includeSynopses: true,
    });

    expect(hidden[0]?.elementIndexes).toHaveLength(1);
    expect(visible[0]?.elementIndexes).toHaveLength(3);
  });
});

describe('production screenplay pagination', () => {
  it('keeps a scene heading with at least two following body lines', () => {
    const filler = Array.from(
      { length: PAGE_LINES.letter - 3 },
      (_, index) => `Action ${index}.`,
    ).join('\n\n');
    const screenplay = parse(`${filler}\n\nINT. ROOM - DAY\n\nOne.\nTwo.\n`);
    const result = paginateScreenplay(screenplay, { format: 'letter' });
    const headingPage = result.pages.findIndex((page) =>
      page.items.some((item) => item.kind === 'scene_heading'),
    );

    expect(headingPage).toBe(1);
    expect(result.pages[1]?.items.some((item) => item.text.includes('One.'))).toBe(true);
  });

  it('never leaves a character cue at the bottom of a page', () => {
    const filler = Array.from(
      { length: PAGE_LINES.letter - 2 },
      (_, index) => `Action ${index}.`,
    ).join('\n\n');
    const screenplay = parse(`${filler}\n\nALICE\nHello there.\n`);
    const result = paginateScreenplay(screenplay, { format: 'letter' });
    const cuePage = result.pages.findIndex((page) =>
      page.items.some((item) => item.kind === 'character'),
    );
    const dialoguePage = result.pages.findIndex((page) =>
      page.items.some((item) => item.kind === 'dialogue'),
    );

    expect(cuePage).toBe(dialoguePage);
  });

  it('keeps a parenthetical with the first line of dialogue', () => {
    const filler = Array.from(
      { length: PAGE_LINES.letter - 4 },
      (_, index) => `Action ${index}.`,
    ).join('\n\n');
    const screenplay = parse(`${filler}\n\nALICE\n(quietly)\nHello.\n`);
    const result = paginateScreenplay(screenplay, { format: 'letter' });
    const parentheticalPage = result.pages.findIndex((page) =>
      page.items.some((item) => item.kind === 'parenthetical'),
    );
    const dialoguePage = result.pages.findIndex((page) =>
      page.items.some((item) => item.kind === 'dialogue'),
    );

    expect(parentheticalPage).toBe(dialoguePage);
  });

  it('adds MORE and a continued cue when dialogue crosses a page', () => {
    const dialogue = Array.from({ length: 70 }, (_, index) => `spoken line ${index}`).join('\n');
    const screenplay = parse(`ALICE\n${dialogue}\n`);
    const result = paginateScreenplay(screenplay, { format: 'letter' });

    expect(result.pages.length).toBeGreaterThan(1);
    expect(result.pages[0]?.items.at(-1)).toMatchObject({ kind: 'more', text: '(MORE)' });
    expect(result.pages[1]?.items[0]).toMatchObject({
      kind: 'continued',
      text: "ALICE (CONT'D)",
    });
  });

  it('honours forced breaks without producing an empty trailing page', () => {
    const screenplay = parse('First.\n\n===\n\nSecond.\n');
    const result = paginateScreenplay(screenplay, { format: 'letter' });

    expect(result.pages).toHaveLength(2);
    expect(result.pages[0]?.items[0]?.text).toBe('First.');
    expect(result.pages[1]?.items[0]?.text).toBe('Second.');
  });

  it('fits more lines on A4 than Letter', () => {
    const screenplay = parse(
      Array.from({ length: PAGE_LINES.a4 }, (_, index) => `Action ${index}.`).join('\n\n'),
    );

    expect(paginateScreenplay(screenplay, { format: 'a4' }).pages).toHaveLength(1);
    expect(paginateScreenplay(screenplay, { format: 'letter' }).pages.length).toBeGreaterThan(1);
  });
});
