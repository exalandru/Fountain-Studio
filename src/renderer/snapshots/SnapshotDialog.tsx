import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DiffHunk, SceneChange } from '@shared/diff/index.js';
import { collapseToHunks, diffLines, diffScenes } from '@shared/diff/index.js';
import { parse } from '@shared/fountain/index.js';
import type { Translator } from '@shared/i18n/index.js';
import type { SnapshotMeta } from '@shared/snapshots/index.js';

interface SnapshotDialogProps {
  /** `null` when the screenplay has never been saved: there is no folder to write beside. */
  path: string | null;
  currentContent: string;
  t: Translator['t'];
  onRestore: (content: string, name: string) => void;
  onClose: () => void;
}

/**
 * Named snapshots of the screenplay, and the comparison between one of them and the
 * current document.
 *
 * The comparison is read at two levels: a summary in scenes — which is what a writer
 * thinks in — and the lines underneath, collapsed to the changed regions.
 */
export function SnapshotDialog({
  path,
  currentContent,
  t,
  onRestore,
  onClose,
}: SnapshotDialogProps) {
  // An unsaved screenplay has nowhere to store snapshots, so the list is empty from the
  // start rather than being emptied by an effect.
  const [snapshots, setSnapshots] = useState<SnapshotMeta[] | null>(path === null ? [] : null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedContent, setSelectedContent] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [draftName, setDraftName] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  /** Maps the main process's error codes onto translated wording. */
  const describe = useCallback(
    (error: unknown): string => {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('limitReached')) return t('snapshots.limitReached');
      if (message.includes('notFound')) return t('snapshots.notFound');
      return t('snapshots.failed', { error: message });
    },
    [t],
  );

  useEffect(() => {
    if (path === null) return;
    void window.quantum
      .invoke('snapshot:list', { path })
      .then(setSnapshots)
      .catch((error: unknown) => {
        setSnapshots([]);
        setFeedback(describe(error));
      });
  }, [describe, path]);

  const select = useCallback(
    (id: string) => {
      if (path === null) return;
      setSelectedId(id);
      setSelectedContent(null);
      setFeedback(null);
      setDraftName(snapshots?.find((snapshot) => snapshot.id === id)?.name ?? '');
      void window.quantum
        .invoke('snapshot:read', { path, id })
        .then(setSelectedContent)
        .catch((error: unknown) => setFeedback(describe(error)));
    },
    [describe, path, snapshots],
  );

  const take = useCallback(async () => {
    if (path === null) return;
    setBusy(true);
    setFeedback(null);
    try {
      const next = await window.quantum.invoke('snapshot:create', {
        path,
        name: name.trim() || t('snapshots.namePlaceholder'),
        content: currentContent,
      });
      setSnapshots(next);
      setName('');
      const created = next[0];
      if (created) {
        select(created.id);
        // `select` reads the list it was created with, which does not yet hold this one.
        setDraftName(created.name);
      }
    } catch (error) {
      setFeedback(describe(error));
    } finally {
      setBusy(false);
    }
  }, [currentContent, describe, name, path, select, t]);

  const rename = useCallback(
    async (id: string) => {
      if (path === null) return;
      setBusy(true);
      setFeedback(null);
      try {
        setSnapshots(await window.quantum.invoke('snapshot:rename', { path, id, name: draftName }));
      } catch (error) {
        setFeedback(describe(error));
      } finally {
        setBusy(false);
      }
    },
    [describe, draftName, path],
  );

  const remove = useCallback(
    async (id: string) => {
      if (path === null) return;
      setBusy(true);
      setFeedback(null);
      try {
        const next = await window.quantum.invoke('snapshot:delete', { path, id });
        setSnapshots(next);
        if (selectedId === id) {
          setSelectedId(null);
          setSelectedContent(null);
        }
        // The row that was clicked has just unmounted; hand focus back to the list.
        requestAnimationFrame(() => listRef.current?.querySelector('button')?.focus());
      } catch (error) {
        setFeedback(describe(error));
      } finally {
        setBusy(false);
      }
    },
    [describe, path, selectedId],
  );

  const selected = snapshots?.find((snapshot) => snapshot.id === selectedId) ?? null;

  const comparison = useMemo(() => {
    if (selectedContent === null) return null;
    const lines = diffLines(selectedContent, currentContent);
    return {
      lines,
      hunks: collapseToHunks(lines.lines),
      scenes: diffScenes(parse(selectedContent), parse(currentContent)),
    };
  }, [currentContent, selectedContent]);

  const sceneSummary = (changes: SceneChange[]): string[] => {
    const counts = { added: 0, removed: 0, modified: 0, moved: 0 };
    for (const change of changes) counts[change.kind]++;
    const parts: string[] = [];
    if (counts.modified > 0) parts.push(t('snapshots.scenesModified', { count: counts.modified }));
    if (counts.added > 0) parts.push(t('snapshots.scenesAdded', { count: counts.added }));
    if (counts.removed > 0) parts.push(t('snapshots.scenesRemoved', { count: counts.removed }));
    if (counts.moved > 0) parts.push(t('snapshots.scenesMoved', { count: counts.moved }));
    return parts;
  };

  const formatDate = (createdAt: number) =>
    new Date(createdAt).toLocaleString(undefined, {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="snapshot-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('snapshots.title')}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
        }}
      >
        <header>
          <h2>{t('snapshots.title')}</h2>
          <button
            type="button"
            className="panel-close"
            aria-label={t('snapshots.close')}
            autoFocus
            onClick={onClose}
          >
            ×
          </button>
        </header>

        {path === null ? (
          <div className="panel-placeholder">{t('snapshots.saveFirst')}</div>
        ) : snapshots === null ? (
          <div className="panel-placeholder">{t('snapshots.loading')}</div>
        ) : (
          <div className="snapshot-layout">
            <div className="rail">
              <ul className="rail-list" aria-label={t('snapshots.list')} ref={listRef}>
                {snapshots.map((snapshot) => (
                  <li key={snapshot.id}>
                    <button
                      type="button"
                      className={`rail-row${snapshot.id === selectedId ? ' is-current' : ''}`}
                      aria-current={snapshot.id === selectedId ? 'true' : undefined}
                      onClick={() => select(snapshot.id)}
                    >
                      <span className="rail-identity">
                        <span className="rail-name">{snapshot.name}</span>
                        <span className="rail-detail">
                          {formatDate(snapshot.createdAt)} ·{' '}
                          {t('snapshots.meta', {
                            lines: snapshot.lineCount,
                            count: snapshot.sceneCount,
                          })}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>

              {snapshots.length === 0 ? (
                <p className="snapshot-empty">{t('snapshots.empty')}</p>
              ) : null}

              <label className="snapshot-take">
                <span className="sr-only">{t('snapshots.nameLabel')}</span>
                <input
                  value={name}
                  maxLength={120}
                  placeholder={t('snapshots.namePlaceholder')}
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !busy) void take();
                  }}
                />
              </label>
              <button
                type="button"
                className="rail-add"
                disabled={busy}
                onClick={() => void take()}
              >
                <span aria-hidden="true">+</span>
                {t('snapshots.take')}
              </button>
            </div>

            <div className="snapshot-pane">
              {selected === null ? (
                <p className="panel-placeholder">{t('snapshots.comparedWith')}</p>
              ) : comparison === null ? (
                <p className="panel-placeholder">{t('snapshots.loading')}</p>
              ) : (
                <>
                  <div className="snapshot-summary">
                    <div className="snapshot-rename">
                      <label>
                        <span className="sr-only">{t('snapshots.renameLabel')}</span>
                        <input
                          value={draftName}
                          maxLength={120}
                          onChange={(event) => setDraftName(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' && !busy) void rename(selected.id);
                          }}
                        />
                      </label>
                      <button
                        type="button"
                        disabled={
                          busy || draftName.trim() === selected.name || draftName.trim() === ''
                        }
                        onClick={() => void rename(selected.id)}
                      >
                        {t('snapshots.rename')}
                      </button>
                    </div>
                    <span>{t('snapshots.comparedWith')}</span>
                    {comparison.hunks.length === 0 ? (
                      <p className="snapshot-identical">{t('snapshots.identical')}</p>
                    ) : (
                      <>
                        <p className="snapshot-scene-summary">
                          {sceneSummary(comparison.scenes).join(' · ') ||
                            t('snapshots.lineStats', {
                              added: comparison.lines.added,
                              removed: comparison.lines.removed,
                            })}
                        </p>
                        <p className="snapshot-line-summary">
                          {t('snapshots.lineStats', {
                            added: comparison.lines.added,
                            removed: comparison.lines.removed,
                          })}
                        </p>
                      </>
                    )}
                    {comparison.lines.coarse ? (
                      <p className="ai-warning">{t('snapshots.coarse')}</p>
                    ) : null}
                    <button
                      type="button"
                      className="ai-danger"
                      disabled={busy}
                      onClick={() => void remove(selected.id)}
                    >
                      {t('snapshots.delete')}
                    </button>
                  </div>

                  <div className="snapshot-diff">
                    {comparison.hunks.map((hunk: DiffHunk, index) => (
                      <div className="snapshot-hunk" key={`${index}-${hunk.skippedBefore}`}>
                        {hunk.skippedBefore > 0 ? <div className="snapshot-gap" /> : null}
                        {hunk.lines.map((line, lineIndex) => (
                          <div
                            className={`snapshot-line is-${line.kind}`}
                            key={`${line.kind}-${line.beforeLine ?? 0}-${line.afterLine ?? 0}-${lineIndex}`}
                          >
                            <span className="snapshot-gutter">{line.beforeLine ?? ''}</span>
                            <span className="snapshot-gutter">{line.afterLine ?? ''}</span>
                            <span className="snapshot-mark" aria-hidden="true">
                              {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}
                            </span>
                            <span className="snapshot-text">{line.text || ' '}</span>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {feedback ? <p className="ai-feedback">{feedback}</p> : null}

        <footer>
          <button
            type="button"
            className="ai-primary"
            disabled={selected === null || selectedContent === null || busy}
            onClick={() => {
              if (selected && selectedContent !== null) onRestore(selectedContent, selected.name);
            }}
          >
            {t('snapshots.restore')}
          </button>
          <button type="button" onClick={onClose}>
            {t('snapshots.done')}
          </button>
        </footer>
      </section>
    </div>
  );
}
