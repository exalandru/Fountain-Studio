import { describe, expect, it } from 'vitest';
import {
  approximateTokens,
  composeAttachedMessage,
  DEFAULT_BRAINSTORMING_PROMPT,
  DEFAULT_AI_PROFILE,
  modeTemperature,
  sanitizeAiConfig,
} from '../../src/shared/ai/index.js';

describe('AI configuration', () => {
  it('sanitizes profiles, URLs and numeric bounds', () => {
    const config = sanitizeAiConfig({
      version: 99,
      activeProfileId: 'unsafe profile',
      profiles: [
        {
          id: 'local',
          name: ' Local ',
          baseUrl: 'file:///private/script',
          model: 'model-x',
          timeoutMs: -1,
          maxTokens: 999_999,
          reasoningEnabled: false,
        },
      ],
      brainstormingPrompt: 'Prompt personnalisé',
    });

    expect(config).toMatchObject({
      version: 1,
      activeProfileId: 'local',
      brainstormingPrompt: 'Prompt personnalisé',
      profiles: [
        {
          id: 'local',
          name: 'Local',
          baseUrl: DEFAULT_AI_PROFILE.baseUrl,
          timeoutMs: 1_000,
          maxTokens: 200_000,
          reasoningEnabled: false,
        },
      ],
    });
  });

  it('keeps unique bounded profiles and a valid active profile', () => {
    const config = sanitizeAiConfig({
      profiles: [
        { ...DEFAULT_AI_PROFILE, id: 'one' },
        { ...DEFAULT_AI_PROFILE, id: 'one' },
        { ...DEFAULT_AI_PROFILE, id: 'two' },
      ],
      activeProfileId: 'missing',
    });

    expect(config.profiles.map(({ id }) => id)).toEqual(['one', 'two']);
    expect(config.activeProfileId).toBe('one');
  });

  it('migrates the original brainstorming prompt to concise, narrative-only plain text rules', () => {
    const legacyPrompt = `Tu es un assistant d’écriture spécialisé dans le scénario.
Tu aides l’auteur à explorer la dramaturgie, la structure, les personnages, les enjeux et les dialogues.
Tu distingues clairement les faits présents dans le contexte des hypothèses créatives.
Tu respectes la langue du scénario et tu ne prétends jamais avoir lu un passage qui n’a pas été joint.
Tes réponses sont concrètes, structurées et directement utiles à la réécriture.`;
    const config = sanitizeAiConfig({
      profiles: [{ ...DEFAULT_AI_PROFILE }],
      activeProfileId: DEFAULT_AI_PROFILE.id,
      brainstormingPrompt: legacyPrompt,
    });

    expect(config.brainstormingPrompt).toBe(DEFAULT_BRAINSTORMING_PROMPT);
    expect(config.brainstormingPrompt).toContain('exclusivement en texte simple');
    expect(config.brainstormingPrompt).toContain('programmation');
    expect(config.brainstormingPrompt).toContain('300 mots');
  });

  it('does not overwrite a customised brainstorming prompt', () => {
    const config = sanitizeAiConfig({
      profiles: [{ ...DEFAULT_AI_PROFILE }],
      activeProfileId: DEFAULT_AI_PROFILE.id,
      brainstormingPrompt: 'Mon prompt personnalisé',
    });
    expect(config.brainstormingPrompt).toBe('Mon prompt personnalisé');
  });
});

describe('AI prompt privacy helpers', () => {
  const attachment = {
    id: 'selection-1',
    kind: 'selection' as const,
    label: 'Sélection',
    content: 'ALICE\nJe ne reviendrai pas.',
    approximateTokens: 8,
  };

  it('does not add screenplay context without an explicit attachment', () => {
    expect(composeAttachedMessage('Analyse ce choix.', [])).toBe('Analyse ce choix.');
  });

  it('labels and includes only explicitly supplied attachments', () => {
    const message = composeAttachedMessage('Analyse ce choix.', [attachment]);
    expect(message).toContain('Contexte explicitement joint par l’auteur');
    expect(message).toContain('type="selection"');
    expect(message).toContain(attachment.content);
  });

  it('uses the milestone temperatures and a conservative token estimate', () => {
    expect(modeTemperature('factual')).toBe(0.2);
    expect(modeTemperature('creative')).toBe(0.7);
    expect(approximateTokens('1234567')).toBe(2);
    expect(approximateTokens('')).toBe(0);
  });
});
