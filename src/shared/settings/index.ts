import type { AppSettings } from '../ipc-contract.js';
import { DEFAULT_SETTINGS } from '../ipc-contract.js';
import type { Locale } from '../i18n/index.js';
import { LOCALES } from '../i18n/index.js';

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function clampDecimal(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.round(value * 10) / 10));
}

/** Keeps known settings keys, validates their types and bounds numeric values. */
export function sanitizeSettings(raw: unknown): AppSettings {
  const target: AppSettings = { ...DEFAULT_SETTINGS };
  if (typeof raw !== 'object' || raw === null) return target;
  const settings = raw as Record<string, unknown>;

  if (
    settings['theme'] === 'system' ||
    settings['theme'] === 'light' ||
    settings['theme'] === 'dark'
  ) {
    target.theme = settings['theme'];
  }
  if (
    typeof settings['language'] === 'string' &&
    LOCALES.includes(settings['language'] as Locale)
  ) {
    target.language = settings['language'] as Locale;
  }
  if (
    typeof settings['editorFontSize'] === 'number' &&
    Number.isFinite(settings['editorFontSize'])
  ) {
    target.editorFontSize = clamp(settings['editorFontSize'], 10, 28);
  }
  if (
    typeof settings['autosaveSeconds'] === 'number' &&
    Number.isFinite(settings['autosaveSeconds'])
  ) {
    target.autosaveSeconds = clamp(settings['autosaveSeconds'], 0, 3600);
  }
  if (typeof settings['backupCount'] === 'number' && Number.isFinite(settings['backupCount'])) {
    target.backupCount = clamp(settings['backupCount'], 0, 20);
  }
  if (
    typeof settings['minutesPerPage'] === 'number' &&
    Number.isFinite(settings['minutesPerPage'])
  ) {
    target.minutesPerPage = clampDecimal(settings['minutesPerPage'], 0.1, 10);
  }
  if (typeof settings['showNotes'] === 'boolean') target.showNotes = settings['showNotes'];
  if (typeof settings['showBoneyard'] === 'boolean') {
    target.showBoneyard = settings['showBoneyard'];
  }
  if (typeof settings['showSynopses'] === 'boolean') {
    target.showSynopses = settings['showSynopses'];
  }
  if (typeof settings['showSections'] === 'boolean') {
    target.showSections = settings['showSections'];
  }
  if (typeof settings['showSceneNumbers'] === 'boolean') {
    target.showSceneNumbers = settings['showSceneNumbers'];
  }
  if (typeof settings['focusMode'] === 'boolean') target.focusMode = settings['focusMode'];
  if (typeof settings['typewriterMode'] === 'boolean') {
    target.typewriterMode = settings['typewriterMode'];
  }
  if (settings['spellcheckLanguage'] === 'en-US' || settings['spellcheckLanguage'] === 'fr') {
    target.spellcheckLanguage = settings['spellcheckLanguage'];
  }

  return target;
}
