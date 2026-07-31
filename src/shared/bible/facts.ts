/**
 * Factual fields for a script bible sheet — computed from the screenplay AST, never persisted.
 *
 * A stored fact goes stale the moment the author cuts a scene, and a bible that quietly lies
 * about the screenplay is worse than no bible. This module recomputes everything on every
 * render so the sidecar only ever holds prose the author (or the AI) wrote themselves.
 */

import type { SceneView } from '../fountain/ast.js';
import type { BibleEntryKind } from './index.js';

/** The facts a sheet can carry. Literal, for the same reason as `BibleFieldId`. */
export type BibleFactKey = 'scenes' | 'speeches' | 'words' | 'firstScene' | 'lastScene';

/** A single factual field: either a quantity for i18n pluralisation or a label for display. */
export interface BibleFact {
  /** i18n key suffix, e.g. `'scenes'` → `bible.fact.scenes`. */
  key: BibleFactKey;

  /**
   * Set for the facts that are quantities. The i18n layer chooses the plural form from a
   * `count` parameter, so a quantity must travel as a number — French says "1 scène" where
   * English says "1 scene", and a pre-formatted string cannot express that.
   */
  count?: number;

  /** Set for the facts that are labels: a scene number may be "12A", not a quantity. */
  value?: string;
}
/**
 * The input shape expected by `factsForEntry`.
 *
 * A narrow view of `ParseResponse`, so a test can build a fixture without the whole analysis
 * type. Characters and locations carry pre-computed totals; scenes carry indexes into the
 * flat element list.
 */
export interface FactsInput {
  characters: ReadonlyArray<{ name: string; speeches: number; words: number }>;
  locations: ReadonlyArray<{ name: string; count: number }>;
  scenes: ReadonlyArray<{
    number: string;
    heading: string;
    /** The location as the parser extracted it: no prefix, no time of day. */
    location: string;
    elementIndexes: readonly number[];
  }>;
  elements: ReadonlyArray<{ kind: string; speaker?: string; text: string }>;
}

/** Every name a sheet covers, upper-cased for comparison. */
function coveredNames(entry: { name: string; aliases?: readonly string[] }): Set<string> {
  return new Set(
    [entry.name, ...(entry.aliases ?? [])].map((name) => name.trim().toLocaleUpperCase()),
  );
}

/**
 * Build the factual fields for one bible entry, recomputed from the AST on every render.
 *
 * Aggregated across every name the sheet covers: a sheet grouping `MÉGALOPOLE` with its
 * ramparts and its streets reports one scene count for the place, which is the whole reason
 * to group them.
 */
export function factsForEntry(
  entry: { kind: BibleEntryKind; name: string; aliases?: readonly string[] },
  analysis: FactsInput,
): BibleFact[] {
  // An object or a notion has no counterpart in the AST, so there is nothing to count.
  if (entry.kind === 'object' || entry.kind === 'concept') return [];

  const covered = coveredNames(entry);
  const facts: BibleFact[] = [];
  const sceneIndexes = new Set<number>();

  if (entry.kind === 'character') {
    let speeches = 0;
    let words = 0;
    for (const character of analysis.characters) {
      if (!covered.has(character.name.trim().toLocaleUpperCase())) continue;
      speeches += character.speeches;
      words += character.words;
    }

    analysis.scenes.forEach((scene, index) => {
      for (const elementIndex of scene.elementIndexes) {
        const element = analysis.elements[elementIndex];
        if (!element) continue;
        const speaker = element.kind === 'character' ? element.text : element.speaker;
        if (speaker !== undefined && covered.has(speaker.trim().toLocaleUpperCase())) {
          sceneIndexes.add(index);
          return;
        }
      }
    });

    // Nothing matched: an empty list rather than a row of zeros, which would read like a real
    // measurement of a real character.
    if (sceneIndexes.size === 0) return [];
    facts.push({ key: 'scenes', count: sceneIndexes.size });
    facts.push({ key: 'speeches', count: speeches });
    if (words > 0) facts.push({ key: 'words', count: words });
  } else {
    // Compared to the parsed location, not to the raw heading: as a substring test, a sheet
    // called "RUE" also claimed "RUE PRINCIPALE" and "GRANDE RUE".
    analysis.scenes.forEach((scene, index) => {
      if (covered.has(scene.location.trim().toLocaleUpperCase())) sceneIndexes.add(index);
    });
    if (sceneIndexes.size === 0) return [];
    facts.push({ key: 'scenes', count: sceneIndexes.size });
  }

  const ordered = [...sceneIndexes].sort((a, b) => a - b);
  const first = analysis.scenes[ordered[0] ?? -1];
  const last = analysis.scenes[ordered[ordered.length - 1] ?? -1];
  if (first) facts.push({ key: 'firstScene', value: first.number });
  if (last && ordered.length > 1) facts.push({ key: 'lastScene', value: last.number });

  return facts;
}

/**
 * Longest context handed to a model for one sheet.
 *
 * Twelve thousand characters is roughly four thousand tokens — a lead character's whole
 * presence in a feature, condensed to their scenes. Larger contexts did not produce better
 * sheets, only slower ones: a local model spends its budget reading rather than writing, and
 * the request times out before a single field comes back.
 */
const MAX_CONTEXT_CHARACTERS = 12_000;

/**
 * The passages of the screenplay that concern one sheet.
 *
 * For a character: their speeches plus the action of the scenes they appear in — a character
 * is defined as much by what they do as by what they say, and a draft written from dialogue
 * alone reads like a transcript. For a location: the action of its scenes. For an object or a
 * notion: any block whose text mentions the name, since the AST has no other handle on it.
 *
 * Each passage is tagged `[number · heading]`, the same shape `buildCharacterVoiceContext`
 * uses, so a model asked for scene-consistent output has the scene number in front of it.
 */export function buildBibleContext(
  entry: { kind: BibleEntryKind; name: string; aliases?: readonly string[] },
  scenes: readonly SceneView[],
  maxCharacters = MAX_CONTEXT_CHARACTERS,
): string {
  const covered = coveredNames(entry);
  const speaks = (element: SceneView['elements'][number]): boolean =>
    element.speaker !== undefined && covered.has(element.speaker.trim().toLocaleUpperCase());
  const chunks: string[] = [];

  for (const scene of scenes) {
    const tag = `[${scene.number} · ${scene.heading}]`;
    const lines: string[] = [];

    if (entry.kind === 'character') {
      if (!scene.elements.some(speaks)) continue;
      for (const element of scene.elements) {
        if (element.kind === 'action') lines.push(element.text);
        else if (speaks(element)) lines.push(`${element.speaker} : ${element.text}`);
      }
    } else if (entry.kind === 'location') {
      // The parsed location, not the raw heading: a substring test on the heading would pull
      // in every place whose name contains this one.
      if (!covered.has(scene.location.trim().toLocaleUpperCase())) continue;
      for (const element of scene.elements) {
        if (element.kind === 'action') lines.push(element.text);
      }
    } else {
      // An object or a notion has no handle in the AST, so its own name in the text is all
      // there is to go on.
      const wanted = entry.name.toLocaleUpperCase();
      for (const element of scene.elements) {
        if (element.text.toLocaleUpperCase().includes(wanted)) lines.push(element.text);
      }
    }

    if (lines.length > 0) chunks.push(`${tag}\n${lines.join('\n')}`);
  }


  // Truncating on a passage boundary rather than mid-sentence: half a speech would make the
  // model draft from something the screenplay does not say.
  //
  // The first passage goes in whatever its length, because a budget smaller than it would
  // otherwise yield an empty context — and a model handed nothing does not decline, it
  // invents. One scene is bounded by what a scene can be; an empty context is not.
  const context: string[] = [];
  let length = 0;
  for (const chunk of chunks) {
    if (context.length > 0 && length + chunk.length > maxCharacters) break;
    context.push(chunk);
    length += chunk.length + 2;
  }
  return context.join('\n\n');
}
