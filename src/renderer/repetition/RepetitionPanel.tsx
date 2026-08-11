import { useEffect, useMemo, useRef, useState } from 'react';
import type { ParseResponse } from '@shared/analysis/index.js';
import type { InconsistencyState } from '@shared/appdata/index.js';
import type { AiInconsistency, InconsistencyStatus } from '@shared/ai/index.js';
import {
  buildStructuralRepetitionPrompt,
  parseInconsistencies,
  structuralRepetitionSystemPrompt,
} from '@shared/ai/index.js';
import type { SceneView } from '@shared/fountain/ast.js';
import type { Locale, Translator } from '@shared/i18n/index.js';
import { parse } from '@shared/fountain/index.js';
import {
  beginDocumentOperation,
  type DocumentOperationContext,
} from '@shared/documents/operations.js';
import type { RepeatedPhrase, RepetitionScope } from '@shared/repetition/index.js';
import { buildSceneDigest, findRepeatedPhrases } from '@shared/repetition/index.js';
import type { AiRequestHandle } from '../ai/request.js';
import { startCollectedAiRequest } from '../ai/request.js';
import { Button } from '../ui/Button.js';
import { Dialog } from '../ui/Dialog.js';
import { Field } from '../ui/Field.js';
import { Select } from '../ui/Select.js';
import { TabList } from '../ui/TabList.js';

interface RepetitionPanelProps {
  documentId: string;
  documentRevision: number;
  screenplay: string;
  analysis: ParseResponse | null;
  /** Structural findings, which unlike the literal ones cost a request and so are kept. */
  state: InconsistencyState;
  t: Translator['t'];
  locale: Locale;
  onStateChange: (state: InconsistencyState) => void;
  onAnalysisResult: (operation: DocumentOperationContext, state: InconsistencyState) => boolean;
  onSelectRange: (range: { from: number; to: number }) => void;
  onSelectReference: (reference: { sceneNumber: string; heading: string }) => void;
  onClose: () => void;
}

type Filter = 'all' | RepetitionScope;
type RepetitionTab = 'text' | 'structural';

const FILTERS: Filter[] = ['all', 'dialogue', 'action'];
const TABS: readonly RepetitionTab[] = ['text', 'structural'];

/**
 * Narrative repetition, read two ways.
 *
 * The literal half — the same words used twice — is computed here, from the AST, every time
 * the panel opens: instant, free, and it needs no API key, so a writer without one still gets
 * the analysis. The structural half — two scenes doing the same job — is a judgement, so it
 * costs a request and is asked for explicitly.
 *
 * The two halves share one dialog but not one scroll region: each lives in its own tab so a
 * long list cannot crush the other feature.
 */
export function RepetitionPanel({
  documentId,
  documentRevision,
  screenplay,
  analysis,
  state,
  t,
  locale,
  onStateChange,
  onAnalysisResult,
  onSelectRange,
  onSelectReference,
  onClose,
}: RepetitionPanelProps) {
  const requestRef = useRef<AiRequestHandle | null>(null);
  const latestOperation = useRef<DocumentOperationContext | null>(null);
  const cancelled = useRef(false);
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState('');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [tab, setTab] = useState<RepetitionTab>('text');

  const scenes = useMemo<SceneView[]>(() => {
    if (analysis === null) return parse(screenplay).scenes;
    return analysis.scenes.map((scene) => ({
      number: scene.number,
      heading: scene.heading,
      location: scene.location,
      elements: scene.elementIndexes.flatMap((index) => {
        const element = analysis.elements[index];
        return element ? [element] : [];
      }),
    }));
  }, [analysis, screenplay]);

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
      latestOperation.current = null;
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
    const operation = beginDocumentOperation(
      { id: documentId, revision: documentRevision },
      'repetition',
    );
    latestOperation.current = operation;
    setRunning(true);
    setElapsedSeconds(0);
    setError(null);
    cancelled.current = false;
    setPhase(t('repetition.analysing'));
    try {
      const config = await window.quantum.invoke('ai:config:get', undefined);
      if (latestOperation.current?.requestId !== operation.requestId) return;
      const handle = startCollectedAiRequest(
        {
          requestId: `repetition-${crypto.randomUUID()}`,
          profileId: config.activeProfileId,
          mode: 'factual',
          temperature: 0.2,
          systemPrompt: structuralRepetitionSystemPrompt(locale),
          messages: [
            { role: 'user', content: buildStructuralRepetitionPrompt(buildSceneDigest(scenes)) },
          ],
        },
        (next) => {
          if (next === 'reasoning') setPhase(t('ai.request.reasoning'));
        },
      );
      requestRef.current = handle;
      const items = parseInconsistencies(await handle.promise);
      if (cancelled.current || latestOperation.current?.requestId !== operation.requestId) return;
      onAnalysisResult(operation, { items, analyzedAt: Date.now() });
    } catch (reason) {
      if (!cancelled.current && latestOperation.current?.requestId === operation.requestId) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (latestOperation.current?.requestId === operation.requestId) {
        requestRef.current = null;
        setRunning(false);
        setPhase('');
      }
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

  const textPanelId = 'repetition-panel-text';
  const structuralPanelId = 'repetition-panel-structural';

  return (
    <Dialog
      className="consistency-dialog"
      title={t('repetition.title')}
      subtitle={t('repetition.subtitle')}
      closeLabel={t('repetition.close')}
      onClose={onClose}
    >
      <div className="consistency-pane">
        <div className="repetition-tab-bar">
          <TabList
            tabs={TABS}
            active={tab}
            label={(id) => t(`repetition.tab.${id}`)}
            idPrefix="repetition-tab"
            panelId={tab === 'text' ? textPanelId : structuralPanelId}
            className="repetition-tabs"
            tabClassName="repetition-tab"
            onChange={setTab}
          />
        </div>

        {/*
         * Both panels stay mounted (hidden when inactive) so filter/expanded state, scroll
         * position, and an in-flight structural request survive tab switches. Cancellation
         * remains tied to dialog unmount, not to leaving the structural tab.
         */}
        <div className="repetition-panels">
          <div
            className="repetition-tabpanel"
            role="tabpanel"
            id={textPanelId}
            aria-labelledby="repetition-tab-text"
            hidden={tab !== 'text'}
          >
            <div className="repetition-controls">
              <Field label={t('repetition.scope')} labelHidden>
                <Select
                  value={filter}
                  onChange={(event) => setFilter(event.target.value as Filter)}
                >
                  {FILTERS.map((candidate) => (
                    <option key={candidate} value={candidate}>
                      {t(`repetition.scope.${candidate}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <p className="repetition-count">
                {t('repetition.found', { count: phrases.length, words: report.wordCount })}
                {report.truncated ? ` · ${t('repetition.truncated')}` : ''}
              </p>
            </div>

            <div className="repetition-text-results">
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
                      {t('repetition.meta', { words: phrase.length, count: phrase.span })}
                    </p>
                    <button
                      type="button"
                      className="repetition-toggle"
                      aria-expanded={expanded === phrase.phrase}
                      onClick={() => setExpanded(expanded === phrase.phrase ? null : phrase.phrase)}
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
          </div>

          <div
            className="repetition-tabpanel"
            role="tabpanel"
            id={structuralPanelId}
            aria-labelledby="repetition-tab-structural"
            hidden={tab !== 'structural'}
          >
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
                  <Button onClick={() => void stop()}>{t('ai.request.stop')}</Button>
                </div>
              ) : (
                <Button
                  variant="primary"
                  disabled={scenes.length === 0}
                  onClick={() => void analyseStructure()}
                >
                  {t('repetition.analyseStructure')}
                </Button>
              )}
              {error ? (
                <p className="ai-warning" role="alert">
                  {error}
                </p>
              ) : null}

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
                    <Field label={t('consistency.statusLabel')} labelHidden>
                      <Select
                        scale="compact"
                        value={item.status}
                        onChange={(event) =>
                          setStatus(item.id, event.target.value as InconsistencyStatus)
                        }
                      >
                        <option value="open">{t('consistency.status.open')}</option>
                        <option value="ignored">{t('consistency.status.ignored')}</option>
                        <option value="resolved">{t('consistency.status.resolved')}</option>
                      </Select>
                    </Field>
                  </article>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
