import type { Range, Scene, Screenplay } from '../fountain/index.js';

/** Message sent to the screenplay-analysis worker. */
export interface ParseRequest {
  /** Tab id, echoed back so stale responses can be discarded. */
  id: string;
  /** Document revision, used to drop out-of-date results. */
  revision: number;
  source: string;
}

export interface IndexedOccurrence extends Range {
  line: number;
}

export interface AnalyzedScene extends Omit<Scene, 'elements'> {
  /** Indexes into `ParseResponse.elements`, avoiding a duplicated nested AST graph. */
  elementIndexes: number[];
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
  durationMs: number;
}
