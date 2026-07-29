import type { Screenplay } from '../fountain/index.js';
import { countWords } from '../fountain/index.js';
import type { PageFormat, PaginationResult } from '../pagination/index.js';
import { paginateScreenplay } from '../pagination/index.js';

export interface SceneStatistic {
  number: string;
  heading: string;
  pages: number;
  eighths: number;
  estimatedMinutes: number;
}

export interface CharacterStatistic {
  name: string;
  speeches: number;
  words: number;
  scenes: number;
}

export interface ScreenplayStatistics {
  format: PageFormat;
  pageCount: number;
  sceneCount: number;
  wordCount: number;
  characterCount: number;
  locationCount: number;
  speechCount: number;
  minutesPerPage: number;
  estimatedMinutes: number;
  actionLines: number;
  dialogueLines: number;
  actionPercent: number;
  dialoguePercent: number;
  averageSceneEighths: number;
  intExt: { int: number; ext: number; mixed: number; other: number };
  timeOfDay: { day: number; night: number; other: number };
  scenes: SceneStatistic[];
  characters: CharacterStatistic[];
}

export interface StatisticsResult {
  pagination: PaginationResult;
  statistics: ScreenplayStatistics;
}

const DAY_VALUES = new Set([
  'DAY',
  'JOUR',
  'DAWN',
  'AUBE',
  'MORNING',
  'MATIN',
  'AFTERNOON',
  'APRÈS-MIDI',
  'APRES-MIDI',
]);
const NIGHT_VALUES = new Set([
  'NIGHT',
  'NUIT',
  'DUSK',
  'CRÉPUSCULE',
  'CREPUSCULE',
  'EVENING',
  'SOIR',
]);

function round(value: number, precision = 1): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

/** Calculates every M3 metric from the same production pagination used by PDF. */
export function calculateStatistics(
  screenplay: Screenplay,
  format: PageFormat = 'a4',
  minutesPerPage = 1,
): StatisticsResult {
  const pagination = paginateScreenplay(screenplay, { format });
  const sceneLines = new Array<number>(screenplay.scenes.length).fill(0);
  let actionLines = 0;
  let dialogueLines = 0;

  for (const page of pagination.pages) {
    for (const item of page.items) {
      const lines = item.lines.length + item.leadingLines;
      if (item.sceneIndex !== null)
        sceneLines[item.sceneIndex] = (sceneLines[item.sceneIndex] ?? 0) + lines;
      if (item.elementIndex === null) continue;
      if (item.kind === 'dialogue' || item.kind === 'parenthetical' || item.kind === 'character') {
        dialogueLines += lines;
      } else if (
        item.kind === 'action' ||
        item.kind === 'scene_heading' ||
        item.kind === 'transition' ||
        item.kind === 'centered' ||
        item.kind === 'lyrics'
      ) {
        actionLines += lines;
      }
    }
  }

  const classifiedLines = actionLines + dialogueLines;
  const scenes = screenplay.scenes.map((scene, index) => {
    const pages = (sceneLines[index] ?? 0) / pagination.linesPerPage;
    const eighths = Math.max(1, Math.round(pages * 8));
    return {
      number: scene.number,
      heading: scene.heading,
      pages: round(pages, 3),
      eighths,
      estimatedMinutes: round(pages * minutesPerPage),
    };
  });

  const intExt = { int: 0, ext: 0, mixed: 0, other: 0 };
  const timeOfDay = { day: 0, night: 0, other: 0 };
  for (const scene of screenplay.scenes) {
    if (scene.intExt === 'INT') intExt.int++;
    else if (scene.intExt === 'EXT' || scene.intExt === 'EST') intExt.ext++;
    else if (scene.intExt === 'INT/EXT') intExt.mixed++;
    else intExt.other++;

    const time = scene.timeOfDay?.toUpperCase() ?? '';
    if (DAY_VALUES.has(time)) timeOfDay.day++;
    else if (NIGHT_VALUES.has(time)) timeOfDay.night++;
    else timeOfDay.other++;
  }

  let wordCount = 0;
  for (const element of screenplay.elements) {
    if (element.kind !== 'note' && element.kind !== 'boneyard') {
      wordCount += countWords(element.text);
    }
  }

  return {
    pagination,
    statistics: {
      format,
      pageCount: pagination.pages.length,
      sceneCount: screenplay.scenes.length,
      wordCount,
      characterCount: screenplay.characters.size,
      locationCount: screenplay.locations.size,
      speechCount: [...screenplay.characters.values()].reduce(
        (total, character) => total + character.speeches,
        0,
      ),
      minutesPerPage,
      estimatedMinutes: round(pagination.pages.length * minutesPerPage),
      actionLines,
      dialogueLines,
      actionPercent: classifiedLines === 0 ? 0 : round((actionLines / classifiedLines) * 100),
      dialoguePercent: classifiedLines === 0 ? 0 : round((dialogueLines / classifiedLines) * 100),
      averageSceneEighths:
        scenes.length === 0
          ? 0
          : round(scenes.reduce((total, scene) => total + scene.eighths, 0) / scenes.length),
      intExt,
      timeOfDay,
      scenes,
      characters: [...screenplay.characters.values()]
        .map((character) => ({
          name: character.name,
          speeches: character.speeches,
          words: character.words,
          scenes: character.sceneIndexes.length,
        }))
        .sort(
          (left, right) => right.speeches - left.speeches || left.name.localeCompare(right.name),
        ),
    },
  };
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Stable rectangular table containing summaries, distributions, characters and scenes. */
export function statisticsToCsv(statistics: ScreenplayStatistics): string {
  const rows = [
    [
      'record_type',
      'key',
      'name',
      'value',
      'pages',
      'eighths',
      'estimated_minutes',
      'speeches',
      'words',
      'scenes',
    ],
    ['summary', 'page_count', '', statistics.pageCount],
    ['summary', 'scene_count', '', statistics.sceneCount],
    ['summary', 'word_count', '', statistics.wordCount],
    ['summary', 'character_count', '', statistics.characterCount],
    ['summary', 'location_count', '', statistics.locationCount],
    ['summary', 'speech_count', '', statistics.speechCount],
    ['summary', 'minutes_per_page', '', statistics.minutesPerPage],
    ['summary', 'estimated_minutes', '', statistics.estimatedMinutes],
    ['distribution', 'action_percent', '', statistics.actionPercent],
    ['distribution', 'dialogue_percent', '', statistics.dialoguePercent],
    ['distribution', 'interior_scenes', '', statistics.intExt.int],
    ['distribution', 'exterior_scenes', '', statistics.intExt.ext],
    ['distribution', 'mixed_scenes', '', statistics.intExt.mixed],
    ['distribution', 'day_scenes', '', statistics.timeOfDay.day],
    ['distribution', 'night_scenes', '', statistics.timeOfDay.night],
    ...statistics.characters.map((character) => [
      'character',
      '',
      character.name,
      '',
      '',
      '',
      '',
      character.speeches,
      character.words,
      character.scenes,
    ]),
    ...statistics.scenes.map((scene) => [
      'scene',
      scene.number,
      scene.heading,
      '',
      scene.pages,
      scene.eighths,
      scene.estimatedMinutes,
    ]),
  ];
  const columnCount = rows[0]?.length ?? 0;
  return `${rows
    .map((row) => [...row, ...Array(Math.max(0, columnCount - row.length)).fill('')])
    .map((row) => row.map(csvCell).join(','))
    .join('\n')}\n`;
}

export function statisticsToJson(statistics: ScreenplayStatistics): string {
  return `${JSON.stringify(statistics, null, 2)}\n`;
}
