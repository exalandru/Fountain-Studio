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
      }),
    );

    expect(parsed?.sidebar.width).toBe(220);
    expect(parsed?.sidebar.filter).toHaveLength(200);
    expect(parsed?.preview.width).toBe(760);
    expect(parsed?.sidebar.activeTab).toBe('structure');
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
