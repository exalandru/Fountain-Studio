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
import { CloseButton } from '../ui/CloseButton.js';
import { Button } from '../ui/Button.js';
import { Field } from '../ui/Field.js';
import { Select } from '../ui/Select.js';
import { TextInput } from '../ui/TextInput.js';

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
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tool = selection.initialTool ?? 'rewrite';
  const [variants, setVariants] = useState<string[]>([]);
  const [phase, setPhase] = useState<'idle' | 'waiting' | 'reasoning' | 'answering'>('idle');
  const [error, setError] = useState<string | null>(null);

  // Cancel any pending AI request on unmount.
  useEffect(
    () => () => {
      void requestRef.current?.cancel();
    },
    [],
  );

  /*
   * Takes the focus on open and hands it back on close.
   *
   * The opener is stored as-is rather than filtered through a `button, input, select` list:
   * this popover is opened from the editor, whose focused element is CodeMirror's
   * contenteditable, which matches none of those — so the filtered form always yielded null
   * and the focus was dropped on `document.body`.
   */
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    containerRef.current?.querySelector<HTMLElement>('button, input, select, textarea')?.focus();
    return () => opener?.focus();
  }, []);

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

  // Window-level Escape: the popover does not steal focus, so a key handler on the
  // section itself would never see Escape once the user has clicked elsewhere.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

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
      ref={containerRef}
    >
      <header>
        <strong>{t(tool === 'synonyms' ? 'rewrite.synonymsTitle' : 'rewrite.title')}</strong>
        <CloseButton label={t('rewrite.close')} onClick={onClose} />
      </header>
      <div className="rewrite-controls">
        {tool === 'rewrite' ? (
          <Field label={t('rewrite.tone')}>
            <Select
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
            </Select>
          </Field>
        ) : null}
        {tool === 'rewrite' && state.lastTone === 'custom' ? (
          <TextInput
            value={state.customStyle}
            maxLength={500}
            aria-label={t('rewrite.customPlaceholder')}
            placeholder={t('rewrite.customPlaceholder')}
            onChange={(event) => onStateChange({ ...state, customStyle: event.target.value })}
          />
        ) : null}
        <Button disabled={busy} onClick={() => void generate()}>
          {t('rewrite.regenerate')}
        </Button>
      </div>
      <div className="rewrite-results">
        {busy ? (
          <div className="rewrite-loading">
            <span className="ai-thinking-dot" />
            {phase === 'reasoning' ? t('ai.request.reasoning') : t('rewrite.generating')}
          </div>
        ) : null}
        {error ? (
          <p className="ai-warning" role="alert">
            {error}
          </p>
        ) : null}
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
