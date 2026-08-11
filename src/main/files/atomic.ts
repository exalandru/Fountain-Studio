import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * Writes a UTF-8 file through a unique sibling temporary, flushes it, then renames it
 * over the target. Calls targeting the same logical file must still be serialised by
 * their owning service.
 */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const temporary = await writeSiblingTemporary(path, data);
  await commitSiblingTemporary(temporary, path);
}

/**
 * Prepares the atomic write without publishing it: the caller may run its final
 * conflict verification between this and {@link commitSiblingTemporary}, so the gap
 * between the last disk observation and the rename stays as small as possible.
 */
export async function writeSiblingTemporary(
  path: string,
  data: string | Uint8Array,
): Promise<string> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const temporary = join(
    parent,
    `.${basename(path)}.${process.pid}.${Date.now().toString(36)}.tmp`,
  );

  const handle = await open(temporary, 'w');
  try {
    try {
      if (typeof data === 'string') await handle.writeFile(data, 'utf8');
      else await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    // The caller does not know the temporary's name yet, so the failed attempt
    // must not leave an orphan `.tmp` behind (only best-effort: close errors on
    // a full disk make even the unlink fail).
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return temporary;
}

/** Publishes a temporary written by {@link writeSiblingTemporary}. The rename is atomic. */
export async function commitSiblingTemporary(temporary: string, path: string): Promise<void> {
  const parent = dirname(path);

  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }

  // Persisting the directory entry closes the last durability gap on Unix. Directory
  // handles are not supported uniformly (notably on Windows), so this remains best
  // effort after the atomic rename has already succeeded.
  try {
    const directory = await open(parent, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    // The target file is already complete and atomically visible.
  }
}
