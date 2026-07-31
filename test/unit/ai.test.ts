import { describe, expect, it } from 'vitest';
import { parse } from '../../src/shared/fountain/index.js';
import {
  approximateTokens,
  buildCharacterNamesPrompt,
  BIBLE_SYSTEM_PROMPT,
  buildCharacterVoiceContext,
  buildVoiceConsistencyPrompt,
  parseBibleDraft,
  buildRewritePrompt,
  buildSynonymPrompt,
  chunkScenes,
  DEFAULT_AI_PROFILE,
  modeTemperature,
  parseInconsistencies,
  parseRewriteVariants,
  parseShortSuggestions,
  sanitizeAiConfig,
  VOICE_CONSISTENCY_SYSTEM_PROMPT,
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

describe('character voice context', () => {
  const screenplay = parse(`INT. LABO - NUIT

ALICE
Les serveurs tiennent.

BOB
Pas longtemps.

EXT. RUE - JOUR

ALICE
(sèchement)
On y va.

Elle claque la portière.

ALICE
Maintenant.
`);

  const scenes = screenplay.scenes.map((scene) => ({
    number: scene.number,
    heading: scene.heading,
    location: scene.location,
    elements: scene.elements,
  }));

  it('gathers one character’s speeches, each tagged with its scene', () => {
    const context = buildCharacterVoiceContext(scenes, 'ALICE');
    expect(context).toContain('[1 · INT. LABO - NUIT]\nALICE : Les serveurs tiennent.');
    expect(context).toContain('[2 · EXT. RUE - JOUR]\nALICE : On y va.');
    expect(context).toContain('[2 · EXT. RUE - JOUR]\nALICE : Maintenant.');
    // Another character's lines, and the action around them, are not this voice.
    expect(context).not.toContain('Pas longtemps.');
    expect(context).not.toContain('portière');
  });

  it('tags each speech with the scene number the model must quote back', () => {
    // parseInconsistencies drops any reference without a sceneNumber, so a context that
    // only carried headings would leave the model inventing the number.
    const context = buildCharacterVoiceContext(scenes, 'ALICE');
    for (const chunk of context.split('\n\n')) {
      expect(chunk).toMatch(/^\[\d+ · /);
    }
  });

  it('keeps parentheticals, which are part of how a character sounds', () => {
    expect(buildCharacterVoiceContext(scenes, 'ALICE')).toContain('(sèchement)');
  });

  it('attributes every speech of a scene, not only the first', () => {
    const chunks = buildCharacterVoiceContext(scenes, 'ALICE').split('\n\n');
    expect(chunks.at(-1)).toBe('[2 · EXT. RUE - JOUR]\nALICE : Maintenant.');
  });

  it('returns nothing for a character who never speaks', () => {
    expect(buildCharacterVoiceContext(scenes, 'CHLOÉ')).toBe('');
  });

  it('accepts voice findings, whose type the parser must recognise', () => {
    // Regression: 'voice' was in the type union but missing from the runtime guard, so every
    // voice finding was silently discarded and the analysis always reported nothing.
    const items = parseInconsistencies(
      '{"items":[{"type":"voice","severity":"minor","description":"Registre trop soutenu.",' +
        '"references":[{"sceneNumber":"2","heading":"EXT. RUE - JOUR","quote":"On y va."}]}]}',
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.type).toBe('voice');
  });

  it('asks for an empty list rather than pressing the model to find something', () => {
    // A voice that holds together has to have a way of being reported as such, or the
    // analysis becomes a machine for manufacturing false positives.
    const prompt = buildVoiceConsistencyPrompt('ALICE', 'x');
    expect(prompt).toContain('{"items":[]}');
    // And the model must be told the variation it sees may be motivated.
    expect(VOICE_CONSISTENCY_SYSTEM_PROMPT).toContain('légitimement');
  });
});

describe('bible drafting', () => {
  const FIELDS = ['role', 'wants', 'fears'] as const;

  it('keeps only the fields that were asked for', () => {
    // A model that invents a key would otherwise put it in the sidecar, and the sidecar is
    // the author's file.
    const drafted = parseBibleDraft(
      '{"fields":{"role":"Chef de projet.","invented":"n’importe quoi","wants":"Finir à temps."}}',
      FIELDS,
    );
    expect(drafted).toEqual({ role: 'Chef de projet.', wants: 'Finir à temps.' });
    expect('invented' in drafted).toBe(false);
  });

  it('strips a Markdown fence, as every parser in this file does', () => {
    expect(parseBibleDraft('```json\n{"fields":{"role":"Témoin."}}\n```', FIELDS)).toEqual({
      role: 'Témoin.',
    });
  });

  it('drops empty and whitespace-only values rather than storing blanks', () => {
    // A blank field is the model saying the screenplay does not establish it, which must
    // leave the author's own field untouched rather than writing a space into it.
    expect(
      parseBibleDraft('{"fields":{"role":"","wants":"   ","fears":"La nuit."}}', FIELDS),
    ).toEqual({ fears: 'La nuit.' });
  });

  it('returns nothing on anything unusable, rather than throwing', () => {
    expect(parseBibleDraft('not json', FIELDS)).toEqual({});
    expect(parseBibleDraft('{"fields":null}', FIELDS)).toEqual({});
    expect(parseBibleDraft('{"fields":["role"]}', FIELDS)).toEqual({});
    expect(parseBibleDraft('{}', FIELDS)).toEqual({});
  });

  it('tells the model that a blank field is a valid answer', () => {
    // Without this the model invents a backstory, and an invention in a bible becomes a fact
    // the production works from.
    expect(BIBLE_SYSTEM_PROMPT).toContain('chaîne vide');
    expect(BIBLE_SYSTEM_PROMPT).toContain('Tu n’invente');
  });
});
