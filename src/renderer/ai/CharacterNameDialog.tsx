import { useEffect, useRef, useState } from 'react';
import {
  buildCharacterNamesPrompt,
  CHARACTER_NAMES_SYSTEM_PROMPT,
  parseShortSuggestions,
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
    try {
      const config = await window.quantum.invoke('ai:config:get', undefined);
      if (latestOperation.current?.requestId !== operation.requestId) return;
      const request = startCollectedAiRequest({
        requestId: operation.requestId,
        profileId: config.activeProfileId,
        mode: 'creative',
        temperature: 0.9,
        reasoning: 'disabled',
        systemPrompt: CHARACTER_NAMES_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: buildCharacterNamesPrompt(
              selection.name,
              selection.existingNames,
              selection.sceneContext,
              style,
            ),
          },
        ],
      });
      requestRef.current = request;
      const parsed = parseShortSuggestions(await request.promise);
      if (latestOperation.current?.requestId !== operation.requestId) return;
      if (parsed.length === 0) throw new Error(t('characterName.invalidResponse'));
      setSuggestions(parsed);
    } catch (reason) {
      if (latestOperation.current?.requestId !== operation.requestId) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (latestOperation.current?.requestId === operation.requestId) {
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
