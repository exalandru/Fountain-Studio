/**
 * Text comparison that ignores what a reader ignores when they search.
 *
 * Pure TypeScript (PLAN.md §3.1). Someone hunting for "megalopole" means MÉGALOPOLE, and
 * someone typing "eleve" means ÉLÈVE: a search that fails on an accent is a search that
 * fails, and on a French screenplay it fails constantly.
 *
 * Folding is for *searching*, never for *identity*. Deciding whether two names denote the
 * same character is a different question — RENE and RENÉ may well be two people — so
 * anything comparing names for identity keeps its accents and asks the author instead.
 */

/**
 * Uppercase, accents removed.
 *
 * NFD splits a letter from its diacritics, which are then dropped as a Unicode property
 * class rather than a hand-written range: `\p{Diacritic}` covers the Vietnamese, Polish and
 * Turkish marks a hard-coded range would miss.
 */
export function foldDiacritics(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toUpperCase();
}

/** Whether `needle` occurs in `haystack`, ignoring case and diacritics. */
export function foldedIncludes(haystack: string, needle: string): boolean {
  if (needle.length === 0) return true;
  return foldDiacritics(haystack).includes(foldDiacritics(needle));
}

/** Whether the two strings are the same name, ignoring case and diacritics. */
export function foldedEquals(a: string, b: string): boolean {
  return foldDiacritics(a) === foldDiacritics(b);
}
