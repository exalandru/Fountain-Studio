import { en } from './en.js';
import { fr } from './fr.js';
import type { Catalog, Locale, Message, MessageKey, MessageParams, Translator } from './types.js';
import { DEFAULT_LOCALE, LOCALES } from './types.js';

/**
 * Minimal translation layer, shared by the main process and the renderer.
 *
 * Hand-written rather than pulled from a library: the requirement is placeholder
 * interpolation plus correct plurals, which `Intl.PluralRules` already provides. That
 * keeps the dependency tree small, as the licence policy demands (PLAN.md §2.1).
 *
 * Catalogues are typed against the English reference, so missing or mis-shaped
 * translations are compile errors rather than runtime surprises.
 */

const CATALOGUES: Record<Locale, Catalog> = {
  // `en` is the reference object; it satisfies Catalog by construction.
  en: en as Catalog,
  fr,
};

/** Narrows an arbitrary string to a supported locale, falling back to English. */
export function resolveLocale(value: string | undefined | null): Locale {
  if (!value) return DEFAULT_LOCALE;
  const lower = value.toLowerCase();
  // Accepts full tags such as "fr-FR" or "en-GB", as returned by app.getLocale().
  const match = LOCALES.find((locale) => lower === locale || lower.startsWith(`${locale}-`));
  return match ?? DEFAULT_LOCALE;
}

/** Replaces every `{name}` slot with the matching parameter. */
function interpolate(template: string, params: MessageParams | undefined): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    // An unknown placeholder is left visible on purpose: silently dropping it would
    // hide the mistake, and a stray "{count}" in the interface is easy to spot.
    return value === undefined ? whole : String(value);
  });
}

/** Picks the plural form matching `count` for the given locale. */
function selectPlural(message: Exclude<Message, string>, locale: Locale, count: number): string {
  const category = new Intl.PluralRules(locale).select(count);
  switch (category) {
    case 'zero':
      return message.zero ?? message.other;
    case 'one':
      return message.one;
    case 'two':
      return message.two ?? message.other;
    case 'few':
      return message.few ?? message.other;
    case 'many':
      return message.many ?? message.other;
    default:
      return message.other;
  }
}

export function createTranslator(locale: Locale): Translator {
  const catalogue = CATALOGUES[locale] ?? CATALOGUES[DEFAULT_LOCALE];
  const fallback = CATALOGUES[DEFAULT_LOCALE];

  return {
    locale,
    t(key: MessageKey, params?: MessageParams): string {
      const message: Message = catalogue[key] ?? fallback[key];

      if (typeof message === 'string') return interpolate(message, params);

      const count = typeof params?.['count'] === 'number' ? params['count'] : 0;
      return interpolate(selectPlural(message, locale, count), params);
    },
  };
}

export { DEFAULT_LOCALE, LOCALES } from './types.js';
export type {
  Catalog,
  Locale,
  Message,
  MessageKey,
  MessageParams,
  PluralForms,
  Translator,
} from './types.js';
export { en } from './en.js';
export { fr } from './fr.js';
