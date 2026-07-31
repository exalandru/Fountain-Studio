import type { IntExt } from '@shared/fountain/index.js';
import { classifyTimeOfDay } from '@shared/fountain/index.js';

/**
 * How a scene is coloured, shared by the timeline and the corkboard.
 *
 * One definition rather than two: the two views sit on the same screen, and a scene shown
 * blue in one and green in the other would be read as two different things.
 */
export type SceneColorMode = 'intExt' | 'timeOfDay' | 'none';

/** Colour class suffix, or `null` when the view asks for no colour at all. */
export function sceneColor(
  scene: { intExt: IntExt | null; timeOfDay: string | null },
  mode: SceneColorMode,
): string | null {
  if (mode === 'none') return null;
  if (mode === 'timeOfDay') return classifyTimeOfDay(scene.timeOfDay);
  if (scene.intExt === 'INT') return 'interior';
  if (scene.intExt === 'EXT' || scene.intExt === 'EST') return 'exterior';
  if (scene.intExt === 'INT/EXT') return 'mixed';
  return 'other';
}
