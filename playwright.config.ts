import { defineConfig } from '@playwright/test';

// End-to-end tests: the real game in Chrome, served by the Vite dev server (started automatically), or by
// any running server given as E2E_URL (e.g. the local server with a production build: npm start, then
// E2E_URL=http://localhost:8080/ npm run e2e).
const external = process.env.E2E_URL;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  workers: 1,
  use: {
    channel: 'chrome',
    viewport: { width: 640, height: 480 },
    deviceScaleFactor: 1,
    baseURL: external ?? 'http://localhost:5173/',
    launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
  },
  webServer: external
    ? undefined
    : {
        command: 'npx vite --port 5173 --strictPort',
        url: 'http://localhost:5173/',
        reuseExistingServer: true,
        timeout: 60_000,
      },
});
