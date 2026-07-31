import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  APP_DATA_VERSION,
  createDefaultAppData,
  parseAppData,
  serializeAppData,
} from '../../src/shared/appdata/index.js';
import {
  companionExists,
  companionPath,
  readAppData,
  writeAppData,
} from '../../src/main/files/appdata.js';

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'quantum-draft-appdata-'));
});

describe('companion schema', () => {
  it('round-trips the current version', () => {
    const data = createDefaultAppData();
    data.preview.syncScroll = true;
    data.sidebar.activeTab = 'characters';
    data.timeline.colorMode = 'timeOfDay';
    data.timeline.zoom = 1.7;
    data.rewrite = { lastTone: 'cinematic', customStyle: 'Sec et elliptique' };
    data.inconsistencies = {
      analyzedAt: 42,
      items: [
        {
          id: 'inconsistency-1',
          type: 'continuity',
          severity: 'minor',
          description: 'Le verre change de main.',
          references: [
            {
              sceneNumber: '2',
              heading: 'INT. BAR - NUIT',
              quote: 'Elle tient le verre.',
            },
          ],
          suggestion: 'Conserver la même main.',
          status: 'resolved',
        },
      ],
    };

    expect(parseAppData(serializeAppData(data))).toEqual(data);
  });

  it('rejects invalid JSON and unsupported versions', () => {
    expect(parseAppData('{')).toBeNull();
    expect(parseAppData(JSON.stringify({ version: APP_DATA_VERSION + 1 }))).toBeNull();
  });

  it('fills missing fields and bounds unsafe widths', () => {
    const parsed = parseAppData(
      JSON.stringify({
        version: APP_DATA_VERSION,
        sidebar: { width: -100, filter: 'x'.repeat(300) },
        preview: { width: 10000 },
        timeline: { zoom: 99, colorMode: 'timeOfDay' },
      }),
    );

    expect(parsed?.sidebar.width).toBe(220);
    expect(parsed?.sidebar.filter).toHaveLength(200);
    expect(parsed?.preview.width).toBe(760);
    expect(parsed?.sidebar.activeTab).toBe('structure');
    expect(parsed?.preview.activeTab).toBe('statistics');
    expect(parsed?.timeline.zoom).toBe(2.5);
    expect(parsed?.timeline.colorMode).toBe('timeOfDay');
  });

  it('keeps voice findings per character, and bounds what a companion file may carry', () => {
    const parsed = parseAppData(
      JSON.stringify({
        version: APP_DATA_VERSION,
        voiceConsistency: {
          ALICE: {
            analyzedAt: 12,
            items: [
              {
                id: 'v1',
                type: 'voice',
                severity: 'major',
                description: 'Registre trop soutenu.',
                references: [],
              },
            ],
          },
          // Nothing to key a sheet on, and a name no screenplay would hold.
          '': { items: [] },
          [`${'x'.repeat(400)}`]: { items: [] },
          BOB: 'not an object',
        },
      }),
    );

    expect(parsed?.voiceConsistency['ALICE']?.items[0]?.type).toBe('voice');
    expect(parsed?.voiceConsistency['ALICE']?.analyzedAt).toBe(12);
    expect(parsed?.voiceConsistency['']).toBeUndefined();
    expect(parsed?.voiceConsistency['BOB']).toBeUndefined();
    expect(Object.keys(parsed?.voiceConsistency ?? {}).every((key) => key.length <= 200)).toBe(true);
  });

  it('migrates removed Brainstorm and left-side memo tabs to the new panel layout', () => {
    const parsed = parseAppData(
      JSON.stringify({
        version: APP_DATA_VERSION,
        sidebar: { activeTab: 'syntax' },
        preview: { activeTab: 'brainstorm' },
      }),
    );
    expect(parsed?.sidebar.activeTab).toBe('structure');
    expect(parsed?.preview.activeTab).toBe('statistics');
  });
});

describe('companion file IO', () => {
  it('derives the required filename from the screenplay path', () => {
    expect(companionPath('/films/story.fountain')).toBe('/films/story.fountain.appdata.json');
  });

  it('writes atomically and reads through the screenplay path', async () => {
    const screenplay = join(directory, 'story.fountain');
    const data = createDefaultAppData();
    data.sidebar.filter = 'garage';

    await writeAppData(screenplay, data);

    expect(await companionExists(screenplay)).toBe(true);
    expect(await readAppData(screenplay)).toEqual(data);
    expect(JSON.parse(await readFile(companionPath(screenplay), 'utf8'))).toEqual(data);
  });

  it('returns null for a missing or malformed companion', async () => {
    const screenplay = join(directory, 'missing.fountain');
    expect(await readAppData(screenplay)).toBeNull();

    await writeFile(companionPath(screenplay), '{"version":1,"sidebar":', 'utf8');
    expect(await readAppData(screenplay)).toBeNull();
  });
});

describe('defaults live inside their own bounds', () => {
  it('survives a round trip unchanged, whatever the shipped defaults are', () => {
    // A default outside its clamp range is silently rewritten on the next open, which reads as
    // the application refusing a preference it offered.
    const defaults = createDefaultAppData();
    expect(parseAppData(serializeAppData(defaults))).toEqual(defaults);
  });
});
