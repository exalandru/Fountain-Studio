import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import type { Element, Screenplay } from '@shared/fountain/index.js';
import { parse } from '@shared/fountain/index.js';
import type { PdfExportOptions } from '@shared/ipc-contract.js';
import type { PaginationItem, ScreenplayPage } from '@shared/pagination/index.js';
import { paginateScreenplay } from '@shared/pagination/index.js';
import {
  REVISION_PAPER,
  alignLines,
  revisedElements,
  revisedLines,
} from '@shared/revision/index.js';

const LINE_HEIGHT = 12;
const CHARACTER_WIDTH = 7.2;

/**
 * Right margin column for revision asterisks.
 *
 * The scene-number column sits at `pageWidth - 102` and the page number at `- 108`, so this
 * leaves the mark alone in the margin where a reader's eye looks for it.
 */
const MARK_X = 64;

interface RenderedPdf {
  bytes: Uint8Array;
  pageCount: number;
}

function fontPath(resourcesDirectory: string, name: string): string {
  return join(resourcesDirectory, 'fonts', name);
}

function withNotes(screenplay: Screenplay): Screenplay {
  const notes: Element[] = screenplay.annotations
    .filter((annotation) => annotation.kind === 'note')
    .map((annotation) => ({
      id: `note-${annotation.range.from}`,
      kind: 'note',
      range: annotation.range,
      line: annotation.line,
      lineCount: annotation.text.split('\n').length,
      text: annotation.text,
      inline: [
        {
          text: annotation.text,
          bold: false,
          italic: false,
          underline: false,
          from: annotation.range.from,
          to: annotation.range.to,
        },
      ],
      forced: false,
    }));
  return {
    ...screenplay,
    elements: [...screenplay.elements, ...notes].sort(
      (left, right) => left.range.from - right.range.from,
    ),
  };
}

/**
 * Fills the sheet with the revision's paper colour.
 *
 * Drawn first, so the watermark and the text sit on top of it. White paints nothing: it is the
 * absence of a revision, and a white rectangle on white would only make the file bigger.
 */
function paintPaper(document: PDFKit.PDFDocument, tint: string | null): void {
  if (tint === null) return;
  const { width, height } = document.page;
  document.save();
  document.rect(0, 0, width, height).fill(tint);
  document.restore();
}

/** The paper colour an export asks for, or `null` when the pages stay white. */
function paperTint(options: PdfExportOptions): string | null {
  const revision = options.revision;
  if (!revision || revision.colourMode === 'header' || revision.colour === 'white') return null;
  return REVISION_PAPER[revision.colour];
}

function titleValues(screenplay: Screenplay, key: string): string[] {
  return screenplay.titlePage.fields.get(key) ?? [];
}

function renderTitlePage(
  document: PDFKit.PDFDocument,
  screenplay: Screenplay,
  tint: string | null,
): void {
  document.addPage();
  paintPaper(document, tint);
  const width = document.page.width;
  const height = document.page.height;
  const title = titleValues(screenplay, 'title');
  const credit = titleValues(screenplay, 'credit');
  const authors =
    titleValues(screenplay, 'author').length > 0
      ? titleValues(screenplay, 'author')
      : titleValues(screenplay, 'authors');
  const source = titleValues(screenplay, 'source');
  const contact = titleValues(screenplay, 'contact');
  const copyright = titleValues(screenplay, 'copyright');

  let y = height * 0.38;
  document.font('CourierPrimeBold').fontSize(12);
  document.text(title.join('\n').toUpperCase(), 72, y, { width: width - 144, align: 'center' });
  y = document.y + LINE_HEIGHT;
  document
    .font('CourierPrime')
    .text(credit.join('\n'), 72, y, { width: width - 144, align: 'center' });
  y = document.y + LINE_HEIGHT;
  document.text(authors.join('\n'), 72, y, { width: width - 144, align: 'center' });
  if (source.length > 0)
    document.text(source.join('\n'), 72, document.y + LINE_HEIGHT, {
      width: width - 144,
      align: 'center',
    });

  if (contact.length > 0 || copyright.length > 0) {
    document.text([...contact, ...copyright].join('\n'), 72, height - 132, {
      width: (width - 144) / 2,
      align: 'left',
    });
  }

  const ignored = new Set([
    'title',
    'credit',
    'author',
    'authors',
    'source',
    'contact',
    'copyright',
  ]);
  const details = [...screenplay.titlePage.fields.entries()].filter(
    ([key, values]) => !ignored.has(key) && values.length > 0,
  );
  if (details.length > 0) {
    document.text(
      details.map(([key, values]) => `${key}: ${values.join('\n')}`).join('\n'),
      width / 2,
      height - 132,
      { width: width / 2 - 72, align: 'right' },
    );
  }
}

function position(
  item: PaginationItem,
  pageWidth: number,
): { x: number; width: number; align?: 'center' | 'right' } {
  switch (item.kind) {
    case 'character':
    case 'continued':
      return { x: 266.4, width: 38 * CHARACTER_WIDTH };
    case 'dialogue':
    case 'lyrics':
    case 'more':
      return {
        x: 180,
        width: 35 * CHARACTER_WIDTH,
        ...(item.kind === 'more' ? { align: 'right' as const } : {}),
      };
    case 'parenthetical':
      return { x: 216, width: 26 * CHARACTER_WIDTH };
    case 'transition':
      return {
        x: pageWidth - 72 - 16 * CHARACTER_WIDTH,
        width: 16 * CHARACTER_WIDTH,
        align: 'right',
      };
    case 'centered':
      return { x: 108, width: 61 * CHARACTER_WIDTH, align: 'center' };
    default:
      return { x: 108, width: 61 * CHARACTER_WIDTH };
  }
}

interface InlineStyle {
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

function fontName(style: InlineStyle): string {
  if (style.bold && style.italic) return 'CourierPrimeBoldItalic';
  if (style.bold) return 'CourierPrimeBold';
  if (style.italic) return 'CourierPrimeItalic';
  return 'CourierPrime';
}

function elementStyles(element: Element, forceBold: boolean, forceItalic: boolean): InlineStyle[] {
  return element.inline.flatMap((span) =>
    Array.from(span.text, () => ({
      bold: forceBold || span.bold,
      italic: forceItalic || span.italic,
      underline: span.underline,
    })),
  );
}

/**
 * Draws one rendered line, run by run, with its emphasis.
 *
 * Underlines are stroked here rather than through pdfkit's `underline` option. That option
 * measures the rule from `options.textWidth`, which only the line wrapper fills in — and every
 * run here is placed by hand with `lineBreak: false`, so the width comes out `undefined` and
 * the rule is drawn to `NaN`, which fails the whole export. Any screenplay containing a single
 * `_underlined_` word was unexportable.
 */
function renderStyledLine(
  document: PDFKit.PDFDocument,
  line: string,
  styles: InlineStyle[],
  x: number,
  y: number,
  width: number,
  colour: string,
  align?: 'center' | 'right',
): void {
  const characters = Array.from(line);
  const runs: Array<{ text: string; style: InlineStyle }> = [];
  for (let index = 0; index < characters.length; index++) {
    const character = characters[index] ?? '';
    const style = styles[index] ?? { bold: false, italic: false, underline: false };
    const previous = runs.at(-1);
    if (
      previous &&
      previous.style.bold === style.bold &&
      previous.style.italic === style.italic &&
      previous.style.underline === style.underline
    ) {
      previous.text += character;
    } else {
      runs.push({ text: character, style });
    }
  }

  const totalWidth = runs.reduce((total, run) => {
    document.font(fontName(run.style));
    return total + document.widthOfString(run.text);
  }, 0);
  let runX =
    align === 'center'
      ? x + (width - totalWidth) / 2
      : align === 'right'
        ? x + width - totalWidth
        : x;
  for (const run of runs) {
    document.font(fontName(run.style));
    const runWidth = document.widthOfString(run.text);
    document.text(run.text, runX, y, { lineBreak: false });
    if (run.style.underline) {
      // pdfkit's own geometry, so the rule sits where the option would have put it.
      const ruleWidth = document.currentLineHeight() < 10 ? 0.5 : 1;
      const ruleY = y + document.currentLineHeight() - ruleWidth;
      document.save();
      document
        .strokeColor(colour)
        .lineWidth(ruleWidth)
        .moveTo(runX, ruleY)
        .lineTo(runX + runWidth, ruleY)
        .stroke();
      document.restore();
    }
    runX += runWidth;
  }
}

function renderWatermark(document: PDFKit.PDFDocument, text: string): void {
  if (!text.trim()) return;
  const { width, height } = document.page;
  document.save();
  document.opacity(0.12).font('CourierPrimeBold').fontSize(48);
  document.rotate(-35, { origin: [width / 2, height / 2] });
  document.text(text, 72, height / 2 - 30, { width: width - 144, align: 'center' });
  document.restore();
}

function renderBodyPage(
  document: PDFKit.PDFDocument,
  screenplay: Screenplay,
  page: ScreenplayPage,
  options: PdfExportOptions,
  revised: ReadonlySet<number>,
  tint: string | null,
): void {
  document.addPage();
  const pageWidth = document.page.width;
  paintPaper(document, tint);
  renderWatermark(document, options.watermark);
  document.opacity(1).font('CourierPrime').fontSize(12).fillColor('#111111');
  // The label, not the position: a locked page keeps its number, and what overflows it is 12A.
  document.text(page.number, pageWidth - 108, 36, { width: 36, align: 'right' });
  const revision = options.revision;
  if (revision && revision.colourMode !== 'page' && revision.header.length > 0) {
    document.text(revision.header, 72, 36, { width: pageWidth - 216, lineBreak: false });
  }

  let y = 72;
  for (const item of page.items) {
    y += item.leadingLines * LINE_HEIGHT;
    const layout = position(item, pageWidth);
    const scene = item.sceneIndex === null ? null : screenplay.scenes[item.sceneIndex];

    if (item.kind === 'scene_heading' && scene && options.sceneNumbers !== 'none') {
      const number = scene.number;
      document.font('CourierPrimeBold');
      if (options.sceneNumbers === 'left' || options.sceneNumbers === 'both') {
        document.text(number, 72, y, { width: 30, lineBreak: false });
      }
      if (options.sceneNumbers === 'right' || options.sceneNumbers === 'both') {
        document.text(number, pageWidth - 102, y, { width: 30, align: 'right', lineBreak: false });
      }
    }

    const bold =
      item.kind === 'character' ||
      item.kind === 'continued' ||
      (item.kind === 'scene_heading' && options.headingsBold);
    const colour = item.kind === 'note' ? '#666666' : '#111111';
    document.fillColor(colour);
    const element = item.elementIndex === null ? null : screenplay.elements[item.elementIndex];
    const plain = element?.inline.map((span) => span.text).join('') ?? item.text;
    const styles = element
      ? elementStyles(element, bold, item.kind === 'note')
      : Array.from(item.text, () => ({
          bold,
          italic: item.kind === 'note',
          underline: false,
        }));
    const marked =
      revision?.marks === true && item.elementIndex !== null && revised.has(item.elementIndex);
    let styleOffset = Math.max(0, plain.indexOf(item.text));
    for (const line of item.lines) {
      const lineOffset = plain.indexOf(line, styleOffset);
      if (lineOffset >= 0) styleOffset = lineOffset;
      renderStyledLine(
        document,
        line,
        styles.slice(styleOffset, styleOffset + Array.from(line).length),
        layout.x,
        y,
        layout.width,
        colour,
        layout.align,
      );
      if (marked) {
        document.font('CourierPrime').fillColor('#111111');
        document.text('*', pageWidth - MARK_X, y, { width: 10, lineBreak: false });
      }
      styleOffset += Array.from(line).length;
      y += LINE_HEIGHT;
    }
  }
}

/**
 * Where each page of the locked draft begins, expressed in lines of today's screenplay.
 *
 * Nothing is stored at lock time: a list of anchors written down then would have gone stale on
 * the first keystroke. The locked draft is paginated here with the very same options, and the
 * diff moves its page starts onto the text as it is now.
 */
function lockedPageStarts(
  baselineSource: string,
  current: string,
  options: PdfExportOptions,
): number[] {
  const parsed = parse(baselineSource);
  const baseline = options.includeNotes ? withNotes(parsed) : parsed;
  const pagination = paginateScreenplay(baseline, {
    format: options.format,
    includeNotes: options.includeNotes,
    includeSynopses: options.includeSynopses,
  });
  const alignment = alignLines(baselineSource, current);

  return pagination.pages.map((page) => {
    const first = page.items.find((item) => item.elementIndex !== null);
    const element =
      first?.elementIndex === undefined || first.elementIndex === null
        ? null
        : baseline.elements[first.elementIndex];
    // `Element.line` is 0-based; a locked start counts from 1.
    const line = (element?.line ?? 0) + 1;
    return alignment.get(line) ?? line;
  });
}

export async function renderScreenplayPdf(
  source: string,
  options: PdfExportOptions,
  resourcesDirectory: string,
): Promise<RenderedPdf> {
  const original = parse(source);
  const screenplay = options.includeNotes ? withNotes(original) : original;
  const revision = options.revision;
  const baseline = revision?.baselineSource ?? '';
  const revised =
    revision && baseline.length > 0
      ? revisedElements(screenplay.elements, revisedLines(baseline, source))
      : new Set<number>();
  const tint = paperTint(options);

  const pagination = paginateScreenplay(screenplay, {
    format: options.format,
    includeNotes: options.includeNotes,
    includeSynopses: options.includeSynopses,
    ...(revision?.lockedPages === true && baseline.length > 0
      ? { lockedPageStarts: lockedPageStarts(baseline, source, options) }
      : {}),
  });
  const from = Math.min(pagination.pages.length, Math.max(1, options.pageFrom ?? 1));
  const to = Math.min(
    pagination.pages.length,
    Math.max(from, options.pageTo ?? pagination.pages.length),
  );
  const selected = pagination.pages.slice(from - 1, to);
  // Only the pages a reader needs to swap into their copy. The title page stays: a set of
  // revised pages is still issued under a title.
  const pages =
    revision?.onlyRevisedPages === true && baseline.length > 0
      ? selected.filter((page) => page.elementIndexes.some((index) => revised.has(index)))
      : selected;
  const size = options.format === 'a4' ? 'A4' : 'LETTER';
  const document = new PDFDocument({ autoFirstPage: false, size, margin: 0, compress: true });
  document.registerFont('CourierPrime', fontPath(resourcesDirectory, 'CourierPrime-Regular.ttf'));
  document.registerFont('CourierPrimeBold', fontPath(resourcesDirectory, 'CourierPrime-Bold.ttf'));
  document.registerFont(
    'CourierPrimeItalic',
    fontPath(resourcesDirectory, 'CourierPrime-Italic.ttf'),
  );
  document.registerFont(
    'CourierPrimeBoldItalic',
    fontPath(resourcesDirectory, 'CourierPrime-BoldItalic.ttf'),
  );

  const chunks: Buffer[] = [];
  document.on('data', (chunk: Buffer) => chunks.push(chunk));
  const complete = new Promise<Buffer>((resolve, reject) => {
    document.once('end', () => resolve(Buffer.concat(chunks)));
    document.once('error', reject);
  });

  if (original.titlePage.fields.size > 0) renderTitlePage(document, original, tint);
  for (const page of pages) renderBodyPage(document, screenplay, page, options, revised, tint);
  document.end();

  const bytes = await complete;
  return {
    bytes: new Uint8Array(bytes),
    pageCount: pages.length + (original.titlePage.fields.size > 0 ? 1 : 0),
  };
}
