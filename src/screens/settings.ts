// Settings screen (main menu "Options") and its dialogs: docs/re/screens.md §8, match-flow.md §1.3.

import type { Game } from '../app/Game.ts';
import { K } from '../ui/menuInput.ts';
import { isRealKey } from '../ui/ui.ts';
import { helpScreen } from '../ui/helpViewer.ts';
import { ScreenButtons, TEXT_SHADOW } from '../ui/gnw.ts';
import { classicLayouts, resetClassicLayouts, setClassicKey } from '../app/controls.ts';
import { allSchemes } from '../app/schemes.ts';

const ROWS = 18;
const PLAYTIMES = [60, 90, 120, 150, 180, 240, 300, 600, 1001];

/** g_scancode_names (index = scancode & 0x7f) */
export const SCANCODE_NAMES: string[] = (() => {
  const n: string[] = new Array(0x80).fill('');
  const set = (i: number, s: string) => (n[i] = s);
  set(0x01, 'Esc');
  '1234567890'.split('').forEach((c, i) => set(0x02 + i, c));
  set(0x0c, '-_'); set(0x0d, '+='); set(0x0e, 'BS'); set(0x0f, 'Tab');
  'QWERTYUIOP'.split('').forEach((c, i) => set(0x10 + i, c));
  set(0x1a, '[{'); set(0x1b, ']}'); set(0x1c, 'Enter'); set(0x1d, 'Ctrl');
  'ASDFGHJKL'.split('').forEach((c, i) => set(0x1e + i, c));
  set(0x27, ';'); set(0x28, "'"); set(0x29, '`~'); set(0x2a, 'LShift'); set(0x2b, '\\|');
  'ZXCVBNM'.split('').forEach((c, i) => set(0x2c + i, c));
  set(0x33, ',<'); set(0x34, '.>'); set(0x35, '/?'); set(0x36, 'RShift'); set(0x37, '(*)'); set(0x38, 'Alt');
  set(0x39, 'Space'); set(0x3a, 'Caps');
  for (let i = 0; i < 10; i++) set(0x3b + i, `F${i + 1}`);
  set(0x45, 'Num'); set(0x46, 'Scroll'); set(0x47, '(7)Home'); set(0x48, '(8)Up'); set(0x49, '(9)PgUp');
  set(0x4a, '(-)'); set(0x4b, '(4)Left'); set(0x4c, '(5)'); set(0x4d, '(6)Right'); set(0x4e, '(+)');
  set(0x4f, '(1)End'); set(0x50, '(2)Down'); set(0x51, '(3)PgDn'); set(0x52, '(0)Ins'); set(0x53, '(.)Del');
  set(0x57, 'F11'); set(0x58, 'F12');
  return n;
})();

export function playtimeString(g: Game, t: number): string {
  return t === 1001 ? g.ui.msg(280) : g.ui.fmt(281, Math.trunc(t / 60), t % 60);
}

/** settings_playtime_step (0x4076fe) */
function playtimeStep(g: Game, dir: number): void {
  const st = g.settings;
  let i = PLAYTIMES.indexOf(st.playtime);
  if (i < 0) {
    st.playtime = g.ui.value(100);
    return;
  }
  i = dir >= 1 ? (i + 1) % PLAYTIMES.length : (i + PLAYTIMES.length - 1) % PLAYTIMES.length;
  st.playtime = PLAYTIMES[i];
}

function yesNo(g: Game, v: number): string {
  return g.ui.msg(25 + (v ? 1 : 0));
}

function rowText(g: Game, i: number): string {
  const ui = g.ui;
  const st = g.settings;
  switch (i) {
    case 0: return ui.fmt(250, yesNo(g, st.team_play));
    case 1: return ui.fmt(251, yesNo(g, st.random_start));
    case 2: return ui.fmt(252, st.nodename);
    case 3: return ui.fmt(253, ui.msg(295 + st.conveyor_speed));
    case 4: return ui.fmt(254, yesNo(g, st.stomped_bombs_detonate));
    case 5: return ui.fmt(255, yesNo(g, st.win_by_kills));
    case 6: return ui.fmt(256, yesNo(g, st.goldman));
    case 7: return ui.fmt(257, ui.msg(315 + st.enclosement_depth));
    case 8: return ui.fmt(258, st.schemefilename);
    case 9: return ui.fmt(259, playtimeString(g, st.playtime));
    case 10: return ui.fmt(260, yesNo(g, st.assign_keyboards));
    case 11: return ui.fmt(261, yesNo(g, st.diseases_destroyable));
    case 12: return ui.fmt(262, yesNo(g, st.lost_net_revert_ai));
    case 13: return ui.fmt(263, yesNo(g, st.disable_game_music));
    case 14: return ui.fmt(264, st.modemport, st.modemirq, st.modembaud, st.modemdial);
    case 15: return ui.msg(265);
    case 16: return ui.msg(266);
    default: return ui.fmt(267, yesNo(g, st.smallmemory === 0 ? 1 : 0));
  }
}

/** settings_screen (0x4080dc) */
export async function settingsScreen(g: Game): Promise<void> {
  const ui = g.ui;
  const st = g.settings;
  await ui.randomGlue();
  ui.restore();
  await ui.present();
  ui.flushInput();
  let sel = 0;
  const X = ui.value(745), Y = ui.value(746), YS = ui.value(747), W = ui.value(748);
  for (;;) {
    ui.restore();
    for (let i = 0; i < ROWS; i++) ui.print(rowText(g, i), W, X, Y + YS * i, ui.col.white, ui.col.black);
    ui.cursor(X - 20, Y + YS * sel + 16);
    ui.pressF1();
    let k = await ui.flip();
    if (k === K.MOUSE && ui.pointerMenus) {
      // touch or mouse (Ui.pointerMenus): tap a row to move the cursor there, tap the selected row to activate it
      const t = ui.taps[0];
      const row = Math.floor((t.y - Y) / YS);
      if (row >= 0 && row < ROWS && t.x >= X - 30 && t.x < X + W) {
        if (row === sel) k = K.ENTER;
        else sel = row;
      }
    }
    if (isRealKey(k)) ui.letter();
    if (k === K.UP) {
      if (--sel < 0) sel = ROWS - 1;
      continue;
    }
    if (k === K.DOWN) {
      if (++sel >= ROWS) sel = 0;
      continue;
    }
    if (k === K.ESC) {
      g.app.saveSettings();
      return;
    }
    if (k === K.F1) {
      await helpScreen(ui, g.dlg);
      continue;
    }
    const inc = k === K.ENTER || k === K.SPACE || k === K.RIGHT;
    const dec = k === K.LEFT;
    if (!inc && !dec) continue;
    switch (sel) {
      case 0:
        st.team_play = st.team_play ? 0 : 1;
        g.session.goldPlayer = -1;
        if (st.team_play) st.win_by_kills = 0;
        break;
      case 1:
        st.random_start = st.random_start ? 0 : 1;
        break;
      case 2: {
        const r = await g.dlg.getString(st.nodename, 30, ui.msg(290), 25, 180);
        if (r !== null) st.nodename = r;
        break;
      }
      case 3:
        st.conveyor_speed = inc ? (st.conveyor_speed + 1) % ui.value(189) : (st.conveyor_speed + ui.value(189) - 1) % ui.value(189);
        break;
      case 4:
        st.stomped_bombs_detonate = st.stomped_bombs_detonate ? 0 : 1;
        break;
      case 5:
        st.win_by_kills = st.win_by_kills ? 0 : 1;
        if (st.team_play) st.win_by_kills = 0;
        break;
      case 6:
        st.goldman = st.goldman ? 0 : 1;
        g.session.goldPlayer = -1;
        break;
      case 7:
        st.enclosement_depth = inc ? (st.enclosement_depth + 1) % ui.value(28) : (st.enclosement_depth + ui.value(28) - 1) % ui.value(28);
        break;
      case 8:
        await chooseScheme(g);
        break;
      case 9:
        playtimeStep(g, inc ? 1 : -1);
        break;
      case 10:
        st.assign_keyboards = st.assign_keyboards ? 0 : 1;
        break;
      case 11:
        st.diseases_destroyable = st.diseases_destroyable ? 0 : 1;
        break;
      case 12:
        st.lost_net_revert_ai = st.lost_net_revert_ai ? 0 : 1;
        break;
      case 13:
        st.disable_game_music = st.disable_game_music ? 0 : 1;
        break;
      case 14:
        await modemDialogs(g);
        break;
      case 15:
        await keydefsScreen(g);
        break;
      case 16:
        await chooseProtocol(g);
        break;
      case 17:
        await memoryModel(g);
        break;
    }
    g.app.saveSettings();
  }
}

/** options_choose_scheme (0x407582) */
async function chooseScheme(g: Game): Promise<void> {
  const ui = g.ui;
  const schemes = allSchemes(g.app);
  if (!schemes.length) {
    await g.dlg.msgboxOk(ui.msg(95), ui.msg(720), ui.col.darkRed, ui.col.yellow);
    return;
  }
  const items = schemes.map((s) => `${s.file.toUpperCase()}: ${s.name}`);
  ui.mouseShow();
  const i = await g.dlg.listSelect(ui.msg(721), items, 100, 100, ui.col.white | TEXT_SHADOW);
  ui.mouseHide();
  if (i >= 0) g.settings.schemefilename = items[i].split(':')[0].toUpperCase();
}

/** settings_modem_dialogs (0x40798b): kept for completeness (the web version has no modem play). */
async function modemDialogs(g: Game): Promise<void> {
  const ui = g.ui;
  const st = g.settings;
  const port = await g.dlg.getString(String(st.modemport), 20, ui.msg(645), 25, 180);
  if (port !== null) st.modemport = parseInt(port, 10) || 0;
  const irq = await g.dlg.getString(String(st.modemirq), 20, ui.msg(646), 25, 180);
  if (irq !== null) st.modemirq = parseInt(irq, 10) || 0;
  const bauds = ['9600', '19200', '38400', '57600', '115200'];
  const b = await g.dlg.listSelect(ui.msg(647), bauds, 100, 100, ui.col.white);
  if (b >= 0) st.modembaud = Number(bauds[b]);
  const phone = await g.dlg.getString(st.modemdial, 30, ui.msg(648), 25, 180);
  if (phone !== null) st.modemdial = phone;
}

/** What Boom Buds says to the brave who pick a protocol of 1997 (it always plays over the Internet). */
const RETRO_PROTOCOL: Record<number, [string, string]> = {
  1: ["IPX? Yeah, right, let's emulate it!", 'Boom Buds plays over the Internet anyway.'],
  2: ['Dialing 555-1212... kssshhh!', 'Just kidding: Boom Buds plays over the Internet.'],
  3: ['A null-modem cable! How retro.', 'Keep it in the drawer: we play over the Internet.'],
};

/**
 * settings_choose_protocol (0x407f4f): only V1110 (4) entries are shown. Boom Buds adds "Internet" at the
 * top (setting 4), which is how it always connects; the original choices are kept, with a wink.
 */
async function chooseProtocol(g: Game): Promise<void> {
  const ui = g.ui;
  const items = ['Internet', ...[629, 631, 632, 633, 634].slice(0, ui.value(1110)).map((m) => ui.msg(m))];
  const i = await g.dlg.listSelect(ui.msg(620), items, 150, 150, ui.col.white);
  if (i === 0) g.settings.netprotocol = 4;
  else if (i >= 1 && i <= 4) {
    g.settings.netprotocol = i - 1;
    const wink = RETRO_PROTOCOL[i - 1];
    if (wink) await g.dlg.msgboxOk(wink[0], wink[1], ui.col.darkRed, ui.col.yellow);
  }
}

/** settings_memory_model (0x407fee): the change takes effect after a restart (the page reloads). */
async function memoryModel(g: Game): Promise<void> {
  const ui = g.ui;
  const st = g.settings;
  ui.mouseShow();
  const r = st.smallmemory === 0
    ? await g.dlg.msgboxYesNo(ui.msg(1322), ui.msg(1323), ui.col.darkRed, ui.col.white)
    : await g.dlg.msgboxYesNo(ui.msg(1320), ui.msg(1321), ui.col.darkRed, ui.col.white);
  if (r === 1) {
    await g.dlg.msgboxOk(ui.msg(1325), ui.msg(1326), ui.col.darkRed, ui.col.white);
    st.smallmemory = st.smallmemory ? 0 : 1;
    g.app.saveSettings();
    location.reload();
    await new Promise(() => {});
  }
  ui.mouseHide();
}

/**
 * keydefs_screen (0x407b9d): layouts KEY 0 / KEY 1, rebinding through mouse clicks on the buttons. In Boom Buds
 * they are the keyboard sets "Keyboard right" and "Keyboard left" of the modern menus (src/app/controls.ts),
 * so a change here shows there and the other way round.
 */
async function keydefsScreen(g: Game): Promise<void> {
  const ui = g.ui;
  const st = g.settings;
  ui.mouseShow();
  ui.flushInput();
  const buttons = new ScreenButtons(g.gnw);
  for (let L = 0; L < 2; L++) {
    for (let a = 0; a < 6; a++) buttons.add(100 + 320 * L, 60 + 60 * a, ui.fmt(1110, L, ui.msg(1120 + a)), 1000 + 1000 * L + a, -1);
  }
  buttons.add(40, 430, ui.msg(1130), 999, -1);
  ui.screenButtons = buttons;
  const draw = () => {
    ui.restore();
    ui.print(ui.msg(1100), 400, 20, 20, ui.col.yellow, ui.col.black);
    for (let L = 0; L < 2; L++) {
      for (let a = 0; a < 6; a++) {
        const code = classicLayouts(st.controls)[L][a] ?? 0;
        if ((code & 0x7f) < 0x59) {
          ui.print(ui.fmt(1140, SCANCODE_NAMES[code & 0x7f]), 200, 100 + 320 * L, 60 + 60 * a + 22, ui.col.white, ui.col.black);
        }
      }
    }
    ui.flushSprites();
    buttons.draw();
  };
  try {
    for (;;) {
      draw();
      const k = await ui.flip();
      if (k > 999 && k < 2999) {
        const L = Math.trunc((k - 1000) / 1000);
        const a = k - 1000 - L * 1000;
        if (L >= 0 && L < 2 && a >= 0 && a < 6) {
          buttons.releaseAll();
          setClassicKey(st.controls, L, a, await captureKey(g, ui.fmt(1110, L, ui.msg(1120 + a))));
          g.app.saveSettings();
        }
      }
      if (k === K.ENTER || k === K.ESC || k === K.SPACE) break;
      if (k === K.F1) await helpScreen(ui, g.dlg);
      else if (k === 999) {
        // GNW redrew the button pressed on the mouse press; the message box then eats the release, so the
        // frozen screen under it (and the screen afterwards) keeps the pressed button
        draw();
        resetClassicLayouts(st.controls);
        g.app.saveSettings();
        await g.dlg.msgboxOk(ui.msg(95), ui.msg(1131), ui.col.white, ui.col.black);
      }
    }
  } finally {
    ui.screenButtons = null;
    buttons.dispose();
    ui.mouseHide();
  }
}

/** keydefs_capture_key (0x407ad9): returns the highest scan code held at the first poll with a key down. */
async function captureKey(g: Game, label: string): Promise<number> {
  const ui = g.ui;
  const input = g.app.input;
  g.dlg.progressTitleSet(ui.fmt(1105, label));
  const under = ui.snapshot();
  const draw = (p: number) => {
    ui.drawSnapshot(under);
    g.dlg.progressDraw(p);
  };
  draw(0);
  await ui.delay(500, () => draw(0));
  ui.flushInput();
  input.down.fill(0);
  let result = 0;
  for (;;) {
    draw(0);
    const k = await ui.flip();
    let done = k === K.ESC;
    for (let i = 0; i < 256; i++) {
      if (input.down[i]) {
        result = i;
        done = true;
      }
    }
    if (done) break;
  }
  ui.drawSnapshot(under);
  g.dlg.progressDraw(100);
  g.app.renderer.deleteTexture(under);
  return result;
}
