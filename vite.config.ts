import { defineConfig, type Plugin } from 'vite';
import type { Server } from 'node:http';
import { attachSignaling } from './server/signaling.ts';
import { versioning } from './tools/build/versioning.ts';

/** Serve the LAN signaling endpoint (/signal) from the dev server too, so netplay works with `npm run dev`. */
function signaling(): Plugin {
  return {
    name: 'boombuds-signaling',
    configureServer(server) {
      if (server.httpServer) attachSignaling(server.httpServer as Server);
    },
    configurePreviewServer(server) {
      if (server.httpServer) attachSignaling(server.httpServer as Server);
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [signaling(), versioning()],
  // the menus are Preact components (src/menu/*.tsx)
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  server: {
    host: true,
    port: 5173,
    // dev tools write screenshots, builds and logs there: no reloads for them
    watch: { ignored: ['**/tmp/**', '**/dist/**', '**/test-results/**'] },
  },
  preview: {
    host: true,
    port: 4173,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 0,
    sourcemap: true,
    // no "plugins took long" notes: emptying dist/ of the 40 MB of game data is the slow part, and expected
    rolldownOptions: { checks: { bundlerTimings: false } },
  },
});
