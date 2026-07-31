/**
 * Renders `build/icon.svg` to `build/icon.png`.
 *
 * The export is a script rather than a manual step because the manual step is what produced the
 * icon this replaces: a 2048×1984 PNG exported from a square source, which electron-builder then
 * had to distort into an `.icns`.
 *
 * Electron does the rasterising. It is already the application's runtime, so no image toolchain
 * and no extra browser download enters the project for one file — and the pixels come from the
 * very engine that draws the interface.
 *
 * CommonJS rather than an ES module: Electron's `electron` module has no named ESM exports, and
 * from a `.mjs` entry the name resolves to the npm shim — which is a path to the binary, not the
 * API. `.cjs` sidesteps the whole question, and Electron runs it as a main script directly.
 *
 * Usage: npm run icon:render -- [--source build/icon.svg] [--out build/icon.png] [--size 1024]
 */
const { readFile, writeFile } = require('node:fs/promises');
const { resolve } = require('node:path');
const { app, BrowserWindow } = require('electron');

/** @returns {{ source: string, out: string, size: number }} */
function parseArguments() {
  // Electron puts the script path in argv, so the flags are read by name rather than by position.
  const argv = process.argv;
  const value = (name) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const raw = value('size') ?? '1024';
  const size = Number(raw);
  if (!Number.isInteger(size) || size < 16 || size > 4096) {
    throw new Error(`--size must be an integer between 16 and 4096, got ${raw}`);
  }
  return { source: value('source') ?? 'build/icon.svg', out: value('out') ?? 'build/icon.png', size };
}

/**
 * The SVG inlined into a page of exactly the target size.
 *
 * The transparent background matters: a macOS icon leaves room around its squircle, and a page
 * painted white would fill that room with white instead of with nothing.
 */
function documentFor(svg, size) {
  return `<!doctype html><meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; background: transparent; }
  svg { display: block; width: ${size}px; height: ${size}px; }
</style>
${svg}`;
}

async function main() {
  if (!app) {
    // The Electron binary behaves as plain Node when ELECTRON_RUN_AS_NODE is set, and then the
    // `electron` module resolves to the path of the binary instead of the API. Worth naming:
    // the symptom is a bare `undefined` and it costs an hour to work out.
    throw new Error(
      'Run this through Electron, not Node — `npm run icon:render` — with ELECTRON_RUN_AS_NODE unset.',
    );
  }
  const { source, out, size } = parseArguments();
  const svg = await readFile(resolve(source), 'utf8');

  await app.whenReady();
  const window = new BrowserWindow({
    width: size,
    height: size,
    show: false,
    transparent: true,
    frame: false,
    // Off-screen rendering at exactly one device pixel per CSS pixel, so the PNG is the size asked
    // for on a Retina machine as well.
    webPreferences: { offscreen: true, zoomFactor: 1 },
  });
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(documentFor(svg, size))}`);
  // A capture comes back at the display's scale factor, so on a Retina machine a 1024 px canvas
  // yields 2048 px — which is exactly how the icon this replaces ended up 2048×1984. Resizing
  // afterwards makes the output the size that was asked for on any machine, and downsampling a
  // supersampled vector render is if anything cleaner than rasterising straight to 1024.
  const captured = await window.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  const image = captured.resize({ width: size, height: size, quality: 'best' });
  await writeFile(resolve(out), image.toPNG());
  const { width, height } = image.getSize();
  if (width !== size || height !== size) {
    throw new Error(`expected ${size}×${size}, produced ${width}×${height}`);
  }
  // Printed so a wrong size is caught at the moment of export rather than at packaging time.
  console.log(`${out} — ${width}×${height}`);
  window.destroy();
  app.quit();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
