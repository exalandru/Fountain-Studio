import type { IndexedOccurrence, ParseRequest, ParseResponse } from '@shared/analysis/index.js';
import { buildCompletionIndex } from '@shared/analysis/index.js';
import type { Range, Screenplay } from '@shared/fountain/index.js';
import { countWords, parse } from '@shared/fountain/index.js';

/**
 * Full parsing off the UI thread (PLAN.md §3.2).
 *
 * The complete analysis takes ~17 ms on 120 pages — more than the 16 ms budget of a
 * keystroke, hence running it here. Highlighting does not wait for this result: it runs
 * the lexer directly inside the editor.
 */

function countAllWords(screenplay: Screenplay): number {
  let total = 0;
  for (const element of screenplay.elements) {
    if (element.kind === 'boneyard' || element.kind === 'note') continue;
    total += countWords(element.text);
  }
  return total;
}

function lineRanges(source: string): Range[] {
  const ranges: Range[] = [];
  let from = 0;

  for (let index = 0; index <= source.length; index++) {
    if (index === source.length || source[index] === '\n') {
      ranges.push({ from, to: index });
      from = index + 1;
    }
  }

  return ranges;
}

self.onmessage = (event: MessageEvent<ParseRequest>) => {
  const { id, revision, source } = event.data;
  const start = performance.now();
  const screenplay = parse(source);
  const ranges = lineRanges(source);
  const elementIndexes = new Map(
    screenplay.elements.map((element, index) => [element.id, index] as const),
  );
  const occurrence = (line: number): IndexedOccurrence => ({
    line,
    ...(ranges[line] ?? { from: 0, to: 0 }),
  });

  const response: ParseResponse = {
    id,
    revision,
    sceneCount: screenplay.scenes.length,
    wordCount: countAllWords(screenplay),
    characterCount: screenplay.characters.size,
    locationCount: screenplay.locations.size,
    diagnostics: screenplay.diagnostics,
    titlePage: [...screenplay.titlePage.fields.entries()],
    elements: screenplay.elements,
    scenes: screenplay.scenes.map(({ elements, ...scene }) => ({
      ...scene,
      elementIndexes: elements.flatMap((element) => {
        const index = elementIndexes.get(element.id);
        return index === undefined ? [] : [index];
      }),
    })),
    sections: screenplay.sections,
    characters: [...screenplay.characters.values()].map((c) => ({
      name: c.name,
      speeches: c.speeches,
      words: c.words,
      occurrences: c.cueLines.map(occurrence),
    })),
    locations: [...screenplay.locations.values()].map((l) => ({
      name: l.name,
      count: l.count,
      mixed: l.mixed,
      occurrences: l.lines.map(occurrence),
    })),
    completions: buildCompletionIndex(screenplay),
    durationMs: performance.now() - start,
  };

  self.postMessage(response);
};
