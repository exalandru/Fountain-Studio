import { useEffect, useMemo, useRef, useState } from 'react';
import type { ParseResponse } from '@shared/analysis/index.js';
import type { InconsistencyState } from '@shared/appdata/index.js';
import type {
  AiInconsistency,
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
  inconsistencySystemPrompt,
  parseInconsistencies,
} from '@shared/ai/index.js';
import type { Locale, Translator } from '@shared/i18n/index.js';
import { parse } from '@shared/fountain/index.js';
import {
  beginDocumentOperation,
  type DocumentOperationContext,
} from '@shared/documents/operations.js';
import type { AiRequestHandle } from './request.js';
import { startCollectedAiRequest } from './request.js';
import { Button } from '../ui/Button.js';
import { Dialog } from '../ui/Dialog.js';
import { Field } from '../ui/Field.js';
import { Select } from '../ui/Select.js';

interface InconsistencyPanelProps {
  documentId: string;
  documentRevision: number;
  screenplay: string;
  analysis: ParseResponse | null;
  state: InconsistencyState;
  t: Translator['t'];
  locale: Locale;
  onStateChange: (state: InconsistencyState) => void;
  onAnalysisResult: (operation: DocumentOperationContext, state: InconsistencyState) => boolean;
  onSelectReference: (reference: { sceneNumber: string; heading: string }) => void;
  onClose: () => void;
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
  documentId,
  documentRevision,
  screenplay,
  analysis,
  state,
  t,
  locale,
  onStateChange,
  onAnalysisResult,
  onSelectReference,
  onClose,
}: InconsistencyPanelProps) {
  const requestRef = useRef<AiRequestHandle | null>(null);
  const latestOperation = useRef<DocumentOperationContext | null>(null);
  const cancelled = useRef(false);
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState('');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<'all' | InconsistencyType>('all');
  const [severityFilter, setSeverityFilter] = useState<'all' | InconsistencySeverity>('all');

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
        systemPrompt: inconsistencySystemPrompt(locale),
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
    if (running) return;

    const operation = beginDocumentOperation(
      { id: documentId, revision: documentRevision },
      'consistency',
    );
    latestOperation.current = operation;

    setRunning(true);
    setElapsedSeconds(0);
    setError(null);
    cancelled.current = false;
    try {
      const config = await window.quantum.invoke('ai:config:get', undefined);
      if (latestOperation.current?.requestId !== operation.requestId) return;
      let output = '';
      if (approximateTokens(screenplay) <= 50_000) {
        output = await request(
          config.activeProfileId,
          buildInconsistencyPrompt(screenplay),
          t('consistency.directPass'),
        );
      } else {
        const sceneRanges = analysis?.scenes ?? parse(screenplay).scenes;
        const chunks = chunkScenes(
          sceneRanges.map((scene) => ({
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
          buildFactCrossCheckPrompt(facts.join('\n')),
          t('consistency.crossCheck'),
        );
      }
      const items = parseInconsistencies(output);
      if (items.length === 0 && !output.includes('"items":[]')) {
        throw new Error(t('consistency.invalidResponse'));
      }
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

  return (
    <Dialog
      className="consistency-dialog"
      title={t('consistency.title')}
      subtitle={t('consistency.wholeScreenplay')}
      closeLabel={t('consistency.close')}
      onClose={onClose}
    >
      <div className="consistency-pane">
        <div className="consistency-controls">
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
            <Button variant="primary" onClick={() => void analyse()}>
              {t('consistency.analyse')}
            </Button>
          )}
          <p>{t('consistency.warning')}</p>
          {error ? (
            <p className="ai-warning" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <div className="consistency-filters">
          <Select
            scale="compact"
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value as typeof typeFilter)}
          >
            {TYPES.map((value) => (
              <option key={value} value={value}>
                {t(`consistency.type.${value}`)}
              </option>
            ))}
          </Select>
          <Select
            scale="compact"
            value={severityFilter}
            onChange={(event) => setSeverityFilter(event.target.value as typeof severityFilter)}
          >
            {SEVERITIES.map((value) => (
              <option key={value} value={value}>
                {t(`consistency.severity.${value}`)}
              </option>
            ))}
          </Select>
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
    </Dialog>
  );
}
