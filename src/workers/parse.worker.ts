import type { Screenplay } from '@shared/fountain/index.js';
import { parse } from '@shared/fountain/index.js';

/**
 * Full parsing off the UI thread (PLAN.md §3.2).
 *
 * The complete analysis takes ~17 ms on 120 pages — more than the 16 ms budget of a
 * keystroke, hence running it here. Highlighting does not wait for this result: it runs
 * the lexer directly inside the editor.
 */

export interface ParseRequest {
  /** Tab id, echoed back so stale responses can be discarded. */
  id: string;
  /** Document revision, used to drop out-of-date results. */
  revision: number;
  source: string;
}

/** Lightweight view of the AST: Maps and Sets do not always survive postMessage well. */
export interface ParseResponse {
  id: string;
  revision: number;
  sceneCount: number;
  wordCount: number;
  characterCount: number;
  locationCount: number;
  diagnostics: Screenplay['diagnostics'];
  scenes: Array<{
    id: string;
    number: string;
    heading: string;
    line: number;
    from: number;
    to: number;
    timeOfDay: string | null;
    intExt: string | null;
    synopsis: string | undefined;
    sectionPath: string[];
  }>;
  characters: Array<{ name: string; speeches: number; words: number; cueLines: number[] }>;
  locations: Array<{ name: string; count: number; mixed: boolean; lines: number[] }>;
  durationMs: number;
}

function countAllWords(screenplay: Screenplay): number {
  let total = 0;
  for (const element of screenplay.elements) {
    if (element.kind === 'boneyard' || element.kind === 'note') continue;
    total += element.text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
  }
  return total;
}

self.onmessage = (event: MessageEvent<ParseRequest>) => {
  const { id, revision, source } = event.data;
  const start = performance.now();
  const screenplay = parse(source);

  const response: ParseResponse = {
    id,
    revision,
    sceneCount: screenplay.scenes.length,
    wordCount: countAllWords(screenplay),
    characterCount: screenplay.characters.size,
    locationCount: screenplay.locations.size,
    diagnostics: screenplay.diagnostics,
    scenes: screenplay.scenes.map((scene) => ({
      id: scene.id,
      number: scene.number,
      heading: scene.heading,
      line: scene.line,
      from: scene.range.from,
      to: scene.range.to,
      timeOfDay: scene.timeOfDay,
      intExt: scene.intExt,
      synopsis: scene.synopsis,
      sectionPath: scene.sectionPath,
    })),
    characters: [...screenplay.characters.values()].map((c) => ({
      name: c.name,
      speeches: c.speeches,
      words: c.words,
      cueLines: c.cueLines,
    })),
    locations: [...screenplay.locations.values()].map((l) => ({
      name: l.name,
      count: l.count,
      mixed: l.mixed,
      lines: l.lines,
    })),
    durationMs: performance.now() - start,
  };

  self.postMessage(response);
};
