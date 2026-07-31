import { useEffect, useMemo, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFDocumentLoadingTask, RenderTask } from 'pdfjs-dist';
import PdfJsWorker from 'pdfjs-dist/build/pdf.worker.mjs?worker';
import type { PdfExportOptions, PdfRevisionOptions } from '@shared/ipc-contract.js';
import type { RevisionState } from '@shared/appdata/index.js';
import { REVISION_PAPER } from '@shared/revision/index.js';
import { useTranslator } from '../hooks/useTranslator.js';

if (!GlobalWorkerOptions.workerPort) GlobalWorkerOptions.workerPort = new PdfJsWorker();

const DEFAULT_OPTIONS: PdfExportOptions = {
  format: 'a4',
  sceneNumbers: 'both',
  includeNotes: false,
  includeSynopses: false,
  headingsBold: true,
  watermark: '',
  pageFrom: null,
  pageTo: null,
  revision: null,
};

/** What the author chooses about a revision; the rest of it comes from the locked draft. */
type RevisionChoices = Pick<
  PdfRevisionOptions,
  'colourMode' | 'marks' | 'lockedPages' | 'onlyRevisedPages'
>;

const DEFAULT_REVISION: RevisionChoices = {
  colourMode: 'header',
  marks: true,
  lockedPages: true,
  onlyRevisedPages: false,
};

interface PdfExportDialogProps {
  source: string;
  suggestedName: string;
  /** Needed to read the locked draft back out of its snapshot. */
  path: string | null;
  revision: RevisionState | null;
  /** Today, as of the moment the dialog was opened, in `yyyy-mm-dd`. */
  issueDate: string;
  onExported: (path: string) => void;
  onError: (message: string) => void;
  onClose: () => void;
}

/** PDF options with a pdf.js preview of the exact bytes produced by the main process. */
export function PdfExportDialog({
  source,
  suggestedName,
  path,
  revision,
  issueDate,
  onExported,
  onError,
  onClose,
}: PdfExportDialogProps) {
  const { t, locale } = useTranslator();
  const dialogRef = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [options, setOptions] = useState<PdfExportOptions>(DEFAULT_OPTIONS);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [previewPage, setPreviewPage] = useState(1);
  const [rendering, setRendering] = useState(true);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [choices, setChoices] = useState<RevisionChoices>(DEFAULT_REVISION);
  const [date, setDate] = useState(issueDate);
  /** The locked draft, read from its snapshot. `null` until it arrives. */
  const [baseline, setBaseline] = useState<string | null>(null);
  const locked = revision?.snapshotId != null && path !== null;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => previous?.focus();
  }, []);

  useEffect(() => {
    if (!locked || path === null || revision?.snapshotId == null) return;
    let cancelled = false;
    void window.quantum
      .invoke('snapshot:read', { path, id: revision.snapshotId })
      .then((content) => {
        if (!cancelled) setBaseline(content);
      })
      // A reference that cannot be read is a screenplay with nothing to compare against, which
      // is exactly how an unlocked one behaves. Better than refusing to export at all.
      .catch(() => {
        if (!cancelled) setBaseline('');
      });
    return () => {
      cancelled = true;
    };
  }, [locked, path, revision?.snapshotId]);

  /**
   * The options actually sent to the renderer.
   *
   * The header is composed here because only this side knows the locale, and upper case because
   * that is how a production reads it off the top of a page.
   */
  const effective = useMemo<PdfExportOptions>(() => {
    if (!locked || baseline === null || revision === null) return { ...options, revision: null };
    const colourName = t(`revision.colour.${revision.colour}`);
    const shown = date.length > 0 ? new Date(date).toLocaleDateString(locale) : '';
    return {
      ...options,
      revision: {
        baselineSource: baseline,
        header: t('revision.pdfHeader', { colour: colourName, date: shown }).toLocaleUpperCase(
          locale,
        ),
        colour: revision.colour,
        ...choices,
      },
    };
  }, [baseline, choices, date, locale, locked, options, revision, t]);

  useEffect(() => {
    let cancelled = false;
    let loading: PDFDocumentLoadingTask | null = null;
    const timer = setTimeout(() => {
      void (async () => {
        setRendering(true);
        setRenderError(null);
        setPdfDocument(null);
        try {
          const rendered = await window.quantum.invoke('pdf:render', {
            source,
            options: effective,
          });
          if (cancelled) return;
          loading = getDocument({ data: new Uint8Array(rendered.bytes) });
          const pdf = await loading.promise;
          if (cancelled) {
            await loading.destroy();
            return;
          }
          setPageCount(pdf.numPages);
          setPreviewPage((current) => Math.min(Math.max(1, current), pdf.numPages));
          setPdfDocument(pdf);
        } catch (error) {
          if (!cancelled) {
            setRenderError(error instanceof Error ? error.message : String(error));
            setRendering(false);
          }
        }
      })();
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (loading) void loading.destroy();
    };
  }, [effective, source]);

  useEffect(() => {
    if (!pdfDocument) return;
    let cancelled = false;
    let renderTask: RenderTask | null = null;

    void (async () => {
      setRendering(true);
      try {
        const page = await pdfDocument.getPage(previewPage);
        const viewport = page.getViewport({ scale: 0.72 });
        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;
        const ratio = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        const context = canvas.getContext('2d');
        if (!context) return;
        renderTask = page.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
        });
        await renderTask.promise;
      } catch (error) {
        if (!cancelled) setRenderError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!cancelled) setRendering(false);
      }
    })();

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [pdfDocument, previewPage]);

  const patch = <K extends keyof PdfExportOptions>(key: K, value: PdfExportOptions[K]) => {
    setOptions((current) => ({ ...current, [key]: value }));
  };

  const exportPdf = async () => {
    setExporting(true);
    try {
      const outcome = await window.quantum.invoke('pdf:export', {
        source,
        options: effective,
        suggestedName,
      });
      if (outcome.status === 'exported') onExported(outcome.path);
      else if (outcome.status === 'error') onError(outcome.message);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="pdf-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('pdf.title')}
        data-page-count={pageCount}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
          if (event.key === 'Tab') {
            const focusable =
              dialogRef.current?.querySelectorAll<HTMLElement>(
                'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
              ) ?? [];
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first && last) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last && first) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <header>
          <h2>{t('pdf.title')}</h2>
          <button
            type="button"
            className="panel-close"
            aria-label={t('pdf.close')}
            autoFocus
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className="pdf-dialog-body">
          <form className="pdf-options" onSubmit={(event) => event.preventDefault()}>
            <label>
              <span>{t('pdf.format')}</span>
              <select
                value={options.format}
                onChange={(event) => patch('format', event.target.value as 'letter' | 'a4')}
              >
                <option value="letter">Letter</option>
                <option value="a4">A4</option>
              </select>
            </label>
            <label>
              <span>{t('pdf.sceneNumbers')}</span>
              <select
                value={options.sceneNumbers}
                onChange={(event) =>
                  patch('sceneNumbers', event.target.value as PdfExportOptions['sceneNumbers'])
                }
              >
                <option value="none">{t('pdf.sceneNumbers.none')}</option>
                <option value="left">{t('pdf.sceneNumbers.left')}</option>
                <option value="right">{t('pdf.sceneNumbers.right')}</option>
                <option value="both">{t('pdf.sceneNumbers.both')}</option>
              </select>
            </label>
            <label className="pdf-check">
              <input
                type="checkbox"
                checked={options.includeNotes}
                onChange={(event) => patch('includeNotes', event.target.checked)}
              />
              {t('pdf.includeNotes')}
            </label>
            <label className="pdf-check">
              <input
                type="checkbox"
                checked={options.includeSynopses}
                onChange={(event) => patch('includeSynopses', event.target.checked)}
              />
              {t('pdf.includeSynopses')}
            </label>
            <label className="pdf-check">
              <input
                type="checkbox"
                checked={options.headingsBold}
                onChange={(event) => patch('headingsBold', event.target.checked)}
              />
              {t('pdf.headingsBold')}
            </label>
            <label>
              <span>{t('pdf.watermark')}</span>
              <input
                type="text"
                maxLength={200}
                value={options.watermark}
                onChange={(event) => patch('watermark', event.target.value)}
              />
            </label>
            {locked && revision !== null ? (
              <fieldset className="pdf-revision">
                <legend>
                  {t('pdf.revision')}
                  <span
                    className="pdf-revision-swatch"
                    style={{ background: REVISION_PAPER[revision.colour] }}
                    aria-hidden="true"
                  />
                  {t(`revision.colour.${revision.colour}`)}
                </legend>
                <label>
                  <span>{t('pdf.revisionColourMode')}</span>
                  <select
                    value={choices.colourMode}
                    onChange={(event) =>
                      setChoices((current) => ({
                        ...current,
                        colourMode: event.target.value as RevisionChoices['colourMode'],
                      }))
                    }
                  >
                    <option value="header">{t('pdf.revisionHeaderOnly')}</option>
                    <option value="page">{t('pdf.revisionPageOnly')}</option>
                    <option value="both">{t('pdf.revisionBoth')}</option>
                  </select>
                </label>
                <label>
                  <span>{t('pdf.revisionDate')}</span>
                  <input
                    type="date"
                    value={date}
                    onChange={(event) => setDate(event.target.value)}
                  />
                </label>
                <label className="pdf-check">
                  <input
                    type="checkbox"
                    checked={choices.marks}
                    onChange={(event) =>
                      setChoices((current) => ({ ...current, marks: event.target.checked }))
                    }
                  />
                  {t('pdf.revisionMarks')}
                </label>
                <label className="pdf-check">
                  <input
                    type="checkbox"
                    checked={choices.lockedPages}
                    onChange={(event) =>
                      setChoices((current) => ({ ...current, lockedPages: event.target.checked }))
                    }
                  />
                  {t('pdf.revisionLockedPages')}
                </label>
                <label className="pdf-check">
                  <input
                    type="checkbox"
                    checked={choices.onlyRevisedPages}
                    onChange={(event) =>
                      setChoices((current) => ({
                        ...current,
                        onlyRevisedPages: event.target.checked,
                      }))
                    }
                  />
                  {t('pdf.revisionOnlyRevised')}
                </label>
                <p className="pdf-revision-note">{t('pdf.revisionNote')}</p>
              </fieldset>
            ) : null}
            <div className="pdf-range">
              <label>
                <span>{t('pdf.pageFrom')}</span>
                <input
                  type="number"
                  min={1}
                  value={options.pageFrom ?? ''}
                  onChange={(event) =>
                    patch('pageFrom', event.target.value ? Number(event.target.value) : null)
                  }
                />
              </label>
              <label>
                <span>{t('pdf.pageTo')}</span>
                <input
                  type="number"
                  min={1}
                  value={options.pageTo ?? ''}
                  onChange={(event) =>
                    patch('pageTo', event.target.value ? Number(event.target.value) : null)
                  }
                />
              </label>
            </div>
          </form>
          <div className="pdf-preview" aria-label={t('pdf.preview')}>
            {rendering ? <div className="panel-placeholder">{t('pdf.rendering')}</div> : null}
            {renderError ? (
              <div className="panel-placeholder">
                {t('pdf.renderFailed')}
                <br />
                {renderError}
              </div>
            ) : null}
            <canvas ref={canvasRef} />
            {!renderError && pageCount > 0 ? (
              <div className="pdf-preview-controls">
                <button
                  type="button"
                  aria-label={t('pdf.previousPage')}
                  disabled={previewPage <= 1 || rendering}
                  onClick={() => setPreviewPage((page) => Math.max(1, page - 1))}
                >
                  ‹
                </button>
                <span>{t('pdf.pageStatus', { page: previewPage, count: pageCount })}</span>
                <button
                  type="button"
                  aria-label={t('pdf.nextPage')}
                  disabled={previewPage >= pageCount || rendering}
                  onClick={() => setPreviewPage((page) => Math.min(pageCount, page + 1))}
                >
                  ›
                </button>
              </div>
            ) : null}
          </div>
        </div>
        <footer>
          <button type="button" onClick={onClose}>
            {t('pdf.cancel')}
          </button>
          <button
            type="button"
            disabled={rendering || renderError !== null || exporting}
            onClick={exportPdf}
          >
            {t('pdf.export')}
          </button>
        </footer>
      </section>
    </div>
  );
}
