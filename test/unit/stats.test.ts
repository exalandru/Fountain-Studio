import { describe, expect, it } from 'vitest';
import { parse } from '../../src/shared/fountain/index.js';
import {
  calculateStatistics,
  statisticsToCsv,
  statisticsToJson,
} from '../../src/shared/stats/index.js';

const screenplay = parse(`INT. KITCHEN - DAY

ALICE
Hello there.

EXT. STREET - NIGHT

ALICE
Goodbye.

BOB
Wait!
`);

describe('screenplay statistics', () => {
  it('shares its page count with production pagination', () => {
    const result = calculateStatistics(screenplay);
    expect(result.statistics.pageCount).toBe(result.pagination.pages.length);
    expect(result.statistics.sceneCount).toBe(2);
    expect(result.statistics.characterCount).toBe(2);
    expect(result.statistics.locationCount).toBe(2);
    expect(result.statistics.speechCount).toBe(3);
    expect(result.statistics.estimatedMinutes).toBe(result.statistics.pageCount);
  });

  it('classifies dialogue, locations and times of day', () => {
    const { statistics } = calculateStatistics(screenplay);
    expect(statistics.dialogueLines).toBeGreaterThan(0);
    expect(statistics.actionLines).toBeGreaterThan(0);
    expect(statistics.actionPercent + statistics.dialoguePercent).toBe(100);
    expect(statistics.intExt).toEqual({ int: 1, ext: 1, mixed: 0, other: 0 });
    expect(statistics.timeOfDay).toEqual({ day: 1, night: 1, other: 0 });
    expect(statistics.characters[0]).toMatchObject({ name: 'ALICE', speeches: 2 });
  });

  it('exports deterministic CSV and JSON', () => {
    const { statistics } = calculateStatistics(screenplay);
    expect(statisticsToCsv(statistics)).toContain(
      'record_type,key,name,value,pages,eighths,estimated_minutes,speeches,words,scenes',
    );
    expect(statisticsToCsv(statistics)).toContain('summary,page_count');
    expect(statisticsToCsv(statistics)).toContain('character,,ALICE');
    expect(statisticsToCsv(statistics)).toContain('INT. KITCHEN - DAY');
    expect(JSON.parse(statisticsToJson(statistics))).toMatchObject({ sceneCount: 2 });
  });

  it('applies the configurable minutes-per-page ratio', () => {
    const { statistics } = calculateStatistics(screenplay, 'letter', 1.5);
    expect(statistics.minutesPerPage).toBe(1.5);
    expect(statistics.estimatedMinutes).toBe(statistics.pageCount * 1.5);
  });
});
