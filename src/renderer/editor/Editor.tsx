import { memo, useEffect, useRef } from 'react';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { codeFolding, foldGutter, foldKeymap } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState } from '@codemirror/state';
import type { CompletionIndex } from '@shared/analysis/index.js';
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  keymap,
  rectangularSelection,
} from '@codemirror/view';
import { fountainCompletion } from './autocomplete.js';
import { fountainFolding } from './folding.js';
import { fountainHighlight, fountainLexField, setVisibility } from './fountain-highlight.js';
import { darkTheme, lightTheme } from './theme.js';

/**
 * React wrapper around CodeMirror 6.
 *
 * The lifecycle is delicate: the CodeMirror instance must be created once per tab, and
 * prop changes (theme, visibility) go through compartments rather than rebuilding the
 * editor — otherwise the undo history and the cursor position are lost on every React
 * render.
 */

export interface EditorProps {
  documentId: string;
  initialContent: string;
  dark: boolean;
  fontSize: number;
  showNotes: boolean;
  showBoneyard: boolean;
  showSynopses: boolean;
  showSections: boolean;
  showSceneNumbers: boolean;
  typewriterMode: boolean;
  formattedMode: boolean;
  completionIndex: CompletionIndex;
  onChange: (content: string) => void;
  onCursorOffset?: (offset: number) => void;
  onSelectionRange?: (range: { from: number; to: number }) => void;
  onScrollOffset?: (offset: number) => void;
  externalScrollOffset?: number | null;
  onViewReady?: (view: EditorView | null) => void;
}

function EditorComponent({
  documentId,
  initialContent,
  dark,
  fontSize,
  showNotes,
  showBoneyard,
  showSynopses,
  showSections,
  showSceneNumbers,
  typewriterMode,
  formattedMode,
  completionIndex,
  onChange,
  onCursorOffset,
  onSelectionRange,
  onScrollOffset,
  externalScrollOffset,
  onViewReady,
}: EditorProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const themeCompartment = useRef(new Compartment());
  const completionCompartment = useRef(new Compartment());
  // The callback is held in a ref: threading it through the extensions would rebuild
  // the editor on every render. The ref is updated in an effect, never during render —
  // the editor only emits a change after user interaction, well after effects have run.
  const onChangeRef = useRef(onChange);
  const onCursorRef = useRef(onCursorOffset);
  const onSelectionRef = useRef(onSelectionRange);
  const onScrollRef = useRef(onScrollOffset);
  const suppressScroll = useRef(false);
  const typewriterRef = useRef(typewriterMode);
  const typewriterFrame = useRef(0);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  useEffect(() => {
    onCursorRef.current = onCursorOffset;
  }, [onCursorOffset]);
  useEffect(() => {
    onSelectionRef.current = onSelectionRange;
  }, [onSelectionRange]);
  useEffect(() => {
    onScrollRef.current = onScrollOffset;
  }, [onScrollOffset]);
  useEffect(() => {
    typewriterRef.current = typewriterMode;
    if (!typewriterMode) return;
    cancelAnimationFrame(typewriterFrame.current);
    typewriterFrame.current = requestAnimationFrame(() => {
      const current = view.current;
      if (!current) return;
      current.dispatch({
        effects: EditorView.scrollIntoView(current.state.selection.main.head, { y: 'center' }),
      });
    });
  }, [typewriterMode]);

  useEffect(() => {
    if (!host.current) return;

    const state = EditorState.create({
      doc: initialContent,
      extensions: [
        history(),
        drawSelection(),
        dropCursor(),
        rectangularSelection(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        closeBrackets(),
        codeFolding(),
        foldGutter({ openText: '▾', closedText: '▸' }),
        search({ top: true }),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...searchKeymap,
          indentWithTab,
        ]),
        EditorView.lineWrapping,
        // CodeMirror disables the spell checker on its contenteditable by default.
        // For a writing application the opposite is needed, so it is switched back on
        // explicitly — otherwise Electron's checker has no effect at all (M0 spike).
        EditorView.contentAttributes.of({
          spellcheck: 'true',
          autocorrect: 'off',
          autocapitalize: 'off',
        }),
        EditorView.domEventHandlers({
          contextmenu(event, currentView) {
            const position = currentView.posAtCoords({ x: event.clientX, y: event.clientY });
            if (position === null) return false;
            const line = currentView.state.doc.lineAt(position);
            const analysed = currentView.state.field(fountainLexField).lines[line.number - 1];
            if (analysed?.kind === 'character' && analysed.character) {
              const index = analysed.raw
                .toLocaleUpperCase('fr-FR')
                .indexOf(analysed.character.toLocaleUpperCase('fr-FR'));
              if (index >= 0) {
                currentView.dispatch({
                  selection: {
                    anchor: analysed.from + index,
                    head: analysed.from + index + analysed.character.length,
                  },
                });
              }
              return false;
            }

            const selection = currentView.state.selection.main;
            if (position >= selection.from && position <= selection.to && !selection.empty) {
              return false;
            }
            const wordCharacter = /[\p{L}\p{N}_'’-]/u;
            let from = position;
            let to = position;
            while (
              from > line.from &&
              wordCharacter.test(currentView.state.sliceDoc(from - 1, from))
            )
              from--;
            while (to < line.to && wordCharacter.test(currentView.state.sliceDoc(to, to + 1))) to++;
            if (to > from) currentView.dispatch({ selection: { anchor: from, head: to } });
            return false;
          },
        }),
        fountainHighlight(),
        fountainFolding(),
        completionCompartment.current.of(fountainCompletion(completionIndex)),
        themeCompartment.current.of(dark ? darkTheme : lightTheme),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          if (update.docChanged || update.selectionSet) {
            onCursorRef.current?.(update.state.selection.main.head);
            onSelectionRef.current?.({
              from: update.state.selection.main.from,
              to: update.state.selection.main.to,
            });
            const pointerSelection = update.transactions.some((transaction) =>
              transaction.isUserEvent('select.pointer'),
            );
            if (typewriterRef.current && update.state.selection.main.empty && !pointerSelection) {
              cancelAnimationFrame(typewriterFrame.current);
              typewriterFrame.current = requestAnimationFrame(() => {
                const current = view.current;
                if (!current) return;
                current.dispatch({
                  effects: EditorView.scrollIntoView(current.state.selection.main.head, {
                    y: 'center',
                  }),
                });
              });
            }
          }
        }),
      ],
    });

    const instance = new EditorView({ state, parent: host.current });
    view.current = instance;
    onViewReady?.(instance);
    onCursorRef.current?.(instance.state.selection.main.head);
    onSelectionRef.current?.({
      from: instance.state.selection.main.from,
      to: instance.state.selection.main.to,
    });

    let frame = 0;
    const handleScroll = () => {
      if (suppressScroll.current) {
        suppressScroll.current = false;
        return;
      }
      cancelAnimationFrame(frame);
      cancelAnimationFrame(typewriterFrame.current);
      frame = requestAnimationFrame(() => {
        const block = instance.lineBlockAtHeight(instance.scrollDOM.scrollTop);
        onScrollRef.current?.(block.from);
      });
    };
    instance.scrollDOM.addEventListener('scroll', handleScroll, { passive: true });
    instance.focus();

    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(typewriterFrame.current);
      instance.scrollDOM.removeEventListener('scroll', handleScroll);
      onViewReady?.(null);
      instance.destroy();
      view.current = null;
    };
    // Switching tabs should rebuild the editor: it is a different document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId]);

  // Theme: targeted reconfiguration, leaving the document and history untouched.
  useEffect(() => {
    view.current?.dispatch({
      effects: themeCompartment.current.reconfigure(dark ? darkTheme : lightTheme),
    });
  }, [dark]);

  useEffect(() => {
    view.current?.dispatch({
      effects: completionCompartment.current.reconfigure(fountainCompletion(completionIndex)),
    });
  }, [completionIndex]);

  useEffect(() => {
    view.current?.dispatch({
      effects: setVisibility.of({
        showNotes,
        showBoneyard,
        showSynopses,
        showSections,
        showSceneNumbers,
        formattedMode,
      }),
    });
  }, [formattedMode, showBoneyard, showNotes, showSceneNumbers, showSections, showSynopses]);

  useEffect(() => {
    const instance = view.current;
    if (externalScrollOffset === null || externalScrollOffset === undefined || !instance) return;
    suppressScroll.current = true;
    instance.dispatch({
      effects: EditorView.scrollIntoView(
        Math.min(instance.state.doc.length, Math.max(0, externalScrollOffset)),
        { y: 'start' },
      ),
    });
  }, [externalScrollOffset]);

  useEffect(() => {
    host.current?.style.setProperty('--editor-font-size', `${fontSize}px`);
  }, [fontSize]);

  return <div className="editor-host" ref={host} />;
}

/**
 * CodeMirror owns the live text after mounting. Zustand mirrors it for persistence,
 * but feeding that same string back as a React prop would otherwise rerender this
 * wrapper on every keystroke for no effect.
 */
export const Editor = memo(
  EditorComponent,
  (previous, next) =>
    previous.documentId === next.documentId &&
    previous.dark === next.dark &&
    previous.fontSize === next.fontSize &&
    previous.showNotes === next.showNotes &&
    previous.showBoneyard === next.showBoneyard &&
    previous.showSynopses === next.showSynopses &&
    previous.showSections === next.showSections &&
    previous.showSceneNumbers === next.showSceneNumbers &&
    previous.typewriterMode === next.typewriterMode &&
    previous.formattedMode === next.formattedMode &&
    previous.completionIndex === next.completionIndex &&
    previous.externalScrollOffset === next.externalScrollOffset &&
    previous.onChange === next.onChange &&
    previous.onCursorOffset === next.onCursorOffset &&
    previous.onScrollOffset === next.onScrollOffset &&
    previous.onViewReady === next.onViewReady,
);
