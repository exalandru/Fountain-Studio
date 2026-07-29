import { defineConfig } from '@playwright/test';

/**
 * Tests de bout en bout sur l'application Electron réellement empaquetée.
 *
 * Ils s'exécutent sur le contenu de `out/`, donc `npm run build` doit avoir été lancé.
 * Un seul worker : les tests partagent le dossier userData de l'application.
 */
export default defineConfig({
  testDir: './test/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
});
