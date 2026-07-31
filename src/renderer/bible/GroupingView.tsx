import { useMemo, useState } from 'react';
import type { BibleEntry, BibleEntryKind } from '@shared/bible/index.js';
import { BIBLE_ENTRY_KINDS } from '@shared/bible/index.js';
import type { BibleReconciliation } from '@shared/bible/index.js';
import { suggestLocationGroups } from '@shared/bible/grouping.js';
import { foldDiacritics } from '@shared/text/index.js';
import type { Translator } from '@shared/i18n/index.js';

interface GroupingViewProps {
  entries: readonly BibleEntry[];
  reconciliation: BibleReconciliation;
  /** Every location the screenplay holds, with how many scenes use it. */
  locations: ReadonlyArray<{ name: string; count: number }>;
  busy: boolean;
  t: Translator['t'];
  onGroup: (parent: string, children: readonly string[]) => void;
  onAttach: (sheetId: string, name: string) => void;
  onCreate: (kind: BibleEntryKind, name: string) => void;
}

/**
 * Deciding which of the screenplay's names are the same thing.
 *
 * Two halves, and the split is deliberate. The suggestions are read from the screenplay's own
 * naming convention, so they are usually right and can be accepted in one click. The
 * unattached list is everything the convention cannot see — a character introduced as "LA
 * FILLE" so the reveal lands, which no heuristic should ever guess.
 */
export function GroupingView({
  entries,
  reconciliation,
  locations,
  busy,
  t,
  onGroup,
  onAttach,
  onCreate,
}: GroupingViewProps) {
  /** Children the author has unticked, keyed `parent|child`. */
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());

  const covered = useMemo(() => {
    const set = new Set<string>();
    for (const entry of entries) {
      for (const name of [entry.name, ...entry.aliases]) set.add(foldDiacritics(name));
    }
    return set;
  }, [entries]);

  const suggestions = useMemo(() => {
    // Parents are taken from every location, not only the unattached ones: a city may already
    // have a sheet while its districts do not.
    return suggestLocationGroups(locations.map((location) => location.name))
      .map((group) => ({
        ...group,
        children: group.children.filter((child) => !covered.has(foldDiacritics(child))),
      }))
      .filter((group) => group.children.length > 0);
  }, [covered, locations]);

  const unattached = useMemo(() => {
    const proposed = new Set(
      suggestions.flatMap((group) => group.children.map((child) => foldDiacritics(child))),
    );
    return reconciliation.unseeded.filter(
      (candidate) => !proposed.has(foldDiacritics(candidate.name)),
    );
  }, [reconciliation, suggestions]);

  /**
   * Grouped by kind, in the order the bible lists them.
   *
   * A flat list mixed characters, places, objects and notions in whatever order the parser
   * happened to report them — which reads as a heap rather than as work to do.
   */
  const unattachedByKind = useMemo(
    () =>
      BIBLE_ENTRY_KINDS.map((kind) => ({
        kind,
        names: unattached
          .filter((candidate) => candidate.kind === kind)
          .map((candidate) => candidate.name)
          .sort((a, b) => a.localeCompare(b)),
      })).filter((group) => group.names.length > 0),
    [unattached],
  );

  const sceneCount = (name: string): number =>
    locations.find((location) => foldDiacritics(location.name) === foldDiacritics(name))?.count ?? 0;

  const sheetsOfKind = (kind: BibleEntryKind) =>
    entries.filter((entry) => entry.kind === kind).sort((a, b) => a.name.localeCompare(b.name));

  const toggle = (key: string) =>
    setExcluded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const nothingToDo = suggestions.length === 0 && unattachedByKind.length === 0;

  return (
    <div className="bible-grouping">
      {nothingToDo ? <p className="panel-placeholder">{t('bible.grouping.none')}</p> : null}

      {suggestions.length > 0 ? (
        <section>
          <h3>{t('bible.grouping.suggestions')}</h3>
          <p className="bible-grouping-hint">{t('bible.grouping.suggestionsHint')}</p>
          {suggestions.map((group) => {
            const kept = group.children.filter(
              (child) => !excluded.has(`${group.parent}|${child}`),
            );
            return (
              <article className="bible-group" key={group.parent}>
                <header>
                  <strong>{group.parent}</strong>
                  <button
                    type="button"
                    className="ai-primary"
                    disabled={busy || kept.length === 0}
                    onClick={() => onGroup(group.parent, kept)}
                  >
                    {t('bible.grouping.group')}
                  </button>
                </header>
                <ul>
                  {group.children.map((child) => {
                    const key = `${group.parent}|${child}`;
                    return (
                      <li key={child}>
                        <label>
                          <input
                            type="checkbox"
                            checked={!excluded.has(key)}
                            onChange={() => toggle(key)}
                          />
                          <span>{child}</span>
                          <small>
                            {t('bible.grouping.childScenes', { count: sceneCount(child) })}
                          </small>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </article>
            );
          })}
        </section>
      ) : null}

      {unattachedByKind.length === 0 ? null : (
        <section>
          <h3>{t('bible.grouping.unattached')}</h3>
          <p className="bible-grouping-hint">{t('bible.grouping.unattachedHint')}</p>
          {unattachedByKind.map((group) => {
            const sheets = sheetsOfKind(group.kind);
            return (
              <div className="bible-unattached-kind-group" key={group.kind}>
                <h4>
                  {t(`bible.kind.${group.kind}`)}
                  <small>{t('bible.grouping.kindCount', { count: group.names.length })}</small>
                </h4>
                <ul className="bible-unattached">
                  {group.names.map((name) => (
                    <li key={name}>
                      <span className="bible-unattached-name">{name}</span>
                      <label>
                        <span className="sr-only">
                          {t('bible.grouping.attachLabel', { name })}
                        </span>
                        <select
                          value=""
                          disabled={busy}
                          onChange={(event) => {
                            const choice = event.target.value;
                            if (choice === '') return;
                            if (choice === 'own') onCreate(group.kind, name);
                            else onAttach(choice, name);
                          }}
                        >
                          <option value="">{t('bible.grouping.attachTo')}</option>
                          <option value="own">{t('bible.grouping.attachOwn')}</option>
                          {sheets.map((sheet) => (
                            <option key={sheet.id} value={sheet.id}>
                              {sheet.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}
