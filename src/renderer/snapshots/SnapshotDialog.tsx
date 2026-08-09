import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DiffHunk, SceneChange } from '@shared/diff/index.js';
import { collapseToHunks, diffLines, diffScenes } from '@shared/diff/index.js';
import { parse } from '@shared/fountain/index.js';
import type { Translator } from '@shared/i18n/index.js';
import type { SnapshotCatalog } from '@shared/snapshots/index.js';
import {
  beginDocumentOperation,
  type DocumentOperationContext,
} from '@shared/documents/operations.js';
import { Button } from '../ui/Button.js';
import { Dialog } from '../ui/Dialog.js';
import { Field } from '../ui/Field.js';
import { TextInput } from '../ui/TextInput.js';

interface SnapshotDialogProps {
  documentId: string;
  documentRevision: number;
  /** `null` when the screenplay has never been saved: there is no folder to write beside. */
  path: string | null;
  currentContent: string;
  t: Translator['t'];
  onRestore: (content: string, name: string, operation: DocumentOperationContext) => boolean;
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
  documentId,
  documentRevision,
  path,
  currentContent,
  t,
  onRestore,
  onClose,
}: SnapshotDialogProps) {
  // An unsaved screenplay has nowhere to store snapshots, so the list is empty from the
  // start rather than being emptied by an effect.
  const [catalog, setCatalog] = useState<SnapshotCatalog | null>(
    path === null ? { status: 'ok', snapshots: [], issues: [] } : null,
  );
  const snapshots = catalog?.snapshots ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedContent, setSelectedContent] = useState<string | null>(null);
  const [selectedOperation, setSelectedOperation] = useState<DocumentOperationContext | null>(null);
  const [name, setName] = useState('');
  const [draftName, setDraftName] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const listGeneration = useRef(0);
  const latestRead = useRef<string | null>(null);

  /** Maps the main process's error codes onto translated wording. */
  const describe = useCallback(
    (error: unknown): string => {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('limitReached')) return t('snapshots.limitReached');
      if (message.includes('notFound')) return t('snapshots.notFound');
      if (message.includes('indexDamaged')) return t('snapshots.indexDamaged');
      if (message.includes('repairFailed')) return t('snapshots.repairFailed');
      return t('snapshots.failed', { error: message });
    },
    [t],
  );

  useEffect(() => {
    if (path === null) return;
    const generation = ++listGeneration.current;
    void window.quantum
      .invoke('snapshot:list', { path })
      .then((next) => {
        if (listGeneration.current === generation) setCatalog(next);
      })
      .catch((error: unknown) => {
        if (listGeneration.current !== generation) return;
        setCatalog({ status: 'error', snapshots: [], issues: [] });
        setFeedback(describe(error));
      });
    return () => {
      listGeneration.current += 1;
    };
  }, [describe, path]);

  const select = useCallback(
    (id: string) => {
      if (path === null) return;
      setSelectedId(id);
      setSelectedContent(null);
      setSelectedOperation(null);
      setFeedback(null);
      setDraftName(snapshots?.find((snapshot) => snapshot.id === id)?.name ?? '');
      const operation = beginDocumentOperation(
        { id: documentId, revision: documentRevision, path },
        'snapshot-read',
      );
      latestRead.current = operation.requestId;
      void window.quantum
        .invoke('snapshot:read', { path, id })
        .then((content) => {
          if (latestRead.current !== operation.requestId) return;
          setSelectedContent(content);
          setSelectedOperation(operation);
        })
        .catch((error: unknown) => {
          if (latestRead.current === operation.requestId) setFeedback(describe(error));
        });
    },
    [describe, documentId, documentRevision, path, snapshots],
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
      setCatalog({ status: 'ok', snapshots: next, issues: [] });
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

  const repair = useCallback(async () => {
    if (path === null) return;
    setBusy(true);
    setFeedback(null);
    try {
      const next = await window.quantum.invoke('snapshot:repair', { path });
      setCatalog(next);
      if (next.status === 'ok') {
        setFeedback(
          next.snapshots.length > 0
            ? t('snapshots.repaired', { count: next.snapshots.length })
            : t('snapshots.repairedEmpty'),
        );
      } else if (next.snapshots.length > 0) {
        setFeedback(t('snapshots.repaired', { count: next.snapshots.length }));
      }
    } catch (error) {
      setFeedback(describe(error));
    } finally {
      setBusy(false);
    }
  }, [describe, path, t]);

  const rename = useCallback(
    async (id: string) => {
      if (path === null) return;
      setBusy(true);
      setFeedback(null);
      try {
        setCatalog({
          status: 'ok',
          snapshots: await window.quantum.invoke('snapshot:rename', { path, id, name: draftName }),
          issues: [],
        });
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
        setCatalog({ status: 'ok', snapshots: next, issues: [] });
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
    <Dialog
      className="snapshot-dialog"
      title={t('snapshots.title')}
      closeLabel={t('snapshots.close')}
      onClose={onClose}
      footer={
        <>
          <Button
            variant="primary"
            disabled={
              selected === null || selectedContent === null || selectedOperation === null || busy
            }
            onClick={() => {
              if (
                selected &&
                selectedContent !== null &&
                selectedOperation !== null &&
                !onRestore(selectedContent, selected.name, selectedOperation)
              ) {
                setFeedback(t('operation.stale'));
              }
            }}
          >
            {t('snapshots.restore')}
          </Button>
          <Button onClick={onClose}>{t('snapshots.done')}</Button>
        </>
      }
    >
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

            {catalog !== null && catalog.status !== 'ok' ? (
              <div className="snapshot-repair" role="status">
                <p className="ai-warning">
                  {catalog.snapshots.length > 0
                    ? t('snapshots.damagedFound', { count: catalog.snapshots.length })
                    : t('snapshots.damaged')}
                </p>
                <Button disabled={busy} onClick={() => void repair()}>
                  {t('snapshots.repair')}
                </Button>
              </div>
            ) : null}

            {snapshots.length === 0 && catalog?.status === 'ok' ? (
              <p className="snapshot-empty">{t('snapshots.empty')}</p>
            ) : null}

            <Field className="snapshot-take" label={t('snapshots.nameLabel')} labelHidden>
              <TextInput
                value={name}
                maxLength={120}
                placeholder={t('snapshots.namePlaceholder')}
                disabled={busy || catalog?.status !== 'ok'}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !busy && catalog?.status === 'ok') void take();
                }}
              />
            </Field>
            <Button
              className="rail-add"
              disabled={busy || catalog?.status !== 'ok'}
              onClick={() => void take()}
            >
              <span aria-hidden="true">+</span>
              {t('snapshots.take')}
            </Button>
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
                    <Field label={t('snapshots.renameLabel')} labelHidden>
                      <TextInput
                        value={draftName}
                        maxLength={120}
                        onChange={(event) => setDraftName(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && !busy) void rename(selected.id);
                        }}
                      />
                    </Field>
                    <Button
                      disabled={
                        busy || draftName.trim() === selected.name || draftName.trim() === ''
                      }
                      onClick={() => void rename(selected.id)}
                    >
                      {t('snapshots.rename')}
                    </Button>
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
                  <Button variant="danger" disabled={busy} onClick={() => void remove(selected.id)}>
                    {t('snapshots.delete')}
                  </Button>
                </div>

                <div className="snapshot-diff">
                  {comparison.hunks.map((hunk: DiffHunk, index) => (
                    <div key={`${index}-${hunk.skippedBefore}`}>
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
                          <span>{line.text || ' '}</span>
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

      {feedback ? (
        <p className="ai-feedback" role="status">
          {feedback}
        </p>
      ) : null}
    </Dialog>
  );
}
