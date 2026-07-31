/**
 * Proposing which of a screenplay's locations are really one place.
 *
 * Pure TypeScript (PLAN.md §3.1), no model involved. A screenwriter writes
 * `EXT. MÉGALOPOLE - REMPARTS - NUIT` and `EXT. MÉGALOPOLE - RUES - JOUR`, and the parser is
 * right to report two locations — they are two places to shoot. But they are one place to
 * write about, and a bible that makes the author fill three sheets for one city is a chore
 * rather than a tool.
 *
 * These are *suggestions*. Nothing is grouped without the author accepting it, because only
 * they know whether `MÉGALOPOLE - RUES` is part of the city or a district with its own life.
 */

import { foldDiacritics } from '../text/index.js';

export interface LocationGroup {
  /** The parent, spelled as the screenplay spells it. */
  parent: string;
  /** Locations that look like parts of it, in the screenplay's own spelling. */
  children: string[];
}

/** Shortest name that can host a child. Below it, containment matches noise. */
const MIN_PARENT_LENGTH = 4;

/** The separator screenwriters use between a place and a part of it. */
const SEGMENT = ' - ';

/** Whether `needle` occurs in `haystack` as a whole word or run of words. */
function containsWords(haystack: string, needle: string): boolean {
  const index = haystack.indexOf(needle);
  if (index < 0) return false;
  const before = index === 0 ? ' ' : haystack[index - 1];
  const afterIndex = index + needle.length;
  const after = afterIndex >= haystack.length ? ' ' : haystack[afterIndex];
  // A word boundary, not a letter: "RUE" is in "RUE PRINCIPALE" but not in "RUELLE".
  return !/[\p{L}\p{N}]/u.test(before ?? ' ') && !/[\p{L}\p{N}]/u.test(after ?? ' ');
}

/**
 * Groups locations that look like parts of the same place.
 *
 * Two heuristics, and the order matters:
 *
 * 1. **Leading segment.** `MÉGALOPOLE - REMPARTS` belongs to `MÉGALOPOLE`. This is the
 *    convention screenwriters already follow, so it carries most of the work and it is
 *    unambiguous — the author wrote the hierarchy themselves.
 * 2. **Whole-word containment.** `REMPARTS DE LA MÉGALOPOLE` belongs to `MÉGALOPOLE` too,
 *    when the parent is itself a location in the screenplay. Catches headings written as
 *    prose, at the cost of being a guess rather than a reading.
 *
 * A location is claimed once. The output is sorted so the page it feeds does not reshuffle
 * between renders.
 */
export function suggestLocationGroups(names: readonly string[]): LocationGroup[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const trimmed = name.trim();
    if (trimmed.length === 0) continue;
    const folded = foldDiacritics(trimmed);
    if (seen.has(folded)) continue;
    seen.add(folded);
    unique.push(trimmed);
  }

  /** Folded name → the spelling to display. */
  const spelling = new Map(unique.map((name) => [foldDiacritics(name), name]));
  const groups = new Map<string, Set<string>>();
  const claimed = new Set<string>();

  const claim = (parentFolded: string, child: string) => {
    const set = groups.get(parentFolded) ?? new Set<string>();
    set.add(child);
    groups.set(parentFolded, set);
    claimed.add(foldDiacritics(child));
  };

  // 1 — the author's own hierarchy.
  const bySegment = new Map<string, string[]>();
  for (const name of unique) {
    const cut = name.indexOf(SEGMENT);
    if (cut <= 0) continue;
    const head = name.slice(0, cut).trim();
    if (head.length === 0) continue;
    const folded = foldDiacritics(head);
    const bucket = bySegment.get(folded);
    if (bucket) bucket.push(name);
    else bySegment.set(folded, [name]);
    // The bare parent may not be a location of its own; remember how it is spelled anyway.
    if (!spelling.has(folded)) spelling.set(folded, head);
  }
  for (const [folded, children] of bySegment) {
    // Worth proposing when two names share the head, or when the bare place also exists —
    // one sub-location and no parent is not a hierarchy, it is just a name with a dash.
    if (children.length < 2 && !unique.some((name) => foldDiacritics(name) === folded)) continue;
    for (const child of children) claim(folded, child);
  }

  // 2 — headings written as prose. Shortest candidate parent wins, so REMPARTS DE LA
  // MÉGALOPOLE goes under MÉGALOPOLE rather than under some longer name containing it.
  const parents = [...unique].sort((a, b) => a.length - b.length || a.localeCompare(b));
  for (const child of unique) {
    if (claimed.has(foldDiacritics(child))) continue;
    const childFolded = foldDiacritics(child);
    const parent = parents.find((candidate) => {
      const candidateFolded = foldDiacritics(candidate);
      return (
        candidateFolded !== childFolded &&
        candidateFolded.length >= MIN_PARENT_LENGTH &&
        candidateFolded.length < childFolded.length &&
        !claimed.has(candidateFolded) &&
        containsWords(childFolded, candidateFolded)
      );
    });
    if (parent !== undefined) claim(foldDiacritics(parent), child);
  }

  return [...groups.entries()]
    .map(([folded, children]) => ({
      parent: spelling.get(folded) ?? folded,
      children: [...children].sort((a, b) => a.localeCompare(b)),
    }))
    .filter((group) => group.children.length > 0)
    .sort((a, b) => a.parent.localeCompare(b.parent));
}
