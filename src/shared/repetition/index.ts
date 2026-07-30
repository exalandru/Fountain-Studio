/**
 * Literal repetition in a screenplay: recurring turns of phrase, verbal tics, formulas.
 *
 * Pure TypeScript (PLAN.md §3.1) and deterministic, so this half of the analysis is instant,
 * free, needs no API key and is exercised by Vitest without a harness. Structural repetition
 * — the same beat played twice, two scenes doing the same job — is a separate, AI-assisted
 * reading; this module deliberately does not attempt it.
 */

import type { Element, SceneView } from '../fountain/ast.js';
import { stripEmphasis } from '../fountain/inline.js';
import { tokenizeWords } from '../fountain/parse.js';

/** Dialogue and action repeat for different reasons, so they are never mixed. */
export type RepetitionScope = 'dialogue' | 'action';

/**
 * Whether one voice owns the phrase or it is spread around.
 *
 * This is the distinction that makes the report usable. A phrase every one of a character's
 * scenes repeats is a signature — deliberate, and the writer wants to keep it. The same
 * phrase in three different mouths is the writer's own tic leaking into the script.
 */
export type RepetitionAttribution = 'signature' | 'spread';

export interface RepetitionOccurrence {
  sceneNumber: string;
  heading: string;
  /** 1-based scene position, used to measure how far apart the repeats sit. */
  sceneIndex: number;
  /** Absent outside dialogue. */
  speaker?: string;
  /** The whole element the phrase was found in, as context for the reader. */
  text: string;
  /** Absolute offsets of the element in the document, for navigation. */
  range: { from: number; to: number };
}

export interface RepeatedPhrase {
  /** The repeated words, normalised: lower case, single spaces, straight apostrophes. */
  phrase: string;
  /** Length in words, which is what makes a repeat conspicuous. */
  length: number;
  scope: RepetitionScope;
  /** How many blocks hold the phrase — always the full count. */
  total: number;
  /** The first `MAX_OCCURRENCES` of them, which is all an interface can usefully show. */
  occurrences: RepetitionOccurrence[];
  /** Distinct speakers, in first-appearance order; empty for action. */
  speakers: string[];
  attribution: RepetitionAttribution;
  /** Scenes between the first and last occurrence. Zero means the same scene. */
  span: number;
}

export interface RepetitionReport {
  phrases: RepeatedPhrase[];
  /** Words examined, so the interface can say what the report was computed on. */
  wordCount: number;
  /**
   * True when the candidate list was cut before the maximality pass. The phrases reported
   * are still real; there may be more of them.
   */
  truncated: boolean;
}

export interface RepetitionOptions {
  /** Shortest phrase reported, in words. Below four, ordinary grammar dominates. */
  minLength?: number;
  /** Longest phrase considered. */
  maxLength?: number;
  /** Fewest occurrences for a phrase to be reported. */
  minOccurrences?: number;
}

const DEFAULT_MIN_LENGTH = 4;
const DEFAULT_MAX_LENGTH = 10;
const DEFAULT_MIN_OCCURRENCES = 2;

/**
 * Share of the screenplay's blocks a word must appear in to count as grammar, not content.
 *
 * Shipping stopword lists would mean one list per language, and would quietly fail on a
 * screenplay written in a language we did not anticipate. The document defines its own
 * instead — but by *dispersion*, not by raw frequency, and the difference is the whole point.
 *
 * Counting occurrences is circular here: a repeated phrase makes its own words frequent, so
 * the very tic being looked for classifies itself as grammar and disappears from the report.
 * Dispersion does not have that flaw. Grammar is everywhere — "le" turns up in half the
 * blocks of any French screenplay — while a tic repeated four times, however striking, sits
 * in four blocks out of hundreds. Only the genuinely ubiquitous words are suppressed, which
 * is all that needs to be.
 */
const FUNCTION_WORD_DISPERSION = 0.25;

/**
 * Blocks a word must appear in at all, however short the document.
 *
 * A share alone breaks down on a fragment: in a twelve-block scene, a phrase repeated three
 * times clears a quarter on its own and would classify itself as grammar again. Being in
 * three blocks is not being ubiquitous — it is only a large share of a small sample. The two
 * conditions therefore compose: the fraction governs a feature, this floor governs a
 * fragment, and a word has to satisfy whichever is greater.
 */
const MIN_FUNCTION_WORD_BLOCKS = 8;

/** Ceiling, in case a very short document makes everything look ubiquitous. */
const MAX_FUNCTION_WORDS = 40;

/**
 * Content words a phrase must carry.
 *
 * With dispersion doing the classifying, this only rejects phrases built entirely out of the
 * handful of words that are everywhere: "et il y a" goes, "je te le dis" stays — three
 * verbatim repeats of that is a tic a writer wants to see.
 */
const MIN_CONTENT_WORDS = 2;

/** Bounds the quadratic maximality pass on a document that repeats itself heavily. */
const MAX_CANDIDATES = 4_000;

/** Bounds what the interface has to render. */
const MAX_PHRASES = 200;

/**
 * Occurrences kept per phrase.
 *
 * A phrase can repeat a thousand times; nobody reads the thousandth. The full count is
 * reported separately, so the report stays truthful without putting a thousand rows in the
 * DOM to say one thing.
 */
const MAX_OCCURRENCES = 30;

/** A phrase and the elements it was found in, before the maximality pass. */
interface Candidate {
  tokens: string[];
  phrase: string;
  scope: RepetitionScope;
  occurrences: RepetitionOccurrence[];
}

interface Unit {
  tokens: string[];
  scope: RepetitionScope;
  occurrence: RepetitionOccurrence;
}

/** Straight apostrophes and lower case, so "L’homme" and "l'homme" are the same word. */
function normalise(token: string): string {
  return token.replace(/’/g, "'").toLocaleLowerCase();
}

function scopeOf(element: Element): RepetitionScope | null {
  if (element.kind === 'dialogue') return 'dialogue';
  if (element.kind === 'action') return 'action';
  // Headings, cues and transitions repeat by design; notes and synopses are not the
  // screenplay. Reporting any of them would bury the findings that matter.
  return null;
}

/** One entry per element that can repeat, tokenised once. */
function readUnits(scenes: readonly SceneView[]): Unit[] {
  const units: Unit[] = [];
  scenes.forEach((scene, index) => {
    for (const element of scene.elements) {
      const scope = scopeOf(element);
      if (scope === null) continue;
      const tokens = tokenizeWords(stripEmphasis(element.text)).map(normalise);
      if (tokens.length === 0) continue;
      units.push({
        tokens,
        scope,
        occurrence: {
          sceneNumber: scene.number,
          heading: scene.heading,
          sceneIndex: index + 1,
          ...(element.speaker === undefined ? {} : { speaker: element.speaker }),
          text: element.text,
          range: { from: element.range.from, to: element.range.to },
        },
      });
    }
  });
  return units;
}

/**
 * The document's own function words: the ones spread across a quarter of its distinct blocks.
 *
 * Distinct, because a block counts once however many times it is reused. Otherwise the
 * circularity comes back at the extreme: a passage repeated in most blocks makes its own
 * words ubiquitous, and the report loses the largest repetition in the screenplay — the one
 * finding that mattered most.
 */
function functionWords(units: readonly Unit[]): Set<string> {
  const distinct = new Map<string, string[]>();
  for (const unit of units) distinct.set(unit.tokens.join(' '), unit.tokens);

  const blocks = new Map<string, number>();
  for (const tokens of distinct.values()) {
    for (const token of new Set(tokens)) blocks.set(token, (blocks.get(token) ?? 0) + 1);
  }
  const threshold = Math.max(distinct.size * FUNCTION_WORD_DISPERSION, MIN_FUNCTION_WORD_BLOCKS);
  return new Set(
    [...blocks.entries()]
      .filter(([, count]) => count >= threshold)
      // Ties broken alphabetically so the same document always yields the same set.
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, MAX_FUNCTION_WORDS)
      .map(([token]) => token),
  );
}

function contentCount(tokens: readonly string[], common: ReadonlySet<string>): number {
  let count = 0;
  for (const token of tokens) if (!common.has(token)) count++;
  return count;
}

/** The shortest sequence covering both, when they overlap or one holds the other. */
function join(a: readonly string[], b: readonly string[]): string[] | null {
  const padded = { a: ` ${a.join(' ')} `, b: ` ${b.join(' ')} ` };
  if (padded.a.includes(padded.b)) return [...a];
  if (padded.b.includes(padded.a)) return [...b];
  for (let overlap = Math.min(a.length, b.length) - 1; overlap >= 1; overlap--) {
    if (a.slice(a.length - overlap).join(' ') === b.slice(0, overlap).join(' ')) {
      return [...a, ...b.slice(overlap)];
    }
    if (b.slice(b.length - overlap).join(' ') === a.slice(0, overlap).join(' ')) {
      return [...b, ...a.slice(overlap)];
    }
  }
  return null;
}

/**
 * Rebuilds a repeated passage from the overlapping windows that cover it.
 *
 * A passage longer than `maxLength` cannot be seen whole by a fixed window, so it arrives as
 * a run of windows that all repeat in exactly the same blocks — a two-line action paragraph
 * reused in every scene comes back as five near-identical findings. Windows sharing the same
 * blocks come from the same passage, so they are welded back together and the report names
 * the passage once, at its true length.
 */
function mergeOverlapping(candidates: readonly Candidate[]): Candidate[] {
  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    // Same scope and the very same blocks: nothing else can produce that coincidence.
    const key = `${candidate.scope}|${candidate.occurrences
      .map((occurrence) => occurrence.range.from)
      .join(',')}`;
    const group = groups.get(key);
    if (group) group.push(candidate);
    else groups.set(key, [candidate]);
  }

  const merged: Candidate[] = [];
  for (const group of groups.values()) {
    const ordered = [...group].sort((a, b) => b.tokens.length - a.tokens.length);
    const built: Candidate[] = [];
    for (const candidate of ordered) {
      let absorbed = false;
      for (let index = 0; index < built.length; index++) {
        const target = built[index];
        if (!target) continue;
        const combined = join(target.tokens, candidate.tokens);
        if (combined) {
          built[index] = { ...target, tokens: combined, phrase: combined.join(' ') };
          absorbed = true;
          break;
        }
      }
      if (!absorbed) built.push(candidate);
    }
    merged.push(...built);
  }
  return merged;
}

/**
 * Drops a phrase when a longer one repeats exactly as often and contains it.
 *
 * Without this, one repeated sentence is reported once per length between the minimum and
 * its own — the same finding, seven times over. Only same-count phrases are compared: if a
 * short phrase recurs more often than the long one containing it, that is a separate and
 * genuine finding.
 */
function keepMaximal(candidates: readonly Candidate[]): Candidate[] {
  const byKey = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.scope}|${candidate.occurrences.length}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(candidate);
    else byKey.set(key, [candidate]);
  }

  const kept: Candidate[] = [];
  for (const bucket of byKey.values()) {
    // Longest first, so a phrase is only ever compared against phrases that could contain it.
    const ordered = [...bucket].sort((a, b) => b.tokens.length - a.tokens.length);
    const survivors: Candidate[] = [];
    for (const candidate of ordered) {
      const padded = ` ${candidate.phrase} `;
      const contained = survivors.some(
        (longer) =>
          longer.tokens.length > candidate.tokens.length && ` ${longer.phrase} `.includes(padded),
      );
      if (!contained) survivors.push(candidate);
    }
    kept.push(...survivors);
  }
  return kept;
}

function describe(candidate: Candidate): RepeatedPhrase {
  const speakers: string[] = [];
  for (const occurrence of candidate.occurrences) {
    if (occurrence.speaker && !speakers.includes(occurrence.speaker)) {
      speakers.push(occurrence.speaker);
    }
  }
  const indexes = candidate.occurrences.map((occurrence) => occurrence.sceneIndex);
  return {
    phrase: candidate.phrase,
    length: candidate.tokens.length,
    scope: candidate.scope,
    total: candidate.occurrences.length,
    occurrences: candidate.occurrences.slice(0, MAX_OCCURRENCES),
    speakers,
    // Action has no speaker, so a repeated action formula is always the writer's own.
    attribution: speakers.length === 1 ? 'signature' : 'spread',
    span: Math.max(...indexes) - Math.min(...indexes),
  };
}

/**
 * Finds phrases that recur word for word.
 *
 * Every phrase length between the bounds is counted, then the maximality pass keeps only the
 * longest form of each repeat. Phrases never cross an element boundary: words shared by the
 * end of one speech and the start of the next are a coincidence, not a repetition.
 */
export function findRepeatedPhrases(
  scenes: readonly SceneView[],
  options: RepetitionOptions = {},
): RepetitionReport {
  const minLength = Math.max(2, options.minLength ?? DEFAULT_MIN_LENGTH);
  const maxLength = Math.max(minLength, options.maxLength ?? DEFAULT_MAX_LENGTH);
  const minOccurrences = Math.max(2, options.minOccurrences ?? DEFAULT_MIN_OCCURRENCES);

  const units = readUnits(scenes);
  const wordCount = units.reduce((total, unit) => total + unit.tokens.length, 0);
  const common = functionWords(units);

  const grouped = new Map<string, Candidate>();
  for (const unit of units) {
    const limit = Math.min(maxLength, unit.tokens.length);
    for (let length = minLength; length <= limit; length++) {
      for (let start = 0; start + length <= unit.tokens.length; start++) {
        const tokens = unit.tokens.slice(start, start + length);
        if (contentCount(tokens, common) < MIN_CONTENT_WORDS) continue;
        const phrase = tokens.join(' ');
        const key = `${unit.scope}|${phrase}`;
        const existing = grouped.get(key);
        if (existing) {
          // A phrase repeated inside one element counts once for it: the element is the
          // occurrence a reader navigates to.
          if (existing.occurrences.at(-1) !== unit.occurrence) {
            existing.occurrences.push(unit.occurrence);
          }
        } else {
          grouped.set(key, { tokens, phrase, scope: unit.scope, occurrences: [unit.occurrence] });
        }
      }
    }
  }

  const candidates = [...grouped.values()].filter(
    (candidate) => candidate.occurrences.length >= minOccurrences,
  );
  // Most-repeated first, so cutting the tail loses the weakest findings rather than
  // arbitrary ones.
  candidates.sort(
    (a, b) => b.occurrences.length - a.occurrences.length || b.tokens.length - a.tokens.length,
  );
  const truncated = candidates.length > MAX_CANDIDATES;

  const phrases = keepMaximal(mergeOverlapping(candidates.slice(0, MAX_CANDIDATES)))
    .map(describe)
    .sort(
      (a, b) =>
        b.total - a.total ||
        b.length - a.length ||
        // A repeat two scenes apart is heard; the same words eighty pages apart are not.
        a.span - b.span ||
        a.phrase.localeCompare(b.phrase),
    );

  return {
    phrases: phrases.slice(0, MAX_PHRASES),
    wordCount,
    truncated: truncated || phrases.length > MAX_PHRASES,
  };
}

/** Longest first action line kept per scene, in characters. */
const DIGEST_ACTION_LENGTH = 160;

/**
 * A compact, one-line-per-scene reading of the screenplay's shape.
 *
 * Structural repetition — two scenes doing the same job, a beat played twice — is the half of
 * this analysis a model has to judge, and judging it means holding every scene at once. The
 * screenplay itself is far too long for that; this digest is roughly thirty words a scene, so
 * a feature fits in a single request and no chunking is needed. Chunking would defeat the
 * question anyway: repetition is only visible across the whole.
 *
 * Deterministic, so it costs nothing and can be checked without a model.
 */
export function buildSceneDigest(scenes: readonly SceneView[]): string {
  return scenes
    .map((scene, index) => {
      const speakers: string[] = [];
      let synopsis = '';
      let action = '';
      let words = 0;
      for (const element of scene.elements) {
        words += tokenizeWords(element.text).length;
        if (element.kind === 'synopsis' && synopsis === '') synopsis = element.text;
        if (element.kind === 'action' && action === '') action = element.text;
        if (element.speaker && !speakers.includes(element.speaker)) speakers.push(element.speaker);
      }
      const parts = [
        `${scene.number} | ${scene.heading}`,
        `${words} mots`,
        speakers.length > 0 ? speakers.join(', ') : '—',
      ];
      // The writer's own synopsis says what a scene is for better than any guess; the first
      // action line is the fallback when there is none.
      if (synopsis !== '') parts.push(`synopsis: ${synopsis.slice(0, DIGEST_ACTION_LENGTH)}`);
      else if (action !== '') parts.push(`action: ${action.slice(0, DIGEST_ACTION_LENGTH)}`);
      return `${index + 1}. ${parts.join(' | ')}`;
    })
    .join('\n');
}
