import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

/**
 * Light and dark editor themes.
 *
 * The editor does not imitate the PDF layout: it stays a comfortable writing surface.
 * Regulation screenplay indentation belongs to the preview and the export (M2/M3). Here
 * we only make element kinds distinguishable at a glance, with a slight offset for
 * dialogue blocks.
 *
 * Colour policy — two kinds of value live here, and they are handled differently:
 *
 *  - Values that also exist in the application shell (surface, text, muted text, accent)
 *    are read from the CSS custom properties in `index.css`. CodeMirror themes compile to
 *    real CSS, so `var(--…)` resolves normally. Copying them as literals is what let the
 *    editor keep an old accent while the rest of the interface moved on.
 *  - The Fountain syntax palette (character, transition, section, note, boneyard) stays
 *    literal: it is a *categorical* set that belongs to the editor, not to the shell, and
 *    it has no counterpart among the shell tokens.
 */

const shared = {
  '&': {
    height: '100%',
    fontSize: 'var(--editor-font-size, 15px)',
  },
  '.cm-scroller': {
    fontFamily: '"Courier Prime", "Courier New", ui-monospace, monospace',
    lineHeight: '1.7',
    padding: '2rem 0 40vh 0',
  },
  '.cm-content': {
    maxWidth: '62ch',
    margin: '0 auto',
    paddingInline: '1rem',
  },
  '.cm-line': { padding: '0 2px' },

  '.cm-fountain-scene': {
    fontWeight: '700',
    textTransform: 'uppercase',
    paddingTop: '1.6em',
  },
  '.cm-fountain-character': {
    fontWeight: '600',
    marginLeft: '10ch',
    paddingTop: '0.8em',
  },
  '.cm-fountain-dialogue': { marginLeft: '5ch' },
  '.cm-fountain-parenthetical': { marginLeft: '8ch', fontStyle: 'italic' },
  '.cm-fountain-lyrics': { marginLeft: '5ch', fontStyle: 'italic' },
  '.cm-fountain-transition': { textAlign: 'right', textTransform: 'uppercase' },
  '.cm-fountain-centered': { textAlign: 'center' },
  '.cm-fountain-section': { fontWeight: '700' },
  '.cm-fountain-synopsis': { fontStyle: 'italic' },
  '.cm-fountain-titlekey': { fontWeight: '600' },
  '.cm-fountain-pagebreak': { letterSpacing: '0.4em', opacity: '0.5' },

  '.cm-fountain-bold': { fontWeight: '700' },
  '.cm-fountain-italic': { fontStyle: 'italic' },
  '.cm-fountain-underline': { textDecoration: 'underline' },
} as const;

export const lightTheme: Extension = EditorView.theme(
  {
    ...shared,
    '&': { ...shared['&'], backgroundColor: 'var(--surface-raised)', color: 'var(--text)' },
    '.cm-content': { ...shared['.cm-content'], caretColor: 'var(--text)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
    '.cm-activeLine': { backgroundColor: '#00000008' },
    '.cm-selectionBackground, ::selection': {
      backgroundColor: 'color-mix(in srgb, var(--accent) 26%, transparent) !important',
    },
    '.cm-gutters': {
      backgroundColor: 'var(--surface-raised)',
      color: 'color-mix(in srgb, var(--text-muted) 65%, transparent)',
      border: 'none',
    },

    '.cm-fountain-scene': { ...shared['.cm-fountain-scene'], color: 'var(--accent)' },
    '.cm-fountain-character': { ...shared['.cm-fountain-character'], color: '#7a3b12' },
    '.cm-fountain-parenthetical': {
      ...shared['.cm-fountain-parenthetical'],
      color: 'var(--text-muted)',
    },
    '.cm-fountain-transition': { ...shared['.cm-fountain-transition'], color: '#7a1b52' },
    '.cm-fountain-section': { ...shared['.cm-fountain-section'], color: '#2f6b3f' },
    '.cm-fountain-synopsis': { ...shared['.cm-fountain-synopsis'], color: 'var(--text-muted)' },
    '.cm-fountain-note': {
      backgroundColor: '#fdf3c7',
      color: '#5c4a09',
      borderRadius: '2px',
    },
    '.cm-fountain-boneyard': { color: '#a8a29a', fontStyle: 'italic' },
  },
  { dark: false },
);

export const darkTheme: Extension = EditorView.theme(
  {
    ...shared,
    '&': { ...shared['&'], backgroundColor: 'var(--surface-raised)', color: 'var(--text)' },
    '.cm-content': { ...shared['.cm-content'], caretColor: 'var(--text)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
    '.cm-activeLine': { backgroundColor: '#ffffff0a' },
    '.cm-selectionBackground, ::selection': {
      backgroundColor: 'color-mix(in srgb, var(--accent) 34%, transparent) !important',
    },
    '.cm-gutters': {
      backgroundColor: 'var(--surface-raised)',
      color: 'color-mix(in srgb, var(--text-muted) 65%, transparent)',
      border: 'none',
    },

    '.cm-fountain-scene': { ...shared['.cm-fountain-scene'], color: 'var(--accent)' },
    '.cm-fountain-character': { ...shared['.cm-fountain-character'], color: '#e0a26b' },
    '.cm-fountain-parenthetical': {
      ...shared['.cm-fountain-parenthetical'],
      color: 'var(--text-muted)',
    },
    '.cm-fountain-transition': { ...shared['.cm-fountain-transition'], color: '#e08bb8' },
    '.cm-fountain-section': { ...shared['.cm-fountain-section'], color: '#84c99a' },
    '.cm-fountain-synopsis': { ...shared['.cm-fountain-synopsis'], color: 'var(--text-muted)' },
    '.cm-fountain-note': {
      backgroundColor: '#4a3f14',
      color: '#f0dfa0',
      borderRadius: '2px',
    },
    '.cm-fountain-boneyard': { color: '#6a6a6e', fontStyle: 'italic' },
  },
  { dark: true },
);
