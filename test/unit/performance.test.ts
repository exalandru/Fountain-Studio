import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collapseToHunks, diffLines, diffScenes } from '../../src/shared/diff/index.js';
import { analyzeForEditor } from '../../src/shared/fountain/editor-analysis.js';
import { parse } from '../../src/shared/fountain/parse.js';
import { findRepeatedPhrases } from '../../src/shared/repetition/index.js';
import { readDocument, sha256Hex } from '../../src/main/files/document.js';

/**
 * The specification requires fluid typing (< 16 ms) on a 120-page screenplay. Editor
 * highlighting relies on masking plus lexing the document, so those two steps must stay
 * well below a keystroke's budget. Completion indexes and the full parse run in a
 * worker, so their budget is wider.
 */

/** ~120 pages of screenplay: 54 lines per page, realistic structure. */
function generateScreenplay(pages: number): string {
  const out: string[] = ['Title: Test de charge', 'Author: Fountain Studio', '', '# ACTE I', ''];

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

describe('version comparison on a feature screenplay', () => {
  const before = generateScreenplay(120);

  it('compares two close versions well inside a dialog opening', () => {
    // The everyday case: take a snapshot, rewrite one line, compare. Trimming the common
    // prefix and suffix is what keeps this from being a six-thousand-line alignment.
    const after = before.replace(
      'and a second line for good measure.',
      'and a rewritten second line.',
    );
    const started = performance.now();
    const diff = diffLines(before, after);
    const hunks = collapseToHunks(diff.lines);
    const elapsed = performance.now() - started;

    expect(diff.coarse).toBe(false);
    expect(diff.added).toBeGreaterThan(0);
    // Only the changed region reaches the view, not the whole document.
    expect(hunks.length).toBeLessThan(20);
    expect(elapsed).toBeLessThan(150);
  });

  it('stays bounded when the two versions have almost nothing in common', () => {
    // The pathological case an exact alignment would choke on: 36 million cells.
    const after = generateScreenplay(120).replace(/JULIE/g, 'CLARA').replace(/INT\./g, 'EXT.');
    const started = performance.now();
    const diff = diffLines(before, after);
    const elapsed = performance.now() - started;

    expect(diff.lines.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(1_000);
  });

  it('summarises a feature by scene fast enough to open a dialog on', () => {
    const after = before.replace(
      'and a second line for good measure.',
      'and a rewritten second line.',
    );
    const beforeAst = parse(before);
    const afterAst = parse(after);
    const started = performance.now();
    const changes = diffScenes(beforeAst, afterAst);
    const elapsed = performance.now() - started;

    expect(changes.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(50);
  });
});

describe('literal repetition on a feature screenplay', () => {
  // Every scene of the generated screenplay reuses the same action paragraph and the same
  // speech, which is the worst case for this analysis: hundreds of identical blocks, every
  // window inside them repeating. A real screenplay gives it far less to chew on.
  const scenes = parse(generateScreenplay(120)).scenes.map((scene) => ({
    number: scene.number,
    heading: scene.heading,
    location: scene.location,
    elements: scene.elements,
  }));

  it('scans a feature fast enough to open a dialog on', () => {
    const started = performance.now();
    const report = findRepeatedPhrases(scenes);
    const elapsed = performance.now() - started;

    expect(report.wordCount).toBeGreaterThan(15_000);
    expect(elapsed).toBeLessThan(300);
  });

  it('names each repeated passage once, at full length, however many windows cover it', () => {
    const report = findRepeatedPhrases(scenes);
    // The document holds exactly two repeated passages. Anything more than a handful of
    // findings means the overlapping windows were reported instead of the passage.
    expect(report.phrases.length).toBeLessThan(5);
    const longest = report.phrases.reduce((best, phrase) =>
      phrase.length > best.length ? phrase : best,
    );
    expect(longest.length).toBeGreaterThan(10);
    expect(longest.total).toBeGreaterThan(200);
    // And the occurrence list stays bounded even at three hundred repeats.
    expect(longest.occurrences.length).toBeLessThanOrEqual(30);
  });
});

describe('H3 file layer: stable read + fingerprint cost', () => {
  // The stable read (two observations + SHA-256 of the adopted bytes) is what a
  // document open and every save's final check now pay. Measured on real disks:
  // ~40 KB screenplay in well under a millisecond; the 100 MiB open limit is the
  // worst authorised case. Thresholds are deliberately far above those measures
  // so CI noise can never flake the suite, while a pathological regression (a
  // whole open re-read per keystroke, an unbounded retry loop) blows straight
  // through them.

  async function measure(size: number, passes: number): Promise<number> {
    const directory = await mkdtemp(join(tmpdir(), 'fountain-studio-h3perf-'));
    const path = join(directory, 'measure.fountain');
    const fill = Buffer.alloc(size);
    for (let i = 0; i < size; i++) fill[i] = 0x61 + (i % 26);
    await writeFile(path, fill);

    const runs: number[] = [];
    for (let i = 0; i < passes; i++) {
      const start = performance.now();
      const snapshot = await readDocument(path);
      runs.push(performance.now() - start);
      expect(snapshot.hash).toHaveLength(64);
    }
    runs.sort((a, b) => a - b);
    return runs[Math.floor(runs.length / 2)] ?? Infinity;
  }

  it('a typical 40 KB screenplay opens and fingerprints without measurable latency', async () => {
    const median = await measure(40 * 1024, 15);
    console.log(`  H3 stable read, 40 KB: ${median.toFixed(1)} ms (median)`);
    expect(median).toBeLessThan(100);
  });

  it('a 100 MiB document — the open limit — still verifies within a save budget', async () => {
    const median = await measure(100 * 1024 * 1024, 5);
    // Saving in place first verifies (two reads + hash), then republishes the whole
    // content; only the verification cost is measured here.
    console.log(`  H3 stable read, 100 MiB: ${median.toFixed(1)} ms (median)`);
    expect(median).toBeLessThan(2_500);
  });

  it('hashing itself is linear and cheap for screenwriting files', () => {
    const kilobytes = 40 * 1024;
    const fill = Buffer.alloc(kilobytes, 0x61);
    const started = performance.now();
    for (let i = 0; i < 100; i++) sha256Hex(fill);
    const elapsed = performance.now() - started;
    const perMegabyte = (elapsed / 100 / kilobytes) * 1024 * 1024;
    console.log(`  sha256: ${perMegabyte.toFixed(1)} ms per MiB`);
    expect(perMegabyte).toBeLessThan(100);
  });
});
