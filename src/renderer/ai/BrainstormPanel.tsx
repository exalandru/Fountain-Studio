import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BrainstormState } from '@shared/appdata/index.js';
import type {
  AiAttachment,
  AiAttachmentKind,
  AiChatMode,
  AiConfigView,
  AiConversation,
  AiConversationMessage,
  AiErrorCode,
} from '@shared/ai/index.js';
import {
  approximateTokens,
  composeAttachedMessage,
  DEFAULT_BRAINSTORMING_PROMPT,
} from '@shared/ai/index.js';
import type { Translator } from '@shared/i18n/index.js';
import { Markdown } from './Markdown.js';

interface BrainstormPanelProps {
  state: BrainstormState;
  settingsRevision: number;
  t: Translator['t'];
  createAttachment: (kind: AiAttachmentKind) => AiAttachment | null;
  onStateChange: (state: BrainstormState) => void;
  onInsert: (content: string) => void;
  onNote: (content: string) => void;
  onShowPreview: () => void;
  onShowStatistics: () => void;
  onOpenSettings: () => void;
  onClose: () => void;
}

function uid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function makeConversation(t: Translator['t']): AiConversation {
  const now = Date.now();
  return {
    id: uid('conversation'),
    title: t('ai.chat.newConversation'),
    mode: 'factual',
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

function errorText(t: Translator['t'], code: AiErrorCode, message: string): string {
  const keys = {
    unauthorized: 'ai.error.unauthorized',
    rateLimit: 'ai.error.rateLimit',
    timeout: 'ai.error.timeout',
    contextLength: 'ai.error.contextLength',
    emptyResponse: 'ai.error.emptyResponse',
    network: 'ai.error.network',
    invalidRequest: 'ai.error.invalidRequest',
    cancelled: 'ai.error.cancelled',
    unknown: 'ai.error.unknown',
  } as const;
  return `${t(keys[code])}${message ? `\n${message}` : ''}`;
}

/** Persistent streaming brainstorming chat with opt-in screenplay attachments. */
export function BrainstormPanel({
  state,
  settingsRevision,
  t,
  createAttachment,
  onStateChange,
  onInsert,
  onNote,
  onShowPreview,
  onShowStatistics,
  onOpenSettings,
  onClose,
}: BrainstormPanelProps) {
  const stateRef = useRef(state);
  const requestRef = useRef<string | null>(null);
  const requestConversationRef = useRef<string | null>(null);
  const assistantRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [config, setConfig] = useState<AiConfigView | null>(null);
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<AiAttachment[]>([]);
  const [running, setRunning] = useState(false);
  const [reasoning, setReasoning] = useState(false);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    void window.quantum
      .invoke('ai:config:get', undefined)
      .then(setConfig)
      .catch(() => setConfig(null));
  }, [settingsRevision]);

  const commit = useCallback(
    (next: BrainstormState) => {
      stateRef.current = next;
      onStateChange(next);
    },
    [onStateChange],
  );
  const updateConversation = useCallback(
    (conversationId: string, update: (conversation: AiConversation) => AiConversation) => {
      const current = stateRef.current;
      commit({
        ...current,
        conversations: current.conversations.map((conversation) =>
          conversation.id === conversationId ? update(conversation) : conversation,
        ),
      });
    },
    [commit],
  );

  const active = useMemo(
    () =>
      state.conversations.find((conversation) => conversation.id === state.activeConversationId) ??
      null,
    [state],
  );

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [active?.messages]);

  useEffect(() => {
    const offReasoning = window.quantum.on('ai:reasoning', ({ requestId }) => {
      if (requestId === requestRef.current) setReasoning(true);
    });
    const offChunk = window.quantum.on('ai:chunk', ({ requestId, chunk }) => {
      if (requestId !== requestRef.current || !assistantRef.current) return;
      setReasoning(false);
      const conversationId = requestConversationRef.current;
      if (!conversationId) return;
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        updatedAt: Date.now(),
        messages: conversation.messages.map((message) =>
          message.id === assistantRef.current
            ? { ...message, content: `${message.content}${chunk}` }
            : message,
        ),
      }));
    });
    const offDone = window.quantum.on('ai:done', ({ requestId }) => {
      if (requestId !== requestRef.current) return;
      requestRef.current = null;
      requestConversationRef.current = null;
      assistantRef.current = null;
      setRunning(false);
      setReasoning(false);
    });
    const offError = window.quantum.on('ai:error', ({ requestId, code, message }) => {
      if (requestId !== requestRef.current || !assistantRef.current) return;
      const conversationId = requestConversationRef.current;
      if (conversationId) {
        updateConversation(conversationId, (conversation) => ({
          ...conversation,
          updatedAt: Date.now(),
          messages: conversation.messages.map((item) =>
            item.id === assistantRef.current
              ? {
                  ...item,
                  content:
                    code === 'cancelled' && item.content
                      ? item.content
                      : errorText(t, code, message),
                }
              : item,
          ),
        }));
      }
      requestRef.current = null;
      requestConversationRef.current = null;
      assistantRef.current = null;
      setRunning(false);
      setReasoning(false);
    });
    return () => {
      offReasoning();
      offChunk();
      offDone();
      offError();
    };
  }, [t, updateConversation]);

  useEffect(
    () => () => {
      const requestId = requestRef.current;
      if (requestId) void window.quantum.invoke('ai:chat:cancel', { requestId });
    },
    [],
  );

  const newConversation = () => {
    if (running) return;
    const conversation = makeConversation(t);
    commit({
      activeConversationId: conversation.id,
      conversations: [conversation, ...stateRef.current.conversations],
    });
    setAttachments([]);
    setDraft('');
  };

  const deleteConversation = () => {
    if (!active || running) return;
    const conversations = stateRef.current.conversations.filter(
      (conversation) => conversation.id !== active.id,
    );
    commit({
      conversations,
      activeConversationId: conversations[0]?.id ?? null,
    });
  };

  const renameConversation = () => {
    if (!active) return;
    const title = window.prompt(t('ai.chat.renamePrompt'), active.title)?.trim();
    if (!title) return;
    updateConversation(active.id, (conversation) => ({
      ...conversation,
      title: title.slice(0, 200),
      updatedAt: Date.now(),
    }));
  };

  const setMode = (mode: AiChatMode) => {
    if (!active) return;
    updateConversation(active.id, (conversation) => ({
      ...conversation,
      mode,
      updatedAt: Date.now(),
    }));
  };

  const attach = (kind: AiAttachmentKind) => {
    const attachment = createAttachment(kind);
    if (!attachment) return;
    setAttachments((current) => [...current.filter((item) => item.kind !== kind), attachment]);
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || running) return;
    const selectedConfig = config ?? (await window.quantum.invoke('ai:config:get', undefined));
    setConfig(selectedConfig);
    let conversation = active;
    if (!conversation) {
      conversation = makeConversation(t);
    }

    const now = Date.now();
    const userMessage: AiConversationMessage = {
      id: uid('message'),
      role: 'user',
      content: text,
      createdAt: now,
      attachments: attachments.map(({ content: _content, ...summary }) => summary),
    };
    const assistant: AiConversationMessage = {
      id: uid('message'),
      role: 'assistant',
      content: '',
      createdAt: now,
    };
    const title =
      conversation.messages.length === 0
        ? text.replace(/\s+/g, ' ').slice(0, 54)
        : conversation.title;
    const nextConversation: AiConversation = {
      ...conversation,
      title,
      messages: [...conversation.messages, userMessage, assistant],
      updatedAt: now,
    };
    const conversations = stateRef.current.conversations.some(
      (item) => item.id === nextConversation.id,
    )
      ? stateRef.current.conversations.map((item) =>
          item.id === nextConversation.id ? nextConversation : item,
        )
      : [nextConversation, ...stateRef.current.conversations];
    commit({ activeConversationId: nextConversation.id, conversations });

    const requestId = uid('request');
    requestRef.current = requestId;
    requestConversationRef.current = nextConversation.id;
    assistantRef.current = assistant.id;
    setRunning(true);
    setReasoning(false);
    setDraft('');
    setAttachments([]);
    try {
      await window.quantum.invoke('ai:chat:start', {
        requestId,
        profileId: selectedConfig.activeProfileId,
        mode: nextConversation.mode,
        systemPrompt: selectedConfig.brainstormingPrompt || DEFAULT_BRAINSTORMING_PROMPT,
        messages: [
          ...conversation.messages.slice(-199).map(({ role, content }) => ({ role, content })),
          { role: 'user' as const, content: composeAttachedMessage(text, attachments) },
        ],
      });
    } catch (error) {
      updateConversation(nextConversation.id, (current) => ({
        ...current,
        messages: current.messages.map((message) =>
          message.id === assistant.id
            ? {
                ...message,
                content: error instanceof Error ? error.message : String(error),
              }
            : message,
        ),
      }));
      requestRef.current = null;
      requestConversationRef.current = null;
      assistantRef.current = null;
      setRunning(false);
      setReasoning(false);
    }
  };

  const stop = async () => {
    const requestId = requestRef.current;
    if (!requestId) return;
    await window.quantum.invoke('ai:chat:cancel', { requestId });
  };

  const tokenEstimate =
    approximateTokens(draft) +
    attachments.reduce((total, attachment) => total + attachment.approximateTokens, 0);

  return (
    <section className="brainstorm-pane">
      <header className="panel-header">
        <span>{t('ai.chat.title')}</span>
        <button type="button" className="panel-tab-button" onClick={onShowPreview}>
          {t('preview.title')}
        </button>
        <button type="button" className="panel-tab-button" onClick={onShowStatistics}>
          {t('stats.title')}
        </button>
        <button type="button" className="panel-tab-button" onClick={onOpenSettings}>
          ⚙
        </button>
        <button
          type="button"
          className="panel-close"
          aria-label={t('ai.chat.close')}
          onClick={onClose}
        >
          ×
        </button>
      </header>

      <div className="ai-conversation-bar">
        <select
          aria-label={t('ai.chat.conversation')}
          value={active?.id ?? ''}
          disabled={running}
          onChange={(event) =>
            commit({ ...stateRef.current, activeConversationId: event.target.value })
          }
        >
          <option value="" disabled>
            {t('ai.chat.noConversation')}
          </option>
          {state.conversations.map((conversation) => (
            <option key={conversation.id} value={conversation.id}>
              {conversation.title}
            </option>
          ))}
        </select>
        <button type="button" title={t('ai.chat.newConversation')} onClick={newConversation}>
          +
        </button>
        <button
          type="button"
          disabled={!active}
          title={t('ai.chat.rename')}
          onClick={renameConversation}
        >
          ✎
        </button>
        <button
          type="button"
          disabled={!active || running}
          title={t('ai.chat.delete')}
          onClick={deleteConversation}
        >
          −
        </button>
      </div>

      <div className="ai-mode-switch" role="group" aria-label={t('ai.chat.mode')}>
        <button
          type="button"
          className={(active?.mode ?? 'factual') === 'factual' ? 'active' : ''}
          onClick={() => {
            if (!active) newConversation();
            else setMode('factual');
          }}
        >
          {t('ai.chat.factual')}
        </button>
        <button
          type="button"
          className={active?.mode === 'creative' ? 'active' : ''}
          onClick={() => {
            if (!active) {
              const conversation = makeConversation(t);
              conversation.mode = 'creative';
              commit({
                activeConversationId: conversation.id,
                conversations: [conversation, ...stateRef.current.conversations],
              });
            } else {
              setMode('creative');
            }
          }}
        >
          {t('ai.chat.creative')}
        </button>
      </div>

      <div ref={scrollRef} className="ai-messages" aria-live="polite">
        {!active || active.messages.length === 0 ? (
          <div className="ai-empty">
            <strong>{t('ai.chat.emptyTitle')}</strong>
            <p>{t('ai.chat.emptyBody')}</p>
          </div>
        ) : (
          active.messages.map((message) => (
            <article key={message.id} className={`ai-message ai-message-${message.role}`}>
              <div className="ai-message-role">
                {message.role === 'user' ? t('ai.chat.you') : t('ai.chat.assistant')}
              </div>
              {message.attachments?.length ? (
                <div className="ai-message-attachments">
                  {message.attachments.map((attachment) => (
                    <span key={attachment.id}>{attachment.label}</span>
                  ))}
                </div>
              ) : null}
              {message.role === 'assistant' ? (
                message.content ? (
                  <Markdown>{message.content}</Markdown>
                ) : (
                  <span className="ai-thinking">
                    <span className="ai-thinking-dot" aria-hidden="true" />
                    {reasoning ? t('ai.chat.reasoning') : t('ai.chat.connecting')}
                  </span>
                )
              ) : (
                <p>{message.content}</p>
              )}
              {message.role === 'assistant' && message.content ? (
                <div className="ai-message-actions">
                  <button
                    type="button"
                    onClick={() => void navigator.clipboard.writeText(message.content)}
                  >
                    {t('ai.chat.copy')}
                  </button>
                  <button type="button" onClick={() => onInsert(message.content)}>
                    {t('ai.chat.insert')}
                  </button>
                  <button type="button" onClick={() => onNote(message.content)}>
                    {t('ai.chat.asNote')}
                  </button>
                </div>
              ) : null}
            </article>
          ))
        )}
      </div>

      <div className="ai-composer">
        {attachments.length ? (
          <div className="ai-attachment-chips">
            {attachments.map((attachment) => (
              <button
                key={attachment.id}
                type="button"
                title={t('ai.chat.removeAttachment')}
                onClick={() =>
                  setAttachments((current) => current.filter((item) => item.id !== attachment.id))
                }
              >
                {attachment.label} ×
              </button>
            ))}
          </div>
        ) : null}
        <div className="ai-attachment-buttons">
          {(['script', 'scene', 'selection', 'statistics'] as const).map((kind) => (
            <button key={kind} type="button" onClick={() => attach(kind)}>
              + {t(`ai.attachment.${kind}`)}
            </button>
          ))}
        </div>
        <textarea
          rows={4}
          value={draft}
          placeholder={t('ai.chat.placeholder')}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="ai-composer-footer">
          <span>{t('ai.chat.tokenEstimate', { count: tokenEstimate })}</span>
          {running ? (
            <button type="button" className="ai-primary" onClick={() => void stop()}>
              {t('ai.chat.stop')}
            </button>
          ) : (
            <button
              type="button"
              className="ai-primary"
              disabled={!draft.trim()}
              onClick={() => void send()}
            >
              {t('ai.chat.send')}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
