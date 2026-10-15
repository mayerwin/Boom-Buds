// Logo and title screens (docs/re/screens.md §3).

import type { Game } from '../app/Game.ts';
import { K } from '../ui/menuInput.ts';
import { isRealKey } from '../ui/ui.ts';

/**
 * screen_show_pcx(name, wait) (0x42a088): one black frame, then the picture with its own palette; with
 * `wait`, until Enter/Esc/Space or V12 (7) seconds have passed (second granularity, so 7-8 s).
 */
export async function screenShowPcx(g: Game, name: string, wait: boolean): Promise<void> {
  const ui = g.ui;
  await ui.blackFrame();
  await ui.ownPaletteScreen(name);
  ui.restore();
  await ui.present();
  ui.flushInput();
  if (!wait) return;
  let start = Math.floor(Date.now() / 1000);
  const timeout = ui.value(12);
  let unlocked = g.app.audio.unlocked;
  for (;;) {
    ui.restore();
    let k = await ui.flip();
    // Browsers only allow audio after a first key press or tap: when that happens on this screen, the
    // title music starts now, so give the picture its full time again.
    if (!unlocked && g.app.audio.unlocked) {
      unlocked = true;
      start = Math.floor(Date.now() / 1000);
    }
    if (start + timeout < Math.floor(Date.now() / 1000)) k = K.ENTER;
    // a tap (or a click, see Ui.pointerMenus) dismisses the picture (the original ignored the mouse here)
    if (k === K.MOUSE && ui.pointerMenus) k = K.ENTER;
    if (isRealKey(k)) ui.letter();
    if (k === K.ENTER || k === K.ESC || k === K.SPACE) {
      ui.menuExit();
      break;
    }
  }
}

/**
 * title_screens (0x42b060). Boom Buds shows only its own title picture: the Interplay / Hudson Soft logos
 * and the "Atomic Bomberman!" announcer line (voice 2800) belong to the original product and are left out
 * (docs/DIFFERENCES.md).
 */
export async function titleScreens(g: Game): Promise<void> {
  const ui = g.ui;
  g.app.audio.playMusic(1000);
  await screenShowPcx(g, 'title', true);
  await ui.blackFrame();
  ui.gamePalette();
}
