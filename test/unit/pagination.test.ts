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

    expect(pages).toHaveLength(3);
    expect(pages[0]?.estimatedLines).toBe(PREVIEW_LINES_PER_PAGE);
    expect(pages[2]?.elementIndexes).toHaveLength(5);
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
      Array.from({ length: Math.floor(PAGE_LINES.a4 / 2) }, (_, index) => `Action ${index}.`).join(
        '\n\n',
      ),
    );

    expect(paginateScreenplay(screenplay, { format: 'a4' }).pages).toHaveLength(1);
    expect(paginateScreenplay(screenplay, { format: 'letter' }).pages.length).toBeGreaterThan(1);
  });
});

/**
 * Locked pages are the promise that page 12 stays page 12 once a crew is holding it. Everything
 * here is read the way a reader of the issued set reads it: by the label on the page.
 */
describe('locked pages', () => {
  /** A screenplay of `count` action blocks, each one line long. */
  const blocks = (count: number): string =>
    Array.from({ length: count }, (_value, index) => `Action ${index}.`).join('\n\n');

  /** 1-based source line of the block whose text is `Action n.`. */
  const lineOf = (source: string, text: string): number =>
    source.slice(0, source.indexOf(text)).split('\n').length;

  it('labels pages by position when nothing is locked', () => {
    // The guarantee that this whole feature costs nothing when it is not used.
    const result = paginateScreenplay(parse(blocks(120)), { format: 'letter' });

    expect(result.pages.length).toBeGreaterThan(2);
    expect(result.pages.map((page) => page.number)).toEqual(
      result.pages.map((page) => String(page.index + 1)),
    );
    expect(result.pages.every((page) => page.lockIndex === null)).toBe(true);
  });

  it('opens a page exactly where a locked start says', () => {
    // A one-line block costs two lines once its blank line is counted, so thirty of them fill
    // rather less than two Letter pages: the second page here exists because it was pinned.
    const source = blocks(30);
    const result = paginateScreenplay(parse(source), {
      format: 'letter',
      lockedPageStarts: [1, lineOf(source, 'Action 10.')],
    });

    expect(result.pages).toHaveLength(2);
    expect(result.pages[1]?.items[0]?.text).toBe('Action 10.');
    expect(result.pages.map((page) => page.number)).toEqual(['1', '2']);
  });

  it('sends what overflows a locked page onto a lettered one, leaving the next number alone', () => {
    // Two pinned pages, and forty blocks crammed into the first — a page and a half of them.
    const source = blocks(60);
    const starts = [1, lineOf(source, 'Action 40.')];
    const result = paginateScreenplay(parse(source), {
      format: 'letter',
      lockedPageStarts: starts,
    });

    expect(result.pages.map((page) => page.number)).toEqual(['1', '1A', '2']);
    // Page 2 still starts where it was pinned: that is the whole point of the letter.
    const second = result.pages.find((page) => page.number === '2');
    expect(second?.items[0]?.text).toBe('Action 40.');
  });

  it('leaves a page short rather than pulling the next page back', () => {
    const source = blocks(90);
    const starts = [1, lineOf(source, 'Action 4.'), lineOf(source, 'Action 60.')];
    const result = paginateScreenplay(parse(source), {
      format: 'letter',
      lockedPageStarts: starts,
    });

    // Page 1 holds four blocks and stops, half blank, exactly like an issued page that lost a
    // scene.
    expect(result.pages[0]?.usedLines).toBeLessThan(PAGE_LINES.letter / 2);
    expect(result.pages[1]?.number).toBe('2');
  });

  it('numbers pages added past the last locked one in plain integers', () => {
    // Nothing follows them, so there is no later number to protect.
    const source = blocks(120);
    const result = paginateScreenplay(parse(source), {
      format: 'letter',
      lockedPageStarts: [1, lineOf(source, 'Action 25.')],
    });

    const labels = result.pages.map((page) => page.number);
    expect(labels.slice(0, 2)).toEqual(['1', '2']);
    expect(labels.slice(2)).toEqual(labels.slice(2).map((_label, index) => String(index + 3)));
  });

  it('ignores a locked start past the end of the screenplay', () => {
    const result = paginateScreenplay(parse(blocks(10)), {
      format: 'letter',
      lockedPageStarts: [1, 9_000],
    });

    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.number).toBe('1');
  });

  it('drops the later of two starts that land on the same element', () => {
    // A page whose content was entirely cut: the earlier page keeps the text, and the number
    // that lost it simply does not appear in the issued set — rather than an empty page 2
    // followed by a page 3 holding what page 2 used to hold.
    const source = blocks(30);
    const line = lineOf(source, 'Action 10.');
    const result = paginateScreenplay(parse(source), {
      format: 'letter',
      lockedPageStarts: [1, line, line],
    });

    expect(result.pages.map((page) => page.number)).toEqual(['1', '2']);
    expect(result.pages.every((page) => page.items.length > 0)).toBe(true);
  });
});
