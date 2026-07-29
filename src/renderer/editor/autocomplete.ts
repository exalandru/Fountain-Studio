import { autocompletion } from '@codemirror/autocomplete';
import type { CompletionContext, CompletionResult, Completion } from '@codemirror/autocomplete';
import type { Extension } from '@codemirror/state';
import { TIMES_OF_DAY, TITLE_PAGE_KEYS } from '@shared/fountain/index.js';
import { fountainLexField } from './fountain-highlight.js';

/**
 * Context-aware autocompletion (§4.1, Better Fountain parity).
 *
 * Suggestions come from the document itself — characters already named, locations
 * already visited — therefore from the shared analysis, never from a list kept on the
 * side. Context decides what is offered: after a blank line a character or a slugline is
 * expected, mid-heading a time of day is.
 *
 * The fixed lists below are Fountain content, not interface text: an author writing in
 * French still types `INT.` and may want `FONDU AU NOIR.`, whatever the interface
 * language is.
 */

const SCENE_PREFIXES = ['INT.', 'EXT.', 'EST.', 'INT./EXT.', 'I/E.'];

const TRANSITIONS = [
  'CUT TO:',
  'DISSOLVE TO:',
  'SMASH CUT TO:',
  'MATCH CUT TO:',
  'FADE TO:',
  'FONDU AU NOIR.',
  'FADE OUT.',
];

function options(values: string[], type: string, boost = 0): Completion[] {
  return values.map((label, index) => ({
    label,
    type,
    // The most frequent entries float up, without overriding CodeMirror's own sort.
    boost: boost - index,
  }));
}

export function fountainCompletion(): Extension {
  return autocompletion({
    activateOnTyping: true,
    icons: false,
    override: [
      (context: CompletionContext): CompletionResult | null => {
        const analysis = context.state.field(fountainLexField, false);
        const lines = analysis?.lines ?? [];
        const doc = context.state.doc;
        const currentLine = doc.lineAt(context.pos);
        const index = currentLine.number - 1;
        const textBefore = doc.sliceString(currentLine.from, context.pos);
        const trimmedBefore = textBefore.trimStart();
        const upper = trimmedBefore.toUpperCase();

        const previousLine = index > 0 ? lines[index - 1] : undefined;
        const previousEmpty = index === 0 || previousLine?.kind === 'empty';
        const { characters, locations, times } = analysis?.completions ?? {
          characters: [],
          locations: [],
          times: [],
        };

        // ── Title page: a key at the top of the file ──
        const lexed = lines[index];
        if (
          lexed?.kind === 'title_page_key' ||
          (index === 0 && /^[A-Za-z]*$/.test(trimmedBefore))
        ) {
          if (!trimmedBefore.includes(':')) {
            return {
              from: currentLine.from + (textBefore.length - trimmedBefore.length),
              options: options(
                TITLE_PAGE_KEYS.map((key) => `${key.charAt(0).toUpperCase()}${key.slice(1)}: `),
                'property',
                50,
              ),
              validFor: /^[A-Za-zÀ-ÿ ]*$/,
            };
          }
        }

        // ── Inside a scene heading: times of day after a dash, locations otherwise ──
        const isHeading =
          lexed?.kind === 'scene_heading' ||
          /^(INT|EXT|EST|I\/E)/i.test(trimmedBefore) ||
          trimmedBefore.startsWith('.');

        if (isHeading) {
          const afterDash = /\s-\s*([^-]*)$/.exec(textBefore);
          if (afterDash) {
            const typed = afterDash[1] ?? '';
            const known = [...times];
            for (const time of TIMES_OF_DAY) if (!known.includes(time)) known.push(time);
            return {
              from: context.pos - typed.length,
              options: options(known, 'constant', 40),
              validFor: /^[\p{L}\p{N}' -]*$/u,
            };
          }

          const afterPrefix = /^\s*(?:\.|(?:INT\.?\/EXT|I\/E|INT|EXT|EST)\.?\s*)(.*)$/i.exec(
            textBefore,
          );
          if (afterPrefix && locations.length > 0) {
            const typed = afterPrefix[1] ?? '';
            return {
              from: context.pos - typed.length,
              options: options(locations, 'variable', 40),
              validFor: /^[\p{L}\p{N}' -]*$/u,
            };
          }
        }

        // ── Character forced with @ ──
        if (trimmedBefore.startsWith('@')) {
          return {
            from: currentLine.from + textBefore.indexOf('@') + 1,
            options: options(characters, 'function', 60),
            validFor: /^[\p{L}\p{N}' .()-]*$/u,
          };
        }

        // ── Start of a block: character, slugline or transition ──
        if (previousEmpty && upper === trimmedBefore && trimmedBefore.length >= 0) {
          const proposals: Completion[] = [
            ...options(characters, 'function', 60),
            ...options(SCENE_PREFIXES, 'keyword', 30),
            ...options(TRANSITIONS, 'keyword', 10),
          ];
          if (proposals.length === 0) return null;

          return {
            from: currentLine.from + (textBefore.length - trimmedBefore.length),
            options: proposals,
            validFor: /^[\p{Lu}\p{N}' ./:()-]*$/u,
          };
        }

        return null;
      },
    ],
  });
}
