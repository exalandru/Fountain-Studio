import { memo, useEffect, useRef } from 'react';
import type { ParseResponse } from '@shared/analysis/index.js';
import type { TimelineState } from '@shared/appdata/index.js';
import { classifyTimeOfDay } from '@shared/fountain/index.js';
import { useTranslator } from '../hooks/useTranslator.js';

interface TimelineProps {
  analysis: ParseResponse | null;
  state: TimelineState;
  activeSceneId: string | null;
  onStateChange: (patch: Partial<TimelineState>) => void;
  onSelectRange: (range: { from: number; to: number }) => void;
  onClose: () => void;
}

function sceneColor(
  scene: ParseResponse['scenes'][number],
  mode: TimelineState['colorMode'],
): string {
  if (mode === 'timeOfDay') return classifyTimeOfDay(scene.timeOfDay);
  if (scene.intExt === 'INT') return 'interior';
  if (scene.intExt === 'EXT' || scene.intExt === 'EST') return 'exterior';
  if (scene.intExt === 'INT/EXT') return 'mixed';
  return 'other';
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

  useEffect(() => {
    activeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }, [activeSceneId]);

  return (
    <section className="timeline" aria-label={t('timeline.title')}>
      <header className="timeline-toolbar">
        <strong>{t('timeline.title')}</strong>
        <label>
          <span>{t('timeline.colors')}</span>
          <select
            value={state.colorMode}
            onChange={(event) =>
              onStateChange({
                colorMode: event.target.value as TimelineState['colorMode'],
              })
            }
          >
            <option value="intExt">{t('timeline.intExt')}</option>
            <option value="timeOfDay">{t('timeline.dayNight')}</option>
          </select>
        </label>
        <label className="timeline-check">
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
        <button
          type="button"
          className="panel-close"
          aria-label={t('timeline.close')}
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <div className="timeline-track">
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
              className={`timeline-scene timeline-${sceneColor(scene, state.colorMode)}${
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
