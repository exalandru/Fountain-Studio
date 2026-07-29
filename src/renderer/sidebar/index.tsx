import { memo, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import type { IndexedOccurrence, ParseResponse } from '@shared/analysis/index.js';
import type { SectionNode } from '@shared/fountain/index.js';
import type { SidebarState, SidebarTab } from '@shared/appdata/index.js';
import { useTranslator } from '../hooks/useTranslator.js';

export interface SidebarProps {
  analysis: ParseResponse | null;
  state: SidebarState;
  activeSceneId: string | null;
  onTabChange: (tab: SidebarTab) => void;
  onFilterChange: (filter: string) => void;
  onShowSynopsesChange: (visible: boolean) => void;
  onSelectRange: (range: { from: number; to: number }) => void;
  onClose: () => void;
}

function normalizeFilter(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function matches(value: string | undefined, filter: string): boolean {
  return filter.length === 0 || value?.toLocaleLowerCase().includes(filter) === true;
}

export const Sidebar = memo(function Sidebar({
  analysis,
  state,
  activeSceneId,
  onTabChange,
  onFilterChange,
  onShowSynopsesChange,
  onSelectRange,
  onClose,
}: SidebarProps) {
  const { t } = useTranslator();
  const cycles = useRef(new Map<string, number>());
  const filter = normalizeFilter(state.filter);

  const scenesByIndex = analysis?.scenes ?? [];
  const rootScenes = useMemo(
    () =>
      (analysis?.scenes ?? []).filter(
        (scene) =>
          scene.sectionPath.length === 0 &&
          (matches(scene.heading, filter) ||
            matches(scene.number, filter) ||
            matches(scene.synopsis, filter)),
      ),
    [analysis?.scenes, filter],
  );

  const locations = useMemo(
    () =>
      (analysis?.locations ?? [])
        .filter((location) => matches(location.name, filter))
        .sort((left, right) => left.name.localeCompare(right.name)),
    [analysis?.locations, filter],
  );
  const characters = useMemo(
    () =>
      (analysis?.characters ?? [])
        .filter((character) => matches(character.name, filter))
        .sort(
          (left, right) => right.speeches - left.speeches || left.name.localeCompare(right.name),
        ),
    [analysis?.characters, filter],
  );

  const cycle = (key: string, occurrences: IndexedOccurrence[]) => {
    if (occurrences.length === 0) return;
    const index = cycles.current.get(key) ?? 0;
    const occurrence = occurrences[index % occurrences.length];
    cycles.current.set(key, (index + 1) % occurrences.length);
    if (occurrence) onSelectRange(occurrence);
  };

  const sceneHasMatch = (sceneIndex: number): boolean => {
    const scene = scenesByIndex[sceneIndex];
    return Boolean(
      scene &&
      (matches(scene.heading, filter) ||
        matches(scene.number, filter) ||
        matches(scene.synopsis, filter)),
    );
  };

  const renderScene = (sceneIndex: number): ReactNode => {
    const scene = scenesByIndex[sceneIndex];
    if (!scene) return null;
    if (
      !matches(scene.heading, filter) &&
      !matches(scene.number, filter) &&
      !matches(scene.synopsis, filter)
    ) {
      return null;
    }

    return (
      <button
        type="button"
        key={scene.id}
        className={`sidebar-scene${scene.id === activeSceneId ? ' is-current' : ''}`}
        onClick={() => onSelectRange(scene.range)}
      >
        <span className="sidebar-scene-line">
          <span className="sidebar-scene-number">{scene.number}</span>
          <span className="sidebar-scene-heading">{scene.heading}</span>
        </span>
        {state.showSynopses && scene.synopsis ? (
          <span className="sidebar-synopsis">{scene.synopsis}</span>
        ) : null}
      </button>
    );
  };

  const renderSection = (section: SectionNode, depth = 0): ReactNode => {
    const sceneMatches = section.sceneIndexes.some(sceneHasMatch);
    const childMatches = section.children.some((child) => sectionHasMatch(child));
    const selfMatches = matches(section.title, filter) || matches(section.synopsis, filter);
    if (filter && !selfMatches && !sceneMatches && !childMatches) return null;

    return (
      <div key={section.id} className="sidebar-section">
        <button
          type="button"
          className="sidebar-section-header"
          style={{ paddingLeft: `${8 + depth * 12}px` }}
          onClick={() => onSelectRange(section.range)}
        >
          <span className="sidebar-section-title">
            {'#'.repeat(section.depth)} {section.title}
          </span>
          {state.showSynopses && section.synopsis ? (
            <span className="sidebar-synopsis">{section.synopsis}</span>
          ) : null}
        </button>
        <div className="sidebar-section-children">
          {section.sceneIndexes.map(renderScene)}
          {section.children.map((child) => renderSection(child, depth + 1))}
        </div>
      </div>
    );
  };

  const sectionHasMatch = (section: SectionNode): boolean => {
    if (matches(section.title, filter) || matches(section.synopsis, filter)) return true;
    if (section.sceneIndexes.some(sceneHasMatch)) return true;
    return section.children.some(sectionHasMatch);
  };

  const structureEmpty =
    rootScenes.length === 0 && !(analysis?.sections.some(sectionHasMatch) ?? false);

  return (
    <aside className="sidebar" aria-label={t('sidebar.title')}>
      <header className="panel-header">
        <span>{t('sidebar.title')}</span>
        <button
          type="button"
          className="panel-close"
          aria-label={t('sidebar.close')}
          onClick={onClose}
        >
          ×
        </button>
      </header>

      <div className="sidebar-tabs" role="tablist">
        {(['structure', 'locations', 'characters'] as const).map((tab, index, tabs) => (
          <button
            type="button"
            role="tab"
            id={`sidebar-tab-${tab}`}
            aria-controls={`sidebar-panel-${tab}`}
            aria-selected={state.activeTab === tab}
            tabIndex={state.activeTab === tab ? 0 : -1}
            className={`sidebar-tab${state.activeTab === tab ? ' active' : ''}`}
            key={tab}
            onClick={() => onTabChange(tab)}
            onKeyDown={(event) => {
              const nextIndex =
                event.key === 'ArrowRight'
                  ? (index + 1) % tabs.length
                  : event.key === 'ArrowLeft'
                    ? (index - 1 + tabs.length) % tabs.length
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? tabs.length - 1
                        : -1;
              const next = tabs[nextIndex];
              if (nextIndex >= 0 && next) {
                event.preventDefault();
                onTabChange(next);
                const tabButtons =
                  event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                    '[role="tab"]',
                  );
                tabButtons?.[nextIndex]?.focus();
              }
            }}
          >
            {t(`sidebar.${tab}`)}
          </button>
        ))}
      </div>

      <div className="sidebar-options">
        <input
          type="search"
          aria-label={t('sidebar.filterPlaceholder')}
          placeholder={t('sidebar.filterPlaceholder')}
          value={state.filter}
          onChange={(event) => onFilterChange(event.target.value)}
        />
        {state.activeTab === 'structure' ? (
          <label className="panel-checkbox">
            <input
              type="checkbox"
              checked={state.showSynopses}
              onChange={(event) => onShowSynopsesChange(event.target.checked)}
            />
            {t('sidebar.showSynopses')}
          </label>
        ) : null}
      </div>

      <div
        className="sidebar-content"
        role="tabpanel"
        id={`sidebar-panel-${state.activeTab}`}
        aria-labelledby={`sidebar-tab-${state.activeTab}`}
      >
        {!analysis ? <div className="panel-placeholder">{t('sidebar.loading')}</div> : null}

        {analysis && state.activeTab === 'structure' ? (
          structureEmpty ? (
            <div className="panel-placeholder">{t('sidebar.noResults')}</div>
          ) : (
            <div className="sidebar-structure">
              {rootScenes.map((scene) => renderScene(scene.index - 1))}
              {analysis.sections.map((section) => renderSection(section))}
            </div>
          )
        ) : null}

        {analysis && state.activeTab === 'locations' ? (
          locations.length === 0 ? (
            <div className="panel-placeholder">{t('sidebar.noResults')}</div>
          ) : (
            <div className="sidebar-list">
              {locations.map((location) => (
                <button
                  type="button"
                  className="sidebar-list-item"
                  key={location.name}
                  onClick={() => cycle(`location:${location.name}`, location.occurrences)}
                >
                  <span>
                    <span className="sidebar-list-name">{location.name}</span>
                    {location.mixed ? (
                      <span className="sidebar-location-mixed">{t('sidebar.locationMixed')}</span>
                    ) : null}
                  </span>
                  <span className="sidebar-list-stat">
                    {t('sidebar.occurrences', { count: location.count })}
                  </span>
                </button>
              ))}
            </div>
          )
        ) : null}

        {analysis && state.activeTab === 'characters' ? (
          characters.length === 0 ? (
            <div className="panel-placeholder">{t('sidebar.noResults')}</div>
          ) : (
            <div className="sidebar-list">
              {characters.map((character) => (
                <button
                  type="button"
                  className="sidebar-list-item"
                  key={character.name}
                  onClick={() => cycle(`character:${character.name}`, character.occurrences)}
                >
                  <span className="sidebar-list-name">{character.name}</span>
                  <span className="sidebar-list-stat">
                    {t('sidebar.speeches', { count: character.speeches })}
                    {' · '}
                    {t('sidebar.words', { count: character.words })}
                  </span>
                </button>
              ))}
            </div>
          )
        ) : null}
      </div>
    </aside>
  );
});
