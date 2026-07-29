import { useMemo } from 'react';
import type { Translator } from '@shared/i18n/index.js';
import { createTranslator } from '@shared/i18n/index.js';
import { useDocuments } from '../store/documents.js';

/**
 * Translator for the current interface language.
 *
 * The language lives in the settings, which are persisted by the main process, so the
 * whole interface re-renders when it changes — no reload needed. The translator itself
 * is memoised: it is rebuilt only when the language actually changes.
 */
export function useTranslator(): Translator {
  const language = useDocuments((state) => state.settings.language);
  return useMemo(() => createTranslator(language), [language]);
}
