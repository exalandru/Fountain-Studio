import { useEffect, useRef, useState } from 'react';
import type { RewriteState } from '@shared/appdata/index.js';
import type { RewriteTone } from '@shared/ai/index.js';
import {
  acceptRewriteVariants,
  buildRewritePrompt,
  buildSynonymPrompt,
  parseShortSuggestions,
  REWRITE_SYSTEM_PROMPT,
  SYNONYM_SYSTEM_PROMPT,
} from '@shared/ai/index.js';
import { useTranslator } from '../hooks/useTranslator.js';
import {
  beginDocumentOperation,
  type DocumentOperationContext,
} from '@shared/documents/operations.js';
import type { AiRequestHandle } from './request.js';
import { startCollectedAiRequest } from './request.js';
import { CloseButton } from '../ui/CloseButton.js';
import { Button } from '../ui/Button.js';
import { Field } from '../ui/Field.js';
import { Select } from '../ui/Select.js';
import { TextInput } from '../ui/TextInput.js';

export interface RewriteSelection {
  operation: DocumentOperationContext;
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
  onReplace: (selection: RewriteSelection, content: string) => boolean;
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

const REWRITE_REPAIR_INSTRUCTION = `Your previous reply was not valid for this task.
Return only a JSON object {"variants":["...","...","..."]} with exactly three distinct rewrites of the selected text alone.
Do not invent scene headings, character cues, dialogue blocks, transitions, camera directions, or Fountain/Markdown emphasis absent from the selection.
No Markdown fences and no commentary.`;

const SYNONYM_REPAIR_INSTRUCTION = `Your previous reply was not valid for this task.
Return only a JSON object {"suggestions":["..."]} with at most ten synonym words or short phrases and no commentary.
No Markdown fences.`;

export function RewriteDialog({
  selection,
  state,
  onStateChange,
  onReplace,
  onClose,
}: RewriteDialogProps) {
  const { t } = useTranslator();
  const requestRef = useRef<AiRequestHandle | null>(null);
  const latestOperation = useRef<DocumentOperationContext | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tool = selection.initialTool ?? 'rewrite';
  const [variants, setVariants] = useState<string[]>([]);
  const [phase, setPhase] = useState<'idle' | 'waiting' | 'reasoning' | 'answering'>('idle');
  const [error, setError] = useState<string | null>(null);

  // Cancel any pending AI request on unmount.
  useEffect(
    () => () => {
      latestOperation.current = null;
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
    const operation = beginDocumentOperation(
      {
        id: selection.operation.documentId,
        revision: selection.operation.documentRevision,
      },
      'rewrite',
    );
    latestOperation.current = operation;
    setVariants([]);
    setError(null);
    setPhase('waiting');

    const isCurrent = () => latestOperation.current?.requestId === operation.requestId;

    const primaryUserContent =
      tool === 'synonyms'
        ? buildSynonymPrompt(selection.text, selection.sceneContext)
        : buildRewritePrompt({
            selection: selection.text,
            elementKind: selection.elementKind,
            speaker: selection.speaker,
            tone: state.lastTone,
            customStyle: state.customStyle,
          });

    const accept = (output: string): string[] | null => {
      if (tool === 'synonyms') {
        const parsed = parseShortSuggestions(output);
        return parsed.length > 0 ? parsed : null;
      }
      const accepted = acceptRewriteVariants(output, selection.text);
      return accepted.ok ? accepted.variants : null;
    };

    try {
      const config = await window.quantum.invoke('ai:config:get', undefined);
      if (!isCurrent()) return;

      const runOnce = async (messages: Array<{ role: 'user' | 'assistant'; content: string }>) => {
        const request = startCollectedAiRequest(
          {
            requestId: operation.requestId,
            profileId: config.activeProfileId,
            mode: 'creative',
            temperature: tool === 'synonyms' ? 0.7 : 0.8,
            reasoning: 'disabled',
            systemPrompt: tool === 'synonyms' ? SYNONYM_SYSTEM_PROMPT : REWRITE_SYSTEM_PROMPT,
            messages,
          },
          setPhase,
        );
        requestRef.current = request;
        return request.promise;
      };

      let output = await runOnce([{ role: 'user', content: primaryUserContent }]);
      if (!isCurrent()) return;

      let parsed = accept(output);
      if (!parsed) {
        // One bounded repair attempt for malformed / contract-invalid model output.
        // Gate before starting: regenerate/unmount must not orphan a second network call.
        if (!isCurrent()) return;
        output = await runOnce([
          { role: 'user', content: primaryUserContent },
          { role: 'assistant', content: output.slice(0, 4_000) },
          {
            role: 'user',
            content: tool === 'synonyms' ? SYNONYM_REPAIR_INSTRUCTION : REWRITE_REPAIR_INSTRUCTION,
          },
        ]);
        if (!isCurrent()) return;
        parsed = accept(output);
      }

      if (!parsed) throw new Error(t('rewrite.invalidResponse'));
      setVariants(parsed);
      setPhase('idle');
    } catch (reason) {
      if (!isCurrent()) return;
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
              if (onReplace(selection, variant)) onClose();
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
