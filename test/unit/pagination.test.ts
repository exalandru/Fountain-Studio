import { describe, expect, it } from 'vitest';
import { parse } from '../../src/shared/fountain/index.js';
import {
  estimateElementLines,
  paginatePreview,
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
