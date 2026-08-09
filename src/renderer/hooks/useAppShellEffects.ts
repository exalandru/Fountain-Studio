import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppSettings } from '@shared/ipc-contract.js';
import type { Locale } from '@shared/i18n/index.js';
import { useDocuments } from '../store/documents.js';

interface AppShellEffectsOptions {
  theme: AppSettings['theme'];
  /** Interface language — drives the accessible document language. */
  language: Locale;
  activeName: string | null;
  anyDirty: boolean;
  save: (options: { forceDialog: boolean }) => Promise<boolean>;
  flushForClose: () => Promise<void>;
  onClosePersistenceError: (error: unknown) => void;
}

/**
 * Theme, settings subscribe, window title, and the native close guard.
 *
 * Kept together because they all talk to the main process about shell-level state
 * rather than about the active screenplay's content.
 */
export function useAppShellEffects({
  theme,
  language,
  activeName,
  anyDirty,
  save,
  flushForClose,
  onClosePersistenceError,
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

  // Accessible document language follows the UI locale, not the spell-checker preference.
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

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
          await flushForClose();
          const dirtyDocuments = store().documents.filter((document) => document.dirty);
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
        } catch (error) {
          onClosePersistenceError(error);
        } finally {
          try {
            await window.quantum.invoke('window:closeDecision', { proceed });
          } finally {
            closing.current = false;
          }
        }
      })();
    });
  }, [flushForClose, onClosePersistenceError, save, store]);

  return useMemo(() => ({ effectiveDark, patchSettings }), [effectiveDark, patchSettings]);
}
