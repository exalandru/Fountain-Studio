import { describe, expect, it } from 'vitest';
import { parse } from '../../src/shared/fountain/index.js';
import type { DocumentEdit } from '../../src/shared/text/index.js';
import {
  REVISION_COLOURS,
  REVISION_PAPER,
  alignLines,
  isRevisionColour,
  nextRevisionColour,
  pageLabel,
  planSceneNumbering,
  revisedElements,
  revisedLines,
  sceneNumbering,
} from '../../src/shared/revision/index.js';

/**
 * Production numbering is a promise made to people who are not reading the file: a crew works
 * from scene numbers on a call sheet and page numbers on a stapled set. These tests are written
 * from that side — what a reader of the issued pages would see — rather than from the shape of
 * the data.
 */

function apply(source: string, edits: readonly DocumentEdit[]): string {
  let result = '';
  let cursor = 0;
  for (const edit of [...edits].sort((left, right) => left.from - right.from)) {
    result += source.slice(cursor, edit.from) + edit.insert;
    cursor = edit.to;
  }
  return result + source.slice(cursor);
}

const numbersOf = (source: string): string[] => parse(source).scenes.map((scene) => scene.number);

describe('revision colours', () => {
  it('walks the production order and never returns to white', () => {
    expect(nextRevisionColour('white')).toBe('blue');
    expect(nextRevisionColour('blue')).toBe('pink');
    // Past the last colour a long production starts the cycle again on blue: white is the
    // original draft, not a revision.
    expect(nextRevisionColour('cherry')).toBe('blue');
  });

  it('has a paper tint for every colour, and only recognises real ones', () => {
    for (const colour of REVISION_COLOURS) {
      expect(REVISION_PAPER[colour], colour).toMatch(/^#[0-9a-f]{6}$/);
      expect(isRevisionColour(colour)).toBe(true);
    }
    expect(isRevisionColour('turquoise')).toBe(false);
    expect(isRevisionColour(undefined)).toBe(false);
    // White is the absence of a tint, so nothing is painted for it.
    expect(REVISION_PAPER.white).toBe('#ffffff');
  });

  it('keeps every tint light enough to read black text on', () => {
    // A page nobody can read serves nobody. WCAG relative luminance, against #000.
    for (const colour of REVISION_COLOURS) {
      const hex = REVISION_PAPER[colour];
      const channels = [1, 3, 5].map((offset) => {
        const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      const luminance =
        0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
      expect((luminance + 0.05) / 0.05, colour).toBeGreaterThan(12);
    }
  });
});

describe('what a revision marks', () => {
  const baseline = 'INT. LABO - NUIT\n\nAlice observe.\n\nALICE\nIls tiennent.\n';

  it('marks a changed line, and nothing else', () => {
    const current = baseline.replace('Ils tiennent.', 'Ils tiennent encore.');

    expect([...revisedLines(baseline, current)]).toEqual([6]);
  });

  it('marks nothing when the text is identical', () => {
    expect(revisedLines(baseline, baseline).size).toBe(0);
  });

  it('marks an insertion on the lines it added', () => {
    const current = baseline.replace('Alice observe.', 'Alice observe.\n\nElle hésite.');
    const marked = revisedLines(baseline, current);

    expect(marked.has(5)).toBe(true);
    expect(marked.has(1)).toBe(false);
  });

  it('marks the line a deletion closed onto', () => {
    // A reader has to be told something used to be there; that is why an issued page sometimes
    // carries an asterisk beside text that reads unchanged.
    const current = 'INT. LABO - NUIT\n\nALICE\nIls tiennent.\n';
    const marked = revisedLines(baseline, current);

    expect(marked.size).toBeGreaterThan(0);
    expect(Math.min(...marked)).toBe(3);
  });

  it('treats an empty baseline as a valid draft before all current lines', () => {
    expect(revisedLines('', baseline).size).toBeGreaterThan(0);
  });

  it('marks a whole element when one of its lines moved', () => {
    const source = 'INT. LABO - NUIT\n\nAlice observe.\nElle attend.\nPuis rien.\n';
    const current = source.replace('Elle attend.', 'Elle patiente.');
    const parsed = parse(current);
    const revised = revisedElements(parsed.elements, revisedLines(source, current));

    // The action block is one element spanning three lines; the heading is untouched.
    const action = parsed.elements.findIndex((element) => element.kind === 'action');
    expect(revised.has(action)).toBe(true);
    expect(revised.has(0)).toBe(false);
  });

  it('reports no element when nothing was marked', () => {
    expect(revisedElements(parse(baseline).elements, new Set()).size).toBe(0);
  });
});

describe('aligning the locked draft onto today', () => {
  it('follows a line that text was inserted above', () => {
    const baseline = 'un\ndeux\ntrois\n';
    const current = 'un\nAJOUT\nAJOUT\ndeux\ntrois\n';
    const alignment = alignLines(baseline, current);

    expect(alignment.get(1)).toBe(1);
    expect(alignment.get(2)).toBe(4);
    expect(alignment.get(3)).toBe(5);
  });

  it('points a deleted line at the place it collapsed onto', () => {
    const alignment = alignLines('un\ndeux\ntrois\n', 'un\ntrois\n');

    expect(alignment.get(1)).toBe(1);
    expect(alignment.get(2)).toBe(2);
    expect(alignment.get(3)).toBe(2);
  });

  it('leaves everything before an addition where it was', () => {
    const baseline = 'un\ndeux\ntrois\n';
    const current = `${baseline}${'ajout\n'.repeat(200)}`;
    const alignment = alignLines(baseline, current);

    expect(alignment.get(1)).toBe(1);
    expect(alignment.get(3)).toBe(3);
  });
});

describe('locking scene numbers', () => {
  const source =
    'INT. LABO - NUIT\n\nUne action.\n\nEXT. RUE - JOUR\n\nUne autre.\n\nINT. CAVE - NUIT\n\nLa fin.\n';

  it('numbers every scene', () => {
    const locked = apply(source, planSceneNumbering(source, parse(source).scenes, 'lock'));

    expect(numbersOf(locked)).toEqual(['1', '2', '3']);
    expect(locked).toContain('INT. LABO - NUIT #1#');
  });

  it('replaces a number that was already declared', () => {
    const numbered = 'INT. A - JOUR #7#\n\nUne action.\n\nEXT. B - NUIT\n\nUne autre.\n';
    const locked = apply(numbered, planSceneNumbering(numbered, parse(numbered).scenes, 'lock'));

    expect(numbersOf(locked)).toEqual(['1', '2']);
    expect(locked).not.toContain('#7#');
  });

  it('changes nothing when the numbering is already right', () => {
    const locked = apply(source, planSceneNumbering(source, parse(source).scenes, 'lock'));

    expect(planSceneNumbering(locked, parse(locked).scenes, 'lock')).toEqual([]);
  });
});

describe('lettering the scenes a revision added', () => {
  /** A locked screenplay, with `insert` unnumbered scenes dropped in at `after`. */
  const withInsertions = (after: number, insert: number): string => {
    const scenes = ['INT. UN - JOUR #1#', 'EXT. DEUX - NUIT #2#', 'INT. TROIS - JOUR #3#'];
    const added = Array.from({ length: insert }, (_value, index) => `EXT. NEUVE${index} - JOUR`);
    scenes.splice(after, 0, ...added);
    return `${scenes.map((heading) => `${heading}\n\nUne action.`).join('\n\n')}\n`;
  };

  it('hangs an inserted scene off the number that follows it', () => {
    const source = withInsertions(1, 1);
    const lettered = apply(source, planSceneNumbering(source, parse(source).scenes, 'letters'));

    expect(numbersOf(lettered)).toEqual(['1', 'A2', '2', '3']);
  });

  it('letters a run in reading order', () => {
    const source = withInsertions(1, 3);
    const lettered = apply(source, planSceneNumbering(source, parse(source).scenes, 'letters'));

    expect(numbersOf(lettered)).toEqual(['1', 'A2', 'B2', 'C2', '2', '3']);
  });

  it('never touches a number that was already declared', () => {
    const source = withInsertions(2, 1);
    const edits = planSceneNumbering(source, parse(source).scenes, 'letters');

    // One edit, on the one heading that had no number.
    expect(edits).toHaveLength(1);
    expect(numbersOf(apply(source, edits))).toEqual(['1', '2', 'A3', '3']);
  });

  it('carries on in integers past the last declared number', () => {
    // Nothing follows, so nothing needs protecting.
    const source = withInsertions(3, 2);
    const lettered = apply(source, planSceneNumbering(source, parse(source).scenes, 'letters'));

    expect(numbersOf(lettered)).toEqual(['1', '2', '3', '4', '5']);
  });

  it('letters a scene inserted before the first one', () => {
    const source = withInsertions(0, 2);
    const lettered = apply(source, planSceneNumbering(source, parse(source).scenes, 'letters'));

    expect(numbersOf(lettered)).toEqual(['A1', 'B1', '1', '2', '3']);
  });

  it('skips I and O, and doubles past Z', () => {
    // `I2` and `12` are the same glyphs on a call sheet, and `O` reads as a zero, so the
    // alphabet used here is 24 letters long.
    const letters = sceneNumbering(parse(withInsertions(1, 26)).scenes, 'letters').slice(1, 27);

    expect(letters).not.toContain('I2');
    expect(letters).not.toContain('O2');
    expect(letters[7]).toBe('H2');
    expect(letters[8]).toBe('J2');
    expect(letters[23]).toBe('Z2');
    expect(letters[24]).toBe('AA2');
    expect(letters[25]).toBe('BB2');
  });

  it('leaves an unlocked screenplay alone', () => {
    // No declared number anywhere: nothing is locked, so nothing gets a letter.
    const plain = 'INT. A - JOUR\n\nUne action.\n\nEXT. B - NUIT\n\nUne autre.\n';
    const lettered = apply(plain, planSceneNumbering(plain, parse(plain).scenes, 'letters'));

    expect(numbersOf(lettered)).toEqual(['1', '2']);
  });

  it('keeps the trailing whitespace of a heading line', () => {
    const source =
      'INT. A - JOUR #1#  \n\nUne action.\n\nEXT. B - NUIT  \n\nUne autre.\n\nINT. C - JOUR #2#  \n\nLa fin.\n';
    const lettered = apply(source, planSceneNumbering(source, parse(source).scenes, 'letters'));

    expect(lettered).toContain('EXT. B - NUIT #A2#  \n');
    expect(numbersOf(lettered)).toEqual(['1', 'A2', '2']);
  });
});

describe('page labels', () => {
  it('letters what overflows a locked page', () => {
    expect(pageLabel(12, 0)).toBe('12');
    expect(pageLabel(12, 1)).toBe('12A');
    expect(pageLabel(12, 2)).toBe('12B');
    // The alphabet skips I, for the same reason scenes do: `12I` reads as `121`.
    expect(pageLabel(12, 8)).toBe('12H');
    expect(pageLabel(12, 9)).toBe('12J');
  });
});
