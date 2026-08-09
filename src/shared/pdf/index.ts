export const PDF_BASELINE_ERROR = {
  unavailable: 'PDF_REVISION_BASELINE_UNAVAILABLE',
  corrupt: 'PDF_REVISION_BASELINE_CORRUPT',
  changed: 'PDF_REVISION_BASELINE_CHANGED',
  invalid: 'PDF_REVISION_BASELINE_INVALID',
} as const;

export type PdfBaselineErrorCode = (typeof PDF_BASELINE_ERROR)[keyof typeof PDF_BASELINE_ERROR];

export function isPdfBaselineErrorMessage(value: unknown): boolean {
  const message = value instanceof Error ? value.message : String(value);
  return Object.values(PDF_BASELINE_ERROR).some((code) => message.includes(code));
}
