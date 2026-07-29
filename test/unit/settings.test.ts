import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/shared/ipc-contract.js';
import { sanitizeSettings } from '../../src/shared/settings/index.js';

describe('settings validation', () => {
  it('keeps defaults for unknown or invalid values', () => {
    expect(
      sanitizeSettings({
        theme: 'neon',
        language: 'xx',
        editorFontSize: Number.NaN,
        unknown: true,
      }),
    ).toEqual(DEFAULT_SETTINGS);
  });

  it('bounds numeric settings received through IPC or a hand-edited file', () => {
    expect(
      sanitizeSettings({
        editorFontSize: 900,
        autosaveSeconds: -12,
        backupCount: 999,
        minutesPerPage: 0,
      }),
    ).toMatchObject({
      editorFontSize: 28,
      autosaveSeconds: 0,
      backupCount: 20,
      minutesPerPage: 0.1,
    });
  });

  it('accepts every supported setting', () => {
    expect(
      sanitizeSettings({
        theme: 'dark',
        language: 'fr',
        editorFontSize: 17,
        autosaveSeconds: 60,
        backupCount: 5,
        minutesPerPage: 0.7,
        showNotes: false,
        showBoneyard: false,
        showSynopses: false,
        showSections: false,
        focusMode: true,
        typewriterMode: true,
        spellcheckLanguage: 'fr',
      }),
    ).toEqual({
      theme: 'dark',
      language: 'fr',
      editorFontSize: 17,
      autosaveSeconds: 60,
      backupCount: 5,
      minutesPerPage: 0.7,
      showNotes: false,
      showBoneyard: false,
      showSynopses: false,
      showSections: false,
      focusMode: true,
      typewriterMode: true,
      spellcheckLanguage: 'fr',
    });
  });
});
