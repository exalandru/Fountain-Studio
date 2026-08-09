/**
 * Bounds for opening user screenplay files into the main process.
 *
 * Individual size aligns with the existing `file:save` / PDF source envelope
 * (~100 MiB). The batch budget keeps a multi-open from allocating that much
 * per file. Path count matches the historical IPC envelope.
 */

/** Maximum bytes for a single screenplay open (`stat.size`, then post-read). */
export const MAX_OPEN_FILE_BYTES = 100 * 1024 * 1024;

/**
 * Maximum aggregate `stat.size` for one multi-open request after per-file checks.
 * Allows several large drafts without permitting 100 × individual max.
 */
export const MAX_OPEN_BATCH_BYTES = 256 * 1024 * 1024;

/** Maximum paths accepted in one open request (dialog, IPC, CLI, OS). */
export const MAX_OPEN_PATHS = 100;

export interface DocumentOpenLimits {
  maxFileBytes: number;
  maxBatchBytes: number;
  maxPaths: number;
}

export const DEFAULT_DOCUMENT_OPEN_LIMITS: DocumentOpenLimits = {
  maxFileBytes: MAX_OPEN_FILE_BYTES,
  maxBatchBytes: MAX_OPEN_BATCH_BYTES,
  maxPaths: MAX_OPEN_PATHS,
};

/** Human-readable size for native error dialogs (binary MiB). */
export function formatOpenByteLimit(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  if (Number.isInteger(mib)) return `${mib} MB`;
  return `${mib.toFixed(1)} MB`;
}
