import { useEffect, useMemo, useRef, useState } from 'react';
import type { ParseResponse } from '@shared/analysis/index.js';
import type { InconsistencyState } from '@shared/appdata/index.js';
import type { AiInconsistency, InconsistencyStatus } from '@shared/ai/index.js';
import {
  buildStructuralRepetitionPrompt,
  parseInconsistencies,
  STRUCTURAL_REPETITION_SYSTEM_PROMPT,
} from '@shared/ai/index.js';
import type { SceneView } from '@shared/fountain/ast.js';
import type { Translator } from '@shared/i18n/index.js';
import type { RepeatedPhrase, RepetitionScope } from '@shared/repetition/index.js';
import { buildSceneDigest, findRepeatedPhrases } from '@shared/repetition/index.js';
import type { AiRequestHandle } from '../ai/request.js';
import { startCollectedAiRequest } from '../ai/request.js';

interface RepetitionPanelProps {
  analysis: ParseResponse | null;
  /** Structural findings, which unlike the literal ones cost a request and so are kept. */
  state: InconsistencyState;
  t: Translator['t'];
  onStateChange: (state: InconsistencyState) => void;
  onSelectRange: (range: { from: number; to: number }) => void;
  onSelectReference: (reference: { sceneNumber: string; heading: string }) => void;
  onClose: () => void;
}

type Filter = 'all' | RepetitionScope;

const FILTERS: Filter[] = ['all', 'dialogue', 'action'];

/**
 * Narrative repetition, read two ways.
 *
 * The literal half — the same words used twice — is computed here, from the AST, every time
 * the panel opens: instant, free, and it needs no API key, so a writer without one still gets
 * the analysis. The structural half — two scenes doing the same job — is a judgement, so it
 * costs a request and is asked for explicitly.
 */
export function RepetitionPanel({
  analysis,
  state,
  t,
  onStateChange,
  onSelectRange,
  onSelectReference,
  onClose,
}: RepetitionPanelProps) {
  const requestRef = useRef<AiRequestHandle | null>(null);
  const cancelled = useRef(false);
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState('');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [expanded, setExpanded] = useState<string | null>(null);

  const scenes = useMemo<SceneView[]>(
    () =>
      (analysis?.scenes ?? []).map((scene) => ({
        number: scene.number,
        heading: scene.heading,
        location: scene.location,
        elements: scene.elementIndexes.flatMap((index) => {
          const element = analysis?.elements[index];
          return element ? [element] : [];
        }),
      })),
    [analysis],
  );

  // Recomputed on open rather than on every keystroke: it is cheap, but not free, and the
  // report is read, not typed into.
  const report = useMemo(() => findRepeatedPhrases(scenes), [scenes]);

  const phrases = useMemo(
    () => report.phrases.filter((phrase) => filter === 'all' || phrase.scope === filter),
    [filter, report],
  );

  useEffect(
    () => () => {
      cancelled.current = true;
      void requestRef.current?.cancel();
    },
    [],
  );

  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    const timer = window.setInterval(
      () => setElapsedSeconds(Math.floor((Date.now() - started) / 1_000)),
      250,
    );
    return () => window.clearInterval(timer);
  }, [running]);

  const analyseStructure = async () => {
    if (running || scenes.length === 0) return;
    setRunning(true);
    setElapsedSeconds(0);
    setError(null);
    cancelled.current = false;
    setPhase(t('repetition.analysing'));
    try {
      const config = await window.quantum.invoke('ai:config:get', undefined);
      const handle = startCollectedAiRequest(
        {
          requestId: `repetition-${crypto.randomUUID()}`,
          profileId: config.activeProfileId,
          mode: 'factual',
          temperature: 0.2,
          systemPrompt: STRUCTURAL_REPETITION_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: buildStructuralRepetitionPrompt(buildSceneDigest(scenes)) }],
        },
        (next) => {
          if (next === 'reasoning') setPhase(t('ai.request.reasoning'));
        },
      );
      requestRef.current = handle;
      const items = parseInconsistencies(await handle.promise);
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

  const describe = (phrase: RepeatedPhrase): string =>
    phrase.attribution === 'signature'
      ? t('repetition.signature', { speaker: phrase.speakers[0] ?? '', count: phrase.total })
      : t('repetition.spread', { count: phrase.total });

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="consistency-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('repetition.title')}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
        }}
      >
        <header>
          <div>
            <h2>{t('repetition.title')}</h2>
            <p>{t('repetition.subtitle')}</p>
          </div>
          <button
            type="button"
            className="panel-close"
            aria-label={t('repetition.close')}
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="consistency-pane">
          <div className="repetition-controls">
            <label>
              <span className="sr-only">{t('repetition.scope')}</span>
              <select value={filter} onChange={(event) => setFilter(event.target.value as Filter)}>
                {FILTERS.map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {t(`repetition.scope.${candidate}`)}
                  </option>
                ))}
              </select>
            </label>
            <p className="repetition-count">
              {t('repetition.found', { count: phrases.length, words: report.wordCount })}
              {report.truncated ? ` · ${t('repetition.truncated')}` : ''}
            </p>
          </div>

          <div className="consistency-results">
            {phrases.length === 0 ? (
              <div className="panel-placeholder">{t('repetition.none')}</div>
            ) : (
              phrases.map((phrase) => (
                <article className="repetition-item" key={`${phrase.scope}-${phrase.phrase}`}>
                  <div className="repetition-heading">
                    <strong>{phrase.phrase}</strong>
                    <span className={`repetition-badge is-${phrase.attribution}`}>
                      {describe(phrase)}
                    </span>
                  </div>
                  <p className="repetition-meta">
                    {t('repetition.meta', { words: phrase.length, span: phrase.span })}
                  </p>
                  <button
                    type="button"
                    className="repetition-toggle"
                    aria-expanded={expanded === phrase.phrase}
                    onClick={() =>
                      setExpanded(expanded === phrase.phrase ? null : phrase.phrase)
                    }
                  >
                    {t('repetition.occurrences', { count: phrase.occurrences.length })}
                  </button>
                  {expanded === phrase.phrase ? (
                    <ul className="repetition-occurrences">
                      {phrase.occurrences.map((occurrence) => (
                        <li key={occurrence.range.from}>
                          <button type="button" onClick={() => onSelectRange(occurrence.range)}>
                            <span>
                              {occurrence.sceneNumber} · {occurrence.heading}
                              {occurrence.speaker ? ` · ${occurrence.speaker}` : ''}
                            </span>
                            <small>{occurrence.text}</small>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </article>
              ))
            )}
          </div>

          <div className="repetition-structural">
            <h3>{t('repetition.structuralTitle')}</h3>
            <p>{t('repetition.structuralHint')}</p>
            {running ? (
              <div className="consistency-running" role="status">
                <div className="consistency-orbit" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
                <div>
                  <strong>{phase || t('ai.request.reasoning')}</strong>
                  <small>
                    {t('consistency.elapsed', {
                      minutes: Math.floor(elapsedSeconds / 60),
                      seconds: String(elapsedSeconds % 60).padStart(2, '0'),
                    })}
                  </small>
                </div>
                <button type="button" onClick={() => void stop()}>
                  {t('ai.request.stop')}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="ai-primary"
                disabled={scenes.length === 0}
                onClick={() => void analyseStructure()}
              >
                {t('repetition.analyseStructure')}
              </button>
            )}
            {error ? <p className="ai-warning">{error}</p> : null}

            {state.items.length === 0 ? (
              <p className="repetition-structural-empty">
                {state.analyzedAt ? t('repetition.structuralEmpty') : t('repetition.notAnalysed')}
              </p>
            ) : (
              state.items.map((item: AiInconsistency) => (
                <article key={item.id} className={`consistency-item severity-${item.severity}`}>
                  <div className="consistency-item-heading">
                    <strong>{t('consistency.type.repetition')}</strong>
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
                  {item.suggestion ? (
                    <p className="consistency-suggestion">{item.suggestion}</p>
                  ) : null}
                  <select
                    value={item.status}
                    onChange={(event) =>
                      setStatus(item.id, event.target.value as InconsistencyStatus)
                    }
                  >
                    <option value="open">{t('consistency.status.open')}</option>
                    <option value="ignored">{t('consistency.status.ignored')}</option>
                    <option value="resolved">{t('consistency.status.resolved')}</option>
                  </select>
                </article>
              ))
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
