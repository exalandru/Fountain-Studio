/**
 * Script bible — a set of sidecar sheets, one per character, location, object or concept.
 *
 * Each sheet carries two kinds of fields: factual data computed from the screenplay AST
 * (never persisted), and prose fields written by the author or drafted by the AI (always
 * persisted). A sheet survives being renamed because it is keyed by a stable `bib-<uuid>`
 * identifier rather than by name.
 *
 * ```
 * films/
 * ├─ script.fountain
 * └─ script.fountain.bible.json
 * ```
 *
 * Pure TypeScript (PLAN_BIBLE.md §3.1): no `electron`, no `node:*`, no DOM. Both IPC sides
 * and the unit tests share this validation.
 */

import { foldDiacritics } from '../text/index.js';

export const BIBLE_VERSION = 1;

/** More sheets than any production needs, and a hard stop on a corrupt file. */
export const MAX_ENTRIES = 500;
export const MAX_NAME_LENGTH = 120;
/** More names than one sheet could plausibly cover, and a stop on a corrupt file. */
export const MAX_ALIASES = 50;
export const MAX_FIELD_LENGTH = 4_000;

export type BibleEntryKind = 'character' | 'location' | 'object' | 'concept';

export const BIBLE_ENTRY_KINDS: readonly BibleEntryKind[] = [
  'character',
  'location',
  'object',
  'concept',
];

/**
 * The prose fields each kind of sheet offers.
 *
 * A fixed set per kind rather than free-form fields: the interface stays stable, the
 * translations exist, and an author is prompted with the questions worth answering instead
 * of an empty box.
 */
/**
 * Every prose field the bible knows about.
 *
 * A literal union rather than `string`: the interface builds its label key as
 * `bible.field.<id>`, and the translator only accepts keys that exist. A field added here
 * without its translation is therefore a compile error, not a blank label at runtime.
 */
export type BibleFieldId =
  | 'role'
  | 'wants'
  | 'fears'
  | 'arc'
  | 'voice'
  | 'background'
  | 'atmosphere'
  | 'meaning'
  | 'history'
  | 'significance'
  | 'definition'
  | 'rules';

export const BIBLE_FIELDS: Readonly<Record<BibleEntryKind, readonly BibleFieldId[]>> = {
  character: ['role', 'wants', 'fears', 'arc', 'voice', 'background'],
  location: ['atmosphere', 'meaning', 'history'],
  object: ['significance', 'history'],
  concept: ['definition', 'rules'],
};

/**
 * A single sheet in the bible.
 *
 * The `id` is stable (`bib-<uuid>`) so a sheet survives a character or location being
 * renamed. The `name` is what ties the sheet to the screenplay text; reconciliation matches
 * it against the AST, and an orphaned name does not silently delete the prose the author
 * has written.
 *
 * Prose fields are keyed by the field ids in `BIBLE_FIELDS[kind]`. Factual data (scene
 * count, speech count, word count, first/last appearance) is never stored here: it is
 * recomputed from the AST every time the panel renders.
 */
export interface BibleEntry {
  id: string;
  kind: BibleEntryKind;
  /** For a character or a location, the name as it appears in the screenplay. */
  name: string;
  /**
   * Other names in the screenplay this sheet also covers.
   *
   * A location's sub-locations (`MÉGALOPOLE - REMPARTS` under `MÉGALOPOLE`), or a character
   * deliberately introduced under another name — "LA FILLE" for the first act, so the reveal
   * lands. The facts, the AI context and the reconciliation all read the aliases, so one
   * sheet accounts for every name it covers.
   */
  aliases: string[];
  /**
   * File name of the sheet's picture inside the images sidecar, or `null`.
   *
   * Only ever a name derived from `id`, never anything the author typed: that is what keeps a
   * sheet name out of a filesystem path.
   */
  image: string | null;
  /** Prose only, keyed by the field ids in `BIBLE_FIELDS`. Never holds computed facts. */
  fields: Record<string, string>;
  /** When the AI last drafted into this sheet, so the author can see what is theirs. */
  draftedAt: number | null;
  updatedAt: number;
}

export interface Bible {
  version: number;
  entries: BibleEntry[];
}

/** Validation guard for `BibleEntryKind`. Used both at the type level and runtime. */
export function isBibleEntryKind(value: unknown): value is BibleEntryKind {
  return typeof value === 'string' && BIBLE_ENTRY_KINDS.includes(value as BibleEntryKind);
}

/**
 * A stable identifier that survives across renames.
 *
 * The `bib-` prefix signals the sheet's origin, and the pattern guards against typos in
 * the ID field itself — a name changed by hand still produces a valid string, but an ID
 * coming from a corrupt sidecar must not slip through.
 */
export function isBibleId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
}

/** Create a fresh, empty bible with the current version. */
/** The picture file a sheet's id maps to. WebP because that is all the renderer writes. */
export function bibleImageName(id: string): string {
  return `${id}.webp`;
}

export function createBible(): Bible {
  return { version: BIBLE_VERSION, entries: [] };
}

/**
 * Sanitises a sheet name for display and comparison.
 *
 * A name is free text typed into a dialog or computed from the screenplay; it must not
 * drift across normalisation. Whitespace is collapsed to single spaces, leading/trailing
 * whitespace is stripped, and the result is bounded to `MAX_NAME_LENGTH`. An empty result
 * signals that the entry should be dropped during parsing.
 */
export function sanitizeBibleName(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.slice(0, MAX_NAME_LENGTH);
}

/**
 * Sanitises a field value for storage.
 *
 * A prose field is an author's free text or an AI draft. Newlines are kept because a
 * character description can span several lines, but the total length is bounded to
 * `MAX_FIELD_LENGTH` so a single field cannot flood the sidecar.
 */
export function sanitizeBibleField(value: string): string {
  return value.slice(0, MAX_FIELD_LENGTH);
}

/** Return the prose fields available for a given sheet kind. */
export function bibleFieldsFor(kind: BibleEntryKind): readonly BibleFieldId[] {
  return BIBLE_FIELDS[kind];
}

/**
 * Reads a bible JSON string, discarding anything malformed.
 *
 * A corrupt sidecar must cost the author nothing but the sheets that were actually
 * unreadable. The worst outcome is an empty bible beside intact prose the author can
 * recover by editing the file directly. Hence the tolerant parse rather than a throw.
 */
export function parseBible(raw: string): Bible {
  const empty: Bible = { version: BIBLE_VERSION, entries: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }

  if (typeof parsed !== 'object' || parsed === null) return empty;

  const root = parsed as Record<string, unknown>;
  if (root['version'] !== BIBLE_VERSION) return empty;
  if (!Array.isArray(root['entries'])) return empty;

  const seenIds = new Set<string>();
  const entries: BibleEntry[] = [];

  for (const candidate of root['entries'].slice(0, MAX_ENTRIES)) {
    if (typeof candidate !== 'object' || candidate === null) continue;

    const entry = candidate as Record<string, unknown>;
    const id = entry['id'];
    if (!isBibleId(id)) continue;
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    const kind = entry['kind'] as BibleEntryKind;
    if (!isBibleEntryKind(kind)) continue;

    if (typeof entry['name'] !== 'string') continue;
    const name = sanitizeBibleName(entry['name']);
    if (name.length === 0) continue;

    const rawFields = entry['fields'] as Record<string, unknown>;
    const fields: Record<string, string> = {};
    const allowedFields = bibleFieldsFor(kind);
    if (typeof rawFields === 'object' && rawFields !== null) {
      for (const key of allowedFields) {
        const value = rawFields[key];
        if (typeof value === 'string') {
          fields[key] = sanitizeBibleField(value);
        }
      }
    }

    // Folded de-duplication, and never the sheet's own name: an alias equal to the name would
    // make the sheet claim itself and count its scenes twice.
    const aliases: string[] = [];
    const claimed = new Set([foldDiacritics(name)]);
    if (Array.isArray(entry['aliases'])) {
      for (const candidate of entry['aliases'].slice(0, MAX_ALIASES)) {
        if (typeof candidate !== 'string') continue;
        const alias = sanitizeBibleName(candidate);
        if (alias.length === 0) continue;
        const folded = foldDiacritics(alias);
        if (claimed.has(folded)) continue;
        claimed.add(folded);
        aliases.push(alias);
      }
    }

    // The picture is named after the id, so a stored name that does not match is a corrupt
    // file pointing somewhere else.
    const image = entry['image'] === bibleImageName(id) ? bibleImageName(id) : null;

    const draftedAt =
      typeof entry['draftedAt'] === 'number' && Number.isFinite(entry['draftedAt'])
        ? entry['draftedAt']
        : null;
    const updatedAt =
      typeof entry['updatedAt'] === 'number' && Number.isFinite(entry['updatedAt'])
        ? entry['updatedAt']
        : 0;

    entries.push({ id, kind, name, aliases, image, fields, draftedAt, updatedAt });
  }

  return { version: BIBLE_VERSION, entries };
}

/** Serialize a bible to JSON with standard indentation. */
export function serializeBible(bible: Bible): string {
  return `${JSON.stringify(bible, null, 2)}\n`;
}

/**
 * Matches sheets against the screenplay by name.
 *
 * Only `character` and `location` sheets are matched: an object or a concept is the
 * author's own invention and has no counterpart in the AST to match against, so it is
 * always attached. Comparison is case-insensitive and accent-sensitive — "ALICE" and
 * "Alice" are one person, "RENE" and "RENÉ" are not necessarily.
 *
 * A sheet whose name no longer matches anything is shown as *orphaned*, never deleted
 * automatically: the author is offered explicit choices (keep, re-attach, or delete).
 */
export interface BibleReconciliation {
  /** Entries whose name still matches something in the screenplay. */
  attached: BibleEntry[];
  /**
   * Entries whose name matches nothing any more — a renamed or cut character. Never deleted
   * automatically: the author is asked.
   */
  orphaned: BibleEntry[];
  /** Names present in the screenplay that have no sheet yet, so the panel can offer them. */
  unseeded: Array<{ kind: BibleEntryKind; name: string }>;
}

export function reconcileBible(
  entries: readonly BibleEntry[],
  screenplay: { characters: readonly string[]; locations: readonly string[] },
): BibleReconciliation {
  const attached: BibleEntry[] = [];
  const orphaned: BibleEntry[] = [];
  const unseeded: Array<{ kind: BibleEntryKind; name: string }> = [];

  // Keyed by kind *and* name: a screenplay may hold a character and a location that share a
  // name, and one must not vouch for the other's sheet. The key carries the original
  // spelling alongside the folded one so a name can be offered back as the author wrote it.
  const known = new Map<string, string>();
  const remember = (kind: BibleEntryKind, name: string) => {
    const key = `${kind}|${name.toLocaleUpperCase()}`;
    if (!known.has(key)) known.set(key, name);
  };
  for (const name of screenplay.characters) remember('character', name);
  for (const name of screenplay.locations) remember('location', name);

  // Every name a sheet covers, so a regrouped sub-location is neither orphaned nor offered
  // again by the composer.
  const covered = (entry: BibleEntry): string[] =>
    [entry.name, ...entry.aliases].map((name) => `${entry.kind}|${name.toLocaleUpperCase()}`);

  const sheets = new Set<string>();
  for (const entry of entries) for (const key of covered(entry)) sheets.add(key);

  for (const entry of entries) {
    // An object or a notion is the author's own invention: there is nothing in the AST it
    // could be matched against, so it is never orphaned.
    if (entry.kind === 'object' || entry.kind === 'concept') {
      attached.push(entry);
      continue;
    }
    if (covered(entry).some((key) => known.has(key))) attached.push(entry);
    else orphaned.push(entry);
  }

  for (const [key, name] of known) {
    if (sheets.has(key)) continue;
    // The key's prefix is the kind, and it was built here, so it is one of the two.
    const kind: BibleEntryKind = key.startsWith('character|') ? 'character' : 'location';
    unseeded.push({ kind, name });
  }

  return { attached, orphaned, unseeded };
}
