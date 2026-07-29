import type { en } from './en.js';

/**
 * Locales shipped in v1. Adding one means adding a catalogue and extending this union —
 * the compiler then points at every place that must handle it.
 */
export const LOCALES = ['en', 'fr'] as const;
export type Locale = (typeof LOCALES)[number];

/** Fallback used when a locale is unknown or a message is missing. */
export const DEFAULT_LOCALE: Locale = 'en';

/**
 * Plural forms, keyed by CLDR plural categories. Only `one` and `other` are required:
 * they cover English and French. Languages needing `zero`, `two`, `few` or `many` can
 * add them without touching existing catalogues.
 */
export interface PluralForms {
  zero?: string;
  one: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
}

export type Message = string | PluralForms;

/** Every message key, taken from the English reference catalogue. */
export type MessageKey = keyof typeof en;

/**
 * Shape every catalogue must satisfy: same keys as English, and the same *kind* of
 * message for each — a key that is plural in English must be plural everywhere.
 */
export type Catalog = {
  [K in MessageKey]: (typeof en)[K] extends string ? string : PluralForms;
};

/** Values substituted into `{placeholder}` slots. `count` also drives plural selection. */
export type MessageParams = Record<string, string | number>;

/** Translator handed to both the main process and the renderer. */
export interface Translator {
  readonly locale: Locale;
  t(key: MessageKey, params?: MessageParams): string;
}
