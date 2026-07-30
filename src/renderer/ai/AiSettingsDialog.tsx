import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { AiConfig, AiConfigView, AiConnectionProfile, AiKeyUpdate } from '@shared/ai/index.js';
import { DEFAULT_AI_PROFILE, sanitizeAiConfig } from '@shared/ai/index.js';
import type { AiProviderKind } from '@shared/ai/providers/index.js';
import { PROVIDER_KINDS, PROVIDER_PRESETS } from '@shared/ai/providers/index.js';
import type { MessageKey } from '@shared/i18n/types.js';
import { useTranslator } from '../hooks/useTranslator.js';

interface AiSettingsDialogProps {
  onClose: () => void;
  onSaved: () => void;
}

const PROVIDER_LABEL: Readonly<Record<AiProviderKind, MessageKey>> = {
  openai: 'ai.settings.provider.openai',
  anthropic: 'ai.settings.provider.anthropic',
  google: 'ai.settings.provider.google',
  ollama: 'ai.settings.provider.ollama',
  mistral: 'ai.settings.provider.mistral',
};

/**
 * Two-letter monograms and a hue per connector, for the badges in the profile rail.
 *
 * Monograms are deliberately two letters and all distinct — a single initial would put
 * Anthropic and an OpenAI-compatible endpoint on the same letter. The hue is applied as a
 * translucent tint behind `--text`, never as a saturated fill behind white: a brand colour
 * at full strength falls below 4.5:1 for text this small.
 *
 * This lives in the renderer rather than in `PROVIDER_PRESETS` because a CSS hue is
 * presentation, and `src/shared` stays platform-agnostic.
 */
const PROVIDER_BADGE: Readonly<Record<AiProviderKind, { monogram: string; hue: string }>> = {
  openai: { monogram: 'OA', hue: '#10a37f' },
  anthropic: { monogram: 'AN', hue: '#d97757' },
  google: { monogram: 'GO', hue: '#4285f4' },
  ollama: { monogram: 'OL', hue: '#8e8e93' },
  mistral: { monogram: 'MI', hue: '#ff7000' },
};

function profileId(): string {
  return `profile-${crypto.randomUUID()}`;
}

/**
 * Replaces a field with the new provider's preset only when it still holds the previous
 * provider's default: a URL or model the author typed themselves is never overwritten.
 */
function retarget(current: string, previousDefault: string, nextDefault: string): string {
  return !current.trim() || current === previousDefault ? nextDefault : current;
}

function ProviderBadge({ provider }: { provider: AiProviderKind }) {
  const badge = PROVIDER_BADGE[provider];
  return (
    <span
      className="ai-provider-badge"
      style={{ '--badge-hue': badge.hue } as CSSProperties}
      aria-hidden="true"
    >
      {badge.monogram}
    </span>
  );
}

/**
 * Multi-provider connection settings.
 *
 * The profile is the axis of navigation, so it is a rail down the left rather than a
 * dropdown lost among the fields, and each action sits next to what it acts on: the key
 * removal beside the key, the model listing under the model. Only the connection probe
 * stays in the footer, because it validates the whole profile.
 */
export function AiSettingsDialog({ onClose, onSaved }: AiSettingsDialogProps) {
  const { t } = useTranslator();
  const railRef = useRef<HTMLUListElement | null>(null);
  const [view, setView] = useState<AiConfigView | null>(null);
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [removedKeys, setRemovedKeys] = useState<Set<string>>(() => new Set());
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState<'models' | 'test' | 'save' | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    void window.quantum
      .invoke('ai:config:get', undefined)
      .then((next) => {
        setView(next);
        setConfig({
          version: next.version,
          activeProfileId: next.activeProfileId,
          profiles: next.profiles.map(({ hasApiKey: _hasApiKey, ...profile }) => profile),
        });
      })
      .catch((error) => setFeedback(error instanceof Error ? error.message : String(error)));
  }, []);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      setKeys({});
      previous?.focus();
    };
  }, []);

  const activeProfile = useMemo(
    () => config?.profiles.find((profile) => profile.id === config.activeProfileId) ?? null,
    [config],
  );
  const activeView = view?.profiles.find((profile) => profile.id === config?.activeProfileId);

  const patchProfile = <K extends keyof AiConnectionProfile>(
    key: K,
    value: AiConnectionProfile[K],
  ) => {
    setConfig((current) =>
      current
        ? {
            ...current,
            profiles: current.profiles.map((profile) =>
              profile.id === current.activeProfileId ? { ...profile, [key]: value } : profile,
            ),
          }
        : current,
    );
    if (key === 'baseUrl') setModels([]);
    setFeedback(null);
  };

  const selectProfile = (id: string) => {
    setConfig((current) => (current ? { ...current, activeProfileId: id } : current));
    setModels([]);
    setFeedback(null);
  };

  /** Switching provider re-targets the endpoint and model, then invalidates the model list. */
  const changeProvider = (next: AiProviderKind) => {
    setConfig((current) =>
      current
        ? {
            ...current,
            profiles: current.profiles.map((profile) => {
              if (profile.id !== current.activeProfileId) return profile;
              const previous = PROVIDER_PRESETS[profile.provider];
              const preset = PROVIDER_PRESETS[next];
              return {
                ...profile,
                provider: next,
                baseUrl: retarget(profile.baseUrl, previous.defaultBaseUrl, preset.defaultBaseUrl),
                model: retarget(profile.model, previous.defaultModel, preset.defaultModel),
              };
            }),
          }
        : current,
    );
    setModels([]);
    setFeedback(null);
  };

  const addProfile = () => {
    const id = profileId();
    setConfig((current) => {
      if (!current) return current;
      // A new profile continues with the provider being configured rather than snapping
      // back to OpenAI.
      const provider =
        current.profiles.find((profile) => profile.id === current.activeProfileId)?.provider ??
        DEFAULT_AI_PROFILE.provider;
      const preset = PROVIDER_PRESETS[provider];
      return {
        ...current,
        activeProfileId: id,
        profiles: [
          ...current.profiles,
          {
            ...DEFAULT_AI_PROFILE,
            id,
            name: t('ai.settings.newProfile'),
            provider,
            baseUrl: preset.defaultBaseUrl,
            model: preset.defaultModel,
          },
        ],
      };
    });
    setModels([]);
    setFeedback(null);
  };

  const removeProfile = () => {
    setConfig((current) => {
      if (!current || current.profiles.length <= 1) return current;
      const profiles = current.profiles.filter((profile) => profile.id !== current.activeProfileId);
      return { ...current, profiles, activeProfileId: profiles[0]?.id ?? 'default' };
    });
    setModels([]);
    setFeedback(null);
    // The button that was just clicked unmounts with its row, which would drop focus to
    // the document body. Hand it to whichever profile became active.
    requestAnimationFrame(() => railRef.current?.querySelector('button')?.focus());
  };

  const temporaryKey = activeProfile
    ? removedKeys.has(activeProfile.id)
      ? ''
      : keys[activeProfile.id] || null
    : null;

  const runModels = async () => {
    if (!activeProfile) return;
    setBusy('models');
    setFeedback(null);
    try {
      const result = await window.quantum.invoke('ai:models:list', {
        profile: activeProfile,
        apiKey: temporaryKey,
      });
      setModels(result);
      setFeedback(t('ai.settings.modelsFound', { count: result.length }));
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const runTest = async () => {
    if (!activeProfile) return;
    setBusy('test');
    setFeedback(null);
    try {
      const result = await window.quantum.invoke('ai:connection:test', {
        profile: activeProfile,
        apiKey: temporaryKey,
      });
      setFeedback(
        t('ai.settings.connectionOk', { latency: result.latencyMs, model: result.model }),
      );
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!config) return;
    setBusy('save');
    setFeedback(null);
    try {
      const normalized = sanitizeAiConfig(config);
      const keyUpdates: AiKeyUpdate[] = [
        ...Object.entries(keys)
          .filter(([, key]) => key.length > 0)
          .map(([id, key]) => ({ profileId: id, key })),
        ...[...removedKeys].map((id) => ({ profileId: id, key: null })),
      ];
      await window.quantum.invoke('ai:config:save', { config: normalized, keyUpdates });
      setKeys({});
      onSaved();
      onClose();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="ai-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('ai.settings.title')}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
        }}
      >
        <header>
          <h2>{t('ai.settings.title')}</h2>
          <button
            type="button"
            className="panel-close"
            aria-label={t('ai.settings.close')}
            autoFocus
            onClick={onClose}
          >
            ×
          </button>
        </header>

        {!config || !view || !activeProfile ? (
          <div className="panel-placeholder">{t('ai.settings.loading')}</div>
        ) : (
          <div className="ai-settings-layout">
            <div className="ai-profile-rail">
              <ul
                className="ai-profile-list"
                aria-label={t('ai.settings.profileList')}
                ref={railRef}
              >
                {config.profiles.map((profile) => (
                  <li key={profile.id}>
                    <button
                      type="button"
                      className={`ai-profile-row${
                        profile.id === config.activeProfileId ? ' is-current' : ''
                      }`}
                      aria-current={profile.id === config.activeProfileId ? 'true' : undefined}
                      onClick={() => selectProfile(profile.id)}
                    >
                      <ProviderBadge provider={profile.provider} />
                      <span className="ai-profile-identity">
                        <span className="ai-profile-name">{profile.name}</span>
                        <span className="ai-profile-provider">
                          {t(PROVIDER_LABEL[profile.provider])}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>

              <button
                type="button"
                className="ai-profile-add"
                disabled={config.profiles.length >= 10}
                onClick={addProfile}
              >
                <span aria-hidden="true">+</span>
                {t('ai.settings.addProfileLong')}
              </button>

              {!view.secureStorageAvailable ? (
                <p className="ai-warning">{t('ai.settings.sessionKeyWarning')}</p>
              ) : null}
            </div>

            <div className="ai-settings-pane">
              <div className="ai-pane-header">
                <label className="ai-profile-name-field">
                  <span className="sr-only">{t('ai.settings.profileName')}</span>
                  <input
                    value={activeProfile.name}
                    maxLength={80}
                    onChange={(event) => patchProfile('name', event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="ai-danger"
                  disabled={config.profiles.length <= 1}
                  onClick={removeProfile}
                >
                  {t('ai.settings.deleteProfile')}
                </button>
              </div>

              <section className="ai-settings-section">
                <h3>{t('ai.settings.sectionConnection')}</h3>
                <div className="ai-field-grid">
                  <label>
                    <span>{t('ai.settings.provider')}</span>
                    <select
                      value={activeProfile.provider}
                      onChange={(event) => changeProvider(event.target.value as AiProviderKind)}
                    >
                      {PROVIDER_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {t(PROVIDER_LABEL[kind])}
                        </option>
                      ))}
                    </select>
                    {activeProfile.provider === 'openai' ? (
                      <small className="ai-field-note">
                        {t('ai.settings.providerCompatibleHint')}
                      </small>
                    ) : null}
                  </label>
                  <label className="ai-field-wide">
                    <span>{t('ai.settings.baseUrl')}</span>
                    <input
                      type="url"
                      value={activeProfile.baseUrl}
                      maxLength={2_000}
                      onChange={(event) => patchProfile('baseUrl', event.target.value)}
                    />
                  </label>
                  <div className="ai-field-wide ai-key-row">
                    <label>
                      <span>
                        {PROVIDER_PRESETS[activeProfile.provider].apiKeyRequired
                          ? t('ai.settings.apiKey')
                          : t('ai.settings.apiKeyOptional')}
                        {activeView?.hasApiKey && !removedKeys.has(activeProfile.id)
                          ? ` — ${t('ai.settings.keyConfigured')}`
                          : ''}
                      </span>
                      <input
                        type="password"
                        autoComplete="off"
                        placeholder={activeView?.hasApiKey ? '••••••••••••' : ''}
                        value={keys[activeProfile.id] ?? ''}
                        onChange={(event) => {
                          const key = event.target.value;
                          setKeys((current) => ({ ...current, [activeProfile.id]: key }));
                          if (key) {
                            setRemovedKeys((current) => {
                              const next = new Set(current);
                              next.delete(activeProfile.id);
                              return next;
                            });
                          }
                        }}
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        setKeys((current) => ({ ...current, [activeProfile.id]: '' }));
                        setRemovedKeys((current) => new Set(current).add(activeProfile.id));
                      }}
                    >
                      {t('ai.settings.removeKey')}
                    </button>
                  </div>
                </div>
              </section>

              {/* The legend doubles as this section's heading: a separate "Model" title
                  above a "Model" legend would say the same thing twice. */}
              <fieldset className="ai-settings-section ai-model-field">
                <legend>{t('ai.settings.model')}</legend>
                {models.length > 0 ? (
                  <div className="ai-model-picker">
                    {models.map((model) => (
                      <label key={model}>
                        <input
                          type="radio"
                          name="ai-model"
                          checked={activeProfile.model === model}
                          onChange={() => patchProfile('model', model)}
                        />
                        <span>{model}</span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <output>{activeProfile.model || t('ai.settings.noModel')}</output>
                )}
                <button type="button" disabled={busy !== null} onClick={() => void runModels()}>
                  {t('ai.settings.listModels')}
                </button>
              </fieldset>

              <section className="ai-settings-section">
                <h3>{t('ai.settings.sectionLimits')}</h3>
                <div className="ai-field-grid">
                  <label>
                    <span>{t('ai.settings.timeout')}</span>
                    <input
                      type="number"
                      min={1}
                      max={600}
                      value={Math.round(activeProfile.timeoutMs / 1_000)}
                      onChange={(event) =>
                        patchProfile('timeoutMs', Math.max(1, Number(event.target.value)) * 1_000)
                      }
                    />
                  </label>
                  <label>
                    <span>{t('ai.settings.maxTokens')}</span>
                    <input
                      type="number"
                      min={64}
                      max={200_000}
                      value={activeProfile.maxTokens}
                      onChange={(event) => patchProfile('maxTokens', Number(event.target.value))}
                    />
                    {activeProfile.reasoningEnabled && activeProfile.maxTokens < 4_096 ? (
                      <small className="ai-field-hint">{t('ai.settings.reasoningTokenHint')}</small>
                    ) : null}
                  </label>
                </div>
              </section>

              <details className="ai-advanced">
                <summary>{t('ai.settings.advanced')}</summary>
                <label className="ai-check ai-reasoning-toggle">
                  <input
                    type="checkbox"
                    checked={!activeProfile.reasoningEnabled}
                    onChange={(event) => patchProfile('reasoningEnabled', !event.target.checked)}
                  />
                  <span>{t('ai.settings.disableReasoning')}</span>
                </label>
                {activeProfile.provider === 'google' && activeProfile.reasoningEnabled ? (
                  <small className="ai-field-note">{t('ai.settings.googleReasoningHint')}</small>
                ) : null}
              </details>

              {feedback ? <p className="ai-feedback">{feedback}</p> : null}
            </div>
          </div>
        )}

        <footer>
          <button
            type="button"
            className="ai-footer-probe"
            disabled={!config || busy !== null}
            onClick={() => void runTest()}
          >
            {t('ai.settings.test')}
          </button>
          <button type="button" onClick={onClose}>
            {t('ai.settings.cancel')}
          </button>
          <button type="button" disabled={!config || busy !== null} onClick={() => void save()}>
            {t('ai.settings.save')}
          </button>
        </footer>
      </section>
    </div>
  );
}
