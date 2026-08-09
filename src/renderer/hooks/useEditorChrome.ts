import { useCallback, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { EditorView } from '@codemirror/view';
import type { ParseResponse } from '@shared/analysis/index.js';
import type { Translator } from '@shared/i18n/index.js';
import { useDocuments } from '../store/documents.js';

/**
 * Editor chrome: cursor, selection, scroll sync, the CodeMirror view ref, and inline
 * formatting. Everything that mutates the document through the view shares `editorView`.
 */
export function useEditorChrome(
  activeId: string | null,
  analysis: ParseResponse | null,
  t: Translator['t'],
  setStatus: (message: string) => void,
) {
  const store = useDocuments.getState;
  const editorView = useRef<EditorView | null>(null);
  const [cursorPosition, setCursorPosition] = useState<{
    documentId: string | null;
    offset: number;
  }>({ documentId: null, offset: 0 });
  const [editorSelection, setEditorSelection] = useState<{
    documentId: string | null;
    from: number;
    to: number;
  }>({ documentId: null, from: 0, to: 0 });
  const [editorScrollPosition, setEditorScrollPosition] = useState<{
    documentId: string | null;
    offset: number;
  }>({ documentId: null, offset: 0 });
  const [previewScrollPosition, setPreviewScrollPosition] = useState<{
    documentId: string | null;
    offset: number;
  }>({ documentId: null, offset: 0 });

  const cursorOffset = cursorPosition.documentId === activeId ? cursorPosition.offset : 0;

  const formattingActive = useMemo(() => {
    const range =
      editorSelection.documentId === activeId
        ? editorSelection
        : { documentId: activeId, from: cursorOffset, to: cursorOffset };
    const spans =
      analysis?.elements.flatMap((element) =>
        element.inline.filter((span) =>
          range.from === range.to
            ? range.from >= span.from && range.from <= span.to
            : span.from <= range.from && span.to >= range.to,
        ),
      ) ?? [];
    return {
      bold: spans.some((span) => span.bold),
      italic: spans.some((span) => span.italic),
      underline: spans.some((span) => span.underline),
    };
  }, [activeId, analysis?.elements, cursorOffset, editorSelection]);

  const handleEditorChange = useCallback(
    (documentId: string, content: string) => {
      store().setContent(documentId, content);
    },
    [store],
  );
  const handleCursorOffset = useCallback(
    (documentId: string, offset: number) => setCursorPosition({ documentId, offset }),
    [],
  );
  const handleSelectionRange = useCallback(
    (documentId: string, range: { from: number; to: number }) =>
      setEditorSelection({ documentId, ...range }),
    [],
  );
  const handleEditorScroll = useCallback(
    (documentId: string, offset: number) => {
      const current = store().documents.find((document) => document.id === documentId);
      if (current?.appData.preview.syncScroll) {
        setEditorScrollPosition({ documentId, offset });
      }
    },
    [store],
  );
  const handlePreviewScroll = useCallback(
    (offset: number) => setPreviewScrollPosition({ documentId: store().activeId, offset }),
    [store],
  );
  const handleViewReady = useCallback((view: EditorView | null) => {
    editorView.current = view;
  }, []);
  const selectEditorRange = useCallback((range: { from: number; to: number }) => {
    const view = editorView.current;
    if (!view) return;
    view.dispatch({
      selection: { anchor: range.from },
      effects: EditorView.scrollIntoView(range.from, { y: 'center' }),
    });
    view.focus();
  }, []);
  const formatSelection = useCallback(
    (marker: '*' | '**' | '_') => {
      const view = editorView.current;
      if (!view) return;
      const selection = view.state.selection.main;
      if (selection.empty) {
        setStatus(t('formatting.selectText'));
        return;
      }
      const text = view.state.sliceDoc(selection.from, selection.to);
      const before = view.state.sliceDoc(
        Math.max(0, selection.from - marker.length),
        selection.from,
      );
      const after = view.state.sliceDoc(
        selection.to,
        Math.min(view.state.doc.length, selection.to + marker.length),
      );
      if (before === marker && after === marker) {
        view.dispatch({
          changes: [
            { from: selection.from - marker.length, to: selection.from, insert: '' },
            { from: selection.to, to: selection.to + marker.length, insert: '' },
          ],
          selection: {
            anchor: selection.from - marker.length,
            head: selection.to - marker.length,
          },
        });
        view.focus();
        return;
      }
      const insert = `${marker}${text}${marker}`;
      view.dispatch({
        changes: { from: selection.from, to: selection.to, insert },
        selection: {
          anchor: selection.from + marker.length,
          head: selection.from + marker.length + text.length,
        },
      });
      view.focus();
    },
    [setStatus, t],
  );

  return {
    editorView: editorView as RefObject<EditorView | null>,
    cursorOffset,
    editorScrollPosition,
    previewScrollPosition,
    formattingActive,
    handleEditorChange,
    handleCursorOffset,
    handleSelectionRange,
    handleEditorScroll,
    handlePreviewScroll,
    handleViewReady,
    selectEditorRange,
    formatSelection,
  };
}
