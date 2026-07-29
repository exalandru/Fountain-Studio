import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * Writes a UTF-8 file through a unique sibling temporary, flushes it, then renames it
 * over the target. Calls targeting the same logical file must still be serialised by
 * their owning service.
 */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const temporary = join(
    parent,
    `.${basename(path)}.${process.pid}.${Date.now().toString(36)}.tmp`,
  );

  const handle = await open(temporary, 'w');
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }

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
