import { describe, expect, it } from 'vitest';
import { collapseToHunks, diffLines, diffScenes } from '../../src/shared/diff/index.js';
import { parse } from '../../src/shared/fountain/parse.js';

function render(before: string, after: string): string[] {
  return diffLines(before, after).lines.map((line) => {
    const mark = line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' ';
    return `${mark}${line.text}`;
  });
}

describe('line diff', () => {
  it('reports no change between identical texts', () => {
    const result = diffLines('a\nb\nc', 'a\nb\nc');
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.coarse).toBe(false);
    expect(result.lines.every((line) => line.kind === 'equal')).toBe(true);
  });

  it('numbers lines on the side they come from', () => {
    const result = diffLines('a\nb\nd', 'a\nc\nd');
    expect(result.lines).toEqual([
      { kind: 'equal', text: 'a', beforeLine: 1, afterLine: 1 },
      { kind: 'removed', text: 'b', beforeLine: 2 },
      { kind: 'added', text: 'c', afterLine: 2 },
      { kind: 'equal', text: 'd', beforeLine: 3, afterLine: 3 },
    ]);
    expect(result).toMatchObject({ added: 1, removed: 1 });
  });

  it('handles a pure insertion', () => {
    expect(render('a\nc', 'a\nb\nc')).toEqual([' a', '+b', ' c']);
  });

  it('handles a pure deletion', () => {
    expect(render('a\nb\nc', 'a\nc')).toEqual([' a', '-b', ' c']);
  });

  it('handles an empty side in each direction', () => {
    expect(diffLines('', 'a\nb')).toMatchObject({ added: 2, removed: 0 });
    expect(diffLines('a\nb', '')).toMatchObject({ added: 0, removed: 2 });
    expect(diffLines('', '')).toMatchObject({ added: 0, removed: 0 });
  });

  it('treats CRLF and LF as the same line break', () => {
    expect(diffLines('a\r\nb', 'a\nb')).toMatchObject({ added: 0, removed: 0 });
  });

  it('trims the common prefix and suffix rather than aligning the whole document', () => {
    // 4 000 identical lines around a single changed one: an exact alignment of the whole
    // document would be 16 million cells, so this only completes because of the trimming.
    const head = Array.from({ length: 2_000 }, (_, i) => `head ${i}`);
    const tail = Array.from({ length: 2_000 }, (_, i) => `tail ${i}`);
    const before = [...head, 'MIDDLE BEFORE', ...tail].join('\n');
    const after = [...head, 'MIDDLE AFTER', ...tail].join('\n');

    const result = diffLines(before, after);
    expect(result).toMatchObject({ added: 1, removed: 1, coarse: false });
    expect(result.lines).toHaveLength(4_002);
  });

  it('anchors on unique common lines when the region exceeds the alignment budget', () => {
    // Two 1 200-line halves with nothing in common would be 1.44 million cells — over
    // budget — but the unique headings between them cut it into small regions.
    const block = (label: string, size: number) =>
      Array.from({ length: size }, (_, i) => `${label} line ${i}`);
    const before = [
      ...block('alpha', 1_200),
      'INT. UNIQUE ANCHOR - NIGHT',
      ...block('beta', 1_200),
    ].join('\n');
    const after = [
      ...block('gamma', 1_200),
      'INT. UNIQUE ANCHOR - NIGHT',
      ...block('delta', 1_200),
    ].join('\n');

    const result = diffLines(before, after);
    // The anchor survives as common ground, so the comparison stays aligned rather than
    // collapsing into one undifferentiated replacement.
    expect(result.coarse).toBe(false);
    expect(result.lines.some((line) => line.kind === 'equal' && line.text.includes('ANCHOR'))).toBe(
      true,
    );
    expect(result).toMatchObject({ added: 2_400, removed: 2_400 });
  });

  it('falls back to a wholesale replacement, and says so, when nothing can be anchored', () => {
    // Every line is duplicated, so no line is unique on either side: there is nothing to
    // anchor on and the region is far over budget.
    const before = Array.from({ length: 2_400 }, (_, i) => `before ${i % 1_200}`).join('\n');
    const after = Array.from({ length: 2_400 }, (_, i) => `after ${i % 1_200}`).join('\n');

    const result = diffLines(before, after);
    expect(result.coarse).toBe(true);
    expect(result).toMatchObject({ added: 2_400, removed: 2_400 });
    // Degrading is acceptable; losing content is not.
    expect(result.lines).toHaveLength(4_800);
  });
});

describe('hunk collapsing', () => {
  it('returns nothing when there is no change', () => {
    expect(collapseToHunks(diffLines('a\nb\nc', 'a\nb\nc').lines)).toEqual([]);
  });

  it('keeps only the change and its context, and counts what it skipped', () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 20', 'line 20 rewritten');

    const hunks = collapseToHunks(diffLines(before, after).lines, 2);
    expect(hunks).toHaveLength(1);
    const hunk = hunks[0];
    // Two lines of context on each side, plus the removal and the insertion.
    expect(hunk?.lines).toHaveLength(6);
    expect(hunk?.skippedBefore).toBe(18);
    expect(hunk?.lines.map((line) => line.kind)).toEqual([
      'equal',
      'equal',
      'removed',
      'added',
      'equal',
      'equal',
    ]);
  });

  it('splits distant changes into separate hunks', () => {
    const before = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 5', 'five').replace('line 50', 'fifty');

    const hunks = collapseToHunks(diffLines(before, after).lines, 2);
    expect(hunks).toHaveLength(2);
    expect(hunks[1]?.skippedBefore).toBeGreaterThan(0);
  });
});

const SCREENPLAY = `INT. LABO - NUIT

Alice observe les serveurs.

EXT. RUE - JOUR

Elle court.

INT. BUREAU - SOIR

Boris attend.
`;

describe('scene diff', () => {
  it('reports nothing when the document is unchanged', () => {
    expect(diffScenes(parse(SCREENPLAY), parse(SCREENPLAY))).toEqual([]);
  });

  it('reports a rewritten body as modified, keeping the scene identity', () => {
    const after = SCREENPLAY.replace('Elle court.', 'Elle ralentit, puis s’arrête.');
    const changes = diffScenes(parse(SCREENPLAY), parse(after));
    expect(changes).toEqual([
      {
        kind: 'modified',
        number: '2',
        heading: 'EXT. RUE - JOUR',
        beforeIndex: 2,
        afterIndex: 2,
      },
    ]);
  });

  it('reports an inserted scene as added, without disturbing its neighbours', () => {
    const after = SCREENPLAY.replace(
      'INT. BUREAU - SOIR',
      'EXT. TOIT - AUBE\n\nElle respire.\n\nINT. BUREAU - SOIR',
    );
    const changes = diffScenes(parse(SCREENPLAY), parse(after));
    expect(changes).toEqual([
      { kind: 'added', number: '3', heading: 'EXT. TOIT - AUBE', afterIndex: 3 },
      {
        kind: 'moved',
        number: '4',
        heading: 'INT. BUREAU - SOIR',
        beforeIndex: 3,
        afterIndex: 4,
      },
    ]);
  });

  it('reports a deleted scene as removed', () => {
    const after = SCREENPLAY.replace('EXT. RUE - JOUR\n\nElle court.\n\n', '');
    const changes = diffScenes(parse(SCREENPLAY), parse(after));
    expect(changes).toEqual([
      {
        kind: 'moved',
        number: '2',
        heading: 'INT. BUREAU - SOIR',
        beforeIndex: 3,
        afterIndex: 2,
      },
      { kind: 'removed', number: '2', heading: 'EXT. RUE - JOUR', beforeIndex: 2 },
    ]);
  });

  it('reports a reordered scene as moved rather than as a deletion and an addition', () => {
    // The whole third scene is lifted to the front.
    const after = `INT. BUREAU - SOIR

Boris attend.

INT. LABO - NUIT

Alice observe les serveurs.

EXT. RUE - JOUR

Elle court.
`;
    const changes = diffScenes(parse(SCREENPLAY), parse(after));
    expect(changes.every((change) => change.kind === 'moved')).toBe(true);
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'moved',
          heading: 'INT. BUREAU - SOIR',
          beforeIndex: 3,
          afterIndex: 1,
        }),
      ]),
    );
  });

  it('reads a retitled scene as a removal and an addition, since the heading is its identity', () => {
    const after = SCREENPLAY.replace('EXT. RUE - JOUR', 'EXT. RUELLE - JOUR');
    const changes = diffScenes(parse(SCREENPLAY), parse(after));
    expect(changes.map((change) => [change.kind, change.heading])).toEqual([
      ['added', 'EXT. RUELLE - JOUR'],
      ['removed', 'EXT. RUE - JOUR'],
    ]);
  });
});
