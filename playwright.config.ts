import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests against the actual Electron application build.
 *
 * They execute the content of `out/`, so `npm run build` must run first.
 * One worker: some journey tests share their application's userData directory.
 */
export default defineConfig({
  testDir: './test/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  /**
   * On CI, an HTML report alongside the console list.
   *
   * Without it a failing run leaves nothing behind: the workflow's failure step finds no
   * `playwright-report/` to upload, so the only trace of, say, a Windows-only failure is
   * whatever scrolled past in the log.
   *
   * Deliberately no `use: { screenshot, trace, video }`. Those are captured by the fixtures
   * behind Playwright's own `page`, and every spec here launches its own application with
   * `electron.launch()` — the options would look like protection and produce nothing.
   */
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : [['list']],
});
