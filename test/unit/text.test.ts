import { describe, expect, it } from 'vitest';
import { foldDiacritics, foldedEquals, foldedIncludes } from '../../src/shared/text/index.js';

/**
 * Folding is for searching, never for identity. These tests pin both halves of that: what a
 * search must find, and the fact that folding is a lossy comparison the caller opts into.
 */
describe('diacritic folding', () => {
  it('strips accents and raises the case', () => {
    expect(foldDiacritics('Mégalopole')).toBe('MEGALOPOLE');
    expect(foldDiacritics('élève')).toBe('ELEVE');
    expect(foldDiacritics('crêpe brûlée')).toBe('CREPE BRULEE');
    expect(foldDiacritics('')).toBe('');
  });

  it('handles marks a hand-written accent range would miss', () => {
    // Why the Unicode property class rather than a Latin-1 range: these marks are outside it.
    expect(foldDiacritics('Đà Nẵng')).toBe('ĐA NANG');
    expect(foldDiacritics('Ankara Üniversitesi')).toBe('ANKARA UNIVERSITESI');
  });

  it('leaves struck-through letters alone, which is a limit worth knowing', () => {
    // Ł and Đ carry a stroke, not a combining mark, so NFD does not separate anything and
    // they survive folding. A Polish or Vietnamese name therefore still needs its stroke
    // typed. Handling it would mean a transliteration table, which is a different feature
    // from ignoring accents.
    expect(foldDiacritics('Łódź')).toBe('ŁODZ');
    expect(foldedIncludes('Łódź', 'lodz')).toBe(false);
    expect(foldedIncludes('Łódź', 'Łodz')).toBe(true);
  });

  it('is idempotent, so folding a folded string is safe', () => {
    const once = foldDiacritics('Mégalopole - Remparts');
    expect(foldDiacritics(once)).toBe(once);
  });

  it('finds what a reader means by an unaccented query', () => {
    expect(foldedIncludes('MÉGALOPOLE - REMPARTS', 'megalopole')).toBe(true);
    expect(foldedIncludes('INT. ÉGLISE - NUIT', 'eglise')).toBe(true);
    // And the other direction: an accented query against unaccented text.
    expect(foldedIncludes('MEGALOPOLE', 'mégalopole')).toBe(true);
    expect(foldedIncludes('MÉGALOPOLE', 'toit')).toBe(false);
  });

  it('treats an empty query as matching everything, which is what a cleared field means', () => {
    expect(foldedIncludes('anything', '')).toBe(true);
    expect(foldedIncludes('', '')).toBe(true);
    expect(foldedIncludes('', 'x')).toBe(false);
  });

  it('compares whole names for equality, not containment', () => {
    expect(foldedEquals('megalopole', 'MÉGALOPOLE')).toBe(true);
    expect(foldedEquals('Rue', 'RUE')).toBe(true);
    // Containment is not equality: this is what keeps "RUE" from adopting "RUE PRINCIPALE".
    expect(foldedEquals('RUE', 'RUE PRINCIPALE')).toBe(false);
  });
});
