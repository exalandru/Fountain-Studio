import { describe, expect, it } from 'vitest';
import { suggestLocationGroups } from '../../src/shared/bible/grouping.js';

/**
 * These are suggestions the author accepts or refuses, so the bar is not "finds everything"
 * but "never proposes something absurd". A wrong group costs a click to refuse; a group that
 * silently merges two real places would corrupt the sheet the author writes from.
 */
describe('grouping locations', () => {
  it('groups sub-locations under the place they name', () => {
    expect(
      suggestLocationGroups([
        'MÉGALOPOLE',
        'MÉGALOPOLE - REMPARTS',
        'MÉGALOPOLE - RUES',
        'TOIT',
      ]),
    ).toEqual([
      { parent: 'MÉGALOPOLE', children: ['MÉGALOPOLE - REMPARTS', 'MÉGALOPOLE - RUES'] },
    ]);
  });

  it('proposes a parent the screenplay never uses on its own', () => {
    // The city may only ever appear through its districts. Two of them is a hierarchy.
    expect(suggestLocationGroups(['CITADELLE - HAUT', 'CITADELLE - BAS'])).toEqual([
      { parent: 'CITADELLE', children: ['CITADELLE - BAS', 'CITADELLE - HAUT'] },
    ]);
  });

  it('leaves a lone dashed name alone', () => {
    // One sub-location and no parent is a name with a dash in it, not a hierarchy.
    expect(suggestLocationGroups(['MAISON - CUISINE', 'TOIT'])).toEqual([]);
  });

  it('groups a sub-location written as prose', () => {
    expect(
      suggestLocationGroups(['MÉGALOPOLE', 'REMPARTS DE LA MÉGALOPOLE', 'RUES DE LA MÉGALOPOLE']),
    ).toEqual([
      {
        parent: 'MÉGALOPOLE',
        children: ['REMPARTS DE LA MÉGALOPOLE', 'RUES DE LA MÉGALOPOLE'],
      },
    ]);
  });

  it('matches whole words only, so a place is not swallowed by a longer word', () => {
    // RUELLE contains the letters of RUE. It is a different place.
    expect(suggestLocationGroups(['RUE', 'RUELLE', 'GRANDE RUELLE'])).toEqual([
      { parent: 'RUELLE', children: ['GRANDE RUELLE'] },
    ]);
  });

  it('ignores accents when deciding what belongs to what', () => {
    const groups = suggestLocationGroups(['MEGALOPOLE', 'MÉGALOPOLE - REMPARTS']);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.children).toEqual(['MÉGALOPOLE - REMPARTS']);
  });

  it('claims a location once, and prefers the author’s own hierarchy', () => {
    // TOUR DE MÉGALOPOLE could sit under either, but the dashed reading wins and nothing is
    // proposed twice.
    const groups = suggestLocationGroups([
      'MÉGALOPOLE',
      'TOUR',
      'MÉGALOPOLE - TOUR',
    ]);
    const children = groups.flatMap((group) => group.children);
    expect(new Set(children).size).toBe(children.length);
    expect(groups).toEqual([{ parent: 'MÉGALOPOLE', children: ['MÉGALOPOLE - TOUR'] }]);
  });

  it('proposes nothing for unrelated places', () => {
    expect(suggestLocationGroups(['LABO', 'TOIT', 'PLAGE', 'HÔPITAL'])).toEqual([]);
  });

  it('is deterministic and de-duplicates its input', () => {
    const names = ['MÉGALOPOLE - RUES', 'MÉGALOPOLE', 'MEGALOPOLE', 'MÉGALOPOLE - REMPARTS'];
    const first = suggestLocationGroups(names);
    expect(suggestLocationGroups([...names].reverse())).toEqual(
      // Reversing the input reverses which spelling is met first, so compare the shape.
      first.map((group) => ({ parent: expect.any(String), children: group.children })),
    );
    expect(first[0]?.children).toEqual(['MÉGALOPOLE - REMPARTS', 'MÉGALOPOLE - RUES']);
  });

  it('survives an empty or blank list', () => {
    expect(suggestLocationGroups([])).toEqual([]);
    expect(suggestLocationGroups(['', '   '])).toEqual([]);
    expect(suggestLocationGroups(['- ORPHELIN'])).toEqual([]);
  });
});
