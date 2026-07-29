import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { ParseResponse } from '@shared/analysis/index.js';
import type { Element, InlineSpan } from '@shared/fountain/index.js';
import type { PaginationItem, ScreenplayPage } from '@shared/pagination/index.js';
import { useTranslator } from '../hooks/useTranslator.js';

const PAPER_WIDTH = 816;
const PAPER_HEIGHT = 1056;
const PAGE_GAP = 20;
const OVERSCAN = 2;

export interface PreviewProps {
  analysis: ParseResponse | null;
  syncScroll: boolean;
  externalOffset: number | null;
  onScrollOffset: (offset: number) => void;
  onSyncScrollChange: (enabled: boolean) => void;
  onShowStatistics: () => void;
  onClose: () => void;
}

function inlineContent(spans: InlineSpan[]): ReactNode {
  return spans.map((span, index) => (
    <span
      key={`${span.from}-${index}`}
      style={{
        fontWeight: span.bold ? 700 : undefined,
        fontStyle: span.italic ? 'italic' : undefined,
        textDecoration: span.underline ? 'underline' : undefined,
      }}
    >
      {span.text}
    </span>
  ));
}

function PreviewElement({ element }: { element: Element }) {
  if (element.kind === 'page_break' || element.kind === 'note' || element.kind === 'boneyard') {
    return null;
  }

  return (
    <div
      className={`preview-element preview-${element.kind.replace('_', '-')}`}
      data-element-id={element.id}
      data-source-from={element.range.from}
    >
      {inlineContent(element.inline)}
    </div>
  );
}

function TitlePage({ fields }: { fields: ParseResponse['titlePage'] }) {
  const values = new Map(fields);
  const title = values.get('title') ?? [];
  const credit = values.get('credit') ?? [];
  const authors = values.get('author') ?? values.get('authors') ?? [];
  const source = values.get('source') ?? [];
  const contact = values.get('contact') ?? [];
  const copyright = values.get('copyright') ?? [];
  const centralKeys = new Set(['title', 'credit', 'author', 'authors', 'source']);
  const leftKeys = new Set(['contact', 'copyright']);
  const details = fields.filter(([key, fieldValues]) => {
    return !centralKeys.has(key) && !leftKeys.has(key) && fieldValues.length > 0;
  });

  return (
    <div className="preview-title-page">
      <div className="preview-title-block">
        <div className="preview-title">{title.join('\n')}</div>
        <div>{credit.join('\n')}</div>
        <div>{authors.join('\n')}</div>
        {source.length > 0 ? <div>{source.join('\n')}</div> : null}
      </div>
      {(contact.length > 0 || copyright.length > 0) && (
        <div className="preview-title-footer">
          {contact.join('\n')}
          {contact.length > 0 && copyright.length > 0 ? '\n' : ''}
          {copyright.join('\n')}
        </div>
      )}
      {details.length > 0 ? (
        <dl className="preview-title-details">
          {details.map(([key, fieldValues]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{fieldValues.join('\n')}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

function LayoutItem({
  item,
  elements,
}: {
  item: PaginationItem;
  elements: ParseResponse['elements'];
}) {
  const element = item.elementIndex === null ? null : elements[item.elementIndex];
  if (element && item.text === element.text) return <PreviewElement element={element} />;

  return (
    <div
      className={`preview-element preview-${item.kind.replace('_', '-')}`}
      data-source-from={item.range?.from}
    >
      {item.lines.join('\n')}
    </div>
  );
}

function BodyPage({
  page,
  elements,
}: {
  page: ScreenplayPage;
  elements: ParseResponse['elements'];
}) {
  return (
    <>
      {page.items.map((item, index) => (
        <LayoutItem
          key={`${item.elementIndex ?? item.kind}-${index}`}
          item={item}
          elements={elements}
        />
      ))}
      <span className="preview-page-number">{page.index + 1}</span>
    </>
  );
}

/**
 * Page-virtualised screenplay preview.
 *
 * Paper is laid out at physical Letter dimensions and scaled to the available pane.
 * Only visible pages plus a two-page overscan are mounted, keeping updates stable on
 * feature-length scripts.
 */
export const Preview = memo(function Preview({
  analysis,
  syncScroll,
  externalOffset,
  onScrollOffset,
  onSyncScrollChange,
  onShowStatistics,
  onClose,
}: PreviewProps) {
  const { t } = useTranslator();
  const paneRef = useRef<HTMLElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const suppressScroll = useRef(false);
  const [scale, setScale] = useState(0.6);
  const [viewport, setViewport] = useState({ top: 0, height: 800 });

  const bodyPages = useMemo(() => analysis?.pagination.pages ?? [], [analysis?.pagination.pages]);
  const hasTitlePage = (analysis?.titlePage.length ?? 0) > 0;
  const totalPages = bodyPages.length + (hasTitlePage ? 1 : 0);
  const scaledHeight = PAPER_HEIGHT * scale;
  const pageStride = scaledHeight + PAGE_GAP;

  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;

    const updateScale = () => {
      const available = Math.max(260, pane.clientWidth - 32);
      setScale(Math.min(1, available / PAPER_WIDTH));
    };
    updateScale();

    const observer = new ResizeObserver(updateScale);
    observer.observe(pane);
    return () => observer.disconnect();
  }, []);

  const updateViewport = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    setViewport({ top: scroller.scrollTop, height: scroller.clientHeight });
  }, []);

  const visible = useMemo(() => {
    const start = Math.max(0, Math.floor(viewport.top / pageStride) - OVERSCAN);
    const end = Math.min(
      totalPages,
      Math.ceil((viewport.top + viewport.height) / pageStride) + OVERSCAN,
    );
    return { start, end };
  }, [pageStride, totalPages, viewport]);

  const bodyPageForOffset = useCallback(
    (offset: number) => {
      let low = 0;
      let high = bodyPages.length - 1;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const page = bodyPages[middle];
        if (!page) break;
        if (offset < page.range.from) high = middle - 1;
        else if (offset > page.range.to) low = middle + 1;
        else return page;
      }
      return bodyPages[Math.min(low, bodyPages.length - 1)] ?? null;
    },
    [bodyPages],
  );

  useEffect(() => {
    if (!syncScroll || externalOffset === null || !scrollRef.current) return;
    const page = bodyPageForOffset(externalOffset);
    if (!page) return;

    const pageIndex = page.index + (hasTitlePage ? 1 : 0);
    const length = Math.max(1, page.range.to - page.range.from);
    const progress = Math.min(1, Math.max(0, (externalOffset - page.range.from) / length));
    suppressScroll.current = true;
    scrollRef.current.scrollTop = pageIndex * pageStride + progress * scaledHeight * 0.8;
  }, [bodyPageForOffset, externalOffset, hasTitlePage, pageStride, scaledHeight, syncScroll]);

  const handleScroll = useCallback(() => {
    updateViewport();
    if (!syncScroll || !analysis || !scrollRef.current) return;
    if (suppressScroll.current) {
      suppressScroll.current = false;
      return;
    }

    const position = scrollRef.current.scrollTop;
    const virtualIndex = Math.min(totalPages - 1, Math.max(0, Math.floor(position / pageStride)));
    const bodyIndex = virtualIndex - (hasTitlePage ? 1 : 0);
    const page = bodyPages[Math.max(0, bodyIndex)];
    if (!page) return;

    const within = Math.max(0, position - virtualIndex * pageStride);
    const progress = Math.min(1, within / Math.max(1, scaledHeight * 0.8));
    onScrollOffset(
      Math.round(page.range.from + progress * Math.max(0, page.range.to - page.range.from)),
    );
  }, [
    analysis,
    bodyPages,
    hasTitlePage,
    onScrollOffset,
    pageStride,
    scaledHeight,
    syncScroll,
    totalPages,
    updateViewport,
  ]);

  const renderPage = (virtualIndex: number) => {
    const isTitle = hasTitlePage && virtualIndex === 0;
    const bodyPage = bodyPages[virtualIndex - (hasTitlePage ? 1 : 0)];

    return (
      <div
        className="preview-page-shell"
        key={isTitle ? 'title' : (bodyPage?.index ?? virtualIndex)}
        style={{ height: scaledHeight }}
      >
        <div
          className="preview-paper"
          style={{ '--preview-scale': scale } as CSSProperties}
          data-page={virtualIndex + 1}
        >
          {isTitle && analysis ? <TitlePage fields={analysis.titlePage} /> : null}
          {!isTitle && bodyPage && analysis ? (
            <BodyPage page={bodyPage} elements={analysis.elements} />
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <section className="preview-pane" ref={paneRef} aria-label={t('preview.title')}>
      <header className="panel-header">
        <span>{t('preview.title')}</span>
        <button type="button" className="panel-tab-button" onClick={onShowStatistics}>
          {t('stats.title')}
        </button>
        <label className="panel-checkbox">
          <input
            type="checkbox"
            checked={syncScroll}
            onChange={(event) => onSyncScrollChange(event.target.checked)}
          />
          {t('preview.syncScroll')}
        </label>
        <button
          type="button"
          className="panel-close"
          aria-label={t('preview.close')}
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <div className="preview-scroll" ref={scrollRef} onScroll={handleScroll}>
        {!analysis ? (
          <div className="panel-placeholder">{t('preview.loading')}</div>
        ) : (
          <>
            <div style={{ height: visible.start * pageStride }} />
            {Array.from({ length: Math.max(0, visible.end - visible.start) }, (_, index) =>
              renderPage(visible.start + index),
            )}
            <div style={{ height: Math.max(0, totalPages - visible.end) * pageStride }} />
          </>
        )}
      </div>
    </section>
  );
});
