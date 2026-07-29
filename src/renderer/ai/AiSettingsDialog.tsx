import { useEffect, useMemo, useRef, useState } from 'react';
import type { AiConfig, AiConfigView, AiConnectionProfile, AiKeyUpdate } from '@shared/ai/index.js';
import { DEFAULT_AI_PROFILE, sanitizeAiConfig } from '@shared/ai/index.js';
import { useTranslator } from '../hooks/useTranslator.js';

interface AiSettingsDialogProps {
  onClose: () => void;
  onSaved: () => void;
}

function profileId(): string {
  return `profile-${crypto.randomUUID()}`;
}

/** Provider-neutral OpenAI-compatible connection settings. */
export function AiSettingsDialog({ onClose, onSaved }: AiSettingsDialogProps) {
  const { t } = useTranslator();
  const dialogRef = useRef<HTMLElement | null>(null);
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
          brainstormingPrompt: next.brainstormingPrompt,
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

  const addProfile = () => {
    const id = profileId();
    setConfig((current) =>
      current
        ? {
            ...current,
            activeProfileId: id,
            profiles: [
              ...current.profiles,
              {
                ...DEFAULT_AI_PROFILE,
                id,
                name: t('ai.settings.newProfile'),
              },
            ],
          }
        : current,
    );
    setModels([]);
  };

  const removeProfile = () => {
    setConfig((current) => {
      if (!current || current.profiles.length <= 1) return current;
      const profiles = current.profiles.filter((profile) => profile.id !== current.activeProfileId);
      return { ...current, profiles, activeProfileId: profiles[0]?.id ?? 'default' };
    });
    setModels([]);
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
        ref={dialogRef}
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
          <div className="ai-settings-body">
            <div className="ai-profile-row">
              <label>
                <span>{t('ai.settings.profile')}</span>
                <select
                  value={config.activeProfileId}
                  onChange={(event) => {
                    setConfig({ ...config, activeProfileId: event.target.value });
                    setModels([]);
                    setFeedback(null);
                  }}
                >
                  {config.profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" onClick={addProfile} disabled={config.profiles.length >= 10}>
                {t('ai.settings.addProfile')}
              </button>
              <button type="button" onClick={removeProfile} disabled={config.profiles.length <= 1}>
                {t('ai.settings.removeProfile')}
              </button>
            </div>

            <div className="ai-settings-grid">
              <label>
                <span>{t('ai.settings.profileName')}</span>
                <input
                  value={activeProfile.name}
                  maxLength={80}
                  onChange={(event) => patchProfile('name', event.target.value)}
                />
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
              <fieldset className="ai-model-field">
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
              </fieldset>
              <label>
                <span>
                  {t('ai.settings.apiKey')}
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

            <div className="ai-settings-actions">
              <button
                type="button"
                onClick={() => {
                  setKeys((current) => ({ ...current, [activeProfile.id]: '' }));
                  setRemovedKeys((current) => new Set(current).add(activeProfile.id));
                }}
              >
                {t('ai.settings.removeKey')}
              </button>
              <button type="button" disabled={busy !== null} onClick={() => void runModels()}>
                {t('ai.settings.listModels')}
              </button>
              <button type="button" disabled={busy !== null} onClick={() => void runTest()}>
                {t('ai.settings.test')}
              </button>
            </div>

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
            </details>

            {!view.secureStorageAvailable ? (
              <p className="ai-warning">{t('ai.settings.sessionKeyWarning')}</p>
            ) : null}
            {feedback ? <p className="ai-feedback">{feedback}</p> : null}
          </div>
        )}

        <footer>
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
