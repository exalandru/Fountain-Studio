import { useEffect, useMemo, useRef, useState } from 'react';
import type { InconsistencyState } from '@shared/appdata/index.js';
import type { AiInconsistency, InconsistencyStatus } from '@shared/ai/index.js';
import {
  approximateTokens,
  buildCharacterVoiceContext,
  buildVoiceConsistencyPrompt,
  voiceConsistencySystemPrompt,
  parseInconsistencies,
} from '@shared/ai/index.js';
import type { ParseResponse } from '@shared/analysis/index.js';
import type { Locale, Translator } from '@shared/i18n/index.js';
import type { AiRequestHandle } from './request.js';
import { startCollectedAiRequest } from './request.js';

interface VoiceConsistencyPanelProps {
  /** `null` until the first analysis lands; the character list comes from it. */
  analysis: ParseResponse | null;
  /** One entry per character, so each voice keeps its own findings. */
  state: Record<string, InconsistencyState>;
  t: Translator['t'];
  locale: Locale;
  onStateChange: (characterName: string, state: InconsistencyState) => void;
  onSelectReference: (reference: { sceneNumber: string; heading: string }) => void;
  onClose: () => void;
}

export function VoiceConsistencyPanel({
  analysis,
  state,
  t,
  locale,
  onStateChange,
  onSelectReference,
  onClose,
}: VoiceConsistencyPanelProps) {
  const requestRef = useRef<AiRequestHandle | null>(null);
  const cancelled = useRef(false);
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState('');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [selectedCharacter, setSelectedCharacter] = useState<string | null>(null);

  // Speaking characters only, and the busiest first: that is the order in which a writer
  // wonders whether a voice holds together.
  const characters = useMemo(
    () =>
      (analysis?.characters ?? [])
        .filter((character) => character.speeches > 0)
        .map((character) => character.name),
    [analysis],
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

  const currentItems = useMemo(() => {
    if (!selectedCharacter) return [];
    return state[selectedCharacter]?.items || [];
  }, [selectedCharacter, state]);

  const request = async (profileId: string, prompt: string, label: string): Promise<string> => {
    if (cancelled.current) throw new Error(t('ai.error.cancelled'));
    setPhase(label);
    const handle = startCollectedAiRequest(
      {
        requestId: `voice-${crypto.randomUUID()}`,
        profileId,
        mode: 'factual',
        temperature: 0.2,
        systemPrompt: voiceConsistencySystemPrompt(locale),
        messages: [{ role: 'user', content: prompt }],
      },
      (next) => {
        if (next === 'reasoning') setPhase(t('ai.request.reasoning'));
      },
    );
    requestRef.current = handle;
    return handle.promise;
  };

  const analyse = async () => {
    if (!selectedCharacter || running || !analysis) return;

    setRunning(true);
    setElapsedSeconds(0);
    setError(null);
    cancelled.current = false;
    try {
      const config = await window.quantum.invoke('ai:config:get', undefined);
      // `AnalyzedScene` holds indexes into the flat element list rather than a nested AST,
      // so the scene's own elements are gathered here.
      const scenes = analysis.scenes.map((scene) => ({
        number: scene.number,
        heading: scene.heading,
        location: scene.location,
        elements: scene.elementIndexes.flatMap((index) => {
          const element = analysis.elements[index];
          return element ? [element] : [];
        }),
      }));
      const context = buildCharacterVoiceContext(scenes, selectedCharacter);

      // Judging a voice means holding all of it at once, so this analysis is deliberately
      // never chunked. The guard is a safety net, at the same threshold as the inconsistency
      // report: no real character speaks anywhere near this much.
      if (approximateTokens(context) > 50_000) {
        throw new Error(t('ai.error.tooLong'));
      }

      const output = await request(
        config.activeProfileId,
        buildVoiceConsistencyPrompt(selectedCharacter, context),
        t('voice.analysing', { character: selectedCharacter }),
      );

      const items = parseInconsistencies(output);
      onStateChange(selectedCharacter, { items, analyzedAt: Date.now() });
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
    if (!selectedCharacter) return;
    const charState = state[selectedCharacter] || { items: [], analyzedAt: 0 };
    onStateChange(selectedCharacter, {
      ...charState,
      items: charState.items.map((item) => (item.id === id ? { ...item, status } : item)),
    });
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="consistency-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('voice.title')}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
        }}
      >
        <header>
          <div>
            <h2>{t('voice.title')}</h2>
            <p>{t('voice.subtitle')}</p>
          </div>
          <button
            type="button"
            className="panel-close"
            aria-label={t('voice.close')}
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className="consistency-pane">
          <div className="voice-controls">
            <select
              value={selectedCharacter || ''}
              onChange={(event) => setSelectedCharacter(event.target.value || null)}
              disabled={running}
            >
              <option value="">{t('voice.selectCharacter')}</option>
              {characters.map((char) => (
                <option key={char} value={char}>
                  {char}
                </option>
              ))}
            </select>

            {selectedCharacter && !running && (
              <button type="button" className="ai-primary" onClick={() => void analyse()}>
                {t('voice.analyse')}
              </button>
            )}

            {running && (
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
            )}
            {error ? <p className="ai-warning">{error}</p> : null}
          </div>

          <div className="consistency-results">
            {!selectedCharacter ? (
              <div className="panel-placeholder">{t('voice.selectFirst')}</div>
            ) : currentItems.length === 0 ? (
              <div className="panel-placeholder">
                {state[selectedCharacter]?.analyzedAt
                  ? t('consistency.empty')
                  : t('voice.notAnalysed')}
              </div>
            ) : (
              currentItems.map((item: AiInconsistency) => (
                <article key={item.id} className={`consistency-item severity-${item.severity}`}>
                  <div className="consistency-item-heading">
                    <strong>{t('consistency.type.voice')}</strong>
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
