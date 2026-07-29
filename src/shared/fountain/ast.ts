/**
 * Fountain AST types — the single source of truth for EVERY consumer: syntax
 * highlighting, preview, sidebar, statistics, timeline, pagination, PDF export and AI
 * context.
 *
 * Project rule (PLAN.md §3.1): no module re-parses the text differently. If a consumer
 * is missing a piece of information, it gets added here.
 */

export type ElementKind =
  | 'scene_heading'
  | 'action'
  | 'character'
  | 'dialogue'
  | 'parenthetical'
  | 'lyrics'
  | 'transition'
  | 'centered'
  | 'page_break'
  | 'section'
  | 'synopsis'
  | 'note'
  | 'boneyard';

/** A run of an element's text, with Fountain emphasis resolved. */
export interface InlineSpan {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  /** Absolute offset of the text within the source document. */
  from: number;
  to: number;
}

export interface Range {
  from: number;
  to: number;
}

export interface Element {
  /**
   * Deterministic identifier for a given snapshot of the document (`el-12`, `sc-3`).
   * This is the key to the AI ↔ editor mapping (§5.4 of the specification): the ids
   * sent to the model are generated here, which guarantees exact references on return.
   */
  id: string;
  kind: ElementKind;
  /** Absolute offsets in the source document, notes and boneyard included. */
  range: Range;
  /** Zero-based line index of the element's first line. */
  line: number;
  /** Number of document lines the element spans (≥ 1). */
  lineCount: number;
  /** The element's text, syntax markers removed, emphasis unresolved. */
  text: string;
  /** The text split with emphasis resolved — used by the preview and the PDF. */
  inline: InlineSpan[];
  /** True when the element was forced by a control character (`.` `!` `@` `>` `~`). */
  forced: boolean;

  // ── Kind-specific fields ─────────────────────────────────────────────────

  /** `character`: name without extension or `^`, normalised to upper case. */
  character?: string;
  /** `character`: extensions such as `(V.O.)` or `(CONT'D)`. */
  extensions?: string;
  /** `character`: this block is the right column of a dual dialogue (`^`). */
  dual?: boolean;
  /** `dialogue` / `parenthetical`: the character speaking. */
  speaker?: string;
  /** `section`: level 1..6 (number of `#`). */
  depth?: number;
  /** `scene_heading`: scene number declared between `#`, e.g. `1A`. */
  sceneNumber?: string;
}

export type IntExt = 'INT' | 'EXT' | 'EST' | 'INT/EXT';

export interface Scene {
  id: string;
  /** Declared number (`#1A#`) when present, otherwise the 1-based ordinal as a string. */
  number: string;
  /** Declared number only — `undefined` when the screenplay does not number scenes. */
  declaredNumber?: string;
  /** 1-based ordinal position in the document. */
  index: number;
  /** Full heading as displayed, without the scene number. */
  heading: string;
  intExt: IntExt | null;
  /** Location extracted from the heading, without prefix or time of day. */
  location: string;
  /** Time of day extracted from the heading (`DAY`, `NIGHT`…), `null` when absent. */
  timeOfDay: string | null;
  /** The `=` synopsis attached to this scene, if any. */
  synopsis?: string;
  /** Titles of the enclosing sections, outermost first. */
  sectionPath: string[];
  /** The scene's elements, heading included. */
  elements: Element[];
  range: Range;
  line: number;
}

export interface SectionNode {
  id: string;
  depth: number;
  title: string;
  synopsis?: string;
  line: number;
  range: Range;
  children: SectionNode[];
  /** Indexes (into `Screenplay.scenes`) of the scenes directly under this section. */
  sceneIndexes: number[];
}

export interface CharacterInfo {
  name: string;
  /** Number of speeches (dialogue blocks), not of lines. */
  speeches: number;
  /** Number of spoken words. */
  words: number;
  /** Lines of the character cues, for the sidebar's "cycle through occurrences". */
  cueLines: number[];
  /** Indexes of the scenes where the character has at least one speech. */
  sceneIndexes: number[];
}

export interface LocationInfo {
  /** Normalised location (upper case, whitespace collapsed). */
  name: string;
  count: number;
  /** True when the location appears both as INT and as EXT. */
  mixed: boolean;
  intExt: Set<IntExt>;
  lines: number[];
  sceneIndexes: number[];
}

export type DiagnosticSeverity = 'info' | 'warning';

/**
 * What a diagnostic is about.
 *
 * The parser reports a code and its parameters, never a sentence: it runs in a worker
 * and has no idea which language the interface is in. Wording lives in the catalogues
 * under `diagnostic.*`, so the same analysis renders in English or French without
 * being redone.
 */
export type DiagnosticCode = 'unterminatedBoneyard' | 'unterminatedNote' | 'duplicateSceneNumber';

export interface Diagnostic {
  severity: DiagnosticSeverity;
  code: DiagnosticCode;
  /** Values to interpolate into the translated message. */
  params?: Record<string, string | number>;
  line: number;
  range: Range;
}

/** A `[[ ]]` note or a boneyard block, with its exact position. */
export interface Annotation {
  kind: 'note' | 'boneyard';
  /** Content without the delimiters. */
  text: string;
  range: Range;
  line: number;
  /** True when the closing delimiter is missing (the block runs to the end). */
  unterminated: boolean;
}

export interface TitlePage {
  /** Keys normalised to lower case (`title`, `credit`, `author`…) → value lines. */
  fields: Map<string, string[]>;
  range: Range;
  /** Number of lines the title page occupies, 0 when absent. */
  lineCount: number;
}

export interface Screenplay {
  /** The exact source text this AST was produced from. */
  source: string;
  titlePage: TitlePage;
  /** Every element, in document order. */
  elements: Element[];
  scenes: Scene[];
  /** Section tree; roots are the shallowest sections. */
  sections: SectionNode[];
  characters: Map<string, CharacterInfo>;
  locations: Map<string, LocationInfo>;
  /** Notes and boneyard, excluded from rendering but kept for the editor and review. */
  annotations: Annotation[];
  diagnostics: Diagnostic[];
}

/**
 * Times of day recognised in scene headings — used for parsing and autocompletion.
 *
 * These are Fountain *content*, not interface strings, so both English and French terms
 * are listed unconditionally: a French author writes `JOUR` inside an English
 * interface, and the statistics must still classify the scene correctly.
 */
export const TIMES_OF_DAY = [
  'JOUR',
  'NUIT',
  'AUBE',
  'CRÉPUSCULE',
  'CREPUSCULE',
  'MATIN',
  'SOIR',
  'APRÈS-MIDI',
  'APRES-MIDI',
  'PLUS TARD',
  'CONTINU',
  'DAY',
  'NIGHT',
  'DAWN',
  'DUSK',
  'MORNING',
  'EVENING',
  'AFTERNOON',
  'LATER',
  'CONTINUOUS',
  'MOMENTS LATER',
  'SAME TIME',
] as const;

/**
 * Recognised title-page keys — used for parsing and autocompletion.
 *
 * Fountain syntax, therefore never translated: a French screenplay still writes
 * `Title:` and `Author:`.
 */
export const TITLE_PAGE_KEYS = [
  'title',
  'credit',
  'author',
  'authors',
  'source',
  'notes',
  'draft date',
  'date',
  'contact',
  'copyright',
  'revision',
] as const;
