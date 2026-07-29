import { useEffect, useRef } from 'react';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { codeFolding, foldGutter, foldKeymap } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState } from '@codemirror/state';
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
import { fountainHighlight, setVisibility } from './fountain-highlight.js';
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
  showSynopses: boolean;
  showSections: boolean;
  onChange: (content: string) => void;
  onViewReady?: (view: EditorView | null) => void;
}

export function Editor({
  documentId,
  initialContent,
  dark,
  fontSize,
  showNotes,
  showSynopses,
  showSections,
  onChange,
  onViewReady,
}: EditorProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const themeCompartment = useRef(new Compartment());
  // The callback is held in a ref: threading it through the extensions would rebuild
  // the editor on every render. The ref is updated in an effect, never during render —
  // the editor only emits a change after user interaction, well after effects have run.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

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
        fountainHighlight(),
        fountainFolding(),
        fountainCompletion(),
        themeCompartment.current.of(dark ? darkTheme : lightTheme),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        }),
      ],
    });

    const instance = new EditorView({ state, parent: host.current });
    view.current = instance;
    onViewReady?.(instance);
    instance.focus();

    return () => {
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
      effects: setVisibility.of({ showNotes, showSynopses, showSections }),
    });
  }, [showNotes, showSynopses, showSections]);

  useEffect(() => {
    host.current?.style.setProperty('--editor-font-size', `${fontSize}px`);
  }, [fontSize]);

  return <div className="editor-host" ref={host} />;
}
