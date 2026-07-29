import { describe, expect, it } from 'vitest';
import { lexDocument, splitCharacter, splitLines } from '../../src/shared/fountain/lexer.js';
import { maskAnnotations } from '../../src/shared/fountain/mask.js';

/** Classifies every non-empty line of a snippet, for readable assertions. */
function kinds(source: string): string[] {
  const { masked } = maskAnnotations(source);
  return lexDocument(masked)
    .filter((l) => l.kind !== 'empty')
    .map((l) => l.kind);
}

function lex(source: string) {
  const { masked } = maskAnnotations(source);
  return lexDocument(masked);
}

describe('splitLines', () => {
  it('preserves offsets with LF line endings', () => {
    expect(splitLines('a\nbb\n').map((l) => [l.raw, l.from, l.to])).toEqual([
      ['a', 0, 1],
      ['bb', 2, 4],
      ['', 5, 5],
    ]);
  });

  it('handles CRLF without shifting positions', () => {
    const lines = splitLines('a\r\nbb');
    expect(lines.map((l) => l.raw)).toEqual(['a', 'bb']);
    expect(lines[1]?.from).toBe(3);
  });
});

describe('splitCharacter', () => {
  it('extracts a plain name', () => {
    expect(splitCharacter('JULIE')).toEqual({ name: 'JULIE', extensions: '', dual: false });
  });

  it('separates the extensions', () => {
    expect(splitCharacter('MARC (V.O.)')).toEqual({
      name: 'MARC',
      extensions: '(V.O.)',
      dual: false,
    });
  });

  it('accumulates several extensions', () => {
    expect(splitCharacter("JULIE (CONT'D) (O.S.)").extensions).toBe("(CONT'D) (O.S.)");
  });

  it('detects the dual-dialogue marker', () => {
    expect(splitCharacter('MARC ^')).toEqual({ name: 'MARC', extensions: '', dual: true });
  });
});

describe('lexDocument — Fountain 1.1 specification rules', () => {
  it('recognises scene headings and their prefixes', () => {
    expect(kinds('INT. KITCHEN - DAY')).toEqual(['scene_heading']);
    expect(kinds('EXT. STREET - NIGHT')).toEqual(['scene_heading']);
    expect(kinds('EST. CITY - DAWN')).toEqual(['scene_heading']);
    expect(kinds('INT./EXT. CAR - DAY')).toEqual(['scene_heading']);
    expect(kinds('I/E. CAR - DAY')).toEqual(['scene_heading']);
  });

  it('forces a heading with a leading dot', () => {
    const lines = lex('.JULIE’S DREAM');
    expect(lines[0]?.kind).toBe('scene_heading');
    expect(lines[0]?.text).toBe('JULIE’S DREAM');
    expect(lines[0]?.forced).toBe(true);
  });

  it('does not mistake an ellipsis for a forced heading', () => {
    expect(kinds('...and then silence.')).toEqual(['action']);
  });

  it('extracts the scene number', () => {
    const lines = lex('INT. KITCHEN - DAY #1A#');
    expect(lines[0]?.sceneNumber).toBe('1A');
    expect(lines[0]?.text).toBe('INT. KITCHEN - DAY');
  });

  it('recognises a character cue followed by dialogue', () => {
    expect(kinds('INT. A - DAY\n\nJULIE\nHello.')).toEqual([
      'scene_heading',
      'character',
      'dialogue',
    ]);
  });

  it('requires a non-empty following line for a character cue', () => {
    // With no dialogue underneath, an upper-case line stays action.
    expect(kinds('INT. A - DAY\n\nJULIE\n\nShe leaves.')).toEqual([
      'scene_heading',
      'action',
      'action',
    ]);
  });

  it('forces a character with @ even in lower case', () => {
    const lines = lex('@McCoy\nHello.');
    expect(lines[0]?.kind).toBe('character');
    expect(lines[0]?.character).toBe('McCoy');
  });

  it('recognises parentheticals inside a dialogue block', () => {
    expect(kinds('JULIE\n(quietly)\nCome here.')).toEqual([
      'character',
      'parenthetical',
      'dialogue',
    ]);
  });

  it('recognises dual dialogue', () => {
    const lines = lex('JULIE\nYou.\n\nMARC ^\nMe.');
    const marc = lines.find((l) => l.character === 'MARC');
    expect(marc?.dual).toBe(true);
  });

  it('recognises lyrics', () => {
    const lines = lex('~We were young');
    expect(lines[0]?.kind).toBe('lyrics');
    expect(lines[0]?.text).toBe('We were young');
  });

  it('recognises a transition ending in TO:', () => {
    expect(kinds('INT. A - DAY\n\nCUT TO:\n\nINT. B - DAY')).toEqual([
      'scene_heading',
      'transition',
      'scene_heading',
    ]);
  });

  it('recognises a transition forced with >', () => {
    const lines = lex('> FADE');
    expect(lines[0]?.kind).toBe('transition');
    expect(lines[0]?.forced).toBe(true);
  });

  it('tells centered text apart from a transition', () => {
    const lines = lex('> THE END <');
    expect(lines[0]?.kind).toBe('centered');
    expect(lines[0]?.text).toBe('THE END');
  });

  it('recognises a page break without mistaking it for a synopsis', () => {
    expect(kinds('===')).toEqual(['page_break']);
    expect(kinds('=====')).toEqual(['page_break']);
  });

  it('recognises sections and their depth', () => {
    const lines = lex('# ACT I\n\n## Sequence 2\n\n### Beat');
    const sections = lines.filter((l) => l.kind === 'section');
    expect(sections.map((s) => [s.depth, s.text])).toEqual([
      [1, 'ACT I'],
      [2, 'Sequence 2'],
      [3, 'Beat'],
    ]);
  });

  it('recognises a synopsis', () => {
    const lines = lex('= Julie learns the truth.');
    expect(lines[0]?.kind).toBe('synopsis');
    expect(lines[0]?.text).toBe('Julie learns the truth.');
  });

  it('forces action with !', () => {
    const lines = lex('!INT. this is action');
    expect(lines[0]?.kind).toBe('action');
    expect(lines[0]?.text).toBe('INT. this is action');
  });

  it('treats accented capitals as capitals', () => {
    // A French character name must be recognised whatever the interface language is.
    expect(kinds('ÉLODIE\nHello.')).toEqual(['character', 'dialogue']);
  });

  it('does not mistake a line of digits for a character', () => {
    expect(kinds('1789\nA date.')).toEqual(['action', 'action']);
  });

  it('keeps action lines distinct at the lexer level', () => {
    // Merging into paragraphs happens in the parser, not here.
    expect(kinds('He walks in.\nHe leaves.')).toEqual(['action', 'action']);
  });
});

describe('lexDocument — title page', () => {
  it('recognises key/value pairs at the top of the file', () => {
    const lines = lex('Title: My Film\nAuthor: Claire\n\nINT. A - DAY');
    expect(lines[0]?.kind).toBe('title_page_key');
    expect(lines[0]?.key).toBe('title');
    expect(lines[0]?.text).toBe('My Film');
    expect(lines[3]?.kind).toBe('scene_heading');
  });

  it('accepts indented values spanning several lines', () => {
    const lines = lex('Title:\n    _**MY FILM**_\n    Short film\n\nINT. A - DAY');
    expect(lines.map((l) => l.kind).slice(0, 3)).toEqual([
      'title_page_key',
      'title_page_value',
      'title_page_value',
    ]);
  });

  it('does not invent a title page when the file opens on a scene', () => {
    const lines = lex('INT. KITCHEN - DAY\n\nShe walks in.');
    expect(lines[0]?.kind).toBe('scene_heading');
  });

  it('does not mistake dialogue containing a colon for a title page', () => {
    const lines = lex('INT. A - DAY\n\nJULIE\nListen: this matters.');
    expect(lines[3]?.kind).toBe('dialogue');
  });
});
