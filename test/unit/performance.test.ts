import { describe, expect, it } from 'vitest';
import { analyzeForEditor } from '../../src/shared/fountain/editor-analysis.js';
import { parse } from '../../src/shared/fountain/parse.js';

/**
 * The specification requires fluid typing (< 16 ms) on a 120-page screenplay. Editor
 * highlighting relies on masking plus lexing the document, so those two steps must stay
 * well below a keystroke's budget. The full parse runs in a worker, so its budget is
 * wider.
 */

/** ~120 pages of screenplay: 54 lines per page, realistic structure. */
function generateScreenplay(pages: number): string {
  const out: string[] = ['Title: Test de charge', 'Author: Quantum Draft', '', '# ACTE I', ''];

  const characters = ['JULIE', 'MARC', 'LE GARDIEN', 'ÉLODIE'];
  const places = ['CUISINE', 'RUE PRINCIPALE', 'BUREAU', 'TOIT'];
  const times = ['JOUR', 'NUIT', 'AUBE'];
  let line = 0;
  let scene = 0;

  while (line < pages * 54) {
    scene++;
    const inOut = scene % 3 === 0 ? 'EXT.' : 'INT.';
    out.push(
      `${inOut} ${places[scene % places.length]} - ${times[scene % times.length]} #${scene}#`,
      '',
      '= Scene synopsis for the sidebar.',
      '',
      'An action paragraph describing what the camera sees, with one *italic* word',
      'and a second line for good measure.',
      '',
    );
    line += 7;

    for (let i = 0; i < 4; i++) {
      const who = characters[(scene + i) % characters.length];
      out.push(
        who ?? 'JULIE',
        '(quietly)',
        'A speech of reasonable length, the kind a real screenplay contains.',
        '',
      );
      line += 4;
    }

    if (scene % 10 === 0) {
      out.push('[[Review note to deal with later.]]', '', '## New sequence', '');
      line += 4;
    }
  }

  return out.join('\n');
}

const script = generateScreenplay(120);

describe('performance on a 120-page screenplay', () => {
  it('the generated screenplay has the expected size', () => {
    const lines = script.split('\n').length;
    expect(lines).toBeGreaterThan(6000);
  });

  it('the complete synchronous editor analysis fits within a keystroke budget (16 ms)', () => {
    // Median over several passes, to smooth out noise and JIT warm-up.
    const durations: number[] = [];
    for (let i = 0; i < 15; i++) {
      const start = performance.now();
      analyzeForEditor(script);
      durations.push(performance.now() - start);
    }
    durations.sort((a, b) => a - b);
    const median = durations[Math.floor(durations.length / 2)] ?? Infinity;

    console.log(`  editor analysis: ${median.toFixed(1)} ms (median, ${script.length} characters)`);
    expect(median).toBeLessThan(16);
  });

  it('the full parse stays under 150 ms (runs in a worker)', () => {
    const durations: number[] = [];
    for (let i = 0; i < 8; i++) {
      const start = performance.now();
      parse(script);
      durations.push(performance.now() - start);
    }
    durations.sort((a, b) => a - b);
    const median = durations[Math.floor(durations.length / 2)] ?? Infinity;

    console.log(`  full parse: ${median.toFixed(1)} ms`);
    expect(median).toBeLessThan(150);
  });

  it('produces a coherent structure at that scale', () => {
    const screenplay = parse(script);
    expect(screenplay.scenes.length).toBeGreaterThan(200);
    expect(screenplay.characters.size).toBe(4);
    expect(screenplay.scenes.every((s) => s.declaredNumber !== undefined)).toBe(true);
  });
});
