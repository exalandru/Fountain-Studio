import { describe, expect, it } from 'vitest';
import { buildCompletionIndex } from '../../src/shared/analysis/index.js';
import { parse } from '../../src/shared/fountain/index.js';

describe('AST-derived editor completions', () => {
  it('orders characters, locations and times by their AST frequency', () => {
    const screenplay = parse(`INT. KITCHEN - DAY

ALICE
Hello.

EXT. STREET - NIGHT

BOB
Hi.

INT. KITCHEN - DAY

ALICE
Again.
`);

    expect(buildCompletionIndex(screenplay)).toEqual({
      characters: ['ALICE', 'BOB'],
      locations: ['KITCHEN', 'STREET'],
      times: ['DAY', 'NIGHT'],
    });
  });

  it('does not index uppercase action as a character', () => {
    const screenplay = parse('LOUD NOISE WITH NO DIALOGUE\n');
    expect(buildCompletionIndex(screenplay).characters).toEqual([]);
  });
});
