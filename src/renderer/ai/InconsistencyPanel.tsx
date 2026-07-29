import { useEffect, useMemo, useRef, useState } from 'react';
import type { ParseResponse } from '@shared/analysis/index.js';
import type { InconsistencyState } from '@shared/appdata/index.js';
import type {
  AiInconsistency,
  InconsistencyMode,
  InconsistencySeverity,
  InconsistencyStatus,
  InconsistencyType,
} from '@shared/ai/index.js';
import {
  approximateTokens,
  buildFactCrossCheckPrompt,
  buildFactExtractionPrompt,
  buildInconsistencyPrompt,
  chunkScenes,
  INCONSISTENCY_SYSTEM_PROMPT,
  parseInconsistencies,
} from '@shared/ai/index.js';
import type { Translator } from '@shared/i18n/index.js';
import type { AiRequestHandle } from './request.js';
import { startCollectedAiRequest } from './request.js';

interface InconsistencyPanelProps {
  screenplay: string;
  analysis: ParseResponse | null;
  activeSceneId: string | null;
  state: InconsistencyState;
  t: Translator['t'];
  getSelection: () => string;
  onStateChange: (state: InconsistencyState) => void;
  onSelectReference: (reference: { sceneNumber: string; heading: string }) => void;
}

const TYPES: Array<'all' | InconsistencyType> = [
  'all',
  'continuity',
  'chronology',
  'character',
  'location',
  'plot',
  'dialogue',
];
const SEVERITIES: Array<'all' | InconsistencySeverity> = ['all', 'info', 'minor', 'major'];

export function InconsistencyPanel({
  screenplay,
  analysis,
  activeSceneId,
  state,
  t,
  getSelection,
  onStateChange,
  onSelectReference,
}: InconsistencyPanelProps) {
  const requestRef = useRef<AiRequestHandle | null>(null);
  const cancelled = useRef(false);
  const [mode, setMode] = useState<InconsistencyMode>('screenplay');
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<'all' | InconsistencyType>('all');
  const [severityFilter, setSeverityFilter] = useState<'all' | InconsistencySeverity>('all');

  useEffect(
    () => () => {
      cancelled.current = true;
      void requestRef.current?.cancel();
    },
    [],
  );

  const activeScene = analysis?.scenes.find((scene) => scene.id === activeSceneId) ?? null;
  const filtered = useMemo(
    () =>
      state.items.filter(
        (item) =>
          (typeFilter === 'all' || item.type === typeFilter) &&
          (severityFilter === 'all' || item.severity === severityFilter),
      ),
    [severityFilter, state.items, typeFilter],
  );

  const request = async (profileId: string, prompt: string, label: string): Promise<string> => {
    if (cancelled.current) throw new Error(t('ai.error.cancelled'));
    setPhase(label);
    const handle = startCollectedAiRequest(
      {
        requestId: `consistency-${crypto.randomUUID()}`,
        profileId,
        mode: 'factual',
        temperature: 0.2,
        systemPrompt: INCONSISTENCY_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      },
      (next) => {
        if (next === 'reasoning') setPhase(t('ai.chat.reasoning'));
      },
    );
    requestRef.current = handle;
    return handle.promise;
  };

  const analyse = async () => {
    if (!analysis || running) return;
    const selection = getSelection();
    const target =
      mode === 'scene' && activeScene
        ? screenplay.slice(activeScene.range.from, activeScene.range.to)
        : mode === 'selection'
          ? selection
          : '';
    if ((mode === 'scene' && !activeScene) || (mode === 'selection' && !selection)) {
      setError(t(mode === 'scene' ? 'consistency.noScene' : 'consistency.noSelection'));
      return;
    }

    setRunning(true);
    setError(null);
    cancelled.current = false;
    try {
      const config = await window.quantum.invoke('ai:config:get', undefined);
      let output = '';
      if (approximateTokens(screenplay) <= 50_000) {
        output = await request(
          config.activeProfileId,
          buildInconsistencyPrompt(mode, screenplay, target),
          t('consistency.directPass'),
        );
      } else {
        const chunks = chunkScenes(
          analysis.scenes.map((scene) => ({
            content: screenplay.slice(scene.range.from, scene.range.to),
          })),
        );
        const facts: string[] = [];
        for (const [index, chunk] of chunks.entries()) {
          facts.push(
            await request(
              config.activeProfileId,
              buildFactExtractionPrompt(chunk),
              t('consistency.factPass', { current: index + 1, count: chunks.length }),
            ),
          );
        }
        output = await request(
          config.activeProfileId,
          buildFactCrossCheckPrompt(mode, facts.join('\n'), target),
          t('consistency.crossCheck'),
        );
      }
      const items = parseInconsistencies(output);
      if (items.length === 0 && !output.includes('"items":[]')) {
        throw new Error(t('consistency.invalidResponse'));
      }
      onStateChange({ items, analyzedAt: Date.now() });
    } catch (reason) {
      if (!cancelled.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      requestRef.current = null;
      setRunning(false);
      setPhase('');
    }
  };

  const stop = async () => {
    cancelled.current = true;
    await requestRef.current?.cancel();
    setRunning(false);
    setPhase('');
  };

  const setStatus = (id: string, status: InconsistencyStatus) => {
    onStateChange({
      ...state,
      items: state.items.map((item) => (item.id === id ? { ...item, status } : item)),
    });
  };

  return (
    <section className="consistency-pane">
      <h2 className="consistency-heading">{t('consistency.title')}</h2>
      <div className="consistency-controls">
        <div className="ai-mode-switch">
          {(['screenplay', 'scene', 'selection'] as const).map((value) => (
            <button
              type="button"
              key={value}
              className={mode === value ? 'active' : ''}
              onClick={() => setMode(value)}
            >
              {t(`consistency.mode.${value}`)}
            </button>
          ))}
        </div>
        {running ? (
          <button type="button" className="ai-primary" onClick={() => void stop()}>
            {t('ai.chat.stop')} · {phase}
          </button>
        ) : (
          <button type="button" className="ai-primary" onClick={() => void analyse()}>
            {t('consistency.analyse')}
          </button>
        )}
        <p>{t('consistency.warning')}</p>
        {error ? <p className="ai-warning">{error}</p> : null}
      </div>
      <div className="consistency-filters">
        <select
          value={typeFilter}
          onChange={(event) => setTypeFilter(event.target.value as typeof typeFilter)}
        >
          {TYPES.map((value) => (
            <option key={value} value={value}>
              {t(`consistency.type.${value}`)}
            </option>
          ))}
        </select>
        <select
          value={severityFilter}
          onChange={(event) => setSeverityFilter(event.target.value as typeof severityFilter)}
        >
          {SEVERITIES.map((value) => (
            <option key={value} value={value}>
              {t(`consistency.severity.${value}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="consistency-results">
        {filtered.length === 0 ? (
          <div className="panel-placeholder">
            {state.analyzedAt ? t('consistency.empty') : t('consistency.notAnalysed')}
          </div>
        ) : (
          filtered.map((item: AiInconsistency) => (
            <article key={item.id} className={`consistency-item severity-${item.severity}`}>
              <div className="consistency-item-heading">
                <strong>{t(`consistency.type.${item.type}`)}</strong>
                <span>{t(`consistency.severity.${item.severity}`)}</span>
              </div>
              <p>{item.description}</p>
              {item.references.map((reference, index) => (
                <button
                  type="button"
                  className="consistency-reference"
                  key={`${reference.sceneNumber}-${index}`}
                  onClick={() => onSelectReference(reference)}
                >
                  {reference.sceneNumber} · {reference.heading}
                  <small>{reference.quote}</small>
                </button>
              ))}
              {item.suggestion ? <p className="consistency-suggestion">{item.suggestion}</p> : null}
              <select
                value={item.status}
                onChange={(event) => setStatus(item.id, event.target.value as InconsistencyStatus)}
              >
                <option value="open">{t('consistency.status.open')}</option>
                <option value="ignored">{t('consistency.status.ignored')}</option>
                <option value="resolved">{t('consistency.status.resolved')}</option>
              </select>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
