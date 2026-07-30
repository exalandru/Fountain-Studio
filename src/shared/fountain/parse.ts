import type {
  CharacterInfo,
  Diagnostic,
  Element,
  ElementKind,
  IntExt,
  LocationInfo,
  Scene,
  Screenplay,
  SectionNode,
  TitlePage,
} from './ast.js';
import { TIMES_OF_DAY } from './ast.js';
import { parseInline, stripEmphasis } from './inline.js';
import type { LexedLine } from './lexer.js';
import { lexDocument } from './lexer.js';
import { maskAnnotations } from './mask.js';

/**
 * Produces the full AST from the source text.
 *
 * This is the only sanctioned entry point for a screenplay's structure (PLAN.md §3.1).
 * Highlighting, preview, sidebar, timeline, statistics, pagination, PDF export and AI
 * context all consume this result.
 */
export function parse(source: string): Screenplay {
  const { masked, annotations } = maskAnnotations(source);
  const lines = lexDocument(masked);
  const diagnostics: Diagnostic[] = [];

  for (const annotation of annotations) {
    if (annotation.unterminated) {
      diagnostics.push({
        severity: 'warning',
        code: annotation.kind === 'boneyard' ? 'unterminatedBoneyard' : 'unterminatedNote',
        line: annotation.line,
        range: annotation.range,
      });
    }
  }

  const titlePage = collectTitlePage(lines);
  const elements = buildElements(lines, source);

  const { scenes, sections } = buildStructure(elements, source, diagnostics);
  const characters = indexCharacters(elements, scenes);
  const locations = indexLocations(scenes);

  return {
    source,
    titlePage,
    elements,
    scenes,
    sections,
    characters,
    locations,
    annotations,
    diagnostics,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Title page
// ─────────────────────────────────────────────────────────────────────────────

function collectTitlePage(lines: LexedLine[]): TitlePage {
  const fields = new Map<string, string[]>();
  let lastKey: string | null = null;
  let lineCount = 0;
  let to = 0;

  for (const line of lines) {
    if (line.kind === 'title_page_key') {
      lastKey = line.key ?? '';
      const values = line.text.length > 0 ? [line.text] : [];
      fields.set(lastKey, values);
      lineCount = line.line + 1;
      to = line.to;
      continue;
    }
    if (line.kind === 'title_page_value' && lastKey !== null) {
      fields.get(lastKey)?.push(line.text);
      lineCount = line.line + 1;
      to = line.to;
      continue;
    }
    if (line.kind === 'empty' && lastKey !== null) continue;
    break;
  }

  return {
    fields,
    range: { from: 0, to: fields.size > 0 ? to : 0 },
    lineCount: fields.size > 0 ? lineCount : 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Elements
// ─────────────────────────────────────────────────────────────────────────────

/** Kinds whose consecutive lines form a single element (one paragraph). */
const MERGEABLE = new Set<ElementKind>(['action', 'dialogue', 'lyrics']);

function buildElements(lines: LexedLine[], source: string): Element[] {
  const elements: Element[] = [];
  let currentSpeaker: string | undefined;
  const signatureOccurrences = new Map<string, number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    if (
      line.kind === 'empty' ||
      line.kind === 'title_page_key' ||
      line.kind === 'title_page_value'
    ) {
      if (line.kind === 'empty') currentSpeaker = undefined;
      continue;
    }

    const kind = line.kind;
    const group: LexedLine[] = [line];

    // Merge following lines of the same kind into a single element.
    if (MERGEABLE.has(kind)) {
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        if (!next || next.kind !== kind) break;
        group.push(next);
        i++;
      }
    }

    const first = group[0];
    const last = group[group.length - 1];
    if (!first || !last) continue;

    const text = group.map((l) => l.text).join('\n');
    const signature = `${kind}\u0000${text}\u0000${first.forced ? 'forced' : ''}`;
    const occurrence = signatureOccurrences.get(signature) ?? 0;
    signatureOccurrences.set(signature, occurrence + 1);
    const element: Element = {
      id: stableId('el', signature, occurrence),
      kind,
      range: { from: first.from, to: last.to },
      line: first.line,
      lineCount: last.line - first.line + 1,
      text,
      inline: inlineForGroup(group, source),
      forced: first.forced,
    };

    if (kind === 'character') {
      element.character = first.character;
      element.extensions = first.extensions;
      element.dual = first.dual ?? false;
      currentSpeaker = first.character;
    } else if (kind === 'dialogue' || kind === 'parenthetical') {
      element.speaker = currentSpeaker;
    } else if (kind === 'section') {
      element.depth = first.depth ?? 1;
      currentSpeaker = undefined;
    } else if (kind === 'scene_heading') {
      if (first.sceneNumber !== undefined) element.sceneNumber = first.sceneNumber;
      currentSpeaker = undefined;
    } else {
      currentSpeaker = undefined;
    }

    elements.push(element);
  }

  return elements;
}

/** Small deterministic FNV-1a identifier, stable when unrelated blocks are inserted. */
function stableId(prefix: string, signature: string, occurrence: number): string {
  let hash = 0x811c9dc5;
  const input = `${signature}\u0000${occurrence}`;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${prefix}-${(hash >>> 0).toString(36)}`;
}

/**
 * Computes emphasis spans line by line, each with its absolute offset.
 *
 * A block's merged text cannot be parsed in one go: removed markers and trimmed
 * whitespace would shift every subsequent position.
 */
function inlineForGroup(group: LexedLine[], source: string): Element['inline'] {
  const spans: Element['inline'] = [];

  for (let index = 0; index < group.length; index++) {
    const line = group[index];
    if (!line) continue;
    if (index > 0) {
      const previous = group[index - 1];
      if (previous) {
        spans.push({
          text: '\n',
          bold: false,
          italic: false,
          underline: false,
          from: previous.to,
          to: previous.to + 1,
        });
      }
    }
    const raw = source.slice(line.from, line.to);
    const at = raw.indexOf(line.text);
    const offset = at === -1 ? line.from : line.from + at;
    spans.push(...parseInline(line.text, offset));
  }

  return spans;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenes and sections
// ─────────────────────────────────────────────────────────────────────────────

function buildStructure(
  elements: Element[],
  source: string,
  diagnostics: Diagnostic[],
): { scenes: Scene[]; sections: SectionNode[] } {
  const scenes: Scene[] = [];
  const roots: SectionNode[] = [];
  /** Stack of open sections, ordered by increasing depth. */
  const stack: SectionNode[] = [];
  const seenNumbers = new Map<string, number>();

  let current: Scene | null = null;
  for (const element of elements) {
    if (element.kind === 'section') {
      current = null;
      const depth = element.depth ?? 1;

      while (stack.length > 0) {
        const top = stack[stack.length - 1];
        if (top && top.depth >= depth) stack.pop();
        else break;
      }

      const node: SectionNode = {
        id: `sec-${element.id.slice(3)}`,
        depth,
        title: stripEmphasis(element.text),
        line: element.line,
        range: { ...element.range },
        children: [],
        sceneIndexes: [],
      };

      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(node);
      else roots.push(node);
      stack.push(node);
      continue;
    }

    if (element.kind === 'scene_heading') {
      const heading = stripEmphasis(element.text);
      const parsed = parseHeading(heading);
      const index = scenes.length + 1;
      const declared = element.sceneNumber;

      if (declared !== undefined) {
        const previous = seenNumbers.get(declared);
        if (previous !== undefined) {
          diagnostics.push({
            severity: 'warning',
            code: 'duplicateSceneNumber',
            // Line numbers are 1-based for the reader, 0-based internally.
            params: { number: declared, line: previous + 1 },
            line: element.line,
            range: { ...element.range },
          });
        } else {
          seenNumbers.set(declared, element.line);
        }
      }

      const scene: Scene = {
        id: `sc-${element.id.slice(3)}`,
        number: declared ?? String(index),
        index,
        heading,
        intExt: parsed.intExt,
        location: parsed.location,
        timeOfDay: parsed.timeOfDay,
        sectionPath: stack.map((s) => s.title),
        elements: [element],
        range: { from: element.range.from, to: element.range.to },
        line: element.line,
      };
      if (declared !== undefined) scene.declaredNumber = declared;

      scenes.push(scene);
      stack[stack.length - 1]?.sceneIndexes.push(scenes.length - 1);
      current = scene;
      continue;
    }

    if (element.kind === 'synopsis') {
      const text = stripEmphasis(element.text);
      if (current && current.synopsis === undefined) current.synopsis = text;
      else {
        const top = stack[stack.length - 1];
        if (top && !current && top.synopsis === undefined) top.synopsis = text;
      }
    }

    if (current) {
      current.elements.push(element);
      current.range.to = element.range.to;
    }
  }

  // Extend each section to the start of the next one at the same level or shallower.
  closeSectionRanges(roots, source.length);

  return { scenes, sections: roots };
}

function closeSectionRanges(nodes: SectionNode[], documentEnd: number): void {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (!node) continue;
    const next = nodes[i + 1];
    node.range.to = next ? next.range.from : documentEnd;
    closeSectionRanges(node.children, node.range.to);
  }
}

interface ParsedHeading {
  intExt: IntExt | null;
  location: string;
  timeOfDay: string | null;
}

const PREFIX_MAP: Array<{ re: RegExp; value: IntExt }> = [
  { re: /^INT\.?\/EXT\.?\b\.?/i, value: 'INT/EXT' },
  { re: /^I\/E\b\.?/i, value: 'INT/EXT' },
  { re: /^INT\b\.?/i, value: 'INT' },
  { re: /^EXT\b\.?/i, value: 'EXT' },
  { re: /^EST\b\.?/i, value: 'EST' },
];

/** Strips diacritics so times of day compare equal with or without accents. */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toUpperCase();
}

const FOLDED_TIMES = TIMES_OF_DAY.map(fold);

/**
 * Splits a heading into prefix / location / time of day.
 *
 * The time of day is only recognised when it matches a known term (see TIMES_OF_DAY).
 * Always taking the last dash-separated segment would classify `INT. HOUSE - KITCHEN`
 * as happening at "KITCHEN", which would skew the day/night ratio in the statistics
 * (§4.6).
 */
export function parseHeading(heading: string): ParsedHeading {
  let rest = heading.trim();
  let intExt: IntExt | null = null;

  for (const { re, value } of PREFIX_MAP) {
    const match = re.exec(rest);
    if (match) {
      intExt = value;
      rest = rest.slice(match[0].length).trim();
      break;
    }
  }

  const segments = rest.split(/\s+[-–—]+\s+/);
  if (segments.length > 1) {
    const lastSegment = segments[segments.length - 1];
    if (lastSegment !== undefined) {
      const folded = fold(lastSegment);
      const isTime = FOLDED_TIMES.some(
        (time) => folded === time || new RegExp(`\\b${escapeRegExp(time)}\\b`).test(folded),
      );
      if (isTime) {
        return {
          intExt,
          location: segments.slice(0, -1).join(' - ').trim(),
          timeOfDay: lastSegment.trim(),
        };
      }
    }
  }

  return { intExt, location: rest, timeOfDay: null };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Classifies a time of day, for statistics and timeline colouring. */
export function classifyTimeOfDay(timeOfDay: string | null): 'day' | 'night' | 'other' {
  if (timeOfDay === null) return 'other';
  const folded = fold(timeOfDay);
  if (/\b(JOUR|DAY|MATIN|MORNING|AUBE|DAWN|MIDI|AFTERNOON|APRES-MIDI)\b/.test(folded)) return 'day';
  if (/\b(NUIT|NIGHT|SOIR|EVENING|CREPUSCULE|DUSK)\b/.test(folded)) return 'night';
  return 'other';
}

// ─────────────────────────────────────────────────────────────────────────────
// Character and location indexes
// ─────────────────────────────────────────────────────────────────────────────

function sceneIndexAt(scenes: Scene[], offset: number): number {
  for (let i = scenes.length - 1; i >= 0; i--) {
    const scene = scenes[i];
    if (scene && offset >= scene.range.from) return i;
  }
  return -1;
}

function indexCharacters(elements: Element[], scenes: Scene[]): Map<string, CharacterInfo> {
  const characters = new Map<string, CharacterInfo>();

  for (const element of elements) {
    if (element.kind === 'character') {
      const name = element.character?.trim();
      if (!name) continue;

      let info = characters.get(name);
      if (!info) {
        info = { name, speeches: 0, words: 0, cueLines: [], sceneIndexes: [] };
        characters.set(name, info);
      }
      info.speeches++;
      info.cueLines.push(element.line);

      const sceneIndex = sceneIndexAt(scenes, element.range.from);
      if (sceneIndex >= 0 && !info.sceneIndexes.includes(sceneIndex)) {
        info.sceneIndexes.push(sceneIndex);
      }
      continue;
    }

    if (element.kind === 'dialogue' && element.speaker) {
      const info = characters.get(element.speaker);
      if (info) info.words += countWords(stripEmphasis(element.text));
    }
  }

  return characters;
}

/**
 * The screenplay's words, as a single definition shared by every consumer.
 *
 * Letters, digits, apostrophes and hyphens: "aujourd’hui" and "porte-parole" are one word
 * each, which is what a writer counting words means. Any analysis that tokenises text has
 * to agree with the word count shown in the statistics, so it goes through here.
 */
export function tokenizeWords(text: string): string[] {
  return text.match(/[\p{L}\p{N}'’-]+/gu) ?? [];
}

export function countWords(text: string): number {
  return tokenizeWords(text).length;
}

function indexLocations(scenes: Scene[]): Map<string, LocationInfo> {
  const locations = new Map<string, LocationInfo>();

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    if (!scene) continue;
    const name = scene.location.replace(/\s+/g, ' ').trim().toUpperCase();
    if (name.length === 0) continue;

    let info = locations.get(name);
    if (!info) {
      info = { name, count: 0, mixed: false, intExt: new Set(), lines: [], sceneIndexes: [] };
      locations.set(name, info);
    }
    info.count++;
    info.lines.push(scene.line);
    info.sceneIndexes.push(i);
    if (scene.intExt) info.intExt.add(scene.intExt);
    info.mixed = info.intExt.has('INT') && info.intExt.has('EXT');
  }

  return locations;
}
