import { readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import { parseCrashRecovery } from '@shared/documents/index.js';
import type { CrashRecovery, Eol } from '@shared/ipc-contract.js';
import { writeFileAtomic } from './atomic.js';

/**
 * Backup autosave, for crash recovery (§4.9).
 *
 * Distinct from saving: it never writes into the author's own file. Each open tab drops
 * a snapshot under userData/autosave/. The snapshot is deleted as soon as the document
 * is really saved or cleanly closed, so anything still there at startup is the trace of
 * an abrupt shutdown.
 */

interface AutosaveRecord {
  path: string | null;
  content: string;
  eol: Eol;
  mtimeMs: number | null;
  savedAt: number;
}

function directory(): string {
  return join(app.getPath('userData'), 'autosave');
}

const pendingById = new Map<string, Promise<void>>();

function serialise(id: string, operation: () => Promise<void>): Promise<void> {
  const previous = pendingById.get(id) ?? Promise.resolve();
  const current = previous.then(operation, operation);
  pendingById.set(id, current);
  const cleanup = () => {
    if (pendingById.get(id) === current) pendingById.delete(id);
  };
  void current.then(cleanup, cleanup);
  return current;
}

/** A tab id must not be able to escape the autosave directory. */
function safeName(id: string): string {
  return `${id.replace(/[^a-zA-Z0-9_-]/g, '')}.json`;
}

export async function writeAutosave(
  id: string,
  path: string | null,
  content: string,
  eol: Eol,
  mtimeMs: number | null,
): Promise<void> {
  return serialise(id, async () => {
    const dir = directory();
    const record: AutosaveRecord = { path, content, eol, mtimeMs, savedAt: Date.now() };
    const target = join(dir, safeName(id));
    await writeFileAtomic(target, JSON.stringify(record));
  });
}

export async function clearAutosave(id: string): Promise<void> {
  return serialise(id, async () => {
    await unlink(join(directory(), safeName(id))).catch(() => undefined);
  });
}

/** Snapshots left behind by a previous session that did not end normally. */
export async function pendingAutosaves(): Promise<CrashRecovery[]> {
  const dir = directory();

  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const out: CrashRecovery[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = await readFile(join(dir, name), 'utf8');
      const record = parseCrashRecovery(raw);
      if (!record) continue;
      out.push({ id: name.slice(0, -'.json'.length), ...record });
    } catch {
      // Unreadable snapshot: skip it rather than block startup.
    }
  }

  return out.sort((a, b) => b.savedAt - a.savedAt);
}
