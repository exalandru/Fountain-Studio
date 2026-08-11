/**
 * Application-level contract for Rewrite Selection.
 *
 * Shape checks live in `parseRewriteVariants`. This module rejects obvious scope
 * escapes that a well-formed JSON payload can still carry: new Fountain structure,
 * unsolicited emphasis, and directorial camera lines that were not in the selection.
 */

import type { ElementKind } from '../fountain/ast.js';
import { isUpperCase, parse, parseInline } from '../fountain/index.js';

/** Kinds that change screenplay structure when invented by a rewrite. */
const STRUCTURAL_KINDS = new Set<ElementKind>([
  'scene_heading',
  'character',
  'dialogue',
  'parenthetical',
  'transition',
  'section',
  'synopsis',
  'centered',
  'page_break',
  'lyrics',
]);

/**
 * Mirrors `lexer.ts` bare transitions. Kept local so the contract can recognise
 * transition *lines* even when the full-document lexer would not (blank-line sandwich
 * missing, or `CUT TO:` misread as a title-page key).
 */
const BARE_TRANSITIONS = new Set([
  'FADE OUT.',
  'FADE OUT',
  'CUT TO BLACK.',
  'CUT TO BLACK',
  'FADE TO BLACK.',
  'FADE TO BLACK',
  'FIN',
  'THE END',
  'GÉNÉRIQUE FIN',
]);

const TRANSITION_SUFFIX = /\bTO:$/;

/**
 * Directorial / coverage lines. Visual prose may mention light and space; these
 * patterns catch shot instructions that rewrite a prose selection into coverage.
 */
const CAMERA_STRUCTURE_LINE =
  /^(?:CAM[ÉE]RA|CAMERA|TRAVELLING|TRAVELING|GROS\s+PLAN|PLAN\s+RAPPROCH[ÉE]|PLAN\s+SUR|CLOSE[- ]?UP|CLOSE\s+ON|WIDE\s+SHOT|INSERT|POV|TILT|PAN\b|ZOOM|DOLLY|TRACKING\s+SHOT)\b/i;

export type RewriteContractFailure = 'shape' | 'scope' | 'formatting' | 'camera';

export type RewriteContractResult =
  { ok: true; variants: string[] } | { ok: false; reason: RewriteContractFailure };

function elementKinds(text: string): ElementKind[] {
  return parse(text).elements.map((element) => element.kind);
}

function emphasisPresent(text: string): { bold: boolean; italic: boolean; underline: boolean } {
  let bold = false;
  let italic = false;
  let underline = false;
  for (const span of parseInline(text)) {
    bold ||= span.bold;
    italic ||= span.italic;
    underline ||= span.underline;
  }
  return { bold, italic, underline };
}

function lineLooksLikeTransition(trimmed: string): boolean {
  if (/^>\s*\S/.test(trimmed)) return true;
  if (!isUpperCase(trimmed)) return false;
  return TRANSITION_SUFFIX.test(trimmed) || BARE_TRANSITIONS.has(trimmed);
}

function hasTransitionLines(text: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed && lineLooksLikeTransition(trimmed)) return true;
  }
  return false;
}

function hasCameraStructure(text: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed && CAMERA_STRUCTURE_LINE.test(trimmed)) return true;
  }
  return false;
}

/** True when `variant` invents Fountain structure absent from `selection`. */
export function introducesStructuralEscape(selection: string, variant: string): boolean {
  const allowed = new Set(elementKinds(selection));
  for (const kind of elementKinds(variant)) {
    if (STRUCTURAL_KINDS.has(kind) && !allowed.has(kind)) return true;
  }
  // Natural `CUT TO:` often fails to become a `transition` element when parsed in
  // isolation (title-page key / missing blank-line sandwich). Still reject the line.
  if (!hasTransitionLines(selection) && hasTransitionLines(variant)) return true;
  return false;
}

/** True when `variant` introduces Fountain emphasis the selection did not use. */
export function introducesEmphasisDrift(selection: string, variant: string): boolean {
  const source = emphasisPresent(selection);
  const next = emphasisPresent(variant);
  if (next.bold && !source.bold) return true;
  if (next.italic && !source.italic) return true;
  if (next.underline && !source.underline) return true;
  return false;
}

/** True when `variant` adds camera/shot instruction lines absent from `selection`. */
export function introducesCameraStructure(selection: string, variant: string): boolean {
  if (hasCameraStructure(selection)) return false;
  return hasCameraStructure(variant);
}

/**
 * Accepts a parsed rewrite payload only when every variant respects the selection's
 * structural and formatting scope.
 */
export function enforceRewriteContract(
  selection: string,
  variants: readonly string[],
): RewriteContractResult {
  if (variants.length !== 3) return { ok: false, reason: 'shape' };
  for (const variant of variants) {
    if (!variant || !variant.trim()) return { ok: false, reason: 'shape' };
    if (introducesStructuralEscape(selection, variant)) {
      return { ok: false, reason: 'scope' };
    }
    if (introducesEmphasisDrift(selection, variant)) {
      return { ok: false, reason: 'formatting' };
    }
    if (introducesCameraStructure(selection, variant)) {
      return { ok: false, reason: 'camera' };
    }
  }
  return { ok: true, variants: [...variants] };
}
