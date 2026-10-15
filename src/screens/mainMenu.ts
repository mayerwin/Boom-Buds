// Main menu (docs/re/screens.md §4 and §23). Returns true when the player confirmed "Exit".

import type { Game } from '../app/Game.ts';
import { K } from '../ui/menuInput.ts';
import { matchPlay } from './match.ts';
import { settingsScreen } from './settings.ts';
import { helpScreen, helpViewFile } from '../ui/helpViewer.ts';
import { netStartGameScreen, netJoinGameScreen } from './network.ts';
import { editorEnter } from './editor.ts';

const ITEMS = 7;

export async function mainMenu(g: Game): Promise<boolean> {
  const ui = g.ui;
  const app = g.app;
  const s = g.session;
  let sel = 0;
  let anim = 0;
  for (;;) {
    // (re-)entry
    let idleStart = performance.now();
    if (s.attract) {
      const r = s.restoreInputs();
      s.attract = 0;
      if (r) {
        g.settings.levelno = r.level;
        g.settings.team_play = r.teamPlay;
      }
    }
    ui.flushInput();
    await ui.setBackground('MAINMENU');
    ui.mouseHide();
    ui.flushInput();
    let music = true;
    let ctrlE = 0;
    let done = false;
    let attract = false;
    let reenter = false;
    while (!done) {
      ui.restore();
      ui.sprite(ui.value(700), ui.value(701) + ui.value(702) * sel, ui.seqFrame('bomb trigger green', anim++ % 19));
      ui.print('V1.1', 50, 0, 0, ui.col.grey, ui.col.black); // the original says V1.0; this is the web version
      let k = await ui.flip();
      if (music) {
        app.audio.playMusic(1010);
        music = false;
      }
      // touch or mouse (Ui.pointerMenus): tapping an item selects and activates it
      if (k === K.MOUSE && ui.pointerMenus) {
        const t = ui.taps[0];
        const item = Math.floor((t.y - (ui.value(701) - 31)) / ui.value(702));
        if (t.x >= 300 && item >= 0 && item < ITEMS) {
          sel = item;
          k = K.ENTER;
        }
      }
      if (k !== -1 && k !== -2) {
        ui.letter();
        idleStart = performance.now();
      }
      const v92 = ui.value(92);
      if ((k === -1 || k === -2) && v92 > 5 && performance.now() - idleStart > v92 * 1000) {
        attract = true;
        break;
      }
      switch (k) {
        case K.ENTER:
        case K.SPACE:
          ui.menuExit();
          done = true;
          break;
        case K.CTRL_Q:
        case K.ESC:
          ui.menuExit();
          sel = 6;
          done = true;
          break;
        case K.CTRL_E:
          if (++ctrlE > 5) {
            ctrlE = 0;
            ui.menuExit();
            await editorEnter(g);
            done = true;
            reenter = true; // back to the menu entry, selection unchanged
          }
          break;
        case K.ALT_O:
          ui.menuExit();
          sel = 3;
          done = true;
          break;
        case K.ALT_A:
          attract = true;
          done = true;
          break;
        case K.ALT_D:
          await g.debugWindow();
          break;
        case K.F1:
          ui.menuExit();
          sel = 5;
          done = true;
          break;
        case K.UP:
          if (--sel < 0) sel = 6;
          break;
        case K.DOWN:
          if (++sel > 6) sel = 0;
          break;
        case -1:
        case -2:
          break;
        default:
          ctrlE = 0;
      }
    }
    if (reenter) continue;
    if (attract) {
      s.attract = 1;
      s.saveInputs(g.settings.levelno, g.settings.team_play);
      g.settings.team_play = 0;
      sel = 0;
    }
    switch (sel) {
      case 0:
        await matchPlay(g);
        break;
      case 1:
        await netStartGameScreen(g);
        break;
      case 2:
        await netJoinGameScreen(g);
        break;
      case 3:
        await settingsScreen(g);
        sel = 0;
        break;
      case 4:
        await helpViewFile(ui, g.dlg, 'credits.bm');
        break;
      case 5:
        await helpScreen(ui, g.dlg);
        break;
      case 6:
        if (await g.confirmExit()) return true;
        sel = 0;
        break;
    }
  }
}
