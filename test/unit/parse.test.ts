import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyTimeOfDay,
  countWords,
  parse,
  parseHeading,
} from '../../src/shared/fountain/parse.js';

/**
 * The reference corpus is a French screenplay on purpose: it exercises accented
 * capitals, typographic apostrophes and French times of day, none of which an
 * English-only fixture would cover. Fountain content is language-independent, so the
 * parser must handle it whatever the interface language is.
 */
const CORPUS = join(import.meta.dirname, '..', 'corpus');
const complet = readFileSync(join(CORPUS, 'complet.fountain'), 'utf8');

describe('parseHeading', () => {
  it('splits prefix, location and time of day', () => {
    expect(parseHeading('INT. CINÉMA LE ROYAL - HALL - JOUR')).toEqual({
      intExt: 'INT',
      location: 'CINÉMA LE ROYAL - HALL',
      timeOfDay: 'JOUR',
    });
  });

  it('recognises INT./EXT. as mixed', () => {
    expect(parseHeading('INT./EXT. CAR - NIGHT').intExt).toBe('INT/EXT');
    expect(parseHeading('I/E. CAR - NIGHT').intExt).toBe('INT/EXT');
  });

  it('does not mistake a sub-location for a time of day', () => {
    // The classic trap: without a list of known times, "KITCHEN" would become the
    // scene's time of day and skew the day/night ratio.
    expect(parseHeading('INT. HOUSE - KITCHEN')).toEqual({
      intExt: 'INT',
      location: 'HOUSE - KITCHEN',
      timeOfDay: null,
    });
  });

  it('recognises a compound time of day', () => {
    expect(parseHeading('EXT. BEACH - LATE AT NIGHT').timeOfDay).toBe('LATE AT NIGHT');
  });

  it('accepts times of day written without accents', () => {
    expect(parseHeading('EXT. TOIT - CREPUSCULE').timeOfDay).toBe('CREPUSCULE');
  });

  it('handles a heading with no time of day', () => {
    expect(parseHeading('INT. KITCHEN')).toEqual({
      intExt: 'INT',
      location: 'KITCHEN',
      timeOfDay: null,
    });
  });
});

describe('classifyTimeOfDay', () => {
  it('classifies times of day as day, night or other, in both languages', () => {
    expect(classifyTimeOfDay('JOUR')).toBe('day');
    expect(classifyTimeOfDay('DAY')).toBe('day');
    expect(classifyTimeOfDay('AUBE')).toBe('day');
    expect(classifyTimeOfDay('NUIT')).toBe('night');
    expect(classifyTimeOfDay('NIGHT')).toBe('night');
    expect(classifyTimeOfDay('CRÉPUSCULE')).toBe('night');
    expect(classifyTimeOfDay('CONTINU')).toBe('other');
    expect(classifyTimeOfDay(null)).toBe('other');
  });
});

describe('countWords', () => {
  it('counts words containing apostrophes and hyphens', () => {
    expect(countWords("C'est un après-midi d'été")).toBe(4);
  });

  it('ignores standalone punctuation', () => {
    expect(countWords('Yes ! No ? ...')).toBe(2);
  });
});

describe('parse — title page', () => {
  it('collects the fields, including multi-line values', () => {
    const { titlePage } = parse(complet);
    expect(titlePage.fields.get('title')).toEqual(['_**LA DERNIÈRE SÉANCE**_', 'Court métrage']);
    expect(titlePage.fields.get('credit')).toEqual(['Écrit par']);
    expect(titlePage.fields.get('author')).toEqual(['Claire Vasseur']);
    expect(titlePage.fields.get('draft date')).toEqual(['12 mars 2026']);
  });

  it('returns an empty title page when the screenplay has none', () => {
    const { titlePage } = parse('INT. KITCHEN - DAY\n\nShe walks in.');
    expect(titlePage.fields.size).toBe(0);
    expect(titlePage.lineCount).toBe(0);
  });
});

describe('parse — scenes', () => {
  it('numbers the scenes and keeps declared numbers', () => {
    const { scenes } = parse(complet);
    expect(scenes.map((s) => s.number)).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(scenes[0]?.declaredNumber).toBe('1');
    expect(scenes[3]?.declaredNumber).toBeUndefined();
  });

  it('extracts locations and times of day', () => {
    const { scenes } = parse(complet);
    expect(scenes[0]?.location).toBe('CINÉMA LE ROYAL - HALL');
    expect(scenes[0]?.timeOfDay).toBe('JOUR');
    expect(scenes[2]?.intExt).toBe('EXT');
    expect(scenes[2]?.timeOfDay).toBe('AUBE');
  });

  it('attaches the synopsis to its scene', () => {
    const { scenes } = parse(complet);
    expect(scenes[0]?.synopsis).toBe('Julie apprend la nouvelle par une affiche.');
  });

  it('records each scene’s section path', () => {
    const { scenes } = parse(complet);
    expect(scenes[0]?.sectionPath).toEqual(['ACTE I', 'Séquence 1 — L’annonce']);
    expect(scenes[3]?.sectionPath).toEqual(['ACTE II']);
  });

  it('includes the heading among the scene’s elements', () => {
    const { scenes } = parse('INT. A - DAY\n\nShe walks in.');
    expect(scenes[0]?.elements[0]?.kind).toBe('scene_heading');
    expect(scenes[0]?.elements[1]?.kind).toBe('action');
  });

  it('creates no scene for text preceding the first heading', () => {
    const { scenes, elements } = parse('A stray note.\n\nINT. A - DAY');
    expect(scenes).toHaveLength(1);
    expect(elements[0]?.kind).toBe('action');
  });
});

describe('parse — sections', () => {
  it('builds the hierarchy', () => {
    const { sections } = parse(complet);
    expect(sections.map((s) => s.title)).toEqual(['ACTE I', 'ACTE II']);
    expect(sections[0]?.children.map((c) => c.title)).toEqual(['Séquence 1 — L’annonce']);
  });

  it('attaches a section’s synopsis', () => {
    const { sections } = parse(complet);
    expect(sections[0]?.synopsis).toBe('L’acte où Julie découvre que le cinéma va fermer.');
  });

  it('attaches scenes to the nearest section', () => {
    const { sections } = parse(complet);
    expect(sections[0]?.children[0]?.sceneIndexes).toEqual([0, 1, 2]);
  });

  it('unwinds correctly from ### back to #', () => {
    const { sections } = parse('# A\n\n## B\n\n### C\n\n# D');
    expect(sections.map((s) => s.title)).toEqual(['A', 'D']);
    expect(sections[0]?.children[0]?.children[0]?.title).toBe('C');
  });
});

describe('parse — characters', () => {
  it('counts speeches and words', () => {
    const { characters } = parse(complet);
    const julie = characters.get('JULIE');
    expect(julie?.speeches).toBe(4);
    expect(julie?.words).toBeGreaterThan(0);
  });

  it('leaves extensions out of the name', () => {
    const { characters } = parse(complet);
    expect(characters.has('MARC')).toBe(true);
    expect(characters.has('MARC (V.O.)')).toBe(false);
  });

  it('links each dialogue to its speaker', () => {
    const { elements } = parse('INT. A - DAY\n\nJULIE\nHello.\n\nMARC\nHi.');
    const dialogues = elements.filter((e) => e.kind === 'dialogue');
    expect(dialogues.map((d) => d.speaker)).toEqual(['JULIE', 'MARC']);
  });

  it('links characters to the scenes where they speak', () => {
    const { characters } = parse(complet);
    expect(characters.get('JULIE')?.sceneIndexes).toContain(0);
  });
});

describe('parse — locations', () => {
  it('deduplicates locations and counts occurrences', () => {
    const { locations } = parse(complet);
    expect(locations.get('RUE DU ROYAL')?.count).toBe(2);
  });

  it('flags locations seen both inside and outside', () => {
    const { locations } = parse(
      'INT. GARAGE - DAY\n\nA.\n\nEXT. GARAGE - NIGHT\n\nB.\n\nINT. CELLAR - DAY\n\nC.',
    );
    expect(locations.get('GARAGE')?.mixed).toBe(true);
    expect(locations.get('CELLAR')?.mixed).toBe(false);
  });
});

describe('parse — notes and boneyard', () => {
  it('collects annotations without turning them into elements', () => {
    const { annotations, elements } = parse(complet);
    expect(annotations.some((a) => a.kind === 'note')).toBe(true);
    expect(annotations.some((a) => a.kind === 'boneyard')).toBe(true);
    expect(elements.some((e) => e.text.includes('Vérifier si cette scène'))).toBe(false);
  });

  it('excludes boneyard content from the text', () => {
    const { elements } = parse('INT. A - DAY\n\n/*\nJULIE\nI will not leave.\n*/\n\nShe leaves.');
    expect(elements.some((e) => e.text.includes('I will not leave'))).toBe(false);
    expect(elements.some((e) => e.text === 'She leaves.')).toBe(true);
  });

  it('keeps the text surrounding an inline note', () => {
    // The note is replaced by as many spaces as it occupied, which keeps offsets exact.
    // The leftover whitespace is the accepted trade-off: collapsing it is the renderer's
    // job (preview, PDF), not a reason for the parser to falsify positions.
    const { elements } = parse('He walks in. [[revisit]] He leaves.');
    expect(elements[0]?.text).toBe(`He walks in.${' '.repeat(12)} He leaves.`);
    expect(elements[0]?.text.replace(/\s+/g, ' ')).toBe('He walks in. He leaves.');
  });

  it('preserves offsets despite masking', () => {
    const source = 'INT. A - DAY\n\n[[note]]\n\nShe walks in.';
    const { elements, source: kept } = parse(source);
    const action = elements.find((e) => e.text === 'She walks in.');
    expect(action).toBeDefined();
    expect(kept.slice(action?.range.from, action?.range.to)).toBe('She walks in.');
  });

  it('reports an unterminated boneyard', () => {
    // Diagnostics carry a code, not a sentence: the wording is the interface's business,
    // so this assertion stays valid in every language.
    const { diagnostics } = parse('INT. A - DAY\n\n/* never closed');
    expect(diagnostics.some((d) => d.code === 'unterminatedBoneyard')).toBe(true);
  });

  it('reports a duplicate scene number with its parameters', () => {
    const { diagnostics } = parse('INT. A - DAY #1#\n\nA.\n\nINT. B - DAY #1#\n\nB.');
    const duplicate = diagnostics.find((d) => d.code === 'duplicateSceneNumber');
    expect(duplicate).toBeDefined();
    expect(duplicate?.params).toEqual({ number: '1', line: 1 });
  });
});

describe('parse — element grouping', () => {
  it('merges contiguous action lines into a single element', () => {
    const { elements } = parse('He walks in.\nHe looks around.\n\nHe leaves.');
    const actions = elements.filter((e) => e.kind === 'action');
    expect(actions).toHaveLength(2);
    expect(actions[0]?.text).toBe('He walks in.\nHe looks around.');
    expect(actions[0]?.lineCount).toBe(2);
  });

  it('merges the lines of a single speech', () => {
    const { elements } = parse('JULIE\nOne line.\nAnother.');
    const dialogues = elements.filter((e) => e.kind === 'dialogue');
    expect(dialogues).toHaveLength(1);
    expect(dialogues[0]?.text).toBe('One line.\nAnother.');
  });

  it('does not merge elements of different kinds', () => {
    const { elements } = parse('JULIE\n(quietly)\nCome here.');
    expect(elements.map((e) => e.kind)).toEqual(['character', 'parenthetical', 'dialogue']);
  });
});

describe('parse — invariants over the full corpus', () => {
  it('keeps every element offset within the document bounds', () => {
    const screenplay = parse(complet);
    for (const element of screenplay.elements) {
      expect(element.range.from).toBeGreaterThanOrEqual(0);
      expect(element.range.to).toBeLessThanOrEqual(complet.length);
      expect(element.range.from).toBeLessThanOrEqual(element.range.to);
    }
  });

  it('returns elements in non-decreasing order', () => {
    const { elements } = parse(complet);
    for (let i = 1; i < elements.length; i++) {
      expect(elements[i]!.range.from).toBeGreaterThanOrEqual(elements[i - 1]!.range.from);
    }
  });

  it('produces unique identifiers', () => {
    const { elements, scenes } = parse(complet);
    expect(new Set(elements.map((e) => e.id)).size).toBe(elements.length);
    expect(new Set(scenes.map((s) => s.id)).size).toBe(scenes.length);
  });

  it('produces a stable snapshot of the structure', () => {
    const { scenes } = parse(complet);
    expect(
      scenes.map((s) => ({
        n: s.number,
        heading: s.heading,
        location: s.location,
        timeOfDay: s.timeOfDay,
        section: s.sectionPath.join(' > '),
      })),
    ).toMatchInlineSnapshot(`
      [
        {
          "heading": "INT. CINÉMA LE ROYAL - HALL - JOUR",
          "location": "CINÉMA LE ROYAL - HALL",
          "n": "1",
          "section": "ACTE I > Séquence 1 — L’annonce",
          "timeOfDay": "JOUR",
        },
        {
          "heading": "INT. CINÉMA LE ROYAL - SALLE 2 - NUIT",
          "location": "CINÉMA LE ROYAL - SALLE 2",
          "n": "2",
          "section": "ACTE I > Séquence 1 — L’annonce",
          "timeOfDay": "NUIT",
        },
        {
          "heading": "EXT. RUE DU ROYAL - AUBE",
          "location": "RUE DU ROYAL",
          "n": "3",
          "section": "ACTE I > Séquence 1 — L’annonce",
          "timeOfDay": "AUBE",
        },
        {
          "heading": "PLUS TARD, DANS UN AUTRE MONDE",
          "location": "PLUS TARD, DANS UN AUTRE MONDE",
          "n": "4",
          "section": "ACTE II",
          "timeOfDay": null,
        },
        {
          "heading": "EXT. TOIT DU ROYAL - CRÉPUSCULE",
          "location": "TOIT DU ROYAL",
          "n": "5",
          "section": "ACTE II",
          "timeOfDay": "CRÉPUSCULE",
        },
        {
          "heading": "EXT. RUE DU ROYAL - JOUR",
          "location": "RUE DU ROYAL",
          "n": "6",
          "section": "ACTE II",
          "timeOfDay": "JOUR",
        },
      ]
    `);
  });
});
