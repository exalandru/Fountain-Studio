import { describe, expect, it } from 'vitest';
import { parse } from '../../src/shared/fountain/index.js';
import {
  approximateTokens,
  acceptRewriteVariants,
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
  parseCharacterNameSuggestions,
  parseInconsistencies,
  parseRewriteVariants,
  parseShortSuggestions,
  sanitizeAiConfig,
  inconsistencySystemPrompt,
  structuralRepetitionSystemPrompt,
  voiceConsistencySystemPrompt,
  REWRITE_SYSTEM_PROMPT,
  SYNONYM_SYSTEM_PROMPT,
  CHARACTER_NAMES_SYSTEM_PROMPT,
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
          timeoutMs: 60_000,
          maxTokens: 200_000,
          reasoningEnabled: false,
        },
      ],
    });
  });

  it('resolves an absent or unknown reasoning level to the provider default', () => {
    const profiles = sanitizeAiConfig({
      version: 1,
      activeProfileId: 'a',
      profiles: [
        // Written before the depth setting existed.
        { id: 'a', name: 'A', model: 'm', reasoningEnabled: true },
        { id: 'b', name: 'B', model: 'm', reasoningEffort: 'turbo' },
        { id: 'c', name: 'C', model: 'm', reasoningEffort: 'high' },
      ],
    }).profiles;

    expect(profiles.map((entry) => entry.reasoningEffort)).toEqual(['auto', 'auto', 'high']);
  });

  it('leaves reasoning off on a fresh profile', () => {
    expect(DEFAULT_AI_PROFILE.reasoningEnabled).toBe(false);
    expect(DEFAULT_AI_PROFILE.reasoningEffort).toBe('auto');
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
      tone: 'dramatic',
      customStyle: '',
    });
    expect(prompt).toContain('Fountain kind of the selection: dialogue');
    expect(prompt).toContain('Speaking character: ALICE');
    expect(prompt).toContain('More dramatic');
    expect(prompt).not.toContain('<scene>');
    expect(prompt).not.toContain('INT. CUISINE');
    // Old behaviour truncated four variants to three; the contract now rejects extras.
    expect(parseRewriteVariants('```json\n{"variants":["A","B","C","D"]}\n```')).toEqual([]);
    expect(parseRewriteVariants('```json\n{"variants":["A","B","C"]}\n```')).toEqual([
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
    expect(context).toContain('[1 · INT. LABO - NUIT]\nALICE: Les serveurs tiennent.');
    expect(context).toContain('[2 · EXT. RUE - JOUR]\nALICE: On y va.');
    expect(context).toContain('[2 · EXT. RUE - JOUR]\nALICE: Maintenant.');
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
    expect(chunks.at(-1)).toBe('[2 · EXT. RUE - JOUR]\nALICE: Maintenant.');
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
    expect(voiceConsistencySystemPrompt('en')).toContain('legitimately');
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
    expect(BIBLE_SYSTEM_PROMPT).toContain('empty string');
    expect(BIBLE_SYSTEM_PROMPT).toContain('not a failure');
    expect(BIBLE_SYSTEM_PROMPT).toContain('invent');
  });
});

/**
 * The prompts are written in English whatever the interface language, and say explicitly which
 * language to answer in. These tests guard the two things that would silently break that: a
 * caveat lost in translation, and a language rule applied to the wrong kind of tool.
 */
describe('prompt language', () => {
  it('names the reader\u2019s language in every report prompt', () => {
    for (const build of [
      inconsistencySystemPrompt,
      voiceConsistencySystemPrompt,
      structuralRepetitionSystemPrompt,
    ]) {
      expect(build('en')).toContain('in English');
      expect(build('fr')).toContain('in French');
      expect(build('fr')).not.toContain('in English');
    }
  });

  it('keeps the quotes in the screenplay\u2019s own language', () => {
    // Told only "answer in English", a model translates the quotations too — and a reference
    // showing a line the screenplay does not contain is worse than no reference: the panel uses
    // those quotes to jump into the text.
    for (const build of [
      inconsistencySystemPrompt,
      voiceConsistencySystemPrompt,
      structuralRepetitionSystemPrompt,
    ]) {
      expect(build('fr')).toContain('verbatim');
      expect(build('fr')).toContain('never translated');
    }
  });

  it('changes nothing but the language line between two locales', () => {
    // Anything else that differed would be prose drifting apart between locales, which is the
    // very thing one English source is meant to prevent.
    for (const build of [
      inconsistencySystemPrompt,
      voiceConsistencySystemPrompt,
      structuralRepetitionSystemPrompt,
    ]) {
      const strip = (locale: 'en' | 'fr') =>
        build(locale)
          .split('\n')
          .filter((line) => !line.startsWith('Write every description'))
          .join('\n');
      expect(strip('en')).toBe(strip('fr'));
    }
  });

  it('never pins a language on what goes back into the screenplay', () => {
    // A French screenplay must get French rewrites under an English interface. These prompts
    // therefore name no language: they defer to the excerpt.
    for (const prompt of [
      REWRITE_SYSTEM_PROMPT,
      SYNONYM_SYSTEM_PROMPT,
      CHARACTER_NAMES_SYSTEM_PROMPT,
      BIBLE_SYSTEM_PROMPT,
    ]) {
      expect(prompt).not.toContain('in English');
      expect(prompt).not.toContain('in French');
    }
    expect(REWRITE_SYSTEM_PROMPT).toContain('language of the excerpt');
    expect(SYNONYM_SYSTEM_PROMPT).toContain('language of the excerpt');
    expect(BIBLE_SYSTEM_PROMPT).toContain('language of the screenplay');
  });

  it('carries the restraint that keeps each analysis quiet', () => {
    // Each of these clauses is what stops a tool from manufacturing findings. Translating the
    // prompts could have flattened them into generic instructions, and no other test would have
    // noticed the analyses turning chatty.
    const voice = voiceConsistencySystemPrompt('en');
    expect(voice).toContain('not a straitjacket');
    expect(voice).toContain('no situation would justify');
    expect(voice).toContain('rather than speculate');

    const repetition = structuralRepetitionSystemPrompt('en');
    expect(repetition).toContain('deliberate return is not a repetition');
    expect(repetition).toContain('treading water');
    expect(repetition).toContain('you abstain');

    expect(inconsistencySystemPrompt('en')).toContain('backed by the passages');
  });

  it('holds no French left over from the translation', () => {
    // A half-finished translation reads as deliberate bilingualism and confuses the model.
    const prompts = [
      REWRITE_SYSTEM_PROMPT,
      SYNONYM_SYSTEM_PROMPT,
      CHARACTER_NAMES_SYSTEM_PROMPT,
      BIBLE_SYSTEM_PROMPT,
      inconsistencySystemPrompt('fr'),
      voiceConsistencySystemPrompt('fr'),
      structuralRepetitionSystemPrompt('fr'),
      buildVoiceConsistencyPrompt('ALICE', 'x'),
      buildSynonymPrompt('mot', 'scene'),
      buildCharacterNamesPrompt('ALICE', [], 'INT. BAR'),
    ];
    for (const prompt of prompts) {
      expect(prompt, prompt.slice(0, 40)).not.toMatch(/[àâçèéêëîïôûùœ]/i);
      expect(prompt).not.toMatch(/\b(Tu|Réponds|Retourne|Propose|scénario|réplique)\b/);
    }
  });
});

/**
 * Rewrite Selection contract.
 *
 * These witnesses encode the product rule the screenshots violated: three variants may be
 * well-formed JSON and still be invalid when they escape the selected prose's scope.
 * Against the previous parser (shape-only, silent 4→3 truncate, no scope check), every
 * rejection case below would have been accepted.
 */
describe('rewrite selection contract', () => {
  const SELECTION =
    'Un ciel immense, cuivré, figé dans un crépuscule éternel. Une lueur persiste, telle une braise sous les cendres.';

  const payload = (variants: string[]) => JSON.stringify({ variants });

  it('accepts three valid plain rewrites of the selected prose', () => {
    const variants = [
      'Le ciel cuivré s’étend à perte de vue, suspendu dans un crépuscule immobile.',
      'Un firmament immense, teinté de cuivre, reste figé dans un soir sans fin.',
      'Le ciel occupe tout l’horizon, cuivré, comme une braise sous la cendre du jour.',
    ];
    const accepted = acceptRewriteVariants(payload(variants), SELECTION);
    expect(accepted).toEqual({ ok: true, variants });
  });

  it('rejects a scene-heading escape for ordinary action prose', () => {
    // Previous implementation: parseRewriteVariants returned three strings → dialog accepted.
    const raw = payload([
      'EXT. MÉTROPOLE MORTE - JOUR\n\nLe ciel occupe tout le cadre.',
      'Un ciel cuivré s’étend.',
      'Une lueur persiste sous les cendres.',
    ]);
    expect(parseRewriteVariants(raw)).toEqual([
      'EXT. MÉTROPOLE MORTE - JOUR\n\nLe ciel occupe tout le cadre.',
      'Un ciel cuivré s’étend.',
      'Une lueur persiste sous les cendres.',
    ]);
    expect(acceptRewriteVariants(raw, SELECTION)).toEqual({ ok: false, reason: 'scope' });
  });

  it('rejects structural screenplay escapes such as character cues', () => {
    const raw = payload([
      'NARRATEUR\nLe ciel cuivré s’étend.',
      'Un firmament immense reste figé.',
      'Une lueur persiste sous les cendres.',
    ]);
    expect(acceptRewriteVariants(raw, SELECTION)).toEqual({ ok: false, reason: 'scope' });
  });

  it('rejects transition lines the isolated Fountain parse may not classify', () => {
    // `CUT TO:` alone is often not a `transition` element (title-page key / blank-line
    // sandwich). The previous shape-only gate would have accepted it.
    expect(
      acceptRewriteVariants(
        payload(['CUT TO:', 'Un firmament immense reste figé.', 'Une lueur persiste.']),
        SELECTION,
      ),
    ).toEqual({ ok: false, reason: 'scope' });
    expect(
      acceptRewriteVariants(
        payload([
          'CUT TO:\n\nLe ciel occupe tout le cadre.',
          'Un firmament immense reste figé.',
          'Une lueur persiste.',
        ]),
        SELECTION,
      ),
    ).toEqual({ ok: false, reason: 'scope' });
  });

  it('accepts cinematic visual prose without screenplay structure', () => {
    const variants = [
      'La lumière glisse sur les ruines sous un ciel cuivré.',
      'Une braise de crépuscule couve au-dessus de la métropole morte.',
      'Le firmament, immense et figé, tient le soir comme une cendre chaude.',
    ];
    expect(acceptRewriteVariants(payload(variants), SELECTION)).toEqual({
      ok: true,
      variants,
    });
  });

  it('rejects Fountain emphasis that the selection did not use', () => {
    // Observed failure mode: **cuivré** appeared although the source had no emphasis.
    const raw = payload([
      'Un ciel immense, **cuivré**, figé dans un crépuscule éternel.',
      'Un firmament immense reste figé.',
      'Une lueur persiste sous les cendres.',
    ]);
    expect(acceptRewriteVariants(raw, SELECTION)).toEqual({ ok: false, reason: 'formatting' });
  });

  it('preserves emphasis when the selection already uses it', () => {
    const selection = 'Un ciel **cuivré** s’étend.';
    const variants = [
      'Un firmament **cuivré** demeure.',
      'Le ciel **cuivré** reste immense.',
      'Une voûte **cuivrée** s’immobilise.',
    ];
    expect(acceptRewriteVariants(payload(variants), selection)).toEqual({
      ok: true,
      variants,
    });
  });

  it('rejects camera-direction structure absent from the selection', () => {
    const raw = payload([
      'CAMÉRA PLONGE sur un ciel cuivré.',
      'Un firmament immense reste figé.',
      'Une lueur persiste sous les cendres.',
    ]);
    expect(acceptRewriteVariants(raw, SELECTION)).toEqual({ ok: false, reason: 'camera' });
  });

  it('rejects too few, too many, empty, and duplicate variants', () => {
    expect(parseRewriteVariants(payload(['A', 'B']))).toEqual([]);
    expect(parseRewriteVariants(payload(['A', 'B', 'C', 'D']))).toEqual([]);
    expect(parseRewriteVariants(payload(['A', 'B', '   ']))).toEqual([]);
    expect(parseRewriteVariants(payload(['A', 'A', 'B']))).toEqual([]);
  });

  it('rejects commentary wrappers instead of extracting embedded JSON', () => {
    const wrapped =
      'Voici trois propositions :\n' +
      payload([
        'Le ciel cuivré s’étend.',
        'Un firmament immense reste figé.',
        'Une lueur persiste sous les cendres.',
      ]);
    expect(parseRewriteVariants(wrapped)).toEqual([]);
    expect(acceptRewriteVariants(wrapped, SELECTION)).toEqual({ ok: false, reason: 'shape' });
  });

  it('keeps French accents and punctuation through a valid payload', () => {
    const variants = [
      "L'horizon s'embrase, cuivré, figé.",
      'Une lueur d’ambre persiste sous les cendres.',
      'Le crépuscule étreint la métropole.',
    ];
    expect(acceptRewriteVariants(payload(variants), SELECTION)).toEqual({
      ok: true,
      variants,
    });
  });

  it('forbids inventing structure in the rewrite system prompt', () => {
    expect(REWRITE_SYSTEM_PROMPT).toContain('selected text only');
    expect(REWRITE_SYSTEM_PROMPT).toContain('scene headings');
    expect(REWRITE_SYSTEM_PROMPT).toContain('camera directions');
    expect(REWRITE_SYSTEM_PROMPT).toContain('evocative prose');
  });

  it('omits surrounding scene context from the rewrite user prompt', () => {
    // Context leakage was a plausible cause of EXT. MÉTROPOLE… escaping into variants.
    const prompt = buildRewritePrompt({
      selection: SELECTION,
      elementKind: 'action',
      speaker: null,
      tone: 'cinematic',
      customStyle: '',
    });
    expect(prompt).toContain('<selection>');
    expect(prompt).toContain(SELECTION);
    expect(prompt).not.toContain('<scene>');
    expect(prompt).toContain('without camera directions');
  });
});

describe('synonym and character-name contracts', () => {
  it('bounds synonym suggestions and rejects non-JSON commentary', () => {
    expect(parseShortSuggestions('Voici des synonymes : marche, avance')).toEqual([]);
    expect(
      parseShortSuggestions(JSON.stringify({ suggestions: ['marche', 'avance', 'marche'] })),
    ).toEqual(['marche', 'avance']);
  });

  it('rejects character-name commentary that would be inserted as a cue', () => {
    // Old parseShortSuggestions would have accepted the commentary string as a name.
    expect(
      parseCharacterNameSuggestions(
        JSON.stringify({
          suggestions: ['Je suggère : CORIN', 'CORIN', 'EVELYN STONE', 'Maybe Nora?'],
        }),
      ),
    ).toEqual(['CORIN', 'EVELYN STONE']);
  });

  it('accepts ordinary multi-word names', () => {
    expect(
      parseCharacterNameSuggestions(
        JSON.stringify({ suggestions: ['EVELYN STONE', 'MAYA VALE', 'NORA BLAKE'] }),
      ),
    ).toEqual(['EVELYN STONE', 'MAYA VALE', 'NORA BLAKE']);
  });
});
