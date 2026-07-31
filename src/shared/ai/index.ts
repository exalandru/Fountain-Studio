/**
 * Pure AI contracts and prompt helpers.
 *
 * No provider SDK is used: each connection profile names a provider, and the matching
 * adapter in `./providers` describes its requests and parses its stream frames. The main
 * process performs the transport.
 */

import type { SceneView } from '../fountain/ast.js';
import type { AiProviderKind } from './providers/types.js';
import { DEFAULT_PROVIDER, isProviderKind } from './providers/types.js';

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

export type RewriteTone =
  'neutral' | 'concise' | 'cinematic' | 'dramatic' | 'comic' | 'formal' | 'colloquial' | 'custom';

export const REWRITE_SYSTEM_PROMPT = `Tu reformules un extrait de scénario Fountain.
Tu produis exactement trois variantes réellement différentes, dans la langue du texte.
Tu conserves le sens, la voix du personnage et la syntaxe Fountain adaptée au type d’élément.
Tu ne modifies jamais les marqueurs Fountain qui ne font pas partie du passage sélectionné.
Réponds exclusivement avec un objet JSON valide de la forme {"variants":["...", "...", "..."]}, sans Markdown ni commentaire.`;

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
  neutral: 'Neutre, naturel et fidèle au texte.',
  concise: 'Plus concis, sans perdre les informations essentielles.',
  cinematic: 'Plus visuel et cinématographique, en privilégiant ce qui peut être filmé.',
  dramatic: 'Plus dramatique, avec davantage de tension et d’enjeu.',
  comic: 'Plus léger ou comique, sans casser la cohérence de la scène.',
  formal: 'Dans un registre soutenu.',
  colloquial: 'Dans un registre familier et oral.',
};

export function buildRewritePrompt(input: RewritePromptInput): string {
  const style =
    input.tone === 'custom'
      ? input.customStyle.trim() || TONE_INSTRUCTIONS.neutral
      : TONE_INSTRUCTIONS[input.tone];
  return `Reformule le passage sélectionné en trois variantes.

Type Fountain : ${input.elementKind}
Personnage locuteur : ${input.speaker ?? 'aucun'}
Scène : ${input.sceneHeading ?? 'hors scène'}
Style demandé : ${style}

Contexte de cohérence, à ne pas reproduire :
<scene>
${input.sceneContext}
</scene>

Passage à reformuler :
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

export const SYNONYM_SYSTEM_PROMPT = `Tu proposes des synonymes adaptés à un scénario.
Tu respectes la langue, le registre et le sens précis du mot dans son contexte.
Réponds exclusivement avec un objet JSON valide de la forme {"suggestions":["..."]}, sans Markdown ni commentaire.
Propose au maximum dix mots ou expressions courtes, sans explication.`;

export function buildSynonymPrompt(word: string, sceneContext: string): string {
  return `Propose jusqu’à dix synonymes du mot sélectionné, adaptés à son emploi exact dans la scène.

<scene>
${sceneContext}
</scene>

<word>
${word}
</word>`;
}

export const CHARACTER_NAMES_SYSTEM_PROMPT = `Tu proposes des noms de personnages pour une œuvre narrative.
Tu respectes la langue, l’époque, le lieu, le genre et le ton déductibles du contexte.
Réponds exclusivement avec un objet JSON valide de la forme {"suggestions":["..."]}, sans Markdown ni commentaire.
Propose au maximum dix noms complets distincts, sans explication.`;

export type CharacterNameStyle = 'common' | 'rare' | 'creative';

export function buildCharacterNamesPrompt(
  currentName: string,
  existingNames: string[],
  sceneContext: string,
  style: CharacterNameStyle = 'common',
): string {
  const styleInstruction: Record<CharacterNameStyle, string> = {
    common:
      'Propose des noms communs et naturels, employés au quotidien dans la langue et la culture déductibles du texte.',
    rare: 'Propose des noms réels et crédibles, mais nettement moins courants, sans tomber dans les noms inventés.',
    creative:
      'Propose des noms fictifs, inventés ou très créatifs, adaptés au genre et à l’univers de l’œuvre.',
  };
  return `Propose jusqu’à dix noms alternatifs pour le personnage "${currentName}".
Style demandé : ${styleInstruction[style]}
Évite les noms déjà employés : ${existingNames.join(', ') || 'aucun'}.

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

export const INCONSISTENCY_SYSTEM_PROMPT = `Tu analyses la cohérence d’un scénario.
Tu ne signales que des contradictions ou risques précis, étayés par les passages fournis.
Tu distingues continuité matérielle, chronologie, caractérisation, géographie, logique d’intrigue et dialogue contradictoire.
Réponds exclusivement en JSON valide, sans Markdown ni commentaire.`;

export function buildInconsistencyPrompt(screenplay: string): string {
  return `Analyse les incohérences sur l’ensemble du scénario.
Retourne {"items":[{"type":"continuity|chronology|character|location|plot|dialogue","severity":"info|minor|major","description":"...","references":[{"sceneNumber":"...","heading":"...","quote":"..."}],"suggestion":"..."}]}.
Chaque référence doit contenir le numéro ET le heading de scène, ainsi qu’une courte citation.

<screenplay>
${screenplay}
</screenplay>`;
}

export function buildFactExtractionPrompt(screenplayChunk: string): string {
  return `Extrais une fiche factuelle par scène : numéro, heading, personnages présents, lieu, moment, objets, blessures ou états, événements, et informations connues des personnages.
Retourne {"facts":[{"sceneNumber":"...","heading":"...","characters":[],"location":"...","time":"...","objects":[],"states":[],"events":[],"knowledge":[]}]}.

<screenplay>
${screenplayChunk}
</screenplay>`;
}

export function buildFactCrossCheckPrompt(facts: string): string {
  return `Vérifie les fiches factuelles entre elles et détecte les incohérences sur l’ensemble du scénario.
Retourne {"items":[{"type":"continuity|chronology|character|location|plot|dialogue","severity":"info|minor|major","description":"...","references":[{"sceneNumber":"...","heading":"...","quote":"..."}],"suggestion":"..."}]}.

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

export const VOICE_CONSISTENCY_SYSTEM_PROMPT = `Tu analyses la cohérence de la « voix » d’un seul personnage dans un scénario.
La voix comprend le registre de langue, les tics et manies verbales, la longueur et le rythme des phrases, le vocabulaire propre au personnage, et sa manière d’attaquer ou d’esquiver.
Une voix n’est pas un carcan : un personnage change légitimement de registre selon son interlocuteur, sous le coup de l’émotion, quand il ment ou quand il joue un rôle. Tu ne signales que les ruptures qu’aucune situation ne justifierait.
On ne te fournit que ses répliques, sans l’action autour : si une rupture pourrait s’expliquer par un contexte dramatique que tu ne vois pas, tu te tais plutôt que de spéculer.
Réponds exclusivement en JSON valide, sans Markdown ni commentaire.`;

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
        chunks.push(`${tag}\n${characterName} : ${element.text}`);
      } else if (element.kind === 'parenthetical') {
        chunks.push(`${tag}\n${characterName} ${element.text}`);
      }
    }
  }
  return chunks.join('\n\n');
}

export const BIBLE_SYSTEM_PROMPT = `Tu rédiges une fiche de bible pour un scénario, à partir du scénario lui-même.
Tu n’écris que ce que le texte établit ou implique clairement. Tu n’inventes ni passé, ni motivation, ni détail physique qui ne soit pas dans le scénario : une bible sert de référence, une invention y devient un fait faux.
Quand le scénario ne dit rien d’un champ, tu renvoies une chaîne vide pour ce champ. Un champ vide est une réponse juste, pas un échec.
Tu écris au présent, en phrases courtes, sans commentaire sur ton propre travail.
Réponds exclusivement en JSON valide, sans Markdown ni commentaire.`;

export function buildBibleDraftPrompt(
  kind: string,
  name: string,
  fields: readonly string[],
  context: string,
): string {
  return `Rédige la fiche de bible pour ${kind} « ${name} ».
Retourne {"fields":{${fields.map((field) => `"${field}":"..."`).join(',')}}}.
N’ajoute aucune autre clé. Laisse une chaîne vide tout champ que le scénario n’établit pas.

<scenario>
${context}
</scenario>`;
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

export const STRUCTURAL_REPETITION_SYSTEM_PROMPT = `Tu cherches les répétitions structurelles dans un scénario : deux scènes qui remplissent la même fonction, un même beat joué deux fois, une information révélée à nouveau comme si elle était neuve, un même mouvement dramatique rejoué à l’identique.
Tu ne t’occupes pas des répétitions de mots ou de tournures : elles sont relevées ailleurs, par un autre moyen.
Un retour délibéré n’est pas une répétition : un motif qui revient transformé, une réponse à une scène antérieure, un rituel qui se dégrade sont des procédés. Tu ne signales que ce qui fait du surplace.
Tu ne disposes que d’un résumé d’une ligne par scène : si tu ne peux pas trancher sans le texte, tu t’abstiens.
Réponds exclusivement en JSON valide, sans Markdown ni commentaire.`;

export function buildStructuralRepetitionPrompt(digest: string): string {
  return `Repère les répétitions structurelles dans ce scénario.
Retourne {"items":[{"type":"repetition","severity":"info|minor|major","description":"...","references":[{"sceneNumber":"...","heading":"...","quote":"..."}],"suggestion":"..."}]}.
Chaque constat cite au moins DEUX scènes — celles qui se répètent — avec leur numéro et leur heading tels qu’ils sont donnés. Le champ quote reprend le résumé de la scène.
La suggestion dit ce que la seconde scène pourrait faire d’autre, ou laquelle des deux se supprime.
Un scénario sans surplace se répond {"items":[]} : c’est un résultat valable, pas un échec.

<scenes>
${digest}
</scenes>`;
}

export function buildVoiceConsistencyPrompt(characterName: string, context: string): string {
  return `Analyse la cohérence de la voix du personnage ${characterName}.
Établis d’abord sa voix dominante sur l’ensemble de ses répliques, puis ne retiens que celles qui s’en écartent sans raison.
Retourne {"items":[{"type":"voice","severity":"info|minor|major","description":"...","references":[{"sceneNumber":"...","heading":"...","quote":"..."}],"suggestion":"..."}]}.
Chaque référence reprend le numéro ET le heading de scène tels qu’ils sont donnés entre crochets, et cite la réplique en cause mot pour mot.
Une voix cohérente se répond {"items":[]} : c’est un résultat valable, pas un échec.

<repliques>
${context}
</repliques>`;
}
