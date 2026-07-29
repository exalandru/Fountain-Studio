import { useEffect, useRef, useState } from 'react';
import {
  buildCharacterNamesPrompt,
  CHARACTER_NAMES_SYSTEM_PROMPT,
  parseShortSuggestions,
} from '@shared/ai/index.js';
import { useTranslator } from '../hooks/useTranslator.js';
import type { AiRequestHandle } from './request.js';
import { startCollectedAiRequest } from './request.js';

export interface CharacterNameSelection {
  name: string;
  existingNames: string[];
  sceneContext: string;
  anchor: { x: number; y: number } | null;
}

interface CharacterNameDialogProps {
  selection: CharacterNameSelection;
  onRename: (name: string) => void;
  onClose: () => void;
}

export function CharacterNameDialog({ selection, onRename, onClose }: CharacterNameDialogProps) {
  const { t } = useTranslator();
  const requestRef = useRef<AiRequestHandle | null>(null);
  const [name, setName] = useState(selection.name);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () => () => {
      void requestRef.current?.cancel();
    },
    [],
  );

  const suggest = async () => {
    await requestRef.current?.cancel();
    setBusy(true);
    setError(null);
    setSuggestions([]);
    try {
      const config = await window.quantum.invoke('ai:config:get', undefined);
      const request = startCollectedAiRequest({
        requestId: `character-names-${crypto.randomUUID()}`,
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
            ),
          },
        ],
      });
      requestRef.current = request;
      const parsed = parseShortSuggestions(await request.promise);
      if (parsed.length === 0) throw new Error(t('characterName.invalidResponse'));
      setSuggestions(parsed);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      requestRef.current = null;
      setBusy(false);
    }
  };

  const apply = (nextName: string) => {
    const normalized = nextName.trim().replace(/\s+/g, ' ').toLocaleUpperCase('fr-FR');
    if (!normalized) return;
    onRename(normalized);
    onClose();
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
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <header>
        <strong>{t('characterName.title')}</strong>
        <button
          type="button"
          className="panel-close"
          aria-label={t('characterName.close')}
          onClick={onClose}
        >
          ×
        </button>
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
        <button
          type="button"
          className="ai-primary"
          disabled={!name.trim()}
          onClick={() => apply(name)}
        >
          {t('characterName.renameAll')}
        </button>
      </div>
      <div className="character-name-ai">
        <button type="button" disabled={busy} onClick={() => void suggest()}>
          {busy ? t('characterName.generating') : t('characterName.suggest')}
        </button>
        <small>{t('characterName.undoHint')}</small>
      </div>
      {error ? <p className="ai-warning">{error}</p> : null}
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
