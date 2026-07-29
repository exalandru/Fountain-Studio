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
  reporter: [['list']],
});
