/**
 * Text primitives shared across features: comparison that ignores accents, and the shape of
 * an edit to the document.
 *
 * Pure TypeScript (PLAN.md §3.1).
 *
 * On folding: someone hunting for "megalopole" means MÉGALOPOLE, and someone typing "eleve"
 * means ÉLÈVE — a search that fails on an accent is a search that fails, and on a French
 * screenplay it fails constantly.
 *
 * Folding is for *searching*, never for *identity*. Deciding whether two names denote the
 * same character is a different question — RENE and RENÉ may well be two people — so
 * anything comparing names for identity keeps its accents and asks the author instead.
 */

/**
 * A replacement of one span of the document, in the coordinates of the text it was computed
 * from.
 *
 * Lives here rather than inside a feature because two of them now produce edits — the
 * corkboard moves scenes, the revision pass numbers them — and both hand them to the same
 * editor. A caller applies a batch in one transaction, which is what makes it one undo step.
 */
export interface DocumentEdit {
  from: number;
  to: number;
  insert: string;
}

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
