import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppSettings } from '@shared/ipc-contract.js';
import { useDocuments } from '../store/documents.js';

interface AppShellEffectsOptions {
  theme: AppSettings['theme'];
  spellcheckLanguage: AppSettings['spellcheckLanguage'];
  activeName: string | null;
  anyDirty: boolean;
  save: (options: { forceDialog: boolean }) => Promise<boolean>;
}

/**
 * Theme, settings subscribe, window title, and the native close guard.
 *
 * Kept together because they all talk to the main process about shell-level state
 * rather than about the active screenplay's content.
 */
export function useAppShellEffects({
  theme,
  spellcheckLanguage,
  activeName,
  anyDirty,
  save,
}: AppShellEffectsOptions) {
  const store = useDocuments.getState;
  const closing = useRef(false);
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const effectiveDark = theme === 'dark' || (theme === 'system' && dark);

  useEffect(() => {
    void window.quantum.invoke('settings:get', undefined).then(store().setSettings);
    const offTheme = window.quantum.on('app:themeChanged', ({ dark: isDark }) => setDark(isDark));
    const offSettings = window.quantum.on('app:settingsChanged', ({ settings: next }) =>
      store().setSettings(next),
    );
    return () => {
      offTheme();
      offSettings();
    };
  }, [store]);

  useEffect(() => {
    document.body.dataset['theme'] = effectiveDark ? 'dark' : 'light';
  }, [effectiveDark]);

  // html lang follows spellcheckLanguage, not the UI locale — those two settings diverge.
  useEffect(() => {
    document.documentElement.lang = spellcheckLanguage;
  }, [spellcheckLanguage]);

  const patchSettings = useCallback(async (patch: Partial<AppSettings>) => {
    await window.quantum.invoke('settings:patch', patch);
  }, []);

  useEffect(() => {
    if (!activeName) return;
    void window.quantum.invoke('window:setDirty', {
      dirty: anyDirty,
      name: activeName,
    });
  }, [activeName, anyDirty]);

  useEffect(() => {
    return window.quantum.on('app:willQuit', () => {
      if (closing.current) return;
      closing.current = true;

      void (async () => {
        let proceed = false;
        try {
          const dirtyDocuments = store().documents.filter((document) => document.dirty);
          await Promise.all(
            dirtyDocuments.map((document) =>
              window.quantum.invoke('autosave:write', {
                id: document.id,
                path: document.path,
                content: document.content,
                eol: document.eol,
                mtimeMs: document.mtimeMs,
              }),
            ),
          );

          proceed = true;
          for (const snapshot of dirtyDocuments) {
            const current = store().documents.find((document) => document.id === snapshot.id);
            if (!current?.dirty) continue;

            const answer = await window.quantum.invoke('dialog:confirmDiscard', {
              name: current.name,
            });
            if (answer === 'cancel') {
              proceed = false;
              break;
            }
            if (answer === 'save') {
              store().setActive(current.id);
              if (!(await save({ forceDialog: false }))) {
                proceed = false;
                break;
              }
            } else {
              await window.quantum.invoke('autosave:clear', { id: current.id });
            }
          }
        } finally {
          try {
            await window.quantum.invoke('window:closeDecision', { proceed });
          } finally {
            closing.current = false;
          }
        }
      })();
    });
  }, [save, store]);

  return useMemo(() => ({ effectiveDark, patchSettings }), [effectiveDark, patchSettings]);
}
