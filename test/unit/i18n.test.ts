import { describe, expect, it } from 'vitest';
import { createTranslator, resolveLocale, LOCALES } from '../../src/shared/i18n/index.js';
import { en } from '../../src/shared/i18n/en.js';
import { fr } from '../../src/shared/i18n/fr.js';
import type { MessageKey } from '../../src/shared/i18n/types.js';

/**
 * Catalogue parity is already enforced by the type system: `fr` is typed as `Catalog`,
 * derived from `en`, so a missing key does not compile. These tests cover what types
 * cannot — that no translation was left as a copy of the English, that plural rules
 * follow the locale, and that interpolation behaves.
 */

const keys = Object.keys(en) as MessageKey[];

describe('catalogues', () => {
  it('every locale is registered', () => {
    expect(LOCALES).toEqual(['en', 'fr']);
  });

  it('French has exactly the same keys as English', () => {
    expect(Object.keys(fr).sort()).toEqual(keys.slice().sort());
  });

  it('plural keys are plural in both catalogues', () => {
    for (const key of keys) {
      const isPluralInEnglish = typeof en[key] === 'object';
      const isPluralInFrench = typeof fr[key] === 'object';
      expect(isPluralInFrench, `mismatched shape for ${key}`).toBe(isPluralInEnglish);
    }
  });

  it('no message is left empty', () => {
    for (const key of keys) {
      const message = fr[key];
      if (typeof message === 'string') {
        expect(message.length, `empty message for ${key}`).toBeGreaterThan(0);
      } else {
        expect(message.one.length).toBeGreaterThan(0);
        expect(message.other.length).toBeGreaterThan(0);
      }
    }
  });

  it('French is actually translated, not copied from English', () => {
    const intentionallyIdentical: MessageKey[] = [
      'app.name',
      'window.title',
      'menu.app.services',
      'status.about',
      'sidebar.structure',
      'sidebar.locationMixed',
    ];
    const identical = keys.filter((key) => {
      const a = en[key];
      const b = fr[key];
      return typeof a === 'string' && typeof b === 'string' && a === b;
    });
    expect(identical.sort()).toEqual(intentionallyIdentical.sort());
  });

  it('placeholders match between locales', () => {
    const slots = (value: string) => (value.match(/\{(\w+)\}/g) ?? []).sort();

    for (const key of keys) {
      const a = en[key];
      const b = fr[key];
      if (typeof a === 'string' && typeof b === 'string') {
        expect(slots(b), `placeholders differ for ${key}`).toEqual(slots(a));
      } else if (typeof a === 'object' && typeof b === 'object') {
        expect(slots(b.one)).toEqual(slots(a.one));
        expect(slots(b.other)).toEqual(slots(a.other));
      }
    }
  });
});

describe('resolveLocale', () => {
  it('accepts a bare locale', () => {
    expect(resolveLocale('fr')).toBe('fr');
    expect(resolveLocale('en')).toBe('en');
  });

  it('accepts a full tag as returned by the OS', () => {
    expect(resolveLocale('fr-FR')).toBe('fr');
    expect(resolveLocale('fr-CA')).toBe('fr');
    expect(resolveLocale('en-GB')).toBe('en');
  });

  it('is case-insensitive', () => {
    expect(resolveLocale('FR-fr')).toBe('fr');
  });

  it('falls back to English for anything unknown', () => {
    expect(resolveLocale('de-DE')).toBe('en');
    expect(resolveLocale('')).toBe('en');
    expect(resolveLocale(undefined)).toBe('en');
    expect(resolveLocale(null)).toBe('en');
  });

  it('does not treat a language merely containing the code as a match', () => {
    // "fro" (Old French) is not "fr": prefix matching must require a separator.
    expect(resolveLocale('fro')).toBe('en');
  });
});

describe('translator', () => {
  it('returns the English message', () => {
    const { t } = createTranslator('en');
    expect(t('workspace.empty')).toBe('No document open');
  });

  it('returns the French message', () => {
    const { t } = createTranslator('fr');
    expect(t('workspace.empty')).toBe('Aucun document ouvert');
  });

  it('interpolates named parameters', () => {
    const { t } = createTranslator('en');
    expect(t('tab.close', { name: 'scene.fountain' })).toBe('Close scene.fountain');
  });

  it('leaves an unknown placeholder visible rather than silently dropping it', () => {
    const { t } = createTranslator('en');
    expect(t('tab.close', {})).toBe('Close {name}');
  });

  it('applies English plural rules', () => {
    const { t } = createTranslator('en');
    expect(t('status.scenes', { count: 0 })).toBe('0 scenes');
    expect(t('status.scenes', { count: 1 })).toBe('1 scene');
    expect(t('status.scenes', { count: 6 })).toBe('6 scenes');
  });

  it('applies French plural rules, where zero is singular', () => {
    // This is exactly why Intl.PluralRules is used rather than a count > 1 test:
    // French writes "0 scène", English writes "0 scenes".
    const { t } = createTranslator('fr');
    expect(t('status.scenes', { count: 0 })).toBe('0 scène');
    expect(t('status.scenes', { count: 1 })).toBe('1 scène');
    expect(t('status.scenes', { count: 6 })).toBe('6 scènes');
  });

  it('exposes the active locale', () => {
    expect(createTranslator('fr').locale).toBe('fr');
  });

  it('translates parser diagnostics in both languages', () => {
    // The parser emits codes; here is where they become sentences.
    const params = { number: '1', line: 12 };
    expect(createTranslator('en').t('diagnostic.duplicateSceneNumber', params)).toContain(
      'already used on line 12',
    );
    expect(createTranslator('fr').t('diagnostic.duplicateSceneNumber', params)).toContain(
      'déjà utilisé à la ligne 12',
    );
  });

  it('keeps Fountain syntax out of the translations', () => {
    // The title-page keys are part of the file format: a French screenplay still
    // writes "Title:". Only the values are translated.
    const { t } = createTranslator('fr');
    expect(t('template.titleValue')).toBe('Sans titre');
    expect(t('template.titleValue')).not.toContain('Title:');
  });
});
