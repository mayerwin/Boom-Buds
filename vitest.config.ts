import { defineConfig } from 'vitest/config';
import { versioning } from './tools/build/versioning.ts';

// Unit tests only (tests/e2e holds the Playwright browser tests, run with `npm run e2e`).
export default defineConfig({
  plugins: [versioning()],
  test: {
    include: ['tests/*.test.ts'],
    // the simulation and AI tests play whole rounds: generous limits for slow or busy machines
    testTimeout: 60_000,
  },
});
