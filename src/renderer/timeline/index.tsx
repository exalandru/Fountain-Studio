import { memo, useEffect, useRef } from 'react';
import type { ParseResponse } from '@shared/analysis/index.js';
import type { TimelineState } from '@shared/appdata/index.js';
import { sceneColor } from '../scene-color.js';
import { useTranslator } from '../hooks/useTranslator.js';
import { CloseButton } from '../ui/CloseButton.js';
import { Field } from '../ui/Field.js';
import { Select } from '../ui/Select.js';

interface TimelineProps {
  analysis: ParseResponse | null;
  state: TimelineState;
  activeSceneId: string | null;
  onStateChange: (patch: Partial<TimelineState>) => void;
  onSelectRange: (range: { from: number; to: number }) => void;
  onClose: () => void;
}

export const Timeline = memo(function Timeline({
  analysis,
  state,
  activeSceneId,
  onStateChange,
  onSelectRange,
  onClose,
}: TimelineProps) {
  const { t } = useTranslator();
  const activeRef = useRef<HTMLButtonElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const el = activeRef.current;
    const track = trackRef.current;
    if (!el || !track) return;

    // Keep scrolling inside the track only. Element.scrollIntoView({ inline: 'center' })
    // also scrolls overflow:hidden ancestors (e.g. .app), which shifts the whole layout
    // and leaves an empty band on the right — especially near the end of the track.
    const elRect = el.getBoundingClientRect();
    const trackRect = track.getBoundingClientRect();
    const delta = elRect.left + elRect.width / 2 - (trackRect.left + trackRect.width / 2);
    const max = Math.max(0, track.scrollWidth - track.clientWidth);
    const next = Math.max(0, Math.min(max, track.scrollLeft + delta));
    track.scrollTo({ left: next, behavior: reduced ? 'auto' : 'smooth' });
  }, [activeSceneId]);

  return (
    <section className="timeline" aria-label={t('timeline.title')}>
      <header className="timeline-toolbar">
        <strong>{t('timeline.title')}</strong>
        <Field label={t('timeline.colors')}>
          <Select
            scale="compact"
            value={state.colorMode}
            onChange={(event) =>
              onStateChange({
                colorMode: event.target.value as TimelineState['colorMode'],
              })
            }
          >
            <option value="intExt">{t('timeline.intExt')}</option>
            <option value="timeOfDay">{t('timeline.dayNight')}</option>
          </Select>
        </Field>
        <label className="panel-checkbox">
          <input
            type="checkbox"
            checked={state.uniformWidth}
            onChange={(event) => onStateChange({ uniformWidth: event.target.checked })}
          />
          {t('timeline.uniform')}
        </label>
        <label className="timeline-zoom">
          <span>{t('timeline.zoom')}</span>
          <input
            type="range"
            min={0.5}
            max={2.5}
            step={0.1}
            value={state.zoom}
            onChange={(event) => onStateChange({ zoom: Number(event.target.value) })}
          />
        </label>
        <CloseButton label={t('timeline.close')} onClick={onClose} />
      </header>
      <div
        className="timeline-track"
        ref={trackRef}
        // A plain wheel scrolls the timeline sideways. Most mice have no horizontal wheel, and
        // there is nothing to scroll vertically here, so a vertical turn is unambiguous. A
        // trackpad's own horizontal gesture already arrives as deltaX and is left alone.
        onWheel={(event) => {
          const track = trackRef.current;
          if (track === null) return;
          if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
          const before = track.scrollLeft;
          track.scrollLeft += event.deltaY;
          // Only claim the gesture when it moved something: at either end the page should
          // still be free to scroll.
          if (track.scrollLeft !== before) event.preventDefault();
        }}
      >
        {analysis?.scenes.map((scene, index) => {
          const statistic = analysis.statistics.scenes[index];
          const eighths = statistic?.eighths ?? 1;
          const width = (state.uniformWidth ? 88 : Math.max(44, eighths * 16)) * state.zoom;
          const section = scene.sectionPath.at(-1);
          const duration = statistic?.estimatedMinutes ?? 0;
          const label = `${scene.number}. ${scene.heading} — ${duration} ${t('stats.minutes')}${
            scene.synopsis ? ` — ${scene.synopsis}` : ''
          }`;
          const active = scene.id === activeSceneId;

          return (
            <button
              key={scene.id}
              ref={active ? activeRef : null}
              type="button"
              className={`timeline-scene timeline-${sceneColor(scene, state.colorMode) ?? 'other'}${
                active ? ' timeline-active' : ''
              }`}
              style={{ width }}
              aria-label={label}
              title={label}
              onClick={() => onSelectRange(scene.range)}
            >
              {section ? <span className="timeline-section">{section}</span> : null}
              <strong>{scene.number}</strong>
              <span>{scene.heading}</span>
            </button>
          );
        })}
        {analysis && analysis.scenes.length === 0 ? (
          <span className="timeline-empty">{t('timeline.empty')}</span>
        ) : null}
      </div>
      <div className="timeline-legend" aria-hidden="true">
        {state.colorMode === 'intExt' ? (
          <>
            <span className="timeline-interior">INT</span>
            <span className="timeline-exterior">EXT</span>
            <span className="timeline-mixed">INT/EXT</span>
          </>
        ) : (
          <>
            <span className="timeline-day">{t('stats.day')}</span>
            <span className="timeline-night">{t('stats.night')}</span>
            <span className="timeline-other">{t('timeline.other')}</span>
          </>
        )}
      </div>
    </section>
  );
});
