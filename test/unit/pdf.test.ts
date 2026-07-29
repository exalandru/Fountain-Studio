import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderScreenplayPdf } from '../../src/main/pdf/render.js';

describe('PDF rendering', () => {
  it('embeds Courier Prime and emits a valid PDF buffer', async () => {
    const rendered = await renderScreenplayPdf(
      'Title: Test\n\nINT. ROOM - DAY\n\nAction.\n',
      {
        format: 'letter',
        sceneNumbers: 'both',
        includeNotes: false,
        includeSynopses: false,
        headingsBold: true,
        watermark: 'DRAFT',
        pageFrom: null,
        pageTo: null,
      },
      join(process.cwd(), 'resources'),
    );

    expect(Buffer.from(rendered.bytes.subarray(0, 5)).toString()).toBe('%PDF-');
    expect(rendered.bytes.length).toBeGreaterThan(1_000);
    expect(rendered.pageCount).toBe(2);
  });

  it('clamps an out-of-range or reversed body-page range to a valid page', async () => {
    const rendered = await renderScreenplayPdf(
      'INT. ROOM - DAY\n\nAction.\n',
      {
        format: 'a4',
        sceneNumbers: 'none',
        includeNotes: false,
        includeSynopses: false,
        headingsBold: false,
        watermark: '',
        pageFrom: 99,
        pageTo: 1,
      },
      join(process.cwd(), 'resources'),
    );

    expect(Buffer.from(rendered.bytes.subarray(0, 5)).toString()).toBe('%PDF-');
    expect(rendered.pageCount).toBe(1);
  });
});
