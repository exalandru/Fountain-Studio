import { RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import type { EditorState, Extension, Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import type { EditorAnalysis, LexedLine } from '@shared/fountain/index.js';
import { analyzeForEditor, parseInline } from '@shared/fountain/index.js';

/**
 * Fountain syntax highlighting.
 *
 * The shared lexer handles a 120-page screenplay in ~6 ms (see the performance test),
 * far below the 16 ms budget per keystroke. So the **whole** document is lexed on every
 * change rather than just the viewport. Structural consumers use the canonical AST
 * worker; this synchronous pass is limited to line classes and annotation ranges.
 *
 * Decorations, on the other hand, are only built for the visible lines.
 */

export interface VisibilityOptions {
  showNotes: boolean;
  showBoneyard: boolean;
  showSynopses: boolean;
  showSections: boolean;
  showSceneNumbers: boolean;
}

export const setVisibility = StateEffect.define<VisibilityOptions>();

export const visibilityField = StateField.define<VisibilityOptions>({
  create: () => ({
    showNotes: true,
    showBoneyard: true,
    showSynopses: true,
    showSections: true,
    showSceneNumbers: true,
  }),
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setVisibility)) return effect.value;
    }
    return value;
  },
});

/** Analysis of the current document, recomputed on every change. */
export const fountainLexField = StateField.define<EditorAnalysis>({
  create(state) {
    return analyzeForEditor(state.doc.toString());
  },
  update(value, transaction) {
    if (!transaction.docChanged) return value;
    return analyzeForEditor(transaction.newDoc.toString());
  },
});

/** One CSS class per element kind — the styling lives in the theme, not here. */
const LINE_CLASS: Record<string, string> = {
  scene_heading: 'cm-fountain-scene',
  action: 'cm-fountain-action',
  character: 'cm-fountain-character',
  dialogue: 'cm-fountain-dialogue',
  parenthetical: 'cm-fountain-parenthetical',
  lyrics: 'cm-fountain-lyrics',
  transition: 'cm-fountain-transition',
  centered: 'cm-fountain-centered',
  page_break: 'cm-fountain-pagebreak',
  section: 'cm-fountain-section',
  synopsis: 'cm-fountain-synopsis',
  title_page_key: 'cm-fountain-titlekey',
  title_page_value: 'cm-fountain-titlevalue',
};

const lineDecorations = new Map<string, Decoration>();
function lineDecoration(className: string, spellcheck: boolean, sceneNumber?: string): Decoration {
  const key = `${className}:${spellcheck}:${sceneNumber ?? ''}`;
  let decoration = lineDecorations.get(key);
  if (!decoration) {
    const attributes: Record<string, string> = {};
    if (!spellcheck) attributes['spellcheck'] = 'false';
    if (sceneNumber !== undefined) attributes['data-scene-number'] = sceneNumber;
    decoration = Decoration.line({
      class: className,
      attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
    });
    lineDecorations.set(key, decoration);
  }
  return decoration;
}

const BOLD = Decoration.mark({ class: 'cm-fountain-bold' });
const ITALIC = Decoration.mark({ class: 'cm-fountain-italic' });
const UNDERLINE = Decoration.mark({ class: 'cm-fountain-underline' });
const BOLD_ITALIC = Decoration.mark({ class: 'cm-fountain-bold cm-fountain-italic' });
const BOLD_UNDERLINE = Decoration.mark({ class: 'cm-fountain-bold cm-fountain-underline' });
const ITALIC_UNDERLINE = Decoration.mark({ class: 'cm-fountain-italic cm-fountain-underline' });
const BOLD_ITALIC_UNDERLINE = Decoration.mark({
  class: 'cm-fountain-bold cm-fountain-italic cm-fountain-underline',
});
const NOTE = Decoration.mark({ class: 'cm-fountain-note' });
const BONEYARD = Decoration.mark({ class: 'cm-fountain-boneyard' });
const HIDDEN = Decoration.replace({});
const HIDDEN_LINE = Decoration.replace({ block: true });

function buildHiddenLines(state: EditorState): DecorationSet {
  const { lines } = state.field(fountainLexField);
  const visibility = state.field(visibilityField);
  const builder = new RangeSetBuilder<Decoration>();

  for (const line of lines) {
    const hidden =
      (line.kind === 'synopsis' && !visibility.showSynopses) ||
      (line.kind === 'section' && !visibility.showSections);
    if (hidden) {
      builder.add(line.from, Math.min(state.doc.length, line.to + 1), HIDDEN_LINE);
    }
  }
  return builder.finish();
}

const hiddenLinesField = StateField.define<DecorationSet>({
  create: buildHiddenLines,
  update(value, transaction) {
    if (transaction.docChanged || transaction.effects.some((effect) => effect.is(setVisibility))) {
      return buildHiddenLines(transaction.state);
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function buildDecorations(view: EditorView): DecorationSet {
  const { lines, annotations } = view.state.field(fountainLexField);
  const visibility = view.state.field(visibilityField);
  const collected: Array<Range<Decoration>> = [];
  const sceneNumbers = new Map<number, string>();
  if (visibility.showSceneNumbers) {
    let ordinal = 0;
    for (const line of lines) {
      if (line.kind !== 'scene_heading') continue;
      ordinal += 1;
      sceneNumbers.set(line.line, line.sceneNumber ?? String(ordinal));
    }
  }

  for (const { from, to } of view.visibleRanges) {
    const firstLine = view.state.doc.lineAt(from).number - 1;
    const lastLine = view.state.doc.lineAt(to).number - 1;

    for (let index = firstLine; index <= lastLine && index < lines.length; index++) {
      const line = lines[index];
      if (!line) continue;

      // Optional hiding of entire kinds (Better Fountain parity, §4.4).
      const hiddenByOption =
        (line.kind === 'synopsis' && !visibility.showSynopses) ||
        (line.kind === 'section' && !visibility.showSections);

      if (hiddenByOption) {
        // Block replacements live in `hiddenLinesField`: layout decorations cannot be
        // provided by a view plugin.
        continue;
      }

      const className = LINE_CLASS[line.kind];
      if (className) {
        collected.push(
          lineDecoration(
            className,
            line.kind !== 'character' && line.kind !== 'scene_heading',
            line.kind === 'scene_heading' ? sceneNumbers.get(line.line) : undefined,
          ).range(line.from),
        );
      }

      // Emphasis only means something on elements that are actually rendered.
      if (
        line.kind === 'action' ||
        line.kind === 'dialogue' ||
        line.kind === 'scene_heading' ||
        line.kind === 'centered' ||
        line.kind === 'lyrics'
      ) {
        collectEmphasis(view.state, line, collected);
      }
    }
  }

  for (const annotation of annotations) {
    if (annotation.to <= from0(view) || annotation.from >= to0(view)) continue;
    if (annotation.kind === 'note') {
      collected.push((visibility.showNotes ? NOTE : HIDDEN).range(annotation.from, annotation.to));
    } else {
      collected.push(
        (visibility.showBoneyard ? BONEYARD : HIDDEN).range(annotation.from, annotation.to),
      );
    }
  }

  // RangeSetBuilder requires sorted insertion; line and mark decorations were
  // collected in two passes, hence the final sort.
  collected.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);

  const builder = new RangeSetBuilder<Decoration>();
  for (const range of collected) builder.add(range.from, range.to, range.value);
  return builder.finish();
}

function from0(view: EditorView): number {
  return view.visibleRanges[0]?.from ?? 0;
}

function to0(view: EditorView): number {
  const ranges = view.visibleRanges;
  return ranges[ranges.length - 1]?.to ?? view.state.doc.length;
}

function collectEmphasis(state: EditorState, line: LexedLine, out: Array<Range<Decoration>>): void {
  const raw = state.doc.sliceString(line.from, line.to);
  const at = raw.indexOf(line.text);
  const offset = at === -1 ? line.from : line.from + at;

  for (const span of parseInline(line.text, offset)) {
    if (!span.bold && !span.italic && !span.underline) continue;
    if (span.from >= span.to) continue;

    const decoration =
      span.bold && span.italic && span.underline
        ? BOLD_ITALIC_UNDERLINE
        : span.bold && span.underline
          ? BOLD_UNDERLINE
          : span.italic && span.underline
            ? ITALIC_UNDERLINE
            : span.bold && span.italic
              ? BOLD_ITALIC
              : span.bold
                ? BOLD
                : span.italic
                  ? ITALIC
                  : UNDERLINE;
    out.push(decoration.range(span.from, span.to));
  }
}

const decorationPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate): void {
      // The viewport changes on scroll: redecorate even without a document change.
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.transactions.some((t) => t.effects.some((e) => e.is(setVisibility)))
      ) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

export function fountainHighlight(): Extension {
  return [visibilityField, fountainLexField, hiddenLinesField, decorationPlugin];
}
