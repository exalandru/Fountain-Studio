import { foldService } from '@codemirror/language';
import type { EditorState, Extension } from '@codemirror/state';
import { fountainLexField } from './fountain-highlight.js';

/**
 * Folding by scene and by section (§4.1).
 *
 * A scene folds up to the next heading; a section up to the next section at the same
 * level or shallower. The service reads the lexer result already in the editor state,
 * so no extra analysis is performed.
 */
export function fountainFolding(): Extension {
  return foldService.of((state: EditorState, lineStart: number, lineEnd: number) => {
    const { lines } = state.field(fountainLexField, false) ?? { lines: [] };
    if (lines.length === 0) return null;

    const index = state.doc.lineAt(lineStart).number - 1;
    const line = lines[index];
    if (!line) return null;

    if (line.kind !== 'scene_heading' && line.kind !== 'section') return null;

    const sectionDepth = line.kind === 'section' ? (line.depth ?? 1) : null;

    for (let next = index + 1; next < lines.length; next++) {
      const candidate = lines[next];
      if (!candidate) continue;

      // A scene ends at the next heading or at the first section encountered.
      // A section encloses its scenes: only a section at the same level or shallower
      // closes it.
      const stops =
        sectionDepth === null
          ? candidate.kind === 'scene_heading' || candidate.kind === 'section'
          : candidate.kind === 'section' && (candidate.depth ?? 1) <= sectionDepth;

      if (stops) {
        // Stop at the end of the previous line, so the blank line separating the two
        // blocks is not swallowed.
        const previous = lines[next - 1];
        const end = previous ? previous.to : candidate.from;
        return end > lineEnd ? { from: lineEnd, to: end } : null;
      }
    }

    const last = lines[lines.length - 1];
    const end = last ? last.to : state.doc.length;
    return end > lineEnd ? { from: lineEnd, to: end } : null;
  });
}
