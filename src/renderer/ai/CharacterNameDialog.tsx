import { useEffect, useRef, useState } from 'react';
import {
  buildCharacterNamesPrompt,
  CHARACTER_NAMES_SYSTEM_PROMPT,
  parseCharacterNameSuggestions,
} from '@shared/ai/index.js';
import type { CharacterNameStyle } from '@shared/ai/index.js';
import { useTranslator } from '../hooks/useTranslator.js';
import {
  beginDocumentOperation,
  type DocumentOperationContext,
} from '@shared/documents/operations.js';
import type { AiRequestHandle } from './request.js';
import { startCollectedAiRequest } from './request.js';
import { CloseButton } from '../ui/CloseButton.js';
import { Button } from '../ui/Button.js';

export interface CharacterNameSelection {
  operation: DocumentOperationContext;
  name: string;
  existingNames: string[];
  sceneContext: string;
  anchor: { x: number; y: number } | null;
}

interface CharacterNameDialogProps {
  selection: CharacterNameSelection;
  onRename: (selection: CharacterNameSelection, name: string) => boolean;
  onClose: () => void;
}

const NAME_REPAIR_INSTRUCTION = `Your previous reply was not valid for this task.
Return only a JSON object {"suggestions":["..."]} with at most ten distinct character names and no commentary.
No Markdown fences.`;

export function CharacterNameDialog({ selection, onRename, onClose }: CharacterNameDialogProps) {
  const { t } = useTranslator();
  const requestRef = useRef<AiRequestHandle | null>(null);
  const latestOperation = useRef<DocumentOperationContext | null>(null);
  const [name, setName] = useState(selection.name);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [style, setStyle] = useState<CharacterNameStyle>('common');
  const [busy, setBusy] = useState(false);
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
   * Hands the focus back on close. Stored as-is for the same reason as in the rewrite
   * popover: the opener is CodeMirror's contenteditable, which no control selector matches.
   * The input below claims the focus itself with `autoFocus`.
   */
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => opener?.focus();
  }, []);

  // Ensure Escape key closes the dialog even when focus is elsewhere.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const suggest = async () => {
    await requestRef.current?.cancel();
    const operation = beginDocumentOperation(
      {
        id: selection.operation.documentId,
        revision: selection.operation.documentRevision,
      },
      'character-names',
    );
    latestOperation.current = operation;
    setBusy(true);
    setError(null);
    setSuggestions([]);
    const isCurrent = () => latestOperation.current?.requestId === operation.requestId;
    const primaryUserContent = buildCharacterNamesPrompt(
      selection.name,
      selection.existingNames,
      selection.sceneContext,
      style,
    );
    try {
      const config = await window.quantum.invoke('ai:config:get', undefined);
      if (!isCurrent()) return;

      const runOnce = async (messages: Array<{ role: 'user' | 'assistant'; content: string }>) => {
        const request = startCollectedAiRequest({
          requestId: operation.requestId,
          profileId: config.activeProfileId,
          mode: 'creative',
          temperature: 0.9,
          reasoning: 'disabled',
          systemPrompt: CHARACTER_NAMES_SYSTEM_PROMPT,
          messages,
        });
        requestRef.current = request;
        return request.promise;
      };

      let output = await runOnce([{ role: 'user', content: primaryUserContent }]);
      if (!isCurrent()) return;
      let parsed = parseCharacterNameSuggestions(output);
      if (parsed.length === 0) {
        // Gate before starting: regenerate/unmount must not orphan a second network call.
        if (!isCurrent()) return;
        output = await runOnce([
          { role: 'user', content: primaryUserContent },
          { role: 'assistant', content: output.slice(0, 4_000) },
          { role: 'user', content: NAME_REPAIR_INSTRUCTION },
        ]);
        if (!isCurrent()) return;
        parsed = parseCharacterNameSuggestions(output);
      }
      if (parsed.length === 0) throw new Error(t('characterName.invalidResponse'));
      setSuggestions(parsed);
    } catch (reason) {
      if (!isCurrent()) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (isCurrent()) {
        requestRef.current = null;
        setBusy(false);
      }
    }
  };

  const apply = (nextName: string) => {
    const normalized = nextName.trim().replace(/\s+/g, ' ').toLocaleUpperCase('fr-FR');
    if (!normalized) return;
    if (onRename(selection, normalized)) onClose();
  };

  const top = Math.min(window.innerHeight - 480, Math.max(60, selection.anchor?.y ?? 110));
  const left = Math.min(window.innerWidth - 480, Math.max(16, selection.anchor?.x ?? 180));

  return (
    <section
      className="rewrite-popover character-name-popover"
      role="dialog"
      aria-modal="false"
      aria-label={t('characterName.title')}
      style={{ top, left }}
    >
      <header>
        <strong>{t('characterName.title')}</strong>
        <CloseButton label={t('characterName.close')} onClick={onClose} />
      </header>
      <div className="character-name-manual">
        <label>
          <span>{t('characterName.newName')}</span>
          <input
            autoFocus
            value={name}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') apply(name);
            }}
          />
        </label>
        <Button variant="primary" disabled={!name.trim()} onClick={() => apply(name)}>
          {t('characterName.renameAll')}
        </Button>
      </div>
      <div className="character-name-ai">
        <fieldset className="character-name-styles">
          <legend>{t('characterName.style')}</legend>
          {(['common', 'rare', 'creative'] as const).map((value) => (
            <label key={value} className={style === value ? 'is-active' : ''}>
              <input
                type="radio"
                name="character-name-style"
                value={value}
                checked={style === value}
                onChange={() => setStyle(value)}
              />
              <span>
                <strong>{t(`characterName.style.${value}`)}</strong>
                <small>{t(`characterName.style.${value}Hint`)}</small>
              </span>
            </label>
          ))}
        </fieldset>
        <Button disabled={busy} onClick={() => void suggest()}>
          {busy ? t('characterName.generating') : t('characterName.suggest')}
        </Button>
        <small>{t('characterName.undoHint')}</small>
      </div>
      {error ? (
        <p className="ai-warning" role="alert">
          {error}
        </p>
      ) : null}
      <div className="rewrite-results character-name-results">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            className="rewrite-variant"
            onClick={() => apply(suggestion)}
          >
            <p>{suggestion}</p>
          </button>
        ))}
      </div>
    </section>
  );
}
