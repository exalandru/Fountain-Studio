import { BrowserWindow } from 'electron';
import type { Locale } from '@shared/i18n/index.js';

/**
 * Spell checker language.
 *
 * The M0 spike established that macOS keeps only **one** language per session: asking
 * for `['fr', 'en-US']` yields `['fr']`. So we set a single language rather than
 * pretending several are active.
 *
 * For now the checking language follows the interface language. The specification
 * (§4.7) ultimately wants it detected from the document instead — a screenplay written
 * in French inside an English interface should still be checked in French. That belongs
 * to M4, together with the per-project dictionary decision.
 */
const SPELLCHECK_LANGUAGE: Record<Locale, string> = {
  en: 'en-US',
  fr: 'fr',
};

export function applySpellCheckerLanguage(locale: Locale): void {
  const language = SPELLCHECK_LANGUAGE[locale];

  for (const window of BrowserWindow.getAllWindows()) {
    const { session } = window.webContents;
    // Guard against a locale the platform does not provide: setting an unavailable
    // language throws and would take the whole save/settings flow down with it.
    if (session.availableSpellCheckerLanguages.includes(language)) {
      session.setSpellCheckerLanguages([language]);
    }
  }
}
