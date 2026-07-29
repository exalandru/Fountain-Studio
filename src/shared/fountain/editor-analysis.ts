import type { LexedLine } from './lexer.js';
import { lexDocument } from './lexer.js';
import { maskAnnotations } from './mask.js';
import { parseHeading } from './parse.js';

export interface EditorAnalysis {
  lines: LexedLine[];
  completions: {
    characters: string[];
    locations: string[];
    times: string[];
  };
  annotations: Array<{ kind: 'note' | 'boneyard'; from: number; to: number }>;
}

/**
 * Complete synchronous analysis required by one editor transaction.
 *
 * It deliberately excludes the full AST, which runs in a worker, but includes the
 * cached completion indexes so the typing benchmark measures the real hot path.
 */
export function analyzeForEditor(source: string): EditorAnalysis {
  const { masked, annotations } = maskAnnotations(source);
  const lines = lexDocument(masked);
  return {
    lines,
    completions: buildCompletionIndex(lines),
    annotations: annotations.map((annotation) => ({
      kind: annotation.kind,
      from: annotation.range.from,
      to: annotation.range.to,
    })),
  };
}

function buildCompletionIndex(lines: LexedLine[]): EditorAnalysis['completions'] {
  const characters = new Map<string, number>();
  const locations = new Map<string, number>();
  const times = new Map<string, number>();

  for (const line of lines) {
    if (line.kind === 'character' && line.character) {
      characters.set(line.character, (characters.get(line.character) ?? 0) + 1);
    } else if (line.kind === 'scene_heading') {
      const heading = parseHeading(line.text);
      if (heading.location) {
        locations.set(heading.location, (locations.get(heading.location) ?? 0) + 1);
      }
      if (heading.timeOfDay) {
        times.set(heading.timeOfDay, (times.get(heading.timeOfDay) ?? 0) + 1);
      }
    }
  }

  const byFrequency = (values: Map<string, number>): string[] =>
    [...values.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([name]) => name);

  return {
    characters: byFrequency(characters),
    locations: byFrequency(locations),
    times: byFrequency(times),
  };
}
