import { useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFDocumentLoadingTask, RenderTask } from 'pdfjs-dist';
import PdfJsWorker from 'pdfjs-dist/build/pdf.worker.mjs?worker';
import type { PdfExportOptions } from '@shared/ipc-contract.js';
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
};

interface PdfExportDialogProps {
  source: string;
  suggestedName: string;
  onExported: (path: string) => void;
  onError: (message: string) => void;
  onClose: () => void;
}

/** PDF options with a pdf.js preview of the exact bytes produced by the main process. */
export function PdfExportDialog({
  source,
  suggestedName,
  onExported,
  onError,
  onClose,
}: PdfExportDialogProps) {
  const { t } = useTranslator();
  const dialogRef = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [options, setOptions] = useState<PdfExportOptions>(DEFAULT_OPTIONS);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [previewPage, setPreviewPage] = useState(1);
  const [rendering, setRendering] = useState(true);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => previous?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let loading: PDFDocumentLoadingTask | null = null;
    const timer = setTimeout(() => {
      void (async () => {
        setRendering(true);
        setRenderError(null);
        setPdfDocument(null);
        try {
          const rendered = await window.quantum.invoke('pdf:render', { source, options });
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
  }, [options, source]);

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
        options,
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
