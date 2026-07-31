import { describe, expect, it } from 'vitest';
import type { SceneView } from '../../src/shared/fountain/ast.js';
import { parse } from '../../src/shared/fountain/index.js';
import { findRepeatedPhrases } from '../../src/shared/repetition/index.js';

function views(source: string): SceneView[] {
  return parse(source).scenes.map((scene) => ({
    number: scene.number,
    heading: scene.heading,
    location: scene.location,
    elements: scene.elements,
  }));
}

/**
 * A short screenplay carrying one of each case the report has to tell apart: a verbal tic
 * spread over three speeches, an action formula reused, a line two characters share, plus
 * headings and transitions that repeat because that is what headings and transitions do.
 */
const SOURCE = `INT. LABO - NUIT

Alice pousse la porte et reste sur le seuil.

ALICE
Je te le dis franchement, ça ne tiendra pas.

BOB
Les serveurs tiennent depuis six mois.

CUT TO:

EXT. RUE - JOUR

Bob pousse la porte et reste sur le seuil.

ALICE
Je te le dis franchement, il faut tout couper.

CUT TO:

INT. LABO - NUIT

Chloé regarde les serveurs sans rien dire.

ALICE
Je te le dis franchement, tu exagères.

CHLOE
Les serveurs tiennent depuis six mois.
`;

describe('literal repetition', () => {
  const report = findRepeatedPhrases(views(SOURCE));
  const find = (phrase: string) => report.phrases.find((item) => item.phrase === phrase);

  it('reports a phrase repeated word for word, most repeated first', () => {
    expect(report.phrases[0]).toMatchObject({
      phrase: 'je te le dis franchement',
      total: 3,
      scope: 'dialogue',
    });
    expect(report.wordCount).toBeGreaterThan(40);
    expect(report.truncated).toBe(false);
  });

  it('reports the whole repeated phrase, not every length inside it', () => {
    // Without the maximality pass this one finding arrives once per window length.
    const shorter = report.phrases.filter((item) => item.phrase.includes('te le dis'));
    expect(shorter).toHaveLength(1);
    expect(find('te le dis franchement')).toBeUndefined();
    expect(find('je te le dis')).toBeUndefined();
  });

  it('tells a character’s signature from the writer’s own tic', () => {
    // Three repeats in one mouth: deliberate, and the writer means to keep it.
    expect(find('je te le dis franchement')).toMatchObject({
      attribution: 'signature',
      speakers: ['ALICE'],
    });
    // The same words in two mouths: the writer's formula, not the character's.
    expect(find('les serveurs tiennent depuis six mois')).toMatchObject({
      attribution: 'spread',
      speakers: ['BOB', 'CHLOE'],
    });
  });

  it('keeps dialogue and action apart, and reports an action formula as spread', () => {
    const formula = find('pousse la porte et reste sur le seuil');
    expect(formula).toMatchObject({
      scope: 'action',
      total: 2,
      speakers: [],
      attribution: 'spread',
    });
    expect(
      report.phrases.every((item) => item.scope === 'dialogue' || item.scope === 'action'),
    ).toBe(true);
  });

  it('ignores what repeats by design: headings, cues and transitions', () => {
    // "INT. LABO - NUIT" appears twice and "CUT TO:" twice; neither is a finding.
    for (const phrase of report.phrases) {
      expect(phrase.phrase).not.toContain('labo');
      expect(phrase.phrase).not.toContain('cut to');
    }
  });

  it('measures how far apart the repeats sit, in scenes', () => {
    // First scene to third: near repeats are heard, distant ones are not.
    expect(find('je te le dis franchement')?.span).toBe(2);
    expect(find('pousse la porte et reste sur le seuil')?.span).toBe(1);
  });

  it('points at each occurrence with the scene and the block it sits in', () => {
    const tic = find('je te le dis franchement');
    expect(tic?.occurrences).toHaveLength(3);
    expect(tic?.occurrences[0]).toMatchObject({
      sceneNumber: '1',
      heading: 'INT. LABO - NUIT',
      sceneIndex: 1,
      speaker: 'ALICE',
    });
    expect(tic?.occurrences[0]?.text).toContain('ça ne tiendra pas');
    // The offsets have to land on the block, so the editor can be taken there.
    const range = tic?.occurrences[0]?.range;
    expect(range?.to).toBeGreaterThan(range?.from ?? 0);
    expect(SOURCE.slice(range?.from ?? 0, range?.to ?? 0)).toContain('franchement');
  });

  it('never spans two blocks, however the words line up across them', () => {
    // "sans rien dire" ends an action and "Je te le dis" opens the next speech; the words
    // touch only because the blocks are adjacent, which is not a repetition.
    for (const phrase of report.phrases) {
      expect(phrase.phrase).not.toContain('dire je te');
    }
  });

  it('honours the thresholds it is given', () => {
    expect(findRepeatedPhrases(views(SOURCE), { minOccurrences: 3 }).phrases).toHaveLength(1);
    // A longer floor than any repeat in this screenplay leaves nothing to report.
    expect(findRepeatedPhrases(views(SOURCE), { minLength: 20 }).phrases).toEqual([]);
    // And a shorter floor may not be pushed below where grammar takes over.
    expect(findRepeatedPhrases(views(SOURCE), { minLength: 0 }).phrases.length).toBeGreaterThan(0);
  });

  it('has nothing to say about an empty or unrepetitive screenplay', () => {
    expect(findRepeatedPhrases([])).toMatchObject({ phrases: [], wordCount: 0 });
    const once = findRepeatedPhrases(
      views('INT. LABO - NUIT\n\nAlice attend seule dans le couloir désert.\n'),
    );
    expect(once.phrases).toEqual([]);
    expect(once.wordCount).toBe(7);
  });
});

describe('literal repetition, degenerate documents', () => {
  it('rebuilds a passage longer than the window into a single finding', () => {
    const block = 'Il pousse la porte, regarde le couloir vide et referme derrière lui sans bruit.';
    const source = [1, 2, 3]
      .map((scene) => `INT. COULOIR ${scene} - NUIT\n\n${block}\n`)
      .join('\n');
    const phrases = findRepeatedPhrases(views(source)).phrases;
    // Fourteen words, well past the ten-word window, yet reported once at full length.
    expect(phrases).toHaveLength(1);
    expect(phrases[0]?.total).toBe(3);
    expect(phrases[0]?.length).toBeGreaterThan(10);
    expect(phrases[0]?.phrase).toContain('sans bruit');
  });

  it('still finds the repetition when a phrase fills most of the screenplay', () => {
    // The frequency of a word cannot decide whether it is grammar: here the repeated line
    // makes its own words the commonest in the document. Dispersion over distinct blocks is
    // what keeps this finding from erasing itself.
    const source = Array.from(
      { length: 12 },
      (_, index) => `INT. LIEU ${index} - JOUR\n\nMARC\nRien ne se passe comme prévu ici.\n`,
    ).join('\n');
    const phrases = findRepeatedPhrases(views(source)).phrases;
    expect(phrases).toHaveLength(1);
    expect(phrases[0]).toMatchObject({ total: 12, attribution: 'signature', speakers: ['MARC'] });
  });

  it('reports the true count while bounding the occurrences it hands out', () => {
    const source = Array.from(
      { length: 60 },
      (_, index) => `INT. LIEU ${index} - JOUR\n\nMARC\nRien ne se passe comme prévu ici.\n`,
    ).join('\n');
    const phrase = findRepeatedPhrases(views(source)).phrases[0];
    expect(phrase?.total).toBe(60);
    // The count stays honest; the list of places to jump to does not grow without end.
    expect(phrase?.occurrences.length).toBeLessThanOrEqual(30);
  });
});
