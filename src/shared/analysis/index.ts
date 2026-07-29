import type { Range, Scene, Screenplay } from '../fountain/index.js';
import type { PaginationResult } from '../pagination/index.js';
import type { ScreenplayStatistics } from '../stats/index.js';

/** Message sent to the screenplay-analysis worker. */
export interface ParseRequest {
  /** Tab id, echoed back so stale responses can be discarded. */
  id: string;
  /** Document revision, used to drop out-of-date results. */
  revision: number;
  source: string;
  minutesPerPage: number;
}

export interface IndexedOccurrence extends Range {
  line: number;
}

export interface AnalyzedScene extends Omit<Scene, 'elements'> {
  /** Indexes into `ParseResponse.elements`, avoiding a duplicated nested AST graph. */
  elementIndexes: number[];
}

/** Completion values derived from the canonical worker AST. */
export interface CompletionIndex {
  characters: string[];
  locations: string[];
  times: string[];
}

/** Builds completion values from the canonical AST, ordered by observed frequency. */
export function buildCompletionIndex(screenplay: Screenplay): CompletionIndex {
  const times = new Map<string, number>();
  for (const scene of screenplay.scenes) {
    if (scene.timeOfDay) times.set(scene.timeOfDay, (times.get(scene.timeOfDay) ?? 0) + 1);
  }
  const byFrequency = (values: Array<[string, number]>): string[] =>
    values
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([name]) => name);

  return {
    characters: byFrequency(
      [...screenplay.characters.values()].map((character) => [character.name, character.speeches]),
    ),
    locations: byFrequency(
      [...screenplay.locations.values()].map((location) => [location.name, location.count]),
    ),
    times: byFrequency([...times.entries()]),
  };
}

/**
 * Serializable AST view shared by the worker and every renderer consumer.
 *
 * Keeping this contract outside the worker avoids importing a runtime worker module
 * merely to obtain types, and gives later pagination/statistics workers one canonical
 * DTO boundary.
 */
export interface ParseResponse {
  id: string;
  revision: number;
  sceneCount: number;
  wordCount: number;
  characterCount: number;
  locationCount: number;
  diagnostics: Screenplay['diagnostics'];
  titlePage: Array<[string, string[]]>;
  elements: Screenplay['elements'];
  scenes: AnalyzedScene[];
  sections: Screenplay['sections'];
  characters: Array<{
    name: string;
    speeches: number;
    words: number;
    occurrences: IndexedOccurrence[];
  }>;
  locations: Array<{
    name: string;
    count: number;
    mixed: boolean;
    occurrences: IndexedOccurrence[];
  }>;
  completions: CompletionIndex;
  pagination: PaginationResult;
  statistics: ScreenplayStatistics;
  durationMs: number;
}
