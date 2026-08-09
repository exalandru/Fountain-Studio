/**
 * Pure AI contracts and prompt helpers.
 *
 * No provider SDK is used: each connection profile names a provider, and the matching
 * adapter in `./providers` describes its requests and parses its stream frames. The main
 * process performs the transport.
 */

import type { SceneView } from '../fountain/ast.js';
import type { Locale } from '../i18n/types.js';
import type { AiProviderKind } from './providers/types.js';
import { DEFAULT_PROVIDER, isProviderKind } from './providers/types.js';

export {
  AI_REQUEST_LIMIT_DEFAULTS,
  aiRequestLimits,
  appendCollectedAiChunk,
  type AiRequestLimits,
} from './limits.js';

export { aiEndpointOrigin, sameAiEndpointOrigin } from './origin.js';

export interface AiConnectionProfile {
  id: string;
  name: string;
  provider: AiProviderKind;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxTokens: number;
  reasoningEnabled: boolean;
}

export interface AiConfig {
  version: 1;
  activeProfileId: string;
  profiles: AiConnectionProfile[];
}

export interface AiProfileView extends AiConnectionProfile {
  hasApiKey: boolean;
}

export interface AiConfigView extends Omit<AiConfig, 'profiles'> {
  profiles: AiProfileView[];
  secureStorageAvailable: boolean;
}

export interface AiKeyUpdate {
  profileId: string;
  /** `null` removes the stored key; absent profile ids are ignored. */
  key: string | null;
}

export const DEFAULT_AI_PROFILE: Readonly<AiConnectionProfile> = {
  id: 'default',
  name: 'OpenAI',
  provider: DEFAULT_PROVIDER,
  baseUrl: 'https://api.openai.com',
  model: 'gpt-5',
  timeoutMs: 60_000,
  maxTokens: 8_192,
  reasoningEnabled: true,
};

export const DEFAULT_AI_CONFIG: Readonly<AiConfig> = {
  version: 1,
  activeProfileId: DEFAULT_AI_PROFILE.id,
  profiles: [DEFAULT_AI_PROFILE],
};

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function safeUrl(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.length > 2_000) return fallback;
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
      return fallback;
    }
    return url.toString().replace(/\/+$/, '');
  } catch {
    return fallback;
  }
}

function safeId(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : fallback;
}

export function sanitizeAiConfig(raw: unknown): AiConfig {
  const fallback: AiConfig = {
    ...DEFAULT_AI_CONFIG,
    profiles: [{ ...DEFAULT_AI_PROFILE }],
  };
  if (typeof raw !== 'object' || raw === null) return fallback;
  const input = raw as Record<string, unknown>;
  const profiles: AiConnectionProfile[] = [];
  if (Array.isArray(input['profiles'])) {
    for (const [index, candidate] of input['profiles'].slice(0, 10).entries()) {
      if (typeof candidate !== 'object' || candidate === null) continue;
      const profile = candidate as Record<string, unknown>;
      const id = safeId(profile['id'], `profile-${index + 1}`);
      if (profiles.some((item) => item.id === id)) continue;
      profiles.push({
        id,
        name:
          typeof profile['name'] === 'string' && profile['name'].trim()
            ? profile['name'].trim().slice(0, 80)
            : `Profile ${index + 1}`,
        // Profiles written before multi-provider support carry no `provider`, and an
        // unknown value must not disable a working connection: both fall back to the
        // OpenAI-compatible protocol the app has always spoken.
        provider: isProviderKind(profile['provider']) ? profile['provider'] : DEFAULT_PROVIDER,
        baseUrl: safeUrl(profile['baseUrl'], DEFAULT_AI_PROFILE.baseUrl),
        model:
          typeof profile['model'] === 'string' && profile['model'].trim()
            ? profile['model'].trim().slice(0, 200)
            : DEFAULT_AI_PROFILE.model,
        timeoutMs: boundedInteger(
          profile['timeoutMs'],
          DEFAULT_AI_PROFILE.timeoutMs,
          1_000,
          600_000,
        ),
        maxTokens: boundedInteger(profile['maxTokens'], DEFAULT_AI_PROFILE.maxTokens, 64, 200_000),
        reasoningEnabled:
          typeof profile['reasoningEnabled'] === 'boolean'
            ? profile['reasoningEnabled']
            : DEFAULT_AI_PROFILE.reasoningEnabled,
      });
    }
  }
  if (profiles.length === 0) profiles.push({ ...DEFAULT_AI_PROFILE });

  const activeCandidate = safeId(input['activeProfileId'], profiles[0]?.id ?? 'default');
  const activeProfileId = profiles.some((profile) => profile.id === activeCandidate)
    ? activeCandidate
    : (profiles[0]?.id ?? 'default');
  return { version: 1, activeProfileId, profiles };
}

export type AiChatMode = 'factual' | 'creative';

export interface AiChatRequest {
  requestId: string;
  profileId: string;
  mode: AiChatMode;
  systemPrompt: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Task-specific override, otherwise the mode's temperature applies. */
  temperature?: number;
  /**
   * Per-task override. Short transformation tasks deliberately bypass thinking, while
   * consistency analysis keeps the profile preference.
   */
  reasoning?: 'profile' | 'disabled';
}

export type AiErrorCode =
  | 'unauthorized'
  | 'rateLimit'
  | 'timeout'
  | 'contextLength'
  | 'emptyResponse'
  | 'network'
  | 'invalidRequest'
  | 'cancelled'
  | 'responseTooLarge'
  | 'unknown';

export function approximateTokens(text: string): number {
  if (!text) return 0;
  // A deliberately conservative provider-neutral estimate. French prose tends to use
  // slightly more tokens than English, hence 3.5 characters rather than the usual 4.
  return Math.max(1, Math.ceil(Array.from(text).length / 3.5));
}

export function modeTemperature(mode: AiChatMode): number {
  return mode === 'factual' ? 0.2 : 0.7;
}

/**
 * Prompts are written in English, whatever the interface language.
 *
 * One prose to maintain rather than two that drift apart, and English is the best-tested path
 * for every model these profiles can reach — small local ones included. What varies by language
 * is not the instructions but a single explicit line saying which language to answer in.
 *
 * Which language that is depends on what the tool produces, and the split matters:
 *
 *  - text that goes *into* the screenplay — a rewrite, a synonym, a character name, a bible
 *    sheet — follows the **screenplay**. A French screenplay must get French variants even when
 *    the interface is in English, so those prompts name no language at all: they say "in the
 *    language of the excerpt" and let the model read it off the text.
 *  - commentary *about* the screenplay — continuity, voice, repetition — follows the **reader**,
 *    because it is displayed inside a translated panel. Those prompts take the locale.
 *
 * The four tools that need no locale keep plain constants; the three that do are functions of it.
 * The signatures therefore say which tools depend on who is reading.
 */

/** Named in English because the instruction around it is. */
const LANGUAGE_NAME: Readonly<Record<Locale, string>> = { en: 'English', fr: 'French' };

/**
 * The line that decides what language a report comes back in.
 *
 * The quoting rule is stated in the same breath on purpose. A model told only "answer in English"
 * translates the quotes as well, and a reference showing a line the screenplay does not contain
 * is worse than no reference at all — the panel uses those quotes to jump into the text.
 */
function reportLanguage(locale: Locale): string {
  return `Write every description and suggestion in ${LANGUAGE_NAME[locale]}. Quote the screenplay verbatim, in its own language, never translated.`;
}

/** The rule for anything that will be pasted back into the screenplay. */
const EXCERPT_LANGUAGE = 'Answer in the language of the excerpt, never in another.';

export type RewriteTone =
  'neutral' | 'concise' | 'cinematic' | 'dramatic' | 'comic' | 'formal' | 'colloquial' | 'custom';

export const REWRITE_SYSTEM_PROMPT = `You rewrite an excerpt of a Fountain screenplay.
You produce exactly three genuinely different variants. ${EXCERPT_LANGUAGE}
You keep the meaning, the character's voice, and the Fountain syntax the element kind calls for.
You never touch Fountain markers that lie outside the selected passage.
Answer with nothing but a valid JSON object of the form {"variants":["...", "...", "..."]}, no Markdown and no commentary.`;

export interface RewritePromptInput {
  selection: string;
  elementKind: string;
  speaker: string | null;
  sceneHeading: string | null;
  sceneContext: string;
  tone: RewriteTone;
  customStyle: string;
}

const TONE_INSTRUCTIONS: Record<Exclude<RewriteTone, 'custom'>, string> = {
  neutral: 'Neutral, natural, faithful to the text.',
  concise: 'Tighter, without losing anything essential.',
  cinematic: 'More visual and cinematic, favouring what a camera can see.',
  dramatic: 'More dramatic, with more tension and more at stake.',
  comic: 'Lighter or funnier, without breaking the scene apart.',
  formal: 'In a formal register.',
  colloquial: 'In a colloquial, spoken register.',
};

export function buildRewritePrompt(input: RewritePromptInput): string {
  const style =
    input.tone === 'custom'
      ? input.customStyle.trim() || TONE_INSTRUCTIONS.neutral
      : TONE_INSTRUCTIONS[input.tone];
  return `Rewrite the selected passage as three variants.

Fountain kind: ${input.elementKind}
Speaking character: ${input.speaker ?? 'none'}
Scene: ${input.sceneHeading ?? 'outside any scene'}
Requested style: ${style}

Context, for consistency only — do not reproduce it:
<scene>
${input.sceneContext}
</scene>

Passage to rewrite:
<selection>
${input.selection}
</selection>`;
}

export function parseRewriteVariants(raw: string): string[] {
  try {
    const cleaned = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');
    const parsed = JSON.parse(cleaned) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return [];
    const variants = (parsed as { variants?: unknown }).variants;
    if (!Array.isArray(variants)) return [];
    return variants
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.trim())
      .filter((value, index, all) => all.indexOf(value) === index)
      .slice(0, 3);
  } catch {
    return [];
  }
}

export const SYNONYM_SYSTEM_PROMPT = `You suggest synonyms that suit a screenplay.
You respect the register and the precise sense the word carries in its context. ${EXCERPT_LANGUAGE}
Answer with nothing but a valid JSON object of the form {"suggestions":["..."]}, no Markdown and no commentary.
Offer at most ten words or short phrases, with no explanation.`;

export function buildSynonymPrompt(word: string, sceneContext: string): string {
  return `Suggest up to ten synonyms for the selected word, fitting the exact use it has in the scene.

<scene>
${sceneContext}
</scene>

<word>
${word}
</word>`;
}

export const CHARACTER_NAMES_SYSTEM_PROMPT = `You suggest character names for a narrative work.
You respect the period, place, genre and tone the context lets you infer, and the language the
screenplay is written in — a name is read aloud by the people in it.
Answer with nothing but a valid JSON object of the form {"suggestions":["..."]}, no Markdown and no commentary.
Offer at most ten distinct full names, with no explanation.`;

export type CharacterNameStyle = 'common' | 'rare' | 'creative';

export function buildCharacterNamesPrompt(
  currentName: string,
  existingNames: string[],
  sceneContext: string,
  style: CharacterNameStyle = 'common',
): string {
  const styleInstruction: Record<CharacterNameStyle, string> = {
    common:
      'Offer ordinary, natural names, the kind used every day in the language and culture the text implies.',
    rare: 'Offer real, credible names, but markedly less common ones — without drifting into invented names.',
    creative:
      'Offer fictional, invented or strongly imaginative names, suited to the genre and world of the work.',
  };
  return `Suggest up to ten alternative names for the character "${currentName}".
Requested style: ${styleInstruction[style]}
Avoid names already in use: ${existingNames.join(', ') || 'none'}.

<scene>
${sceneContext}
</scene>`;
}

export function parseShortSuggestions(raw: string, maximum = 10): string[] {
  try {
    const cleaned = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');
    const parsed = JSON.parse(cleaned) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return [];
    const suggestions = (parsed as { suggestions?: unknown }).suggestions;
    if (!Array.isArray(suggestions)) return [];
    return suggestions
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.trim())
      .filter((value, index, all) => all.indexOf(value) === index)
      .slice(0, maximum);
  } catch {
    return [];
  }
}

export type InconsistencyType =
  | 'continuity'
  | 'chronology'
  | 'character'
  | 'location'
  | 'plot'
  | 'dialogue'
  | 'voice'
  | 'repetition';
export type InconsistencySeverity = 'info' | 'minor' | 'major';
export type InconsistencyStatus = 'open' | 'ignored' | 'resolved';

export interface InconsistencyReference {
  sceneNumber: string;
  heading: string;
  quote: string;
}

export interface AiInconsistency {
  id: string;
  type: InconsistencyType;
  severity: InconsistencySeverity;
  description: string;
  references: InconsistencyReference[];
  suggestion: string;
  status: InconsistencyStatus;
}

export function inconsistencySystemPrompt(locale: Locale): string {
  return `You analyse a screenplay's consistency.
You report only precise contradictions or risks, each backed by the passages you were given.
You tell apart physical continuity, chronology, characterisation, geography, plot logic and contradictory dialogue.
${reportLanguage(locale)}
Answer with nothing but valid JSON, no Markdown and no commentary.`;
}

export function buildInconsistencyPrompt(screenplay: string): string {
  return `Analyse the whole screenplay for inconsistencies.
Return {"items":[{"type":"continuity|chronology|character|location|plot|dialogue","severity":"info|minor|major","description":"...","references":[{"sceneNumber":"...","heading":"...","quote":"..."}],"suggestion":"..."}]}.
Every reference must carry the scene number AND its heading, plus a short quotation.

<screenplay>
${screenplay}
</screenplay>`;
}

export function buildFactExtractionPrompt(screenplayChunk: string): string {
  return `Extract one factual record per scene: number, heading, characters present, location, time, objects, injuries or states, events, and what the characters know.
Return {"facts":[{"sceneNumber":"...","heading":"...","characters":[],"location":"...","time":"...","objects":[],"states":[],"events":[],"knowledge":[]}]}.

<screenplay>
${screenplayChunk}
</screenplay>`;
}

export function buildFactCrossCheckPrompt(facts: string): string {
  return `Check the factual records against one another and find the inconsistencies across the whole screenplay.
Return {"items":[{"type":"continuity|chronology|character|location|plot|dialogue","severity":"info|minor|major","description":"...","references":[{"sceneNumber":"...","heading":"...","quote":"..."}],"suggestion":"..."}]}.

<facts>
${facts}
</facts>`;
}

const INCONSISTENCY_TYPES = new Set<InconsistencyType>([
  'continuity',
  'chronology',
  'character',
  'location',
  'plot',
  'dialogue',
  'voice',
  'repetition',
]);
const INCONSISTENCY_SEVERITIES = new Set<InconsistencySeverity>(['info', 'minor', 'major']);

export function parseInconsistencies(raw: string): AiInconsistency[] {
  try {
    const cleaned = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');
    const parsed = JSON.parse(cleaned) as { items?: unknown };
    if (!Array.isArray(parsed.items)) return [];
    return parsed.items.slice(0, 500).flatMap((candidate, index) => {
      if (typeof candidate !== 'object' || candidate === null) return [];
      const item = candidate as Record<string, unknown>;
      if (
        !INCONSISTENCY_TYPES.has(item['type'] as InconsistencyType) ||
        !INCONSISTENCY_SEVERITIES.has(item['severity'] as InconsistencySeverity) ||
        typeof item['description'] !== 'string'
      ) {
        return [];
      }
      const references = Array.isArray(item['references'])
        ? item['references'].slice(0, 20).flatMap((value) => {
            if (typeof value !== 'object' || value === null) return [];
            const reference = value as Record<string, unknown>;
            if (
              typeof reference['sceneNumber'] !== 'string' ||
              typeof reference['heading'] !== 'string' ||
              typeof reference['quote'] !== 'string'
            ) {
              return [];
            }
            return [
              {
                sceneNumber: reference['sceneNumber'].slice(0, 40),
                heading: reference['heading'].slice(0, 300),
                quote: reference['quote'].slice(0, 500),
              },
            ];
          })
        : [];
      return [
        {
          id: `inconsistency-${Date.now()}-${index}`,
          type: item['type'] as InconsistencyType,
          severity: item['severity'] as InconsistencySeverity,
          description: item['description'].slice(0, 4_000),
          references,
          suggestion:
            typeof item['suggestion'] === 'string' ? item['suggestion'].slice(0, 4_000) : '',
          status: 'open' as const,
        },
      ];
    });
  } catch {
    return [];
  }
}

/** Groups complete scenes without cutting one in the middle. */
export function chunkScenes(scenes: Array<{ content: string }>, maximumTokens = 20_000): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const scene of scenes) {
    const candidate = current ? `${current}\n\n${scene.content}` : scene.content;
    if (current && approximateTokens(candidate) > maximumTokens) {
      chunks.push(current);
      current = scene.content;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function voiceConsistencySystemPrompt(locale: Locale): string {
  return `You analyse how consistent one character's voice is across a screenplay.
A voice is made of register, verbal tics and habits, sentence length and rhythm, the vocabulary that belongs to this character, and the way they go at a subject or dodge it.
A voice is not a straitjacket: a character legitimately shifts register depending on who they are speaking to, under emotion, when they lie, or when they are playing a part. You report only breaks that no situation would justify.
You are given their lines alone, without the action around them: where a break could be explained by dramatic context you cannot see, you stay quiet rather than speculate.
${reportLanguage(locale)}
Answer with nothing but valid JSON, no Markdown and no commentary.`;
}

/**
 * Every speech by one character, each tagged with the scene it belongs to.
 *
 * The scene *number* is part of the tag, not just the heading: the model is asked for a
 * `sceneNumber` in every reference, and `parseInconsistencies` discards any reference that
 * lacks one. Without the number in the context the model can only invent it, and the
 * reference chip would then display a scene that does not exist.
 *
 * Parentheticals are kept: "(sèchement)" is part of how a character sounds, and dropping it
 * would hide exactly the tonal breaks this analysis looks for.
 */
export function buildCharacterVoiceContext(
  scenes: readonly SceneView[],
  characterName: string,
): string {
  const chunks: string[] = [];
  for (const scene of scenes) {
    const tag = `[${scene.number} · ${scene.heading}]`;
    for (const element of scene.elements) {
      if (element.speaker !== characterName) continue;
      if (element.kind === 'dialogue') {
        chunks.push(`${tag}\n${characterName}: ${element.text}`);
      } else if (element.kind === 'parenthetical') {
        chunks.push(`${tag}\n${characterName} ${element.text}`);
      }
    }
  }
  return chunks.join('\n\n');
}

export const BIBLE_SYSTEM_PROMPT = `You draft one sheet of a screenplay's bible, from the screenplay itself.
You write only what the text establishes or clearly implies. You invent no past, no motivation and no physical detail the screenplay does not carry: a bible is used as a reference, so anything invented in it becomes a false fact.
Where the screenplay says nothing about a field, you return an empty string for that field. An empty field is a correct answer, not a failure — and it shows the author where their screenplay is silent.
You write in the present tense, in short sentences, with no remarks about your own work.
You write in the language of the screenplay, since the author reads this sheet beside it.
Answer with nothing but valid JSON, no Markdown and no commentary.`;

export function buildBibleDraftPrompt(
  kind: string,
  name: string,
  fields: readonly string[],
  context: string,
): string {
  return `Draft the bible sheet for ${kind} "${name}".
Return {"fields":{${fields.map((field) => `"${field}":"..."`).join(',')}}}.
Add no other key. Leave an empty string in any field the screenplay does not establish.

<screenplay>
${context}
</screenplay>`;
}

/**
 * Reads a drafted sheet.
 *
 * Only the fields that were asked for are kept: a model that invents a key would otherwise
 * put it in the sidecar, and the sidecar is the author's file.
 */
export function parseBibleDraft(raw: string, allowed: readonly string[]): Record<string, string> {
  try {
    const cleaned = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');
    const parsed = JSON.parse(cleaned) as { fields?: unknown };
    if (typeof parsed.fields !== 'object' || parsed.fields === null) return {};
    const source = parsed.fields as Record<string, unknown>;
    const result: Record<string, string> = {};
    for (const field of allowed) {
      const value = source[field];
      if (typeof value === 'string' && value.trim().length > 0) {
        result[field] = value.slice(0, 4_000);
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function structuralRepetitionSystemPrompt(locale: Locale): string {
  return `You look for structural repetition in a screenplay: two scenes doing the same job, the same beat played twice, information revealed again as though it were new, the same dramatic move run a second time unchanged.
Repeated words and turns of phrase are not your concern: those are found elsewhere, by other means.
A deliberate return is not a repetition: a motif that comes back changed, an answer to an earlier scene, a ritual that decays — these are craft. You report only what is treading water.
You have a one-line summary per scene and nothing more: where you cannot decide without the text, you abstain.
${reportLanguage(locale)}
Answer with nothing but valid JSON, no Markdown and no commentary.`;
}

export function buildStructuralRepetitionPrompt(digest: string): string {
  return `Find the structural repetitions in this screenplay.
Return {"items":[{"type":"repetition","severity":"info|minor|major","description":"...","references":[{"sceneNumber":"...","heading":"...","quote":"..."}],"suggestion":"..."}]}.
Every finding cites at least TWO scenes — the ones that repeat — with the number and heading exactly as given. The quote field carries the scene's summary.
The suggestion says what the second scene could do instead, or which of the two should go.
A screenplay that never treads water is answered with {"items":[]}: that is a valid result, not a failure.

<scenes>
${digest}
</scenes>`;
}

export function buildVoiceConsistencyPrompt(characterName: string, context: string): string {
  return `Analyse how consistent ${characterName}'s voice is.
Establish their dominant voice across all their lines first, then keep only the lines that depart from it without reason.
Return {"items":[{"type":"voice","severity":"info|minor|major","description":"...","references":[{"sceneNumber":"...","heading":"...","quote":"..."}],"suggestion":"..."}]}.
Every reference carries the scene number AND heading exactly as given in brackets, and quotes the offending line word for word.
A consistent voice is answered with {"items":[]}: that is a valid result, not a failure.

<lines>
${context}
</lines>`;
}
