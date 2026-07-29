import { memo } from 'react';
import type { ScreenplayStatistics } from '@shared/stats/index.js';
import { useTranslator } from '../hooks/useTranslator.js';

interface StatsPanelProps {
  statistics: ScreenplayStatistics | null;
  minutesPerPage: number;
  onExport: (format: 'csv' | 'json') => void;
  onMinutesPerPage: (value: number) => void;
}

function SplitBar({
  left,
  right,
  leftLabel,
  rightLabel,
}: {
  left: number;
  right: number;
  leftLabel: string;
  rightLabel: string;
}) {
  return (
    <div className="stats-chart">
      <div className="stats-chart-labels">
        <span>
          {leftLabel} {left}%
        </span>
        <span>
          {rightLabel} {right}%
        </span>
      </div>
      <svg
        viewBox="0 0 100 8"
        role="img"
        aria-label={`${leftLabel} ${left}%, ${rightLabel} ${right}%`}
      >
        <rect width="100" height="8" rx="4" className="stats-chart-track" />
        <rect width={left} height="8" rx="4" className="stats-chart-primary" />
      </svg>
    </div>
  );
}

/** M3 statistics panel; every value comes from the production pagination worker. */
export const StatsPanel = memo(function StatsPanel({
  statistics,
  minutesPerPage,
  onExport,
  onMinutesPerPage,
}: StatsPanelProps) {
  const { t } = useTranslator();

  return (
    <section className="stats-pane" aria-label={t('stats.title')}>
      {!statistics ? (
        <div className="panel-placeholder">{t('stats.loading')}</div>
      ) : (
        <div className="stats-scroll">
          <div className="stats-summary">
            <div>
              <strong>{statistics.pageCount}</strong>
              <span>{t('stats.pages')}</span>
            </div>
            <div>
              <strong>{statistics.sceneCount}</strong>
              <span>{t('stats.scenes')}</span>
            </div>
            <div>
              <strong>{statistics.wordCount}</strong>
              <span>{t('stats.words')}</span>
            </div>
            <div>
              <strong>{statistics.estimatedMinutes}</strong>
              <span>{t('stats.minutes')}</span>
            </div>
            <div>
              <strong>{statistics.characterCount}</strong>
              <span>{t('stats.characters')}</span>
            </div>
            <div>
              <strong>{statistics.locationCount}</strong>
              <span>{t('stats.locations')}</span>
            </div>
            <div>
              <strong>{statistics.speechCount}</strong>
              <span>{t('stats.speeches')}</span>
            </div>
          </div>

          <label className="stats-ratio">
            <span>{t('stats.minutesPerPage')}</span>
            <input
              type="number"
              min={0.1}
              max={10}
              step={0.1}
              value={minutesPerPage}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isFinite(value) && value >= 0.1 && value <= 10) {
                  onMinutesPerPage(value);
                }
              }}
            />
          </label>

          <section className="stats-section">
            <h3>{t('stats.balance')}</h3>
            <SplitBar
              left={statistics.actionPercent}
              right={statistics.dialoguePercent}
              leftLabel={t('stats.action')}
              rightLabel={t('stats.dialogue')}
            />
          </section>

          <section className="stats-section">
            <h3>{t('stats.scenes')}</h3>
            <dl className="stats-breakdown">
              <div>
                <dt>INT</dt>
                <dd>{statistics.intExt.int}</dd>
              </div>
              <div>
                <dt>EXT</dt>
                <dd>{statistics.intExt.ext}</dd>
              </div>
              <div>
                <dt>INT/EXT</dt>
                <dd>{statistics.intExt.mixed}</dd>
              </div>
              <div>
                <dt>{t('stats.day')}</dt>
                <dd>{statistics.timeOfDay.day}</dd>
              </div>
              <div>
                <dt>{t('stats.night')}</dt>
                <dd>{statistics.timeOfDay.night}</dd>
              </div>
              <div>
                <dt>{t('stats.averageScene')}</dt>
                <dd>{statistics.averageSceneEighths}/8</dd>
              </div>
            </dl>
          </section>

          <section className="stats-section">
            <h3>{t('stats.characters')}</h3>
            <div className="stats-character-list">
              {statistics.characters.map((character) => (
                <div key={character.name}>
                  <strong>{character.name}</strong>
                  <span>
                    {character.speeches} {t('stats.speeches')} · {character.words}{' '}
                    {t('stats.words')}
                  </span>
                </div>
              ))}
            </div>
          </section>

          <div className="stats-actions">
            <button type="button" onClick={() => onExport('csv')}>
              {t('stats.exportCsv')}
            </button>
            <button type="button" onClick={() => onExport('json')}>
              {t('stats.exportJson')}
            </button>
          </div>
        </div>
      )}
    </section>
  );
});
