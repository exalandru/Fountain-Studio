import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PdfExportOptions } from '../../src/shared/ipc-contract.js';
import { renderScreenplayPdf } from '../../src/main/pdf/render.js';

const RESOURCES = join(process.cwd(), 'resources');

/**
 * The text of each page of a rendered PDF, in drawing order.
 *
 * Read back through pdf.js rather than by searching the bytes: a pdfkit content stream is
 * compressed, so the only honest way to assert what a reader will see is to extract it. The
 * page label is drawn first, so it is always the first item of a page.
 */
async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const document = await pdfjs.getDocument({ data: bytes, useSystemFonts: false }).promise;
  const pages: string[] = [];
  for (let index = 1; index <= document.numPages; index++) {
    const page = await document.getPage(index);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join('|'));
  }
  return pages;
}

const baseOptions: PdfExportOptions = {
  format: 'letter',
  sceneNumbers: 'both',
  includeNotes: false,
  includeSynopses: false,
  headingsBold: true,
  watermark: '',
  pageFrom: null,
  pageTo: null,
  revision: null,
};

describe('PDF rendering', () => {
  it('embeds Courier Prime and emits a valid PDF buffer', async () => {
    const rendered = await renderScreenplayPdf(
      'Title: Test\n\nINT. ROOM - DAY\n\nAction.\n',
      { ...baseOptions, watermark: 'DRAFT' },
      RESOURCES,
    );

    expect(Buffer.from(rendered.bytes.subarray(0, 5)).toString()).toBe('%PDF-');
    expect(rendered.bytes.length).toBeGreaterThan(1_000);
    expect(rendered.pageCount).toBe(2);
  });

  it('clamps an out-of-range or reversed body-page range to a valid page', async () => {
    const rendered = await renderScreenplayPdf(
      'INT. ROOM - DAY\n\nAction.\n',
      { ...baseOptions, format: 'a4', sceneNumbers: 'none', pageFrom: 99, pageTo: 1 },
      RESOURCES,
    );

    expect(Buffer.from(rendered.bytes.subarray(0, 5)).toString()).toBe('%PDF-');
    expect(rendered.pageCount).toBe(1);
  });
});

/**
 * Emphasis, and the shapes a real screenplay turns out to contain.
 *
 * These exist because of a reported failure: a screenplay holding a single `_underlined_` word
 * could not be exported at all. pdfkit measures an underline from the line wrapper's own
 * `textWidth`, and every run here is placed by hand with `lineBreak: false`, so that width was
 * `undefined` and the rule was stroked to `NaN` — taking the whole export down. The rule is now
 * drawn directly, and the sweep below covers the other element kinds it could have hit.
 */
describe('PDF emphasis and awkward screenplays', () => {
  const shapes: Record<string, string> = {
    'underline in action': 'INT. A - JOUR\n\nUn mot _souligné_ ici.\n',
    'bold, italic and underline mixed':
      'INT. A - JOUR\n\n**Gras** et *italique* et _souligné_ mêlés.\n',
    'underline in dialogue': 'INT. A - JOUR\n\nALICE\nUn mot _souligné_.\n',
    'underline in a parenthetical': 'INT. A - JOUR\n\nALICE\n(_doucement_)\nUn mot.\n',
    'underline in a heading': 'INT. _A_ - JOUR\n\nUne action.\n',
    'underline centred': 'INT. A - JOUR\n\n>_Centré souligné_<\n\nUne action.\n',
    'underline in a transition': 'INT. A - JOUR\n\nUne action.\n\n>_FONDU AU NOIR_:\n',
    'underline in lyrics': 'INT. A - JOUR\n\n~Une chanson _qui dure_\n',
    'underline in a note': 'INT. A - JOUR\n\nUne action. [[une _note_ ici]]\n',
    'underline wrapping over several lines': `INT. A - JOUR\n\n_${'Un mot souligné '.repeat(60)}_\n`,
    'dual dialogue': 'INT. A - JOUR\n\nALICE\nUn.\n\nBOB ^\nDeux.\n',
    'a title page missing most of its fields': 'Title: Essai\n\nINT. A - JOUR\n\nUne action.\n',
    'nothing but a title page': 'Title: Essai\n',
    'an empty document': '',
  };

  for (const [name, source] of Object.entries(shapes)) {
    it(`exports with ${name}`, async () => {
      const rendered = await renderScreenplayPdf(
        source,
        { ...baseOptions, includeNotes: true, watermark: 'BROUILLON' },
        RESOURCES,
      );

      expect(Buffer.from(rendered.bytes.subarray(0, 5)).toString()).toBe('%PDF-');
    });
  }

  it('really draws the rule, rather than merely surviving it', async () => {
    // Not enough that the export succeeds: the underline has to be on the page. A stroked rule
    // is drawing rather than text, so it shows up as bytes the plain version does not have.
    const underlined = await renderScreenplayPdf(
      'INT. A - JOUR\n\nUn mot _souligné_ ici.\n',
      baseOptions,
      RESOURCES,
    );
    const plain = await renderScreenplayPdf(
      'INT. A - JOUR\n\nUn mot souligné ici.\n',
      baseOptions,
      RESOURCES,
    );

    expect(underlined.bytes.length).toBeGreaterThan(plain.bytes.length);
    // And the text itself is untouched: the markers are not printed.
    const [page] = await pageTexts(underlined.bytes);
    expect(page).toContain('Un mot souligné ici.');
    expect(page).not.toContain('_');
  });
});

/**
 * The main process is where a revision is assembled: it diffs, paginates the locked draft to
 * find its page starts, and decides which sheets go out. The marks themselves are unit-tested
 * in `revision.test.ts`; what matters here is that the assembly holds together and that nothing
 * of it leaks into an ordinary export.
 */
describe('PDF revisions', () => {
  const scene = (index: number): string =>
    `INT. LIEU${index} - JOUR\n\nUne action de la scène ${index}.\n`;
  const source = Array.from({ length: 40 }, (_value, index) => scene(index)).join('\n');

  const revision = (over: Partial<NonNullable<PdfExportOptions['revision']>> = {}) => ({
    ...baseOptions,
    revision: {
      baseline: {
        path: '/tmp/screenplay.fountain',
        snapshotId: 'snap-unit-baseline',
        source,
      },
      header: 'RÉVISION BLEUE — 31/07/26',
      colour: 'blue' as const,
      colourMode: 'both' as const,
      marks: true,
      lockedPages: true,
      onlyRevisedPages: false,
      ...over,
    },
  });

  it('issues only the pages a revision touched', async () => {
    const current = source.replace('Une action de la scène 1.', 'Une action réécrite.');
    const whole = await renderScreenplayPdf(current, revision(), RESOURCES);
    const partial = await renderScreenplayPdf(
      current,
      revision({ onlyRevisedPages: true }),
      RESOURCES,
    );

    expect(whole.pageCount).toBeGreaterThan(1);
    // One touched page out of several: a reader swaps one sheet into their copy.
    expect(partial.pageCount).toBe(1);
    expect(partial.bytes.length).toBeLessThan(whole.bytes.length);
  });

  it('issues nothing but the title page when the screenplay is untouched', async () => {
    const rendered = await renderScreenplayPdf(
      source,
      revision({ onlyRevisedPages: true }),
      RESOURCES,
    );

    // Honest rather than convenient: there is nothing to reissue.
    expect(rendered.pageCount).toBe(0);
  });

  it('spends paper rather than moving the pages that follow', async () => {
    // Half a page of dialogue added to the first scene. Unlocked, every following page would
    // shift; locked, the extra text lands on a lettered page and the rest stay put.
    const added = Array.from({ length: 24 }, (_value, index) => `Ligne ajoutée ${index}.`).join(
      '\n\n',
    );
    const current = source.replace('Une action de la scène 1.', `Une action.\n\n${added}`);

    const flowing = await renderScreenplayPdf(current, revision({ lockedPages: false }), RESOURCES);
    const locked = await renderScreenplayPdf(current, revision(), RESOURCES);

    // Pinning costs paper: a page whose content is fixed cannot absorb what spilled from the
    // one before, so a revised set legitimately runs to more sheets than a freshly flowed
    // script. That is the trade a production accepts to keep page 13 on page 13 — the labels
    // that prove the pinning are asserted in `pagination.test.ts`.
    expect(locked.pageCount).toBeGreaterThanOrEqual(flowing.pageCount);
    expect(Buffer.from(locked.bytes.subarray(0, 5)).toString()).toBe('%PDF-');
  });

  it('paints the paper only when the export asks for a colour', async () => {
    const current = source.replace('Une action de la scène 1.', 'Une action réécrite.');
    // `both` and `header` draw the same text, so the only difference between them is the
    // rectangles — comparing `page` against `header` would move two things at once, since a
    // tinted page drops the header.
    const tinted = await renderScreenplayPdf(current, revision({ colourMode: 'both' }), RESOURCES);
    const plain = await renderScreenplayPdf(current, revision({ colourMode: 'header' }), RESOURCES);
    const white = await renderScreenplayPdf(
      current,
      revision({ colourMode: 'both', colour: 'white' }),
      RESOURCES,
    );

    expect(tinted.bytes.length).toBeGreaterThan(plain.bytes.length);
    // White is the absence of a revision: nothing is painted, so it costs exactly what the
    // header-only export costs.
    expect(white.bytes.length).toBe(plain.bytes.length);
  });

  it('prints the header and an asterisk beside what changed', async () => {
    const current = source.replace('Une action de la scène 1.', 'Une action réécrite.');
    const rendered = await renderScreenplayPdf(current, revision(), RESOURCES);
    const pages = await pageTexts(rendered.bytes);

    // Every page carries the header, so a loose sheet says which revision it belongs to.
    expect(pages.every((page) => page.includes('RÉVISION BLEUE — 31/07/26'))).toBe(true);
    // Exactly one page carries a mark, and it is the one holding the rewritten line.
    const marked = pages.filter((page) => page.includes('|*'));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain('Une action réécrite.');
  });

  it('drops the header when the page itself carries the colour', async () => {
    const current = source.replace('Une action de la scène 1.', 'Une action réécrite.');
    const rendered = await renderScreenplayPdf(
      current,
      revision({ colourMode: 'page' }),
      RESOURCES,
    );
    const pages = await pageTexts(rendered.bytes);

    expect(pages.some((page) => page.includes('RÉVISION'))).toBe(false);
  });

  it('gives an overflowing page a letter and leaves the next number alone', async () => {
    // Half a page of new text in the first scene. The pages after it must keep their numbers —
    // that is the promise a locked screenplay makes to whoever is holding page 3.
    const added = Array.from({ length: 24 }, (_value, index) => `Ligne ajoutée ${index}.`).join(
      '\n\n',
    );
    const current = source.replace('Une action de la scène 1.', `Une action.\n\n${added}`);
    const rendered = await renderScreenplayPdf(current, revision(), RESOURCES);
    const labels = (await pageTexts(rendered.bytes)).map((page) => page.split('|')[0]);

    expect(labels[0]).toBe('1');
    expect(labels[1]).toBe('1A');
    expect(labels[2]).toBe('2');
    // No number is issued twice, which is the whole point of the letters.
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('numbers pages plainly when nothing is locked', async () => {
    const rendered = await renderScreenplayPdf(source, baseOptions, RESOURCES);
    const labels = (await pageTexts(rendered.bytes)).map((page) => page.split('|')[0]);

    expect(labels).toEqual(labels.map((_label, index) => String(index + 1)));
  });

  it('rejects revision rendering when the structured baseline is absent', async () => {
    const malformed = revision() as PdfExportOptions & {
      revision: Omit<NonNullable<PdfExportOptions['revision']>, 'baseline'>;
    };
    delete (malformed.revision as Partial<NonNullable<PdfExportOptions['revision']>>).baseline;

    await expect(renderScreenplayPdf(source, malformed, RESOURCES)).rejects.toThrow(
      'PDF_REVISION_BASELINE_INVALID',
    );
  });

  it('treats an empty validated baseline as real revision input', async () => {
    const rendered = await renderScreenplayPdf(
      source,
      revision({
        baseline: {
          path: '/tmp/screenplay.fountain',
          snapshotId: 'snap-empty-baseline',
          source: '',
        },
        onlyRevisedPages: true,
        lockedPages: true,
      }),
      RESOURCES,
    );

    expect(rendered.pageCount).toBeGreaterThan(1);
  });
});
