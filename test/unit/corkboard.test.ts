import { describe, expect, it } from 'vitest';
import { parse } from '../../src/shared/fountain/index.js';
import {
  gapToTargetIndex,
  planSceneMove,
  planSynopsisEdit,
  sceneBlocks,
} from '../../src/shared/corkboard/index.js';
import type { DocumentEdit } from '../../src/shared/corkboard/index.js';

/**
 * The corkboard rewrites the author's screenplay, so these tests are written against the
 * documents that go wrong — no blank line between two scenes, a section heading in the middle,
 * no newline at the end of the file — rather than against the tidy fixture.
 *
 * Most of them re-parse the result: the question is never "is the string what I expected" but
 * "is this still the same screenplay, in a different order".
 */

/** Applies edits given in original coordinates, the way CodeMirror does. */
function apply(source: string, changes: readonly DocumentEdit[]): string {
  let result = '';
  let cursor = 0;
  for (const change of [...changes].sort((left, right) => left.from - right.from)) {
    result += source.slice(cursor, change.from) + change.insert;
    cursor = change.to;
  }
  return result + source.slice(cursor);
}

const headingsOf = (source: string): string[] => parse(source).scenes.map((scene) => scene.heading);

const move = (source: string, from: number, to: number): string => {
  const plan = planSceneMove(source, parse(source).scenes, from, to);
  expect(plan, 'expected a plan').not.toBeNull();
  return plan ? apply(source, plan.changes) : source;
};

const THREE = ['INT. CAFÉ - JOUR', 'EXT. RUE - NUIT', 'INT. CAVE - NUIT'];
const simple = `${THREE[0]}\n\nAlix entre.\n\n${THREE[1]}\n\nElle court.\n\n${THREE[2]}\n\nLe noir.\n`;

describe('scene blocks', () => {
  it('claims the blank lines that follow a scene', () => {
    const blocks = sceneBlocks(simple, parse(simple).scenes);

    expect(blocks).toHaveLength(3);
    // Each block ends where the next one starts: no character of the screenplay belongs to
    // nothing, which is what makes a move lossless.
    expect(blocks[0]?.to).toBe(blocks[1]?.from);
    expect(blocks[1]?.to).toBe(blocks[2]?.from);
    expect(blocks[2]?.to).toBe(simple.length);
    expect(simple.slice(blocks[0]?.from, blocks[0]?.to)).toBe(
      'INT. CAFÉ - JOUR\n\nAlix entre.\n\n',
    );
  });

  it('stops before a section heading rather than carrying it along', () => {
    const source = 'INT. A - JOUR\n\nUne action.\n\n# ACTE II\n\nINT. B - JOUR\n\nUne autre.\n';
    const blocks = sceneBlocks(source, parse(source).scenes);

    expect(source.slice(blocks[0]?.from, blocks[0]?.to)).toBe('INT. A - JOUR\n\nUne action.\n\n');
    expect(source.slice(blocks[0]?.to ?? 0, (blocks[0]?.to ?? 0) + 9)).toBe('# ACTE II');
  });

  it('handles a last scene with no newline at the end of the file', () => {
    const source = 'INT. A - JOUR\n\nUne action.\n\nINT. B - JOUR\n\nLa fin.';
    const blocks = sceneBlocks(source, parse(source).scenes);

    expect(blocks[1]?.to).toBe(source.length);
  });
});

describe('moving a scene', () => {
  it('moves a scene down', () => {
    expect(headingsOf(move(simple, 0, 2))).toEqual([THREE[1], THREE[2], THREE[0]]);
  });

  it('moves a scene up', () => {
    expect(headingsOf(move(simple, 2, 0))).toEqual([THREE[2], THREE[0], THREE[1]]);
  });

  it('moves a scene by a single position, in both directions', () => {
    expect(headingsOf(move(simple, 0, 1))).toEqual([THREE[1], THREE[0], THREE[2]]);
    expect(headingsOf(move(simple, 1, 0))).toEqual([THREE[1], THREE[0], THREE[2]]);
  });

  it('carries the scene body along, not just the heading', () => {
    const moved = move(simple, 0, 2);

    expect(moved).toContain('INT. CAFÉ - JOUR\n\nAlix entre.');
    expect(moved.indexOf('Alix entre.')).toBeGreaterThan(moved.indexOf('Le noir.'));
  });

  it('refuses a move that changes nothing', () => {
    const scenes = parse(simple).scenes;

    expect(planSceneMove(simple, scenes, 1, 1)).toBeNull();
    expect(planSceneMove(simple, scenes, -1, 0)).toBeNull();
    expect(planSceneMove(simple, scenes, 0, 3)).toBeNull();
    expect(planSceneMove(simple, scenes, 1.5, 0)).toBeNull();
  });

  it('refuses to move the only scene of a screenplay', () => {
    const single = 'INT. A - JOUR\n\nSeule.\n';

    expect(planSceneMove(single, parse(single).scenes, 0, 0)).toBeNull();
  });

  it('leaves exactly one blank line between scenes, whatever the move', () => {
    // Every ordered pair, so a normalisation that only works in one direction is caught.
    for (let from = 0; from < 3; from++) {
      for (let to = 0; to < 3; to++) {
        if (from === to) continue;
        const moved = move(simple, from, to);
        expect(headingsOf(moved), `${from}→${to}`).toHaveLength(3);
        expect(moved, `${from}→${to}`).not.toMatch(/\n\n\n[^\s]/);
      }
    }
  });

  it('opens a blank line when the destination has only a single break', () => {
    // A heading is only a heading when a blank line precedes it — the parser drops one that
    // follows a line of action. A section heading has no such rule, so a scene can end one
    // newline before `# ACTE II`, and inserting there must add the missing break rather than
    // glue the moved heading to the previous line.
    const tight =
      'INT. A - JOUR\n\nAction A.\n\nINT. B - JOUR\n\nAction B.\n# ACTE II\n\nINT. C - JOUR\n\nAction C.\n';
    expect(headingsOf(tight)).toHaveLength(3);

    const after = parse(move(tight, 0, 1)).scenes;

    expect(after.map((scene) => scene.heading)).toEqual([
      'INT. B - JOUR',
      'INT. A - JOUR',
      'INT. C - JOUR',
    ]);
    // Landing in front of the title, the moved scene stays outside the act.
    expect(after.map((scene) => scene.sectionPath)).toEqual([[], [], ['ACTE II']]);
  });

  it('moves a scene into the section it is dropped under', () => {
    const source =
      'INT. A - JOUR\n\nUne action.\n\n# ACTE II\n\nINT. B - JOUR\n\nUne autre.\n\nINT. C - JOUR\n\nLa fin.\n';
    const scenes = parse(source).scenes;
    expect(scenes.map((scene) => scene.sectionPath)).toEqual([[], ['ACTE II'], ['ACTE II']]);

    const moved = move(source, 0, 2);
    const after = parse(moved).scenes;

    expect(after.map((scene) => scene.heading)).toEqual([
      'INT. B - JOUR',
      'INT. C - JOUR',
      'INT. A - JOUR',
    ]);
    // The title stayed where it was, and the scene that passed it belongs to it now.
    expect(after.map((scene) => scene.sectionPath)).toEqual([
      ['ACTE II'],
      ['ACTE II'],
      ['ACTE II'],
    ]);
    expect(moved).toContain('# ACTE II');
  });

  it('takes a scene out of a section when it moves above it', () => {
    const source = 'INT. A - JOUR\n\nUne action.\n\n# ACTE II\n\nINT. B - JOUR\n\nUne autre.\n';
    const after = parse(move(source, 1, 0)).scenes;

    expect(after.map((scene) => scene.heading)).toEqual(['INT. B - JOUR', 'INT. A - JOUR']);
    expect(after.map((scene) => scene.sectionPath)).toEqual([[], []]);
  });

  it('keeps declared scene numbers exactly as they were', () => {
    const source =
      'INT. A - JOUR #1# \n\nUne action.\n\nINT. B - JOUR #12# \n\nUne autre.\n\nINT. C - JOUR #A3# \n\nLa fin.\n';
    const after = parse(move(source, 2, 0)).scenes;

    // The order changed, the numbers did not: a declared number is a locked number.
    expect(after.map((scene) => scene.number)).toEqual(['A3', '1', '12']);
  });

  it('carries a synopsis with its scene', () => {
    const source = 'INT. A - JOUR\n= Alix hésite.\n\nUne action.\n\nINT. B - JOUR\n\nUne autre.\n';
    const after = parse(move(source, 0, 1)).scenes;

    expect(after[1]?.heading).toBe('INT. A - JOUR');
    expect(after[1]?.synopsis).toBe('Alix hésite.');
    expect(after[0]?.synopsis).toBeUndefined();
  });

  it('preserves CRLF line endings', () => {
    const source = simple.replace(/\n/g, '\r\n');
    const moved = move(source, 0, 2);

    expect(moved).not.toMatch(/[^\r]\n/);
    expect(parse(moved).scenes.map((scene) => scene.heading)).toEqual([
      THREE[1],
      THREE[2],
      THREE[0],
    ]);
  });

  it('keeps the title page and anything before the first scene in place', () => {
    const source = `Title: Essai\nCredit: Écrit par\n\n${simple}`;
    const moved = move(source, 2, 0);

    expect(moved.startsWith('Title: Essai\nCredit: Écrit par\n\n')).toBe(true);
    expect(parse(moved).titlePage.fields.get('title')).toEqual(['Essai']);
    expect(headingsOf(moved)).toEqual([THREE[2], THREE[0], THREE[1]]);
  });

  it('adds a final newline only when the document already had one', () => {
    const unterminated = 'INT. A - JOUR\n\nUne action.\n\nINT. B - JOUR\n\nLa fin.';
    const moved = move(unterminated, 0, 1);

    expect(moved.endsWith('\n')).toBe(false);
    expect(headingsOf(moved)).toEqual(['INT. B - JOUR', 'INT. A - JOUR']);
    expect(move(simple, 0, 2).endsWith('\n')).toBe(true);
  });

  it('points the caret at the moved heading', () => {
    for (const [from, to] of [
      [0, 2],
      [2, 0],
      [1, 2],
      [1, 0],
    ] as const) {
      const plan = planSceneMove(simple, parse(simple).scenes, from, to);
      expect(plan).not.toBeNull();
      if (!plan) continue;
      const moved = apply(simple, plan.changes);
      expect(moved.slice(plan.caret), `${from}→${to}`).toMatch(new RegExp(`^${THREE[from]}`));
    }
  });
});

describe('drop gaps', () => {
  it('reads a gap past the dragged card as one position too far', () => {
    // Dropping card 0 into the gap before card 2 lands it at index 1: its own slot closed up.
    expect(gapToTargetIndex(0, 2)).toBe(1);
    expect(gapToTargetIndex(0, 3)).toBe(2);
    // Dropping into either gap around itself changes nothing.
    expect(gapToTargetIndex(1, 1)).toBe(1);
    expect(gapToTargetIndex(1, 2)).toBe(1);
    // Backwards, the gap index is already the final position.
    expect(gapToTargetIndex(2, 0)).toBe(0);
    expect(gapToTargetIndex(2, 1)).toBe(1);
  });
});

describe('editing a synopsis', () => {
  const source = 'INT. A - JOUR\n= Alix hésite.\n\nUne action.\n\nINT. B - JOUR\n\nLa fin.\n';

  /** The heading end and the existing `=` element, as the corkboard reads them. */
  const targetOf = (text: string, index: number) => {
    const parsed = parse(text);
    const scene = parsed.scenes[index];
    if (!scene) throw new Error('no such scene');
    const heading = scene.elements[0];
    const synopsis = scene.elements.find((element) => element.kind === 'synopsis');
    return {
      headingTo: heading?.range.to ?? 0,
      synopsis: synopsis ? { ...synopsis.range } : null,
    };
  };

  it('inserts a synopsis under a scene that has none', () => {
    const edit = planSynopsisEdit(source, targetOf(source, 1), 'La fille parle enfin.');
    expect(edit).not.toBeNull();
    if (!edit) return;

    const result = apply(source, [edit]);
    expect(parse(result).scenes[1]?.synopsis).toBe('La fille parle enfin.');
    // Inserted under its own heading, not appended at the end of the scene.
    expect(result).toContain('INT. B - JOUR\n= La fille parle enfin.\n\nLa fin.');
  });

  it('replaces an existing synopsis', () => {
    const edit = planSynopsisEdit(source, targetOf(source, 0), 'Alix renonce.');
    const result = edit ? apply(source, [edit]) : source;

    expect(parse(result).scenes[0]?.synopsis).toBe('Alix renonce.');
    expect(result).not.toContain('hésite');
  });

  it('removes the line when the synopsis is emptied', () => {
    const edit = planSynopsisEdit(source, targetOf(source, 0), '   ');
    const result = edit ? apply(source, [edit]) : source;

    expect(parse(result).scenes[0]?.synopsis).toBeUndefined();
    // The line went with its own break: no blank line appears under the heading.
    expect(result.startsWith('INT. A - JOUR\n\nUne action.')).toBe(true);
  });

  it('flattens a synopsis pasted as several lines', () => {
    // A `=` holds one line. Left as is, the second paragraph would become action.
    const edit = planSynopsisEdit(source, targetOf(source, 1), 'Elle parle.\n\nPuis se tait.');
    const result = edit ? apply(source, [edit]) : source;

    expect(parse(result).scenes[1]?.synopsis).toBe('Elle parle. Puis se tait.');
    expect(parse(result).scenes[1]?.elements.filter((e) => e.kind === 'synopsis')).toHaveLength(1);
  });

  it('does nothing when the text is unchanged, or empty on a scene without one', () => {
    expect(planSynopsisEdit(source, targetOf(source, 0), 'Alix hésite.')).toBeNull();
    expect(planSynopsisEdit(source, targetOf(source, 1), '  ')).toBeNull();
  });

  it('writes with the document line ending', () => {
    const crlf = source.replace(/\n/g, '\r\n');
    const edit = planSynopsisEdit(crlf, targetOf(crlf, 1), 'Ajoutée.');
    const result = edit ? apply(crlf, [edit]) : crlf;

    expect(result).not.toMatch(/[^\r]\n/);
    expect(parse(result).scenes[1]?.synopsis).toBe('Ajoutée.');
  });
});
