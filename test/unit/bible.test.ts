/**
 * Unit tests for the script bible data model (Steps 2 and 4).
 *
 * Modeled on `test/unit/snapshots.test.ts`: describe blocks with sentence-like it names
 * that state a guarantee, and comments that explain why a case matters.
 */

import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { BibleEntry, BibleEntryKind } from '../../src/shared/bible/index.js';
import {
  BIBLE_ENTRY_KINDS,
  MAX_ENTRIES,
  MAX_FIELD_LENGTH,
  MAX_ALIASES,
  MAX_NAME_LENGTH,
  isBibleEntryKind,
  isBibleId,
  createBible,
  sanitizeBibleName,
  sanitizeBibleField,
  bibleFieldsFor,
  parseBible,
  serializeBible,
  reconcileBible,
} from '../../src/shared/bible/index.js';
import { buildBibleContext, factsForEntry, type FactsInput } from '../../src/shared/bible/facts.js';
import { parse } from '../../src/shared/fountain/index.js';
import {
  bibleImagesDirectory,
  deleteBibleImage,
  pruneBibleImages,
  readBibleImage,
  writeBibleImage,
} from '../../src/main/files/bible.js';

// ───────────────────────────────────────────────────────────────────────────
// Step 2 — data model tests
// ───────────────────────────────────────────────────────────────────────────

describe('bible entry kinds are a closed set', () => {
  it.each(BIBLE_ENTRY_KINDS)('recognizes %s as a valid kind', (kind) => {
    expect(isBibleEntryKind(kind)).toBe(true);
  });

  it.each(['characters', 'place', 'object ', 42, null, undefined])(
    'rejects %p as a valid kind',
    (value) => {
      expect(isBibleEntryKind(value)).toBe(false);
    },
  );
});

describe('bible identifiers are stable and strict', () => {
  it.each([
    'bib-abc123',
    'bib-a',
    'bib-A_B-9',
    'bib--test',
    'some-id-within-length-limit',
  ])('accepts %j as a valid ID', (value) => {
    expect(isBibleId(value)).toBe(true);
  });

  it.each([
    'bib with space',
    '',
    'a'.repeat(81), // over the 80-character limit
    'id$pecial', // $ not allowed
    'id/name', // / not allowed
  ])('rejects %j as a valid ID', (value) => {
    expect(isBibleId(value)).toBe(false);
  });
});

describe('createBible round-trips through serializeBible → parseBible', () => {
  it('is identity for an empty bible', () => {
    const original = createBible();
    const parsed = parseBible(serializeBible(original));
    expect(parsed).toEqual(original);
  });

  it('round-trips a bible with entries', () => {
    const entry: BibleEntry = {
      id: 'bib-abc123',
      kind: 'character',
      name: 'Alice',
      aliases: [],
      image: null,
      fields: { role: 'Protagonist', wants: 'Survival' },
      draftedAt: null,
      updatedAt: 1_770_000_000_000,
    };
    const bible = { version: 1, entries: [entry] };
    const parsed = parseBible(serializeBible(bible));
    expect(parsed).toEqual(bible);
  });
});

describe('sanitizeBibleName collapses whitespace and bounds the length', () => {
  it('collapses runs of spaces to one', () => {
    expect(sanitizeBibleName('  two   spaces    ')).toBe('two spaces');
  });

  it('trims leading and trailing whitespace', () => {
    expect(sanitizeBibleName('  trimmed   ')).toBe('trimmed');
  });

  it('bounds to MAX_NAME_LENGTH', () => {
    expect(sanitizeBibleName('x'.repeat(MAX_NAME_LENGTH + 10))).toHaveLength(
      MAX_NAME_LENGTH,
    );
  });

  it('preserves empty for an all-whitespace string', () => {
    expect(sanitizeBibleName('    ')).toBe('');
  });
});

describe('sanitizeBibleField bounds the length but keeps newlines', () => {
  it('keeps newlines for multi-line prose', () => {
    const input = 'Line one\nLine two\n';
    const result = sanitizeBibleField(input);
    expect(result).toBe(input);
  });

  it('bounds to MAX_FIELD_LENGTH', () => {
    const longText = 'x'.repeat(MAX_FIELD_LENGTH + 100);
    expect(sanitizeBibleField(longText)).toHaveLength(MAX_FIELD_LENGTH);
  });
});

describe('bibleFieldsFor returns the fixed set for each kind', () => {
  it('returns the character fields', () => {
    expect(bibleFieldsFor('character')).toEqual([
      'role', 'wants', 'fears', 'arc', 'voice', 'background',
    ]);
  });

  it('returns the location fields', () => {
    expect(bibleFieldsFor('location')).toEqual(['atmosphere', 'meaning', 'history']);
  });

  it('returns the object fields', () => {
    expect(bibleFieldsFor('object')).toEqual(['significance', 'history']);
  });

  it('returns the concept fields', () => {
    expect(bibleFieldsFor('concept')).toEqual(['definition', 'rules']);
  });
});

describe('parseBible is tolerant of corruption', () => {
  it('returns an empty bible rather than throwing on garbage', () => {
    for (const raw of ['', 'not json', '{', '{{', null, undefined]) {
      expect(() =>
        parseBible(typeof raw === 'string' ? raw : String(raw)),
      ).not.toThrow();
      expect(
        parseBible(typeof raw === 'string' ? raw : String(raw)).entries,
      ).toEqual([]);
    }
  });

  it('rejects an unknown version', () => {
    const parsed = parseBible(JSON.stringify({ version: 99, entries: [] }));
    expect(parsed.entries).toEqual([]);
  });

  it('drops malformed entries while keeping sound ones in the same file', () => {
    const parsed = parseBible(
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: 'bib-1',
            kind: 'character',
            name: 'Alice',
            aliases: [],
            image: null,
            fields: {},
            draftedAt: null,
            updatedAt: 1,
          },
          { id: '', kind: 'character', name: 'Bob', fields: {}, draftedAt: null, updatedAt: 1 },
          {
            id: 'bib-3',
            kind: 'unknown',
            name: 'Charlie',
            aliases: [],
            image: null,
            fields: {},
            draftedAt: null,
            updatedAt: 1,
          },
          {
            id: 'bib-4',
            kind: 'character',
            name: '',
            aliases: [],
            image: null,
            fields: {},
            draftedAt: null,
            updatedAt: 1,
          },
          {
            id: 'bib-5',
            kind: 'object',
            name: 'The Key',
            aliases: [],
            image: null,
            fields: { significance: 'Important' },
          },
        ],
      }),
    );
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries.map((e) => e.id)).toEqual(['bib-1', 'bib-5']);
  });

  it('drops a duplicated ID, keeping the first occurrence', () => {
    const parsed = parseBible(
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: 'bib-same',
            kind: 'character',
            name: 'First',
            aliases: [],
            image: null,
            fields: {},
            draftedAt: null,
            updatedAt: 1,
          },
          {
            id: 'bib-same',
            kind: 'character',
            name: 'Second',
            aliases: [],
            image: null,
            fields: {},
            draftedAt: null,
            updatedAt: 2,
          },
        ],
      }),
    );
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.name).toBe('First');
  });

  it('bounds the list to MAX_ENTRIES', () => {
    const entries: Array<Record<string, unknown>> = [];
    for (let index = 0; index < MAX_ENTRIES + 10; index++) {
      entries.push({
        id: `bib-entry-${index}`,
        kind: 'character' as BibleEntryKind,
        name: `Character ${index}`,
        aliases: [],
        image: null,
        fields: {},
        draftedAt: null,
        updatedAt: index,
      });
    }
    const parsed = parseBible(JSON.stringify({ version: 1, entries }));
    expect(parsed.entries).toHaveLength(MAX_ENTRIES);
  });

  it('drops unknown field keys — an unknown key is dropped, not kept', () => {
    const parsed = parseBible(
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: 'bib-abc',
            kind: 'character',
            name: 'Alice',
            aliases: [],
            image: null,
            fields: { role: 'Protagonist', invented: 'y' },
            draftedAt: null,
            updatedAt: 1,
          },
        ],
      }),
    );
    expect(parsed.entries[0]?.fields).toHaveProperty('role', 'Protagonist');
    expect(parsed.entries[0]?.fields).not.toHaveProperty('invented');
  });

  it('sanitises names and fields during parse', () => {
    const parsed = parseBible(
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: 'bib-san',
            kind: 'character',
            name: '  spaced   name   ',
            aliases: [],
            image: null,
            fields: {
              role: '  a role field value that is quite long '
                .slice(0, MAX_FIELD_LENGTH),
            },
            draftedAt: null,
            updatedAt: 1_770_000_000_000,
          },
        ],
      }),
    );
    expect(parsed.entries[0]?.name).toBe('spaced name');
  });

  it('rejects a missing or non-finite draftedAt/updatedAt', () => {
    const parsed = parseBible(
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: 'bib-timestamps',
            kind: 'character',
            name: 'Alice',
            aliases: [],
            image: null,
            fields: {},
            draftedAt: NaN,
            updatedAt: Infinity,
          },
        ],
      }),
    );
    expect(parsed.entries[0]?.draftedAt).toBeNull();
    expect(parsed.entries[0]?.updatedAt).toBe(0);
  });
});

describe('serializeBible produces stable, human-readable JSON', () => {
  it('produces valid JSON with indentation and trailing newline', () => {
    const bible = createBible();
    const serialized = serializeBible(bible);
    expect(serialized.endsWith('\n')).toBe(true);
    const reparsed = JSON.parse(serialized);
    expect(reparsed).toEqual(bible);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Step 4 — factsForEntry tests
// ───────────────────────────────────────────────────────────────────────────

describe('factsForEntry returns empty for object and concept kinds', () => {
  const input: FactsInput = {
    characters: [],
    locations: [],
    scenes: [],
    elements: [],
  };

  it('object yields []', () => {
    expect(factsForEntry({ kind: 'object', name: 'Key' }, input)).toEqual([]);
  });

  it('concept yields []', () => {
    expect(
      factsForEntry({ kind: 'concept', name: 'Time Travel' }, input),
    ).toEqual([]);
  });
});

describe('factsForEntry returns empty for an unknown character', () => {
  const input: FactsInput = {
    characters: [],
    locations: [{ name: 'LABO', count: 2 }],
    scenes: [],
    elements: [],
  };

  it('a non-existent character yields []', () => {
    expect(factsForEntry({ kind: 'character', name: 'GHOST' }, input)).toEqual(
      [],
    );
  });
});

describe('factsForEntry computes character facts', () => {
  const input: FactsInput = {
    characters: [{ name: 'ALICE', speeches: 5, words: 120 }],
    locations: [],
    scenes: [
      { number: '1', heading: 'INT. LABO - NUIT', location: 'LABO', elementIndexes: [] },
      { number: '2', heading: 'EXT. RUE - JOUR', location: 'RUE', elementIndexes: [0, 1] },
      { number: '3', heading: 'INT. LABO - NUIT', location: 'LABO', elementIndexes: [2] },
    ],
    elements: [
      { kind: 'character', text: 'ALICE', speaker: undefined },
      { kind: 'dialogue', text: 'Hello.', speaker: 'ALICE' },
      { kind: 'dialogue', text: 'Goodbye.', speaker: 'ALICE' },
    ],
  };

  it('reports scenes, speeches and words', () => {
    const facts = factsForEntry({ kind: 'character', name: 'ALICE' }, input);
    const scenesFact = facts.find((f) => f.key === 'scenes');
    const speechesFact = facts.find((f) => f.key === 'speeches');
    const wordsFact = facts.find((f) => f.key === 'words');
    expect(scenesFact?.count).toBe(2);
    expect(speechesFact?.count).toBe(5);
    expect(wordsFact?.count).toBe(120);
  });

  it('includes firstScene and lastScene values', () => {
    const facts = factsForEntry({ kind: 'character', name: 'ALICE' }, input);
    const firstScene = facts.find((f) => f.key === 'firstScene');
    const lastScene = facts.find((f) => f.key === 'lastScene');
    expect(firstScene?.value).toBe('2');
    expect(lastScene?.value).toBe('3');
  });

  it('first and last are the same when there is only one scene', () => {
    const singleScene: FactsInput = {
      ...input,
      scenes: [{ number: '42', heading: 'INT. ROOM', location: 'ROOM', elementIndexes: [0, 1] }],
    };
    const facts = factsForEntry(
      { kind: 'character', name: 'ALICE' },
      singleScene,
    );
    const firstScene = facts.find((f) => f.key === 'firstScene');
    const lastScene = facts.find((f) => f.key === 'lastScene');
    expect(firstScene?.value).toBe('42');
    expect(lastScene).toBeUndefined();
  });
});

describe('factsForEntry handles characters with zero words gracefully', () => {
  const input: FactsInput = {
    characters: [{ name: 'SILENT', speeches: 0, words: 0 }],
    locations: [],
    scenes: [{ number: '1', heading: 'INT. ROOM', location: 'ROOM', elementIndexes: [0] }],
    elements: [{ kind: 'character', text: 'SILENT', speaker: undefined }],
  };

  it('reports zero speeches and skips words when words is zero', () => {
    const facts = factsForEntry({ kind: 'character', name: 'SILENT' }, input);
    const speechesFact = facts.find((f) => f.key === 'speeches');
    const wordsFact = facts.find((f) => f.key === 'words');
    expect(speechesFact?.count).toBe(0);
    expect(wordsFact).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Step 7 — reconciliation tests
// ───────────────────────────────────────────────────────────────────────────

describe('reconcileBible matches sheets against the screenplay by name', () => {
  const screenplay = {
    characters: ['ALICE', 'BOB'],
    locations: ['LABO', 'RUE'],
  };

  it('attaches a sheet whose name matches (case-insensitive)', () => {
    const entries: BibleEntry[] = [
      {
        id: 'bib-1',
        kind: 'character',
        name: 'alice',
        aliases: [],
        image: null,
        fields: {},
        draftedAt: null,
        updatedAt: 1,
      },
    ];
    const result = reconcileBible(entries, screenplay);
    expect(result.attached.map((e) => e.name)).toContain('alice');
    expect(result.orphaned).toEqual([]);
  });

  it('orphaned entries still carry their prose', () => {
    const entries: BibleEntry[] = [
      {
        id: 'bib-deleted',
        kind: 'character',
        name: 'DEAD-CHAR',
        aliases: [],
        image: null,
        fields: { role: 'Was important', background: 'Once lived here' },
        draftedAt: null,
        updatedAt: 1,
      },
    ];
    const result = reconcileBible(entries, screenplay);
    expect(result.orphaned).toHaveLength(1);
    expect(result.orphaned[0]?.fields).toEqual({
      role: 'Was important',
      background: 'Once lived here',
    });
  });

  it('a screenplay name with no sheet appears in unseeded', () => {
    const entries: BibleEntry[] = [];
    const result = reconcileBible(entries, screenplay);
    expect(result.unseeded.map((u) => u.name)).toContain('ALICE');
    expect(result.unseeded.map((u) => u.name)).toContain('BOB');
  });

  it('an object sheet is always attached even though no AST name matches', () => {
    const entries: BibleEntry[] = [
      {
        id: 'bib-obj',
        kind: 'object' as BibleEntryKind,
        name: 'The Key',
        aliases: [],
        image: null,
        fields: {},
        draftedAt: null,
        updatedAt: 1,
      },
    ];
    const result = reconcileBible(entries, screenplay);
    expect(result.attached.map((e) => e.id)).toContain('bib-obj');
    expect(result.orphaned).toEqual([]);
  });

  it('reconcileBible matches case-insensitively', () => {
    const entries: BibleEntry[] = [
      {
        id: 'bib-1',
        kind: 'character',
        name: 'alice',
        aliases: [],
        image: null,
        fields: {},
        draftedAt: null,
        updatedAt: 1,
      },
      {
        id: 'bib-2',
        kind: 'character',
        name: 'Alice',
        aliases: [],
        image: null,
        fields: {},
        draftedAt: null,
        updatedAt: 1,
      },
    ];
    const result = reconcileBible(entries, screenplay);
    expect(result.attached).toHaveLength(2);
  });

  it('an accent-different name is considered orphaned', () => {
    const entriesWithAccent: BibleEntry[] = [
      {
        id: 'bib-accent',
        kind: 'character',
        name: 'REN\u00c9',
        aliases: [],
        image: null,
        fields: {},
        draftedAt: null,
        updatedAt: 1,
      },
    ];
    // screenplay has no "REN\u00c9" or "RENE": the accent-sensitive comparison
    // considers them different.
    const result = reconcileBible(entriesWithAccent, {
      characters: ['RENE'],
      locations: [],
    });
    expect(result.orphaned).toHaveLength(1);
  });

  it('a vanished name is listed as orphaned and not re-seeded', () => {
    const entries: BibleEntry[] = [
      {
        id: 'bib-vanish',
        kind: 'character',
        name: 'GHOST',
        aliases: [],
        image: null,
        fields: {},
        draftedAt: null,
        updatedAt: 1,
      },
    ];
    const result = reconcileBible(entries, screenplay);
    expect(result.orphaned.map((e) => e.name)).toContain('GHOST');
    expect(result.unseeded.map((u) => u.name)).not.toContain('GHOST');
  });
});
describe('reconciliation keeps kinds apart and hands names back as written', () => {
  const sheet = (
    kind: 'character' | 'location' | 'object',
    name: string,
    aliases: string[] = [],
  ) => ({
    id: `bib-${kind}-${name}`,
    kind,
    name,
    aliases,
    image: null,
    fields: {},
    draftedAt: null,
    updatedAt: 0,
  });

  it('does not let a location vouch for a character of the same name', () => {
    // A screenplay can hold a character called VOLTAIRE and a café called VOLTAIRE. Matching
    // on the name alone attached the character sheet to the location and it read as sound.
    const result = reconcileBible([sheet('character', 'VOLTAIRE')], {
      characters: [],
      locations: ['VOLTAIRE'],
    });
    expect(result.attached).toEqual([]);
    expect(result.orphaned.map((entry) => entry.name)).toEqual(['VOLTAIRE']);
  });

  it('offers an unseeded name in the spelling the screenplay uses', () => {
    const result = reconcileBible([], { characters: [], locations: ['Rue du Bac'] });
    expect(result.unseeded).toEqual([{ kind: 'location', name: 'Rue du Bac' }]);
  });

  it('does not offer a name that already has a sheet of that kind', () => {
    const result = reconcileBible([sheet('character', 'alice')], {
      characters: ['ALICE'],
      locations: ['ALICE'],
    });
    expect(result.attached).toHaveLength(1);
    // The location of the same name still has no sheet, so it is still on offer.
    expect(result.unseeded).toEqual([{ kind: 'location', name: 'ALICE' }]);
  });

  it('never orphans an object or a notion, which have no counterpart to match', () => {
    const result = reconcileBible([sheet('object', 'La clé de laiton')], {
      characters: [],
      locations: [],
    });
    expect(result.orphaned).toEqual([]);
    expect(result.attached).toHaveLength(1);
  });
});

describe('a sheet name that is not a string is dropped, not coerced', () => {
  it('refuses an object where a name should be', () => {
    // String({}) is "[object Object]", which passes an emptiness check and lands a nonsense
    // sheet in the rail.
    const parsed = parseBible(
      JSON.stringify({
        version: 1,
        entries: [
          { id: 'bib-1', kind: 'character', name: {}, fields: {} },
          { id: 'bib-2', kind: 'character', name: 42, fields: {} },
          { id: 'bib-3', kind: 'character', name: 'ALICE', fields: {} },
        ],
      }),
    );
    expect(parsed.entries.map((entry) => entry.name)).toEqual(['ALICE']);
  });
});

describe('the passages handed to a model for one sheet', () => {
  const screenplay = parse(`INT. LABO - NUIT

Alice referme la porte derrière elle.

ALICE
Les serveurs tiennent.

BOB
Pour l’instant.

EXT. RUE - JOUR

Il pleut sur le trottoir.

ALICE
On y va.
`);

  const scenes = screenplay.scenes.map((scene) => ({
    number: scene.number,
    heading: scene.heading,
    location: scene.location,
    elements: scene.elements,
  }));

  it('gives a character their speeches and the action around them, scene by scene', () => {
    const context = buildBibleContext({ kind: 'character', name: 'ALICE' }, scenes);
    // A character is defined as much by what they do as by what they say, so the action of
    // their scenes travels with their lines.
    expect(context).toContain('[1 · INT. LABO - NUIT]');
    expect(context).toContain('Alice referme la porte derrière elle.');
    expect(context).toContain('ALICE : Les serveurs tiennent.');
    expect(context).toContain('[2 · EXT. RUE - JOUR]');
    expect(context).toContain('ALICE : On y va.');
    // Another character's lines are not this sheet.
    expect(context).not.toContain('Pour l’instant.');
  });

  it('skips the scenes a character never speaks in', () => {
    const context = buildBibleContext({ kind: 'character', name: 'BOB' }, scenes);
    expect(context).toContain('[1 · INT. LABO - NUIT]');
    expect(context).not.toContain('[2 · EXT. RUE - JOUR]');
  });

  it('gives a location the action of its own scenes', () => {
    const context = buildBibleContext({ kind: 'location', name: 'LABO' }, scenes);
    expect(context).toContain('Alice referme la porte');
    expect(context).not.toContain('Il pleut');
  });

  it('finds an object wherever the screenplay mentions it', () => {
    const context = buildBibleContext({ kind: 'object', name: 'trottoir' }, scenes);
    expect(context).toContain('Il pleut sur le trottoir.');
    expect(context).not.toContain('serveurs');
  });

  it('is empty for a name the screenplay never uses', () => {
    expect(buildBibleContext({ kind: 'character', name: 'CHLOÉ' }, scenes)).toBe('');
  });

  it('truncates on a passage boundary, never mid-word', () => {
    // Half a speech would have the model drafting from something the screenplay does not say.
    const context = buildBibleContext({ kind: 'character', name: 'ALICE' }, scenes, 120);
    expect(context).toContain('[1 · INT. LABO - NUIT]');
    expect(context).not.toContain('[2 · EXT. RUE - JOUR]');
    // Whatever survived is whole: the last passage ends where its own text ends.
    expect(context.endsWith('tiennent.')).toBe(true);
  });

  it('keeps the first passage even when it alone exceeds the budget', () => {
    // An empty context is the worst outcome: a model handed nothing does not decline, it
    // invents — which is exactly what a bible must never contain.
    const context = buildBibleContext({ kind: 'character', name: 'ALICE' }, scenes, 10);
    expect(context).not.toBe('');
    expect(context).toContain('[1 · INT. LABO - NUIT]');
    expect(context).not.toContain('[2 · EXT. RUE - JOUR]');
  });
});

describe('location facts', () => {
  const input: FactsInput = {
    characters: [],
    locations: [{ name: 'LABO', count: 2 }],
    scenes: [
      { number: '1', heading: 'INT. LABO - NUIT', location: 'LABO', elementIndexes: [] },
      { number: '2', heading: 'EXT. RUE - JOUR', location: 'RUE', elementIndexes: [] },
      { number: '3', heading: 'INT. LABO - AUBE', location: 'LABO', elementIndexes: [] },
    ],
    elements: [],
  };

  it('counts the scenes that use a place, and where it first and last appears', () => {
    const facts = factsForEntry({ kind: 'location', name: 'LABO' }, input);
    expect(facts).toEqual([
      { key: 'scenes', count: 2 },
      { key: 'firstScene', value: '1' },
      { key: 'lastScene', value: '3' },
    ]);
  });

  it('says nothing about a place the screenplay does not contain', () => {
    // Not "0 scenes": an orphaned sheet showing a measurement reads like a real measurement.
    expect(factsForEntry({ kind: 'location', name: 'TOIT' }, input)).toEqual([]);
  });
});

describe('a sheet covers several names', () => {
  const sheet = (
    kind: 'character' | 'location',
    name: string,
    aliases: string[],
  ): BibleEntry => ({
    id: `bib-${name}`,
    kind,
    name,
    aliases,
    image: null,
    fields: {},
    draftedAt: null,
    updatedAt: 0,
  });

  it('validates, bounds and de-duplicates aliases on the folded form', () => {
    const parsed = parseBible(
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: 'bib-1',
            kind: 'location',
            name: 'MÉGALOPOLE',
            aliases: [
              'MÉGALOPOLE - REMPARTS',
              // The same name twice, once unaccented: one alias, not two.
              'MEGALOPOLE - REMPARTS',
              // The sheet's own name: it cannot be its own alias, or it would count itself twice.
              'megalopole',
              '   ',
              42,
              { name: 'nope' },
            ],
            fields: {},
          },
        ],
      }),
    );
    expect(parsed.entries[0]?.aliases).toEqual(['MÉGALOPOLE - REMPARTS']);
  });

  it('bounds the alias list', () => {
    const parsed = parseBible(
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: 'bib-1',
            kind: 'location',
            name: 'LIEU',
            aliases: Array.from({ length: MAX_ALIASES + 20 }, (_, index) => `ALIAS ${index}`),
            fields: {},
          },
        ],
      }),
    );
    expect(parsed.entries[0]?.aliases.length).toBeLessThanOrEqual(MAX_ALIASES);
  });

  it('is attached when an alias matches, even if its own name no longer does', () => {
    // A character introduced as LA FILLE and later named: the sheet is one person.
    const result = reconcileBible([sheet('character', 'ALIX', ['LA FILLE'])], {
      characters: ['LA FILLE'],
      locations: [],
    });
    expect(result.attached).toHaveLength(1);
    expect(result.orphaned).toEqual([]);
  });

  it('stops offering a name that a sheet already covers', () => {
    // Otherwise the composer keeps proposing the sub-locations that were just grouped.
    const result = reconcileBible(
      [sheet('location', 'MÉGALOPOLE', ['MÉGALOPOLE - REMPARTS'])],
      { characters: [], locations: ['MÉGALOPOLE', 'MÉGALOPOLE - REMPARTS', 'MÉGALOPOLE - RUES'] },
    );
    expect(result.unseeded).toEqual([{ kind: 'location', name: 'MÉGALOPOLE - RUES' }]);
  });

  it('sums a place’s scenes across the names it covers', () => {
    const input: FactsInput = {
      characters: [],
      locations: [],
      scenes: [
        { number: '1', heading: 'EXT. MÉGALOPOLE - JOUR', location: 'MÉGALOPOLE', elementIndexes: [] },
        {
          number: '2',
          heading: 'EXT. MÉGALOPOLE - REMPARTS - NUIT',
          location: 'MÉGALOPOLE - REMPARTS',
          elementIndexes: [],
        },
        { number: '3', heading: 'INT. TOIT - AUBE', location: 'TOIT', elementIndexes: [] },
        {
          number: '4',
          heading: 'EXT. MÉGALOPOLE - RUES - JOUR',
          location: 'MÉGALOPOLE - RUES',
          elementIndexes: [],
        },
      ],
      elements: [],
    };
    expect(
      factsForEntry(
        { kind: 'location', name: 'MÉGALOPOLE', aliases: ['MÉGALOPOLE - REMPARTS', 'MÉGALOPOLE - RUES'] },
        input,
      ),
    ).toEqual([
      { key: 'scenes', count: 3 },
      { key: 'firstScene', value: '1' },
      { key: 'lastScene', value: '4' },
    ]);
  });

  it('sums a character’s speeches and words across the names they are called', () => {
    const input: FactsInput = {
      characters: [
        { name: 'ALIX', speeches: 4, words: 90 },
        { name: 'LA FILLE', speeches: 2, words: 30 },
      ],
      locations: [],
      scenes: [
        { number: '1', heading: 'INT. LABO - NUIT', location: 'LABO', elementIndexes: [0] },
        { number: '2', heading: 'EXT. RUE - JOUR', location: 'RUE', elementIndexes: [1] },
      ],
      elements: [
        { kind: 'dialogue', text: 'Tôt.', speaker: 'LA FILLE' },
        { kind: 'dialogue', text: 'Tard.', speaker: 'ALIX' },
      ],
    };
    expect(factsForEntry({ kind: 'character', name: 'ALIX', aliases: ['LA FILLE'] }, input)).toEqual([
      { key: 'scenes', count: 2 },
      { key: 'speeches', count: 6 },
      { key: 'words', count: 120 },
      { key: 'firstScene', value: '1' },
      { key: 'lastScene', value: '2' },
    ]);
  });

  it('does not claim a place whose name merely contains its own', () => {
    // Regression: the location facts matched `heading.includes(name)`, so a sheet called RUE
    // silently counted RUE PRINCIPALE and GRANDE RUE as its own scenes.
    const input: FactsInput = {
      characters: [],
      locations: [],
      scenes: [
        { number: '1', heading: 'EXT. RUE - JOUR', location: 'RUE', elementIndexes: [] },
        {
          number: '2',
          heading: 'EXT. RUE PRINCIPALE - JOUR',
          location: 'RUE PRINCIPALE',
          elementIndexes: [],
        },
        { number: '3', heading: 'EXT. GRANDE RUE - NUIT', location: 'GRANDE RUE', elementIndexes: [] },
      ],
      elements: [],
    };
    expect(factsForEntry({ kind: 'location', name: 'RUE' }, input)).toEqual([
      { key: 'scenes', count: 1 },
      { key: 'firstScene', value: '1' },
    ]);
  });

  it('gathers the context of every name a sheet covers', () => {
    const screenplay = parse(`EXT. MÉGALOPOLE - JOUR

La foule avance.

EXT. MÉGALOPOLE - REMPARTS - NUIT

Le vent siffle sur la pierre.

INT. TOIT - AUBE

Rien ne bouge.
`);
    const scenes = screenplay.scenes.map((scene) => ({
      number: scene.number,
      heading: scene.heading,
      location: scene.location,
      elements: scene.elements,
    }));
    const context = buildBibleContext(
      { kind: 'location', name: 'MÉGALOPOLE', aliases: ['MÉGALOPOLE - REMPARTS'] },
      scenes,
    );
    expect(context).toContain('La foule avance.');
    expect(context).toContain('Le vent siffle sur la pierre.');
    expect(context).not.toContain('Rien ne bouge.');
  });
});

describe('sheet pictures on disk', () => {
  let directory: string;
  let screenplay: string;

  /** The smallest valid WebP: a 1×1 lossy frame. */
  const WEBP =
    'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'quantum-bible-image-'));
    screenplay = join(directory, 'story.fountain');
    await writeFile(screenplay, 'INT. LABO - NUIT\n', 'utf8');
  });

  it('writes the picture under a name derived from the sheet id', async () => {
    const name = await writeBibleImage(screenplay, 'bib-abc123', WEBP);
    expect(name).toBe('bib-abc123.webp');
    // No separator, no traversal: the name never comes from anything the author typed.
    expect(name).not.toContain('/');
    expect(name).not.toContain('..');
    expect(await readdir(bibleImagesDirectory(screenplay))).toEqual(['bib-abc123.webp']);
    expect(await readBibleImage(screenplay, 'bib-abc123')).toBe(WEBP);
  });

  it('refuses anything that is not the WebP the renderer produces', async () => {
    // An SVG is a script, and the renderer displays these as `img src`.
    await expect(
      writeBibleImage(screenplay, 'bib-1', 'data:image/svg+xml;base64,PHN2Zy8+'),
    ).rejects.toThrow();
    await expect(
      writeBibleImage(screenplay, 'bib-1', 'data:text/html;base64,PHNjcmlwdC8+'),
    ).rejects.toThrow();
    await expect(writeBibleImage(screenplay, 'bib-1', 'not a data uri')).rejects.toThrow();
    // And an empty payload, which would leave a zero-byte file the interface cannot show.
    await expect(writeBibleImage(screenplay, 'bib-1', 'data:image/webp;base64,')).rejects.toThrow();
  });

  it('refuses a payload beyond the size a 512-pixel portrait could reach', async () => {
    const huge = `data:image/webp;base64,${'A'.repeat(4_000_000)}`;
    await expect(writeBibleImage(screenplay, 'bib-1', huge)).rejects.toThrow();
  });

  it('reports a missing picture as absent rather than failing', async () => {
    expect(await readBibleImage(screenplay, 'bib-never')).toBeNull();
    // Deleting one that was never there is not an error either.
    await expect(deleteBibleImage(screenplay, 'bib-never')).resolves.toBeUndefined();
  });

  it('removes a picture on request', async () => {
    await writeBibleImage(screenplay, 'bib-1', WEBP);
    await deleteBibleImage(screenplay, 'bib-1');
    expect(await readBibleImage(screenplay, 'bib-1')).toBeNull();
  });

  it('prunes pictures whose sheet is gone', async () => {
    await writeBibleImage(screenplay, 'bib-keep', WEBP);
    await writeBibleImage(screenplay, 'bib-drop', WEBP);
    await pruneBibleImages(screenplay, ['bib-keep']);
    expect(await readdir(bibleImagesDirectory(screenplay))).toEqual(['bib-keep.webp']);
  });

  it('keeps a stored picture name only when it matches the sheet id', () => {
    // A corrupt sidecar must not be able to point a sheet at another file.
    const parsed = parseBible(
      JSON.stringify({
        version: 1,
        entries: [
          { id: 'bib-1', kind: 'character', name: 'A', image: 'bib-1.webp', fields: {} },
          { id: 'bib-2', kind: 'character', name: 'B', image: '../../secret.webp', fields: {} },
          { id: 'bib-3', kind: 'character', name: 'C', image: 'bib-9.webp', fields: {} },
        ],
      }),
    );
    expect(parsed.entries.map((entry) => entry.image)).toEqual(['bib-1.webp', null, null]);
  });
});
