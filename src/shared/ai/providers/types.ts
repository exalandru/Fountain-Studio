/**
 * Provider contracts.
 *
 * An adapter *describes* HTTP requests and *parses* stream frames. It never performs I/O:
 * the transport lives in `main/ai/proxy.ts`. Keeping the wire formats here as pure
 * functions is what makes every provider testable in Vitest without an Electron harness
 * (PLAN.md §3.1).
 */

import type { AiChatRequest, AiConnectionProfile } from '../index.js';

/**
 * Wire protocol of a connection. `mistral` shares the OpenAI protocol and only differs
 * by its presets, but stays a distinct kind so the settings UI can offer it explicitly.
 */
export type AiProviderKind = 'openai' | 'anthropic' | 'google' | 'ollama' | 'mistral';

export const PROVIDER_KINDS: readonly AiProviderKind[] = [
  'openai',
  'anthropic',
  'google',
  'ollama',
  'mistral',
];

/** Profiles written before multi-provider support are OpenAI-compatible. */
export const DEFAULT_PROVIDER: AiProviderKind = 'openai';

export function isProviderKind(value: unknown): value is AiProviderKind {
  return typeof value === 'string' && (PROVIDER_KINDS as readonly string[]).includes(value);
}

export interface AiRequestPlan {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/**
 * Optional request fields still believed to be accepted by an endpoint. Every provider
 * rejects a different subset — current Claude models refuse `temperature` outright, some
 * Gemini models refuse a zero thinking budget — so the transport starts optimistic and
 * walks this down through `degrade()`, memoising the result per (provider, url, model).
 */
export interface ProviderCapabilities {
  /** Ask for reasoning. */
  reasoning: boolean;
  /**
   * Ask for a specific reasoning depth rather than the provider's own default. Separate from
   * `reasoning` so an endpoint that refuses a graded level — an out-of-range Gemini budget, a
   * string `think` an older Ollama does not know — falls back to plain reasoning instead of
   * losing reasoning altogether.
   */
  gradedReasoning: boolean;
  /** Ask explicitly for reasoning to be switched off. */
  disableReasoning: boolean;
  /** Send a sampling temperature. */
  temperature: boolean;
}

export interface AiStreamFrame {
  content: string;
  reasoning: boolean;
  /** Error carried inside the stream itself rather than by the HTTP status. */
  error?: string;
}

export const EMPTY_FRAME: AiStreamFrame = { content: '', reasoning: false };

export interface AiProviderAdapter {
  readonly kind: AiProviderKind;
  /** `false` lets the settings dialog present the key as optional (Ollama). */
  readonly apiKeyRequired: boolean;
  /** Newline-delimited JSON instead of server-sent events (Ollama). */
  readonly framing: 'sse' | 'ndjson';

  modelsRequest(profile: AiConnectionProfile, apiKey: string): AiRequestPlan;
  parseModels(json: unknown): string[];

  /** Non-streaming round trip used by « Tester la connexion ». */
  probeRequest(
    profile: AiConnectionProfile,
    apiKey: string,
    capabilities: ProviderCapabilities,
  ): AiRequestPlan;
  parseProbe(json: unknown, fallbackModel: string): string;

  chatRequest(
    profile: AiConnectionProfile,
    apiKey: string,
    request: AiChatRequest,
    capabilities: ProviderCapabilities,
  ): AiRequestPlan;
  parseFrame(data: string): AiStreamFrame;

  /**
   * Called when an endpoint rejects a request with 400/422. Returns a reduced capability
   * set worth retrying, or `null` once nothing optional is left to drop.
   */
  degrade(current: ProviderCapabilities, status: number, body: string): ProviderCapabilities | null;
}

export interface ProviderPreset {
  kind: AiProviderKind;
  defaultBaseUrl: string;
  defaultModel: string;
  apiKeyRequired: boolean;
}

export const JSON_HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
};

/** Appends `path` without duplicating a version prefix the user already pasted. */
export function joinPath(baseUrl: string, prefix: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return base.endsWith(prefix) ? `${base}${path}` : `${base}${prefix}${path}`;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

export function readString(record: Record<string, unknown> | null, key: string): string {
  const value = record?.[key];
  return typeof value === 'string' ? value : '';
}

/** Case-insensitive field mention, used to attribute a 400 to the parameter that caused it. */
export function mentions(body: string, field: string): boolean {
  return body.toLowerCase().includes(field);
}

export function sortedUnique(models: string[]): string[] {
  return [...new Set(models.filter((model) => model.length > 0))].sort((left, right) =>
    left.localeCompare(right),
  );
}
