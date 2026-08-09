import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ParseResponse } from '@shared/analysis/index.js';
import { BIBLE_SYSTEM_PROMPT, buildBibleDraftPrompt, parseBibleDraft } from '@shared/ai/index.js';
import type { Bible, BibleEntry, BibleEntryKind } from '@shared/bible/index.js';
import {
  BIBLE_ENTRY_KINDS,
  bibleFieldsFor,
  createBible,
  reconcileBible,
  sanitizeBibleName,
} from '@shared/bible/index.js';
import { buildBibleContext, factsForEntry } from '@shared/bible/facts.js';
import { GroupingView } from './GroupingView.js';
import { normaliseBibleImage } from './image.js';
import type { SceneView } from '@shared/fountain/ast.js';
import { foldDiacritics, foldedEquals, foldedIncludes } from '@shared/text/index.js';
import type { Translator } from '@shared/i18n/index.js';
import type { PendingWrites } from '@shared/persistence/PendingWrites.js';
import {
  beginDocumentOperation,
  type DocumentOperationContext,
  validateDocumentOperation,
} from '@shared/documents/operations.js';
import type { AiRequestHandle } from '../ai/request.js';
import { startCollectedAiRequest } from '../ai/request.js';
import { useDocuments } from '../store/documents.js';
import { Button } from '../ui/Button.js';
import { Dialog } from '../ui/Dialog.js';
import { Field } from '../ui/Field.js';
import { Select } from '../ui/Select.js';
import { TextInput } from '../ui/TextInput.js';

/**
 * Names offered at once.
 *
 * Enough to browse a cast without the popup swallowing the rail; past it the list scrolls, and
 * the hint underneath says how many are left.
 */
const MAX_SUGGESTIONS = 40;

/** Up to two letters, so a sheet without a picture is still recognisable at a glance. */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return words
    .slice(0, 2)
    .map((word) => [...word][0] ?? '')
    .join('')
    .toLocaleUpperCase();
}

interface BiblePanelProps {
  documentId: string;
  documentRevision: number;
  /** `null` when the screenplay has never been saved: there is no sidecar to write beside. */
  path: string | null;
  analysis: ParseResponse | null;
  t: Translator['t'];
  pendingWrites: PendingWrites;
  onPersistenceError: (message: string) => void;
  onClose: () => void;
}

/**
 * The script bible: one sheet per character, place, object or notion.
 *
 * Two kinds of field, and the difference is the whole design. The facts come from the AST and
 * are recomputed on every render — never stored, because a stored fact starts lying the
 * moment the author cuts a scene. The prose is the author's, saved to a sidecar, and the
 * model may only ever draft into fields that are still empty.
 */
export function BiblePanel({
  documentId,
  documentRevision,
  path,
  analysis,
  t,
  pendingWrites,
  onPersistenceError,
  onClose,
}: BiblePanelProps) {
  // An unsaved screenplay has nowhere to store a bible, so the state starts settled rather
  // than being emptied by an effect.
  const [bible, setBible] = useState<Bible | null>(path === null ? createBible() : null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [newKind, setNewKind] = useState<BibleEntryKind>('character');
  const [draftName, setDraftName] = useState('');
  const [highlighted, setHighlighted] = useState(-1);
  /** True while the whole candidate list is being browsed rather than filtered by typing. */
  const [listOpen, setListOpen] = useState(false);
  const [view, setView] = useState<'sheets' | 'grouping'>('sheets');
  /** Sheet id → data URI, or null once we know there is no picture. */
  const [pictures, setPictures] = useState<ReadonlyMap<string, string | null>>(new Map());
  const requestRef = useRef<AiRequestHandle | null>(null);
  const latestDraft = useRef<DocumentOperationContext | null>(null);
  const cancelled = useRef(false);
  const mounted = useRef(true);
  const bibleRef = useRef<Bible | null>(bible);
  const flushInFlight = useRef<Promise<void> | null>(null);
  /** Cleared only after the main process acknowledges the exact submitted revision. */
  const dirty = useRef(false);
  /**
   * Counts local changes, so a write's echo cannot undo an edit made while it was in flight.
   *
   * Without it, creating a sheet and typing straight into it loses the first words: the create
   * write returns the bible as it was saved — with the field still empty — and adopting that
   * reply overwrites what was typed in between.
   */
  const revision = useRef(0);

  const adoptBible = useCallback((next: Bible) => {
    bibleRef.current = next;
    if (mounted.current) setBible(next);
  }, []);

  const scenes = useMemo<SceneView[]>(
    () =>
      (analysis?.scenes ?? []).map((scene) => ({
        number: scene.number,
        heading: scene.heading,
        location: scene.location,
        elements: scene.elementIndexes.flatMap((index) => {
          const element = analysis?.elements[index];
          return element ? [element] : [];
        }),
      })),
    [analysis],
  );

  const reconciliation = useMemo(
    () =>
      reconcileBible(bible?.entries ?? [], {
        characters: (analysis?.characters ?? []).map((character) => character.name),
        locations: (analysis?.locations ?? []).map((location) => location.name),
      }),
    [analysis, bible],
  );

  useEffect(() => {
    if (path === null) return;
    let cancelledHere = false;
    void window.quantum
      .invoke('bible:read', { path })
      .then((next) => {
        if (!cancelledHere) adoptBible(next);
      })
      .catch((error: unknown) => {
        if (cancelledHere) return;
        const message = t('bible.failed', { error: String(error) });
        adoptBible(createBible());
        setFeedback(message);
        onPersistenceError(message);
      });
    return () => {
      cancelledHere = true;
    };
  }, [adoptBible, onPersistenceError, path, t]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancelled.current = true;
      latestDraft.current = null;
      void requestRef.current?.cancel();
    };
  }, []);

  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    const timer = window.setInterval(
      () => setElapsedSeconds(Math.floor((Date.now() - started) / 1_000)),
      250,
    );
    return () => window.clearInterval(timer);
  }, [running]);

  // Loaded lazily and once: a bible of thirty sheets would otherwise carry a megabyte of
  // base64 through every IPC reply that touches it.
  useEffect(() => {
    if (path === null || bible === null) return;
    const missing = bible.entries.filter(
      (entry) => entry.image !== null && !pictures.has(entry.id),
    );
    if (missing.length === 0) return;
    let cancelledHere = false;
    void Promise.all(
      missing.map(async (entry) => {
        const uri = await window.quantum
          .invoke('bible:imageRead', { path, id: entry.id })
          .catch(() => null);
        return [entry.id, uri] as const;
      }),
    ).then((loaded) => {
      if (cancelledHere) return;
      setPictures((current) => new Map([...current, ...loaded]));
    });
    return () => {
      cancelledHere = true;
    };
  }, [bible, path, pictures]);

  const writeRevision = useCallback(
    async (next: Bible, submittedRevision: number) => {
      if (path === null) return;
      if (mounted.current) setBusy(true);
      try {
        const written = await window.quantum.invoke('bible:write', { path, bible: next });
        // The reply is only worth adopting when nothing has changed since: it is the sorted,
        // re-validated form of what we sent, not newer truth.
        if (revision.current === submittedRevision) {
          dirty.current = false;
          adoptBible(written);
        }
        if (mounted.current) setFeedback(null);
      } catch (error) {
        const message = t('bible.failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        if (mounted.current) setFeedback(message);
        onPersistenceError(message);
        throw error;
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [adoptBible, onPersistenceError, path, t],
  );

  const flushPendingBible = useCallback((): Promise<void> => {
    if (flushInFlight.current) return flushInFlight.current;
    const operation = (async () => {
      while (dirty.current) {
        const current = bibleRef.current;
        if (current === null || path === null) return;
        await writeRevision(current, revision.current);
      }
    })();
    flushInFlight.current = operation;
    void operation.then(
      () => {
        if (flushInFlight.current === operation) flushInFlight.current = null;
      },
      () => {
        if (flushInFlight.current === operation) flushInFlight.current = null;
      },
    );
    return operation;
  }, [path, writeRevision]);

  useEffect(() => pendingWrites.register(flushPendingBible), [flushPendingBible, pendingWrites]);

  const persist = useCallback(
    async (next: Bible) => {
      revision.current += 1;
      dirty.current = true;
      adoptBible(next);
      try {
        await flushPendingBible();
      } catch {
        // writeRevision reported the failure and deliberately left this revision dirty.
      }
    },
    [adoptBible, flushPendingBible],
  );

  /** Starts a write without clearing dirty state before the main process acknowledges it. */
  const flush = useCallback(() => {
    void flushPendingBible().catch(() => {
      // writeRevision already exposed the error; the next blur or close retries the same data.
    });
  }, [flushPendingBible]);

  const candidates = useMemo(
    () =>
      reconciliation.unseeded
        .filter((candidate) => candidate.kind === newKind)
        .map((candidate) => candidate.name),
    [newKind, reconciliation],
  );

  const suggestions = useMemo(() => {
    const typed = draftName.trim();
    // Opened without typing, the field is a chooser: every name still waiting for a sheet.
    // Searching is not the only way to find one — a writer often wants to see what is left.
    if (typed.length === 0) return listOpen ? candidates.slice(0, MAX_SUGGESTIONS) : [];
    // An exact hit is not a suggestion — there is nothing left to complete.
    return candidates
      .filter((candidate) => !foldedEquals(candidate, typed) && foldedIncludes(candidate, typed))
      .slice(0, MAX_SUGGESTIONS);
  }, [candidates, draftName, listOpen]);

  const selected = bible?.entries.find((entry) => entry.id === selectedId) ?? null;
  const orphaned = reconciliation.orphaned.some((entry) => entry.id === selectedId);

  const update = (id: string, change: (entry: BibleEntry) => BibleEntry) => {
    const current = bibleRef.current;
    if (current === null) return;
    revision.current += 1;
    dirty.current = true;
    adoptBible({
      ...current,
      entries: current.entries.map((entry) =>
        entry.id === id ? { ...change(entry), updatedAt: Date.now() } : entry,
      ),
    });
  };

  const add = useCallback(
    async (kind: BibleEntryKind, name: string) => {
      const typed = sanitizeBibleName(name);
      // The screenplay's spelling wins. Creating a sheet called "megalopole" beside a
      // screenplay that says MÉGALOPOLE would orphan it on the spot.
      const wanted =
        (analysis?.characters ?? [])
          .map((character) => character.name)
          .concat((analysis?.locations ?? []).map((location) => location.name))
          .find((candidate) => foldedEquals(candidate, typed)) ?? typed;
      // Typing a name that already has a sheet of that kind opens it rather than making a
      // second one: two sheets called ALICE would both look right in the rail and only one
      // of them would be the one being written.
      const existing = (bible?.entries ?? []).find(
        (entry) =>
          entry.kind === kind && entry.name.toLocaleUpperCase() === wanted.toLocaleUpperCase(),
      );
      if (existing) {
        setSelectedId(existing.id);
        return;
      }
      const entry: BibleEntry = {
        id: `bib-${crypto.randomUUID()}`,
        kind,
        name: wanted,
        aliases: [],
        image: null,
        fields: {},
        draftedAt: null,
        updatedAt: Date.now(),
      };
      const next: Bible = {
        ...(bible ?? createBible()),
        entries: [...(bible?.entries ?? []), entry],
      };
      setSelectedId(entry.id);
      await persist(next);
    },
    [analysis, bible, persist],
  );

  /**
   * Re-attaches an orphaned sheet to a name the screenplay still has.
   *
   * The next bible is built and persisted in one go rather than setting state and then
   * flushing: `flush` closes over the bible of the current render, so calling it in the same
   * handler would write the state from before the rename and undo it.
   */
  const reattach = useCallback(
    async (id: string, name: string) => {
      if (bible === null) return;
      await persist({
        ...bible,
        entries: bible.entries.map((entry) =>
          entry.id === id ? { ...entry, name, updatedAt: Date.now() } : entry,
        ),
      });
    },
    [bible, persist],
  );

  const remove = (id: string) => {
    if (bible === null) return;
    setSelectedId(null);
    // The picture goes with the sheet; otherwise the images folder keeps orphans for ever.
    if (path !== null) void window.quantum.invoke('bible:imageDelete', { path, id });
    void persist({ ...bible, entries: bible.entries.filter((entry) => entry.id !== id) });
  };

  /** Folds a set of locations into one sheet, creating the parent if it does not exist. */
  const group = useCallback(
    async (parent: string, children: readonly string[]) => {
      const current = bible ?? createBible();
      const merge = (entry: BibleEntry): BibleEntry => {
        const claimed = new Set([entry.name, ...entry.aliases].map(foldDiacritics));
        const added = children.filter((child) => !claimed.has(foldDiacritics(child)));
        return { ...entry, aliases: [...entry.aliases, ...added], updatedAt: Date.now() };
      };
      const existing = current.entries.find(
        (entry) => entry.kind === 'location' && foldedEquals(entry.name, parent),
      );
      const next: Bible = existing
        ? {
            ...current,
            entries: current.entries.map((entry) =>
              entry.id === existing.id ? merge(entry) : entry,
            ),
          }
        : {
            ...current,
            entries: [
              ...current.entries,
              merge({
                id: `bib-${crypto.randomUUID()}`,
                kind: 'location',
                name: parent,
                aliases: [],
                image: null,
                fields: {},
                draftedAt: null,
                updatedAt: Date.now(),
              }),
            ],
          };
      await persist(next);
    },
    [bible, persist],
  );

  /** Puts one screenplay name onto an existing sheet. */
  const attach = useCallback(
    async (sheetId: string, name: string) => {
      if (bible === null) return;
      await persist({
        ...bible,
        entries: bible.entries.map((entry) =>
          entry.id === sheetId
            ? { ...entry, aliases: [...entry.aliases, name], updatedAt: Date.now() }
            : entry,
        ),
      });
    },
    [bible, persist],
  );

  /** Takes it back off, so grouping can be undone where it is visible. */
  const detach = useCallback(
    async (sheetId: string, name: string) => {
      if (bible === null) return;
      await persist({
        ...bible,
        entries: bible.entries.map((entry) =>
          entry.id === sheetId
            ? {
                ...entry,
                aliases: entry.aliases.filter((alias) => !foldedEquals(alias, name)),
                updatedAt: Date.now(),
              }
            : entry,
        ),
      });
    },
    [bible, persist],
  );

  const chooseImage = useCallback(
    async (entry: BibleEntry) => {
      if (path === null || bible === null) return;
      setBusy(true);
      setFeedback(null);
      try {
        const picked = await window.quantum.invoke('bible:imagePick', undefined);
        if (picked === null) return;
        // Shrunk in the renderer, so what reaches the disk is bounded whatever was chosen.
        const normalised = await normaliseBibleImage(picked);
        const name = await window.quantum.invoke('bible:imageWrite', {
          path,
          id: entry.id,
          dataUri: normalised,
        });
        setPictures((current) => new Map(current).set(entry.id, normalised));
        await persist({
          ...bible,
          entries: bible.entries.map((candidate) =>
            candidate.id === entry.id
              ? { ...candidate, image: name, updatedAt: Date.now() }
              : candidate,
          ),
        });
      } catch (error) {
        setFeedback(
          t('bible.imageFailed', {
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      } finally {
        setBusy(false);
      }
    },
    [bible, path, persist, t],
  );

  const removeImage = useCallback(
    async (entry: BibleEntry) => {
      if (path === null || bible === null) return;
      await window.quantum.invoke('bible:imageDelete', { path, id: entry.id });
      setPictures((current) => new Map(current).set(entry.id, null));
      await persist({
        ...bible,
        entries: bible.entries.map((candidate) =>
          candidate.id === entry.id
            ? { ...candidate, image: null, updatedAt: Date.now() }
            : candidate,
        ),
      });
    },
    [bible, path, persist],
  );

  const draft = async () => {
    if (selected === null || running) return;
    const operation = beginDocumentOperation(
      { id: documentId, revision: documentRevision, path },
      'bible',
    );
    const submittedBibleRevision = revision.current;
    latestDraft.current = operation;
    setRunning(true);
    setElapsedSeconds(0);
    setFeedback(null);
    cancelled.current = false;
    try {
      const context = buildBibleContext(selected, scenes);
      // Nothing to draft from. Asking anyway is asking the model to invent, which is the one
      // thing a bible must never contain.
      if (context.trim().length === 0) {
        setFeedback(t('bible.draftNoContext', { name: selected.name }));
        return;
      }
      const config = await window.quantum.invoke('ai:config:get', undefined);
      if (latestDraft.current?.requestId !== operation.requestId) return;
      const fields = bibleFieldsFor(selected.kind);
      const handle = startCollectedAiRequest({
        requestId: operation.requestId,
        profileId: config.activeProfileId,
        mode: 'factual',
        temperature: 0.2,
        // Drafting a sheet is extraction from text that is already in front of the model, not
        // a problem to reason about. Thinking first doubles or triples the wait — enough for a
        // local model to blow past the profile's timeout — and buys nothing here.
        reasoning: 'disabled',
        systemPrompt: BIBLE_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: buildBibleDraftPrompt(
              t(`bible.kind.${selected.kind}`).toLocaleLowerCase(),
              selected.name,
              fields,
              context,
            ),
          },
        ],
      });
      requestRef.current = handle;
      const drafted = parseBibleDraft(await handle.promise, fields);
      const operationStatus = validateDocumentOperation(
        useDocuments.getState().documents,
        operation,
        latestDraft.current?.requestId,
      );
      if (
        cancelled.current ||
        bible === null ||
        operationStatus !== 'current' ||
        revision.current !== submittedBibleRevision
      ) {
        if (!cancelled.current && operationStatus !== 'superseded') {
          setFeedback(t('operation.stale'));
        }
        return;
      }

      // The author always wins: the draft fills what is empty and never overwrites a word
      // they wrote themselves.
      const merged: Record<string, string> = { ...selected.fields };
      for (const [field, value] of Object.entries(drafted)) {
        if ((merged[field] ?? '').trim().length === 0) merged[field] = value;
      }
      void persist({
        ...bible,
        entries: bible.entries.map((entry) =>
          entry.id === selected.id
            ? { ...entry, fields: merged, draftedAt: Date.now(), updatedAt: Date.now() }
            : entry,
        ),
      });
    } catch (error) {
      if (!cancelled.current && latestDraft.current?.requestId === operation.requestId) {
        setFeedback(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (latestDraft.current?.requestId === operation.requestId) {
        requestRef.current = null;
        setRunning(false);
      }
    }
  };

  const stop = async () => {
    cancelled.current = true;
    await requestRef.current?.cancel();
    setRunning(false);
  };

  const select = (id: string) => {
    flush();
    setSelectedId(id);
  };

  const close = () => {
    flush();
    onClose();
  };

  const facts = selected === null || analysis === null ? [] : factsForEntry(selected, analysis);

  const row = (entry: BibleEntry, isOrphan: boolean) => (
    <li key={entry.id}>
      <button
        type="button"
        className={`rail-row${entry.id === selectedId ? ' is-current' : ''}`}
        aria-current={entry.id === selectedId ? 'true' : undefined}
        onClick={() => select(entry.id)}
      >
        <span className="bible-avatar is-small" aria-hidden="true">
          {pictures.get(entry.id) ? (
            <img src={pictures.get(entry.id) ?? ''} alt="" />
          ) : (
            <span>{initials(entry.name)}</span>
          )}
        </span>
        <span className="rail-identity">
          <span className="rail-name">{entry.name}</span>
          <span className="rail-detail">
            {t(`bible.kind.${entry.kind}`)}
            {isOrphan ? ` · ${t('bible.orphanBadge')}` : ''}
          </span>
        </span>
      </button>
    </li>
  );

  return (
    <Dialog
      className="bible-dialog"
      title={t('bible.title')}
      subtitle={t('bible.subtitle')}
      closeLabel={t('bible.close')}
      onClose={close}
      headerActions={
        path === null ? null : (
          <div className="bible-views" role="group" aria-label={t('bible.view')}>
            {(['sheets', 'grouping'] as const).map((candidate) => (
              <button
                type="button"
                key={candidate}
                className={view === candidate ? 'is-current' : ''}
                aria-pressed={view === candidate}
                onClick={() => setView(candidate)}
              >
                {t(`bible.view.${candidate}`)}
              </button>
            ))}
          </div>
        )
      }
      footer={<Button onClick={close}>{t('bible.done')}</Button>}
    >
      {path === null ? (
        <div className="panel-placeholder">{t('bible.saveFirst')}</div>
      ) : bible === null ? (
        <div className="panel-placeholder">{t('bible.loading')}</div>
      ) : view === 'grouping' ? (
        <GroupingView
          entries={bible.entries}
          reconciliation={reconciliation}
          locations={analysis?.locations ?? []}
          busy={busy}
          t={t}
          onGroup={(parent, children) => void group(parent, children)}
          onAttach={(sheetId, name) => void attach(sheetId, name)}
          onCreate={(kind, name) => void add(kind, name)}
        />
      ) : (
        <div className="bible-layout">
          <div className="rail">
            <ul className="rail-list" aria-label={t('bible.list')}>
              {reconciliation.attached.map((entry) => row(entry, false))}
              {reconciliation.orphaned.map((entry) => row(entry, true))}
            </ul>

            {bible.entries.length === 0 ? (
              <p className="bible-rail-empty">{t('bible.empty')}</p>
            ) : null}

            {/*
                One composer instead of a button per detected name. A feature has thirty
                speaking parts and twenty locations; offering fifty buttons buried the rail
                and made the panel unreadable. The names are still one keystroke away — they
                are the field's suggestions — and the same three controls also create the
                objects and notions that no screenplay can suggest.
              */}
            <form
              className="bible-compose"
              onSubmit={(event) => {
                event.preventDefault();
                if (draftName.trim().length === 0) return;
                void add(newKind, draftName);
                setDraftName('');
                setListOpen(false);
              }}
            >
              <div className="bible-compose-row">
                <Field label={t('bible.addKind')} labelHidden>
                  <Select
                    value={newKind}
                    onChange={(event) => setNewKind(event.target.value as BibleEntryKind)}
                  >
                    {BIBLE_ENTRY_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {t(`bible.kind.${kind}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
                {/*
                    A native <datalist> would be less code, but it filters accent-sensitively
                    and that cannot be configured: typing "megalopole" offered nothing on a
                    screenplay full of MÉGALOPOLE. This is the same control, filtered by us.
                  */}
                <Field label={t('bible.addName')} labelHidden>
                  <TextInput
                    value={draftName}
                    maxLength={120}
                    placeholder={t('bible.addPlaceholder')}
                    role="combobox"
                    aria-expanded={suggestions.length > 0}
                    aria-controls="bible-suggestions"
                    aria-activedescendant={
                      highlighted >= 0 ? `bible-suggestion-${highlighted}` : undefined
                    }
                    autoComplete="off"
                    onChange={(event) => {
                      setDraftName(event.target.value);
                      setHighlighted(-1);
                      setListOpen(false);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'ArrowDown' && suggestions.length === 0) {
                        // The conventional way to open a combo box from the keyboard.
                        event.preventDefault();
                        setListOpen(true);
                        return;
                      }
                      if (suggestions.length === 0) return;
                      if (event.key === 'ArrowDown') {
                        event.preventDefault();
                        setHighlighted((current) => (current + 1) % suggestions.length);
                      } else if (event.key === 'ArrowUp') {
                        event.preventDefault();
                        setHighlighted((current) =>
                          current <= 0 ? suggestions.length - 1 : current - 1,
                        );
                      } else if (event.key === 'Enter' && highlighted >= 0) {
                        event.preventDefault();
                        const picked = suggestions[highlighted];
                        if (picked !== undefined) {
                          setDraftName(picked);
                          setHighlighted(-1);
                          setListOpen(false);
                        }
                      } else if (event.key === 'Escape') {
                        // Swallowed only when there is a list to close, so Escape still
                        // closes the dialog otherwise.
                        event.stopPropagation();
                        setHighlighted(-1);
                        setListOpen(false);
                      }
                    }}
                  />
                </Field>
                <button
                  type="button"
                  className="bible-compose-open"
                  disabled={busy || candidates.length === 0}
                  aria-label={t('bible.browse')}
                  aria-expanded={listOpen}
                  onClick={() => {
                    setDraftName('');
                    setHighlighted(-1);
                    setListOpen((current) => !current);
                  }}
                >
                  <span aria-hidden="true">▾</span>
                </button>
                <button
                  type="submit"
                  className="bible-compose-add"
                  disabled={busy || draftName.trim().length === 0}
                  aria-label={t('bible.add')}
                >
                  <span aria-hidden="true">+</span>
                </button>
              </div>
              {suggestions.length > 0 ? (
                <ul className="bible-suggestions" id="bible-suggestions" role="listbox">
                  {suggestions.map((candidate, index) => (
                    <li
                      key={candidate}
                      id={`bible-suggestion-${index}`}
                      role="option"
                      aria-selected={index === highlighted}
                    >
                      <button
                        type="button"
                        className={index === highlighted ? 'is-current' : ''}
                        onClick={() => {
                          setDraftName(candidate);
                          setHighlighted(-1);
                          setListOpen(false);
                        }}
                      >
                        {candidate}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {candidates.length > 0 ? (
                <p className="bible-compose-hint">
                  {t('bible.candidates', { count: candidates.length })}
                </p>
              ) : null}
            </form>
          </div>

          <div className="bible-pane">
            {selected === null ? (
              <p className="panel-placeholder">{t('bible.selectFirst')}</p>
            ) : (
              <>
                {orphaned ? (
                  <div className="bible-orphan">
                    <strong>{t('bible.orphanTitle')}</strong>
                    <p>{t('bible.orphanHint', { name: selected.name })}</p>
                    <div className="bible-orphan-actions">
                      <Field label={t('bible.orphanReattach')} labelHidden>
                        <Select
                          value=""
                          onChange={(event) => {
                            if (event.target.value === '') return;
                            void reattach(selected.id, event.target.value);
                          }}
                        >
                          <option value="">{t('bible.orphanReattach')}</option>
                          {reconciliation.unseeded
                            .filter((candidate) => candidate.kind === selected.kind)
                            .map((candidate) => (
                              <option key={candidate.name} value={candidate.name}>
                                {candidate.name}
                              </option>
                            ))}
                        </Select>
                      </Field>
                      <Button variant="danger" disabled={busy} onClick={() => remove(selected.id)}>
                        {t('bible.orphanDelete')}
                      </Button>
                    </div>
                  </div>
                ) : null}

                <div className="bible-heading">
                  <div className="bible-identity">
                    <button
                      type="button"
                      className="bible-avatar"
                      disabled={busy}
                      aria-label={t('bible.imageChange', { name: selected.name })}
                      onClick={() => void chooseImage(selected)}
                    >
                      {pictures.get(selected.id) ? (
                        <img src={pictures.get(selected.id) ?? ''} alt="" />
                      ) : (
                        <span>{initials(selected.name)}</span>
                      )}
                    </button>
                    {pictures.get(selected.id) ? (
                      <button
                        type="button"
                        className="bible-avatar-remove"
                        disabled={busy}
                        aria-label={t('bible.imageRemove')}
                        onClick={() => void removeImage(selected)}
                      >
                        <span aria-hidden="true">×</span>
                      </button>
                    ) : null}
                  </div>
                  <label className="bible-name">
                    <span className="sr-only">{t('bible.nameLabel')}</span>
                    <input
                      value={selected.name}
                      maxLength={120}
                      onChange={(event) => {
                        update(selected.id, (entry) => ({ ...entry, name: event.target.value }));
                      }}
                      onBlur={flush}
                    />
                  </label>
                </div>

                {selected.aliases.length > 0 ? (
                  <div className="bible-aliases">
                    <h3>{t('bible.aliases')}</h3>
                    <ul>
                      {selected.aliases.map((alias) => (
                        <li key={alias}>
                          {alias}
                          <button
                            type="button"
                            aria-label={t('bible.aliasRemove', { name: alias })}
                            disabled={busy}
                            onClick={() => void detach(selected.id, alias)}
                          >
                            <span aria-hidden="true">×</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                <div className="bible-facts">
                  <h3>{t('bible.facts')}</h3>
                  {facts.length === 0 ? (
                    <p>{t('bible.noFacts')}</p>
                  ) : (
                    <ul>
                      {facts.map((fact) => (
                        <li key={fact.key}>
                          {t(`bible.fact.${fact.key}`, {
                            count: fact.count ?? 0,
                            value: fact.value ?? '',
                          })}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="bible-draft">
                  {running ? (
                    <div className="consistency-running" role="status">
                      <div className="consistency-orbit" aria-hidden="true">
                        <span />
                        <span />
                        <span />
                      </div>
                      <div>
                        <strong>{t('bible.drafting', { name: selected.name })}</strong>
                        <small>
                          {t('consistency.elapsed', {
                            minutes: Math.floor(elapsedSeconds / 60),
                            seconds: String(elapsedSeconds % 60).padStart(2, '0'),
                          })}
                        </small>
                      </div>
                      <Button onClick={() => void stop()}>{t('ai.request.stop')}</Button>
                    </div>
                  ) : (
                    <Button variant="primary" onClick={() => void draft()}>
                      {t('bible.draft')}
                    </Button>
                  )}
                  {selected.draftedAt ? (
                    <p className="bible-drafted-note">
                      {t('bible.draftedNote')} {t('bible.draftKept')}
                    </p>
                  ) : null}
                </div>
                <div className="bible-fields">
                  {bibleFieldsFor(selected.kind).map((field) => (
                    <label key={field}>
                      <span>{t(`bible.field.${field}`)}</span>
                      <textarea
                        rows={3}
                        // An empty form reads as broken; a question reads as an invitation.
                        placeholder={t(`bible.placeholder.${field}`)}
                        value={selected.fields[field] ?? ''}
                        onChange={(event) => {
                          update(selected.id, (entry) => ({
                            ...entry,
                            fields: { ...entry.fields, [field]: event.target.value },
                          }));
                        }}
                        onBlur={flush}
                      />
                    </label>
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
