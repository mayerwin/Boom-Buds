import { App } from './app/App.ts';
import { Game } from './app/Game.ts';
import { setupOrientationOverlay } from './engine/mobile.ts';
import artUrl from './menu/art/home-bg.webp';
import { watchForUpdates } from './app/update.ts';

async function boot(): Promise<void> {
  // a page served from the browser's cache right after a release reloads before anything else
  watchForUpdates();
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const app = new App(canvas);
  await app.init();
  document.getElementById('boot')?.remove();
  setupOrientationOverlay(artUrl);
  if (app.isTouch) app.setTouchMode(true);
  const game = new Game(app);
  // debugging / automated tests
  (window as unknown as { __boombuds: unknown }).__boombuds = { app, game };
  await game.run();
}

boot().catch((e) => {
  console.error(e);
  const el = document.getElementById('boot');
  if (el) el.textContent = 'Error: ' + (e instanceof Error ? e.message : String(e));
});
