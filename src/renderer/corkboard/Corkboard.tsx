import { memo, useCallback, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { AnalyzedScene, ParseResponse } from '@shared/analysis/index.js';
import type { CorkboardState } from '@shared/appdata/index.js';
import { gapToTargetIndex } from '@shared/corkboard/index.js';
import type { Translator } from '@shared/i18n/index.js';
import { sceneColor } from '../scene-color.js';

interface CorkboardProps {
  analysis: ParseResponse | null;
  state: CorkboardState;
  activeSceneId: string | null;
  t: Translator['t'];
  onStateChange: (patch: Partial<CorkboardState>) => void;
  onMoveScene: (sceneId: string, targetSceneId: string) => void;
  onEditSynopsis: (sceneId: string, text: string) => void;
  onSelectRange: (range: { from: number; to: number }) => void;
  onUndo: () => void;
  onRedo: () => void;
  onClose: () => void;
}

/** Travel, in pixels, below which a press stays a click. */
const DRAG_THRESHOLD = 4;

const NO_SCENES: AnalyzedScene[] = [];

/**
 * Pages and eighths, the way a schedule reads them: `2 4/8` is two pages and a half.
 *
 * Digits and a slash, so nothing to translate — the unit is spelled out in the card's
 * accessible label, where a screen reader needs the word.
 */
function eighthsLabel(eighths: number): string {
  const pages = Math.floor(eighths / 8);
  const rest = eighths % 8;
  if (pages === 0) return `${rest}/8`;
  if (rest === 0) return String(pages);
  return `${pages} ${rest}/8`;
}

interface DropPoint {
  /** Index of the card the scene would land in front of; `n` means past the last one. */
  gap: number;
  /** The card the insertion bar is drawn against, and on which side. */
  index: number;
  side: 'left' | 'right';
}

/**
 * Where the pointer says the scene should land.
 *
 * Read from the list's own children rather than from a map of refs. The board reorders, and
 * React moves a keyed node without calling its ref again — a map built at mount would keep
 * pointing at the positions the cards used to hold.
 *
 * The board wraps onto several rows, so proximity beats a row-by-row walk: the nearest card
 * centre says which card is meant, and the side the pointer sits on says which of its two gaps.
 * The bar is then drawn on that same side, next to the pointer. Drawing it in the gap itself
 * would put it at the far left of the next row whenever a row ends, which looks like a
 * different destination even though it is the same one.
 */
function dropPointAt(list: HTMLElement | null, x: number, y: number): DropPoint {
  const fallback: DropPoint = { gap: 0, index: 0, side: 'left' };
  if (list === null) return fallback;
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  let after = false;
  for (let index = 0; index < list.children.length; index++) {
    const card = list.children[index];
    if (!(card instanceof HTMLElement)) continue;
    const rect = card.getBoundingClientRect();
    const centreX = rect.left + rect.width / 2;
    const centreY = rect.top + rect.height / 2;
    const distance = (x - centreX) ** 2 + (y - centreY) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
      after = x > centreX;
    }
  }
  if (best < 0) return fallback;
  return { gap: after ? best + 1 : best, index: best, side: after ? 'right' : 'left' };
}

interface DragState {
  index: number;
  drop: DropPoint;
  originX: number;
  originY: number;
  /** True once the press has travelled far enough to be a drag. */
  moved: boolean;
}

/**
 * The corkboard: one card per scene, over the writing column.
 *
 * The board never holds the screenplay — it reads the analysis and asks the editor to rewrite
 * the document. That is what keeps a move a single undo step, and keeps this file free of any
 * knowledge of Fountain.
 *
 * Both a move and a synopsis show through immediately and are confirmed ~80 ms later, when the
 * worker has re-analysed the document. Waiting for that round trip would make every card spring
 * back before settling, which reads as a failed gesture; so each change is displayed
 * optimistically and held only against the analysis revision it was made on. The first fresher
 * analysis wins, whatever it says.
 */
export const Corkboard = memo(function Corkboard({
  analysis,
  state,
  activeSceneId,
  t,
  onStateChange,
  onMoveScene,
  onEditSynopsis,
  onSelectRange,
  onUndo,
  onRedo,
  onClose,
}: CorkboardProps) {
  const list = useRef<HTMLUListElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [order, setOrder] = useState<{ revision: number; ids: string[] } | null>(null);
  const [draft, setDraft] = useState<{
    id: string;
    text: string;
    /** The revision the text was committed on, or `null` while it is still being typed. */
    committedAt: number | null;
  } | null>(null);
  const cancelled = useRef(false);

  const revision = analysis?.revision ?? -1;
  const scenes = analysis?.scenes ?? NO_SCENES;
  const ordered = useMemo(() => {
    if (order === null || order.revision !== revision) return scenes;
    const byId = new Map(scenes.map((scene) => [scene.id, scene]));
    const list_ = order.ids.flatMap((id) => {
      const scene = byId.get(id);
      return scene ? [scene] : [];
    });
    return list_.length === scenes.length ? list_ : scenes;
  }, [order, revision, scenes]);

  // A committed draft is dropped as soon as an analysis newer than the commit arrives: from
  // then on the document itself is the better answer.
  const liveDraft =
    draft && (draft.committedAt === null || draft.committedAt === revision) ? draft : null;

  const move = useCallback(
    (from: number, to: number) => {
      const scene = ordered[from];
      const destination = ordered[to];
      if (!scene || !destination || from === to) return;
      const ids = ordered.map((candidate) => candidate.id);
      const [lifted] = ids.splice(from, 1);
      if (lifted !== undefined) ids.splice(to, 0, lifted);
      setOrder({ revision, ids });
      // Named, not numbered: positions here are the board's, and the board can be one analysis
      // behind the document. The editor resolves both ids against the screenplay as it is.
      onMoveScene(scene.id, destination.id);
    },
    [onMoveScene, ordered, revision],
  );

  const commit = useCallback(
    (scene: AnalyzedScene, text: string) => {
      setDraft({ id: scene.id, text, committedAt: revision });
      onEditSynopsis(scene.id, text);
    },
    [onEditSynopsis, revision],
  );

  /**
   * Where to draw the insertion bar, or `null` when there is nothing to show.
   *
   * Suppressed when the drop would change nothing, so hovering a card's own two gaps does not
   * promise a move that will not happen.
   */
  const indicator =
    drag !== null && drag.moved && gapToTargetIndex(drag.index, drag.drop.gap) !== drag.index
      ? drag.drop
      : null;

  return (
    <section
      className="corkboard"
      aria-label={t('corkboard.title')}
      // The board holds focus while it rewrites the document, and both usual routes to undo go
      // through the editor's own focus. Without this a run of moves could not be taken back.
      onKeyDown={(event) => {
        if (!event.metaKey && !event.ctrlKey) return;
        const key = event.key.toLowerCase();
        if (key !== 'z' && key !== 'y') return;
        event.preventDefault();
        if (key === 'y' || event.shiftKey) onRedo();
        else onUndo();
      }}
    >
      <header className="corkboard-toolbar">
        <strong>{t('corkboard.title')}</strong>
        <label>
          <span>{t('corkboard.colors')}</span>
          <select
            value={state.colorMode}
            onChange={(event) =>
              onStateChange({ colorMode: event.target.value as CorkboardState['colorMode'] })
            }
          >
            <option value="intExt">{t('timeline.intExt')}</option>
            <option value="timeOfDay">{t('timeline.dayNight')}</option>
            <option value="none">{t('corkboard.colorNone')}</option>
          </select>
        </label>
        <label className="corkboard-size">
          <span>{t('corkboard.cardWidth')}</span>
          <input
            type="range"
            min={180}
            max={420}
            step={20}
            value={state.cardWidth}
            onChange={(event) => onStateChange({ cardWidth: Number(event.target.value) })}
          />
        </label>
        <span className="corkboard-hint">{t('corkboard.moveHint')}</span>
        <button
          type="button"
          className="panel-close"
          aria-label={t('corkboard.close')}
          onClick={onClose}
        >
          ×
        </button>
      </header>

      {analysis === null ? <div className="panel-placeholder">{t('sidebar.loading')}</div> : null}
      {analysis !== null && scenes.length === 0 ? (
        <div className="panel-placeholder">{t('corkboard.empty')}</div>
      ) : null}

      <ul
        className="corkboard-grid"
        ref={list}
        style={{ '--card-width': `${state.cardWidth}px` } as CSSProperties}
        onPointerMove={(event) => {
          if (drag === null) return;
          const moved =
            drag.moved ||
            Math.abs(event.clientX - drag.originX) > DRAG_THRESHOLD ||
            Math.abs(event.clientY - drag.originY) > DRAG_THRESHOLD;
          if (!moved) return;
          const drop = dropPointAt(list.current, event.clientX, event.clientY);
          if (drop.gap !== drag.drop.gap || drop.index !== drag.drop.index || !drag.moved) {
            setDrag({ ...drag, drop, moved });
          }
        }}
        onPointerUp={() => {
          if (drag === null) return;
          setDrag(null);
          if (drag.moved) move(drag.index, gapToTargetIndex(drag.index, drag.drop.gap));
        }}
        onPointerCancel={() => setDrag(null)}
      >
        {ordered.map((scene, position) => {
          const statistic = analysis?.statistics.scenes[scene.index - 1];
          const colour = sceneColor(scene, state.colorMode);
          const section = scene.sectionPath.at(-1);
          const eighths = statistic?.eighths ?? 1;
          const editingThis = liveDraft?.id === scene.id;

          return (
            <li
              key={scene.id}
              className={[
                'corkboard-card',
                colour === null ? 'corkboard-plain' : `corkboard-${colour}`,
                scene.id === activeSceneId ? 'is-current' : '',
                drag?.moved && drag.index === position ? 'is-dragging' : '',
                indicator?.index === position && indicator.side === 'left' ? 'is-drop-before' : '',
                indicator?.index === position && indicator.side === 'right' ? 'is-drop-after' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              tabIndex={0}
              aria-label={t('corkboard.cardLabel', {
                number: scene.number,
                heading: scene.heading,
                eighths: eighthsLabel(eighths),
              })}
              onPointerDown={(event) => {
                // A press on a control is a press on that control; everything else is a handle.
                if (event.button !== 0) return;
                if (event.target instanceof Element && event.target.closest('button, textarea')) {
                  return;
                }
                event.currentTarget.setPointerCapture(event.pointerId);
                setDrag({
                  index: position,
                  drop: { gap: position, index: position, side: 'left' },
                  originX: event.clientX,
                  originY: event.clientY,
                  moved: false,
                });
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && drag !== null) {
                  setDrag(null);
                  return;
                }
                // Alt, because the arrows alone move focus between cards.
                if (!event.altKey) return;
                const step =
                  event.key === 'ArrowLeft' || event.key === 'ArrowUp'
                    ? -1
                    : event.key === 'ArrowRight' || event.key === 'ArrowDown'
                      ? 1
                      : 0;
                const target = position + step;
                if (step === 0 || target < 0 || target >= ordered.length) return;
                event.preventDefault();
                move(position, target);
              }}
            >
              <div className="corkboard-card-head">
                <span className="corkboard-number">{scene.number}</span>
                {section ? <span className="corkboard-section">{section}</span> : null}
              </div>
              <button
                type="button"
                className="corkboard-heading"
                title={t('corkboard.goToScene')}
                onClick={() => {
                  // A drag ends with a click on the card; it must not also jump to the scene.
                  if (drag?.moved) return;
                  onSelectRange(scene.range);
                }}
              >
                {scene.heading}
              </button>
              <textarea
                className="corkboard-synopsis"
                value={editingThis ? liveDraft.text : (scene.synopsis ?? '')}
                placeholder={t('corkboard.synopsisPlaceholder')}
                aria-label={t('corkboard.synopsisLabel', { heading: scene.heading })}
                onFocus={() =>
                  setDraft({ id: scene.id, text: scene.synopsis ?? '', committedAt: null })
                }
                onChange={(event) =>
                  setDraft({ id: scene.id, text: event.target.value, committedAt: null })
                }
                onBlur={() => {
                  if (cancelled.current) {
                    cancelled.current = false;
                    setDraft(null);
                    return;
                  }
                  if (editingThis && liveDraft.committedAt === null) commit(scene, liveDraft.text);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    cancelled.current = true;
                    event.currentTarget.blur();
                    return;
                  }
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    event.currentTarget.blur();
                  }
                }}
              />
              <div className="corkboard-card-foot">
                <span>{eighthsLabel(eighths)}</span>
                <span>
                  {statistic?.estimatedMinutes ?? 0} {t('stats.minutes')}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
});
