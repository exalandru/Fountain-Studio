/**
 * Document-path identity for open-tab ownership.
 *
 * Fountain Studio treats an absolute screenplay path as a unique open identity within
 * one instance. Comparison follows the host filesystem: case-insensitive on Windows and
 * macOS, case-sensitive on Linux. Symlink/inode identity is intentionally out of scope.
 */

export type PathPlatform = 'darwin' | 'win32' | 'linux' | string;

/** Best-effort host platform without depending on Node typings in the renderer bundle. */
export function detectPathPlatform(): PathPlatform {
  const runtime = globalThis as typeof globalThis & { process?: { platform?: string } };
  const platform = runtime.process?.platform;
  return typeof platform === 'string' ? platform : 'linux';
}

/** Normalises separators and `.` / `..` segments without resolving against a process cwd. */
export function normalizeDocumentPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return '';

  const windowsDrive = /^[A-Za-z]:/.test(trimmed);
  const windowsUnc = trimmed.startsWith('\\\\') || trimmed.startsWith('//');
  const separator = windowsDrive || windowsUnc || trimmed.includes('\\') ? '\\' : '/';
  const rewritten = trimmed.replace(/[\\/]+/g, separator);
  const isAbsolute =
    rewritten.startsWith('/') ||
    windowsDrive ||
    rewritten.startsWith('\\\\') ||
    rewritten.startsWith('//');

  const parts = rewritten.split(separator);
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') {
      if (part === '' && stack.length === 0 && isAbsolute) stack.push('');
      continue;
    }
    if (part === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '' && stack[stack.length - 1] !== '..') {
        stack.pop();
      } else if (!isAbsolute) {
        stack.push('..');
      }
      continue;
    }
    stack.push(part);
  }

  if (windowsDrive && stack[0] !== undefined) {
    stack[0] = stack[0].toUpperCase();
  }

  let normalized = stack.join(separator);
  if (isAbsolute && separator === '/' && !normalized.startsWith('/')) normalized = `/${normalized}`;
  if (windowsDrive && normalized.endsWith('\\') && /^[A-Za-z]:\\$/.test(normalized) === false) {
    normalized = normalized.replace(/\\+$/, '');
  }
  if (!windowsDrive && normalized.length > 1 && normalized.endsWith(separator)) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

export function comparableDocumentPath(
  path: string,
  platform: PathPlatform = detectPathPlatform(),
): string {
  const normalized = normalizeDocumentPath(path);
  return platform === 'win32' || platform === 'darwin'
    ? normalized.toLocaleLowerCase('en-US')
    : normalized;
}

export function documentPathsEqual(left: string, right: string, platform?: PathPlatform): boolean {
  return comparableDocumentPath(left, platform) === comparableDocumentPath(right, platform);
}

export function findDocumentByPath<T extends { path: string | null }>(
  documents: readonly T[],
  path: string,
  platform?: PathPlatform,
): T | undefined {
  return documents.find(
    (document) => document.path !== null && documentPathsEqual(document.path, path, platform),
  );
}
