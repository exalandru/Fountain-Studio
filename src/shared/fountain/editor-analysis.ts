import type { LexedLine } from './lexer.js';
import { lexDocument } from './lexer.js';
import { maskAnnotations } from './mask.js';

export interface EditorAnalysis {
  lines: LexedLine[];
  annotations: Array<{ kind: 'note' | 'boneyard'; from: number; to: number }>;
}

/**
 * Complete synchronous analysis required by one editor transaction.
 *
 * It deliberately excludes the full AST, which runs in a worker. Completion indexes
 * also come from that AST and are injected into CodeMirror separately.
 */
export function analyzeForEditor(source: string): EditorAnalysis {
  const { masked, annotations } = maskAnnotations(source);
  const lines = lexDocument(masked);
  return {
    lines,
    annotations: annotations.map((annotation) => ({
      kind: annotation.kind,
      from: annotation.range.from,
      to: annotation.range.to,
    })),
  };
}
