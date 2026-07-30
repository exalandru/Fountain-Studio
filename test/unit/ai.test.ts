import { describe, expect, it } from 'vitest';
import {
  approximateTokens,
  buildCharacterNamesPrompt,
  buildRewritePrompt,
  buildSynonymPrompt,
  chunkScenes,
  DEFAULT_AI_PROFILE,
  modeTemperature,
  parseInconsistencies,
  parseRewriteVariants,
  parseShortSuggestions,
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
    });

    expect(config).toMatchObject({
      version: 1,
      activeProfileId: 'local',
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

  it('adopts a declared provider and falls back to OpenAI otherwise', () => {
    const config = sanitizeAiConfig({
      activeProfileId: 'anthropic',
      profiles: [
        // Written before multi-provider support: no `provider` field at all.
        { ...DEFAULT_AI_PROFILE, id: 'legacy', provider: undefined },
        { ...DEFAULT_AI_PROFILE, id: 'anthropic', provider: 'anthropic' },
        { ...DEFAULT_AI_PROFILE, id: 'bogus', provider: 'cohere' },
      ],
    });

    expect(config.profiles.map((profile) => [profile.id, profile.provider])).toEqual([
      ['legacy', 'openai'],
      ['anthropic', 'anthropic'],
      ['bogus', 'openai'],
    ]);
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
});

describe('M6 structured AI helpers', () => {
  it('builds an AST-aware rewrite prompt and parses exactly three distinct variants', () => {
    const prompt = buildRewritePrompt({
      selection: 'Je pars.',
      elementKind: 'dialogue',
      speaker: 'ALICE',
      sceneHeading: 'INT. CUISINE - NUIT',
      sceneContext: 'ALICE\nJe pars.',
      tone: 'dramatic',
      customStyle: '',
    });
    expect(prompt).toContain('Type Fountain : dialogue');
    expect(prompt).toContain('Personnage locuteur : ALICE');
    expect(prompt).toContain('Plus dramatique');
    expect(parseRewriteVariants('```json\n{"variants":["A","B","C","D"]}\n```')).toEqual([
      'A',
      'B',
      'C',
    ]);
  });

  it('validates structured inconsistencies and ignores malformed items', () => {
    const items = parseInconsistencies(
      JSON.stringify({
        items: [
          {
            type: 'chronology',
            severity: 'major',
            description: 'Le jour change sans transition.',
            references: [
              {
                sceneNumber: '12',
                heading: 'EXT. RUE - JOUR',
                quote: 'Le soleil se lève.',
              },
            ],
            suggestion: 'Ajouter une ellipse.',
          },
          { type: 'invalid', severity: 'major', description: 'Non valide' },
        ],
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: 'chronology',
      severity: 'major',
      status: 'open',
    });
  });

  it('chunks long scripts only between complete scenes', () => {
    expect(
      chunkScenes(
        [{ content: 'A'.repeat(40) }, { content: 'B'.repeat(40) }, { content: 'C'.repeat(40) }],
        20,
      ),
    ).toEqual(['A'.repeat(40), 'B'.repeat(40), 'C'.repeat(40)]);
  });

  it('builds concise synonym and character-name prompts and bounds suggestions', () => {
    expect(buildSynonymPrompt('marche', 'Elle marche vite.')).toContain('<word>\nmarche\n</word>');
    expect(buildCharacterNamesPrompt('ALICE', ['ALICE', 'BOB'], 'INT. BAR')).toContain(
      'ALICE, BOB',
    );
    expect(
      parseShortSuggestions(
        JSON.stringify({
          suggestions: [
            'avance',
            'progresse',
            'avance',
            ...Array.from({ length: 20 }, (_, i) => `s${i}`),
          ],
        }),
      ),
    ).toEqual(['avance', 'progresse', 's0', 's1', 's2', 's3', 's4', 's5', 's6', 's7']);
  });
});

describe('AI request tuning', () => {
  it('uses the milestone temperatures and a conservative token estimate', () => {
    expect(modeTemperature('factual')).toBe(0.2);
    expect(modeTemperature('creative')).toBe(0.7);
    expect(approximateTokens('1234567')).toBe(2);
    expect(approximateTokens('')).toBe(0);
  });
});
