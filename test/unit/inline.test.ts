import { describe, expect, it } from 'vitest';
import { parseInline, stripEmphasis } from '../../src/shared/fountain/inline.js';

/** Reading shortcut: `[text, styles]` where styles ∈ {b, i, u}. */
function shape(text: string): Array<[string, string]> {
  return parseInline(text).map((s) => {
    let styles = '';
    if (s.bold) styles += 'b';
    if (s.italic) styles += 'i';
    if (s.underline) styles += 'u';
    return [s.text, styles];
  });
}

describe('parseInline — Fountain emphasis', () => {
  it('leaves plain text untouched', () => {
    expect(shape('Julie walks in.')).toEqual([['Julie walks in.', '']]);
  });

  it('recognises italics', () => {
    expect(shape('She is *in a hurry*.')).toEqual([
      ['She is ', ''],
      ['in a hurry', 'i'],
      ['.', ''],
    ]);
  });

  it('recognises bold', () => {
    expect(shape('**CAREFUL**')).toEqual([['CAREFUL', 'b']]);
  });

  it('recognises bold italics with three asterisks', () => {
    expect(shape('***really***')).toEqual([['really', 'bi']]);
  });

  it('recognises underline', () => {
    expect(shape('_important_')).toEqual([['important', 'u']]);
  });

  it('combines nested underline and bold', () => {
    expect(shape('_**both at once**_')).toEqual([['both at once', 'bu']]);
  });

  it('does not start emphasis when the delimiter is followed by a space', () => {
    expect(shape('2 * 3 * 4')).toEqual([['2 * 3 * 4', '']]);
  });

  it('handles an escaped literal asterisk', () => {
    expect(shape('Note\\*')).toEqual([['Note*', '']]);
  });

  it('leaves an unpaired asterisk as-is', () => {
    expect(shape('5 * 3 = 15')).toEqual([['5 * 3 = 15', '']]);
  });

  it('keeps absolute offsets exact', () => {
    const spans = parseInline('ab *cd* ef', 100);
    expect(spans.map((s) => [s.text, s.from, s.to])).toEqual([
      ['ab ', 100, 103],
      ['cd', 104, 106],
      [' ef', 107, 110],
    ]);
  });

  it('stripEmphasis removes the markers', () => {
    expect(stripEmphasis('One **word** and *another*')).toBe('One word and another');
  });

  it('handles several emphases on the same line', () => {
    expect(shape('*a* and *b*')).toEqual([
      ['a', 'i'],
      [' and ', ''],
      ['b', 'i'],
    ]);
  });

  it('resolves emphasis inside accented French text', () => {
    // The parser works on UTF-16 code units; accents must not shift offsets.
    expect(shape('Élodie s’*éloigne*')).toEqual([
      ['Élodie s’', ''],
      ['éloigne', 'i'],
    ]);
  });
});
