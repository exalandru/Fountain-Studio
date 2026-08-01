import { useCallback } from 'react';
import type { RefObject } from 'react';
import { isolateHistory, redo, undo } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import { planSceneMove, planSynopsisEdit } from '@shared/corkboard/index.js';
import { parse } from '@shared/fountain/index.js';
import type { Translator } from '@shared/i18n/index.js';

/**
 * Corkboard document operations.
 *
 * The board takes focus away from the editor, so undo/redo and scene moves must go
 * through the shared `editorView` rather than through native Edit-menu roles.
 */
export function useCorkboardActions(
  editorView: RefObject<EditorView | null>,
  showSynopses: boolean,
  t: Translator['t'],
  setStatus: (message: string) => void,
) {
  const undoEdit = useCallback(() => {
    const view = editorView.current;
    if (view) undo(view);
  }, [editorView]);
  const redoEdit = useCallback(() => {
    const view = editorView.current;
    if (view) redo(view);
  }, [editorView]);

  const moveScene = useCallback(
    (sceneId: string, targetSceneId: string) => {
      const view = editorView.current;
      if (!view) return;
      const source = view.state.doc.toString();
      const scenes = parse(source).scenes;
      const fromIndex = scenes.findIndex((scene) => scene.id === sceneId);
      const targetIndex = scenes.findIndex((scene) => scene.id === targetSceneId);
      if (fromIndex < 0 || targetIndex < 0) return;
      const plan = planSceneMove(source, scenes, fromIndex, targetIndex);
      if (!plan) return;
      view.dispatch({
        changes: plan.changes,
        selection: { anchor: plan.caret },
        annotations: isolateHistory.of('full'),
      });
      const scene = scenes[fromIndex];
      if (scene) {
        setStatus(t('corkboard.moved', { number: scene.number, position: targetIndex + 1 }));
      }
    },
    [editorView, setStatus, t],
  );

  const editSceneSynopsis = useCallback(
    (sceneId: string, text: string) => {
      const view = editorView.current;
      if (!view) return;
      const source = view.state.doc.toString();
      const scene = parse(source).scenes.find((candidate) => candidate.id === sceneId);
      if (!scene) return;
      const heading = scene.elements[0];
      const synopsis = scene.elements.find((element) => element.kind === 'synopsis');
      const edit = planSynopsisEdit(
        source,
        {
          headingTo: heading?.range.to ?? scene.range.from,
          synopsis: synopsis ? { ...synopsis.range } : null,
        },
        text,
      );
      if (!edit) return;
      view.dispatch({ changes: edit, annotations: isolateHistory.of('full') });
      if (!showSynopses) setStatus(t('corkboard.synopsisHidden'));
    },
    [editorView, setStatus, showSynopses, t],
  );

  return { undoEdit, redoEdit, moveScene, editSceneSynopsis };
}
