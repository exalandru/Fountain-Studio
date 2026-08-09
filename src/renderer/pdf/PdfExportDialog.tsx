import { useEffect, useMemo, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFDocumentLoadingTask, RenderTask } from 'pdfjs-dist';
import PdfJsWorker from 'pdfjs-dist/build/pdf.worker.mjs?worker';
import type { PdfExportOptions, PdfRevisionOptions } from '@shared/ipc-contract.js';
import type { RevisionState } from '@shared/appdata/index.js';
import { isPdfBaselineErrorMessage } from '@shared/pdf/index.js';
import { REVISION_PAPER } from '@shared/revision/index.js';
import {
  beginDocumentOperation,
  type DocumentOperationContext,
  validateDocumentOperation,
} from '@shared/documents/operations.js';
import { useTranslator } from '../hooks/useTranslator.js';
import { useDocuments } from '../store/documents.js';
import { Button } from '../ui/Button.js';
import { Checkbox } from '../ui/Checkbox.js';
import { Dialog } from '../ui/Dialog.js';
import { Field } from '../ui/Field.js';
import { Select } from '../ui/Select.js';
import { TextInput } from '../ui/TextInput.js';

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
  documentId: string;
  documentRevision: number;
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

type BaselineState =
  | { status: 'not-required' }
  | { status: 'loading'; snapshotId: string; operation: DocumentOperationContext | null }
  | {
      status: 'ready';
      snapshotId: string;
      operation: DocumentOperationContext;
      content: string;
    }
  | { status: 'error'; snapshotId: string; reason: 'unavailable' | 'invalid' };

/** PDF options with a pdf.js preview of the exact bytes produced by the main process. */
export function PdfExportDialog({
  documentId,
  documentRevision,
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
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const latestBaselineRequest = useRef<string | null>(null);
  const previewGeneration = useRef(0);
  const exportingRef = useRef(false);
  const [options, setOptions] = useState<PdfExportOptions>(DEFAULT_OPTIONS);
  const [pdfDocument, setPdfDocument] = useState<{
    value: PDFDocumentProxy;
    signature: string;
  } | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [previewPage, setPreviewPage] = useState(1);
  const [rendering, setRendering] = useState(true);
  const [renderError, setRenderError] = useState<{
    signature: string;
    message: string;
  } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [previewReadySignature, setPreviewReadySignature] = useState<string | null>(null);
  const [choices, setChoices] = useState<RevisionChoices>(DEFAULT_REVISION);
  const [date, setDate] = useState(issueDate);
  const requiredSnapshotId = revision?.snapshotId ?? null;
  const baselineRequired = requiredSnapshotId !== null;
  const [baseline, setBaseline] = useState<BaselineState>(() =>
    requiredSnapshotId === null
      ? { status: 'not-required' }
      : { status: 'loading', snapshotId: requiredSnapshotId, operation: null },
  );
  const baselineStatus = useMemo<BaselineState>(() => {
    if (requiredSnapshotId === null) return { status: 'not-required' };
    if (path === null) {
      return { status: 'error', snapshotId: requiredSnapshotId, reason: 'unavailable' };
    }
    const current =
      baseline.status === 'ready' &&
      baseline.snapshotId === requiredSnapshotId &&
      baseline.operation.documentId === documentId &&
      baseline.operation.documentRevision === documentRevision &&
      baseline.operation.documentPath === path;
    if (current || (baseline.status === 'error' && baseline.snapshotId === requiredSnapshotId)) {
      return baseline;
    }
    return { status: 'loading', snapshotId: requiredSnapshotId, operation: null };
  }, [baseline, documentId, documentRevision, path, requiredSnapshotId]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => previous?.focus();
  }, []);

  useEffect(() => {
    if (requiredSnapshotId === null) {
      latestBaselineRequest.current = null;
      return;
    }
    if (path === null) {
      latestBaselineRequest.current = null;
      return;
    }
    const operation = beginDocumentOperation(
      { id: documentId, revision: documentRevision, path },
      'pdf-baseline',
    );
    latestBaselineRequest.current = operation.requestId;
    void window.quantum
      .invoke('snapshot:read', { path, id: requiredSnapshotId })
      .then((content) => {
        const status = validateDocumentOperation(
          useDocuments.getState().documents,
          operation,
          latestBaselineRequest.current ?? '',
        );
        if (status !== 'current') return;
        setBaseline({ status: 'ready', snapshotId: requiredSnapshotId, operation, content });
      })
      .catch(() => {
        if (latestBaselineRequest.current !== operation.requestId) return;
        setBaseline({ status: 'error', snapshotId: requiredSnapshotId, reason: 'unavailable' });
      });
    return () => {
      if (latestBaselineRequest.current === operation.requestId) {
        latestBaselineRequest.current = null;
      }
    };
  }, [documentId, documentRevision, path, requiredSnapshotId]);

  /**
   * The options actually sent to the renderer.
   *
   * The header is composed here because only this side knows the locale, and upper case because
   * that is how a production reads it off the top of a page.
   */
  const effective = useMemo<PdfExportOptions | null>(() => {
    if (!baselineRequired) return { ...options, revision: null };
    if (revision === null || path === null || baselineStatus.status !== 'ready') {
      return null;
    }
    const colourName = t(`revision.colour.${revision.colour}`);
    const shown = date.length > 0 ? new Date(date).toLocaleDateString(locale) : '';
    return {
      ...options,
      revision: {
        baseline: {
          path,
          snapshotId: baselineStatus.snapshotId,
          source: baselineStatus.content,
        },
        header: t('revision.pdfHeader', { colour: colourName, date: shown }).toLocaleUpperCase(
          locale,
        ),
        colour: revision.colour,
        ...choices,
      },
    };
  }, [baselineStatus, baselineRequired, choices, date, locale, options, path, revision, t]);

  const previewSignature = useMemo(
    () => (effective === null ? null : JSON.stringify({ source, options: effective })),
    [effective, source],
  );
  const currentRenderError =
    renderError?.signature === previewSignature ? renderError.message : null;

  useEffect(() => {
    const generation = ++previewGeneration.current;
    let cancelled = false;
    let loading: PDFDocumentLoadingTask | null = null;
    if (effective === null || previewSignature === null) {
      return;
    }
    const timer = setTimeout(() => {
      void (async () => {
        setPdfDocument(null);
        setPageCount(0);
        setPreviewReadySignature(null);
        setRenderError(null);
        setRendering(true);
        try {
          const rendered = await window.quantum.invoke('pdf:render', {
            source,
            options: effective,
          });
          if (cancelled || previewGeneration.current !== generation) return;
          loading = getDocument({ data: new Uint8Array(rendered.bytes) });
          const pdf = await loading.promise;
          if (cancelled || previewGeneration.current !== generation) {
            await loading.destroy();
            return;
          }
          setPageCount(pdf.numPages);
          setPreviewPage((current) => Math.min(Math.max(1, current), pdf.numPages));
          setPdfDocument({ value: pdf, signature: previewSignature });
        } catch (error) {
          if (!cancelled && previewGeneration.current === generation) {
            if (isPdfBaselineErrorMessage(error) && requiredSnapshotId !== null) {
              setBaseline({
                status: 'error',
                snapshotId: requiredSnapshotId,
                reason: 'invalid',
              });
            } else {
              setRenderError({
                signature: previewSignature,
                message: error instanceof Error ? error.message : String(error),
              });
            }
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
  }, [effective, previewSignature, requiredSnapshotId, source]);

  useEffect(() => {
    if (!pdfDocument) return;
    let cancelled = false;
    let renderTask: RenderTask | null = null;
    let completed = false;

    void (async () => {
      setRendering(true);
      setPreviewReadySignature(null);
      try {
        const page = await pdfDocument.value.getPage(previewPage);
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
        completed = true;
      } catch (error) {
        if (!cancelled) {
          setRenderError({
            signature: pdfDocument.signature,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        if (!cancelled) {
          setRendering(false);
          if (completed) setPreviewReadySignature(pdfDocument.signature);
        }
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
    if (
      effective === null ||
      previewSignature === null ||
      previewReadySignature !== previewSignature ||
      exportingRef.current
    ) {
      return;
    }
    exportingRef.current = true;
    setExporting(true);
    try {
      const outcome = await window.quantum.invoke('pdf:export', {
        source,
        options: effective,
        suggestedName,
      });
      if (outcome.status === 'exported') onExported(outcome.path);
      else if (outcome.status === 'error') {
        if (isPdfBaselineErrorMessage(outcome.message) && requiredSnapshotId !== null) {
          setBaseline({ status: 'error', snapshotId: requiredSnapshotId, reason: 'invalid' });
        } else {
          onError(outcome.message);
        }
      }
    } finally {
      exportingRef.current = false;
      setExporting(false);
    }
  };

  return (
    <Dialog
      className="pdf-dialog"
      title={t('pdf.title')}
      closeLabel={t('pdf.close')}
      data-page-count={pageCount}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('pdf.cancel')}</Button>
          <Button
            variant="primary"
            disabled={
              effective === null ||
              previewSignature === null ||
              previewReadySignature !== previewSignature ||
              rendering ||
              currentRenderError !== null ||
              exporting
            }
            onClick={() => void exportPdf()}
          >
            {t('pdf.export')}
          </Button>
        </>
      }
    >
      <div className="pdf-dialog-body">
        <form className="pdf-options" onSubmit={(event) => event.preventDefault()}>
          <Field label={t('pdf.format')}>
            <Select
              value={options.format}
              onChange={(event) => patch('format', event.target.value as 'letter' | 'a4')}
            >
              <option value="letter">Letter</option>
              <option value="a4">A4</option>
            </Select>
          </Field>
          <Field label={t('pdf.sceneNumbers')}>
            <Select
              value={options.sceneNumbers}
              onChange={(event) =>
                patch('sceneNumbers', event.target.value as PdfExportOptions['sceneNumbers'])
              }
            >
              <option value="none">{t('pdf.sceneNumbers.none')}</option>
              <option value="left">{t('pdf.sceneNumbers.left')}</option>
              <option value="right">{t('pdf.sceneNumbers.right')}</option>
              <option value="both">{t('pdf.sceneNumbers.both')}</option>
            </Select>
          </Field>
          <Checkbox
            className="pdf-check"
            label={t('pdf.includeNotes')}
            checked={options.includeNotes}
            onChange={(checked) => patch('includeNotes', checked)}
          />
          <Checkbox
            className="pdf-check"
            label={t('pdf.includeSynopses')}
            checked={options.includeSynopses}
            onChange={(checked) => patch('includeSynopses', checked)}
          />
          <Checkbox
            className="pdf-check"
            label={t('pdf.headingsBold')}
            checked={options.headingsBold}
            onChange={(checked) => patch('headingsBold', checked)}
          />
          <Field label={t('pdf.watermark')}>
            <TextInput
              type="text"
              maxLength={200}
              value={options.watermark}
              onChange={(event) => patch('watermark', event.target.value)}
            />
          </Field>
          {baselineRequired && revision !== null ? (
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
              <Field label={t('pdf.revisionColourMode')}>
                <Select
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
                </Select>
              </Field>
              <Field label={t('pdf.revisionDate')}>
                <TextInput
                  type="date"
                  value={date}
                  onChange={(event) => setDate(event.target.value)}
                />
              </Field>
              <Checkbox
                className="pdf-check"
                label={t('pdf.revisionMarks')}
                checked={choices.marks}
                onChange={(checked) => setChoices((current) => ({ ...current, marks: checked }))}
              />
              <Checkbox
                className="pdf-check"
                label={t('pdf.revisionLockedPages')}
                checked={choices.lockedPages}
                onChange={(checked) =>
                  setChoices((current) => ({ ...current, lockedPages: checked }))
                }
              />
              <Checkbox
                className="pdf-check"
                label={t('pdf.revisionOnlyRevised')}
                checked={choices.onlyRevisedPages}
                onChange={(checked) =>
                  setChoices((current) => ({
                    ...current,
                    onlyRevisedPages: checked,
                  }))
                }
              />
              <p className="pdf-revision-note">{t('pdf.revisionNote')}</p>
            </fieldset>
          ) : null}
          <div className="pdf-range">
            <Field label={t('pdf.pageFrom')}>
              <TextInput
                type="number"
                min={1}
                value={options.pageFrom ?? ''}
                onChange={(event) =>
                  patch('pageFrom', event.target.value ? Number(event.target.value) : null)
                }
              />
            </Field>
            <Field label={t('pdf.pageTo')}>
              <TextInput
                type="number"
                min={1}
                value={options.pageTo ?? ''}
                onChange={(event) =>
                  patch('pageTo', event.target.value ? Number(event.target.value) : null)
                }
              />
            </Field>
          </div>
        </form>
        <div className="pdf-preview" aria-label={t('pdf.preview')}>
          {baselineStatus.status === 'loading' ? (
            <div className="panel-placeholder">{t('pdf.baselineLoading')}</div>
          ) : null}
          {baselineStatus.status === 'error' ? (
            <div className="panel-placeholder" role="alert">
              {t('pdf.baselineUnavailable')}
            </div>
          ) : null}
          {baselineStatus.status !== 'loading' &&
          baselineStatus.status !== 'error' &&
          (rendering ||
            (previewSignature !== null && previewReadySignature !== previewSignature)) ? (
            <div className="panel-placeholder">{t('pdf.rendering')}</div>
          ) : null}
          {baselineStatus.status !== 'error' && currentRenderError ? (
            <div className="panel-placeholder">
              {t('pdf.renderFailed')}
              <br />
              {currentRenderError}
            </div>
          ) : null}
          <canvas
            ref={canvasRef}
            hidden={previewSignature === null || previewReadySignature !== previewSignature}
          />
          {!currentRenderError &&
          previewSignature !== null &&
          previewReadySignature === previewSignature &&
          pageCount > 0 ? (
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
    </Dialog>
  );
}
