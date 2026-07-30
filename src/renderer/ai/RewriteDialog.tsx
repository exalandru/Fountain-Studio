import { useEffect, useRef, useState } from 'react';
import type { RewriteState } from '@shared/appdata/index.js';
import type { RewriteTone } from '@shared/ai/index.js';
import {
  buildRewritePrompt,
  buildSynonymPrompt,
  parseRewriteVariants,
  parseShortSuggestions,
  REWRITE_SYSTEM_PROMPT,
  SYNONYM_SYSTEM_PROMPT,
} from '@shared/ai/index.js';
import { useTranslator } from '../hooks/useTranslator.js';
import type { AiRequestHandle } from './request.js';
import { startCollectedAiRequest } from './request.js';

export interface RewriteSelection {
  from: number;
  to: number;
  text: string;
  elementKind: string;
  speaker: string | null;
  sceneHeading: string | null;
  sceneContext: string;
  anchor: { x: number; y: number } | null;
  initialTool?: 'rewrite' | 'synonyms';
}

interface RewriteDialogProps {
  selection: RewriteSelection;
  state: RewriteState;
  onStateChange: (state: RewriteState) => void;
  onReplace: (from: number, to: number, content: string) => void;
  onClose: () => void;
}

const TONES: RewriteTone[] = [
  'neutral',
  'concise',
  'cinematic',
  'dramatic',
  'comic',
  'formal',
  'colloquial',
  'custom',
];

export function RewriteDialog({
  selection,
  state,
  onStateChange,
  onReplace,
  onClose,
}: RewriteDialogProps) {
  const { t } = useTranslator();
  const requestRef = useRef<AiRequestHandle | null>(null);
  const tool = selection.initialTool ?? 'rewrite';
  const [variants, setVariants] = useState<string[]>([]);
  const [phase, setPhase] = useState<'idle' | 'waiting' | 'reasoning' | 'answering'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () => () => {
      void requestRef.current?.cancel();
    },
    [],
  );

  const generate = async () => {
    await requestRef.current?.cancel();
    setVariants([]);
    setError(null);
    setPhase('waiting');
    try {
      const config = await window.quantum.invoke('ai:config:get', undefined);
      const request = startCollectedAiRequest(
        {
          requestId: `rewrite-${crypto.randomUUID()}`,
          profileId: config.activeProfileId,
          mode: 'creative',
          temperature: tool === 'synonyms' ? 0.7 : 0.8,
          reasoning: 'disabled',
          systemPrompt: tool === 'synonyms' ? SYNONYM_SYSTEM_PROMPT : REWRITE_SYSTEM_PROMPT,
          messages: [
            {
              role: 'user',
              content:
                tool === 'synonyms'
                  ? buildSynonymPrompt(selection.text, selection.sceneContext)
                  : buildRewritePrompt({
                      selection: selection.text,
                      elementKind: selection.elementKind,
                      speaker: selection.speaker,
                      sceneHeading: selection.sceneHeading,
                      sceneContext: selection.sceneContext,
                      tone: state.lastTone,
                      customStyle: state.customStyle,
                    }),
            },
          ],
        },
        setPhase,
      );
      requestRef.current = request;
      const output = await request.promise;
      const parsed =
        tool === 'synonyms' ? parseShortSuggestions(output) : parseRewriteVariants(output);
      if (parsed.length === 0 || (tool === 'rewrite' && parsed.length !== 3)) {
        throw new Error(t('rewrite.invalidResponse'));
      }
      setVariants(parsed);
      setPhase('idle');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setPhase('idle');
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => void generate(), 0);
    return () => window.clearTimeout(timer);
    // The first generation belongs to the selection that opened this popover.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const busy = phase !== 'idle';
  const top = Math.min(window.innerHeight - 520, Math.max(60, selection.anchor?.y ?? 110));
  const left = Math.min(window.innerWidth - 540, Math.max(16, selection.anchor?.x ?? 180));

  return (
    <section
      className="rewrite-popover"
      role="dialog"
      aria-modal="false"
      aria-label={t(tool === 'synonyms' ? 'rewrite.synonymsTitle' : 'rewrite.title')}
      style={{ top, left }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <header>
        <strong>{t(tool === 'synonyms' ? 'rewrite.synonymsTitle' : 'rewrite.title')}</strong>
        <button
          type="button"
          className="panel-close"
          aria-label={t('rewrite.close')}
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <div className="rewrite-controls">
        {tool === 'rewrite' ? (
          <label>
            <span>{t('rewrite.tone')}</span>
            <select
              value={state.lastTone}
              onChange={(event) =>
                onStateChange({ ...state, lastTone: event.target.value as RewriteTone })
              }
            >
              {TONES.map((tone) => (
                <option key={tone} value={tone}>
                  {t(`rewrite.tone.${tone}`)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {tool === 'rewrite' && state.lastTone === 'custom' ? (
          <input
            value={state.customStyle}
            maxLength={500}
            placeholder={t('rewrite.customPlaceholder')}
            onChange={(event) => onStateChange({ ...state, customStyle: event.target.value })}
          />
        ) : null}
        <button type="button" disabled={busy} onClick={() => void generate()}>
          {t('rewrite.regenerate')}
        </button>
      </div>
      <div className="rewrite-results">
        {busy ? (
          <div className="rewrite-loading">
            <span className="ai-thinking-dot" />
            {phase === 'reasoning' ? t('ai.request.reasoning') : t('rewrite.generating')}
          </div>
        ) : null}
        {error ? <p className="ai-warning">{error}</p> : null}
        {variants.map((variant, index) => (
          <button
            key={`${index}-${variant}`}
            type="button"
            className="rewrite-variant"
            onClick={() => {
              onReplace(selection.from, selection.to, variant);
              onClose();
            }}
          >
            <span>{index + 1}</span>
            <p>{variant}</p>
          </button>
        ))}
      </div>
    </section>
  );
}
