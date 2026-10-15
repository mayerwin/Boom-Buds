// The secret level editor (Ctrl-E x6 on the main menu): editor_enter (0x40330e), the editor main menu
// (0x403184), the scheme editor (0x4028d2, old name team_ring_draw; keys dispatched through the jump table
// at 0x402cb0) and its power-up table editor (0x402595, one entry: 0x4023a2). docs/re/screens.md §19, the
// user documentation is EDITOR.BM.
//
// Like the original, the scheme editor uses the current scheme file setting ("schemefilename") as the name
// of the file being edited; on exit it asks whether that file should stay the current scheme file and puts
// the previous name back otherwise. Saved files go to the browser's storage (src/app/schemes.ts) instead of
// DATA\SCHEMES.

import type { Game } from '../app/Game.ts';
import type { App } from '../app/App.ts';
import type { Scheme } from '../engine/assets.ts';
import type { PointerRecord } from '../engine/input.ts';
import type { Ui } from '../ui/ui.ts';
import { K } from '../ui/menuInput.ts';
import { isRealKey } from '../ui/ui.ts';
import { helpScreen } from '../ui/helpViewer.ts';
import { ScreenButtons, TEXT_SHADOW } from '../ui/gnw.ts';
import { sprintf } from '../ui/text.ts';
import { cellCenterX, cellFeetY, pxToCx, pyToCy } from '../game/sim/map.ts';
import {
  SCHEME_W, SCHEME_H, SCHEME_PLAYERS, SCHEME_POWERS, allSchemes, atoi, basicGrid, parseSchemeText, powerComments,
  resetToBasicGrid, saveCustomScheme, schemeCell, schemeFileName, schemeFileText, schemePath, serializeScheme,
  setSchemeCell,
} from '../app/schemes.ts';

const TILE_NAMES = ['blank', 'solid', 'brick'];

/**
 * Pictures of the cells (global 0x45b7b8, which keeps its value between editor sessions): 0 = the tiles
 * of level 0 ("tile 0 blank/solid/brick"), -1 = the line drawings of EDIT.ANI ("tile -1 ..."). Key '0'.
 */
let tileSet = 0;

/** A touch held this long acts as the right mouse button (touch screens have no second button). */
const LONG_PRESS_MS = 500;

/** 0x402206: animation frame of a cell type (0 blank, 1 solid, 2 brick) in the current tile set. */
function tileFrame(ui: Ui, type: number): number {
  return ui.seqFrame(`tile ${tileSet} ${TILE_NAMES[type] ?? 'blank'}`, 0);
}

/**
 * GNW's mouse_get_position / mouse_get_buttons (bit 0 left, bit 1 right) rebuilt from the pointer
 * records. A press shorter than one frame still counts once (taps on touch screens).
 */
class EditorMouse {
  private readonly app: App;
  private held = 0;
  private latched = 0;
  /** start of the current touch (-1 none) */
  private touchAt = -1;

  constructor(app: App) {
    this.app = app;
  }

  get x(): number {
    return this.app.input.pointerX;
  }

  get y(): number {
    return this.app.input.pointerY;
  }

  update(records: PointerRecord[]): void {
    for (const p of records) {
      const bit = p.button === 0 ? 1 : p.button === 2 ? 2 : 0;
      if (p.type === 'down') {
        this.held |= bit;
        this.latched |= bit;
        if (bit === 1 && p.kind === 'touch') this.touchAt = performance.now();
      } else if (p.type === 'up') {
        this.held &= ~bit;
        if (bit === 1) this.touchAt = -1;
      } else if (bit) {
        // pointer events report a second button pressed or released during a press as a move
        this.held ^= bit;
        if (this.held & bit) this.latched |= bit;
      }
    }
    if (!this.app.input.pointerDown) {
      this.held = 0;
      this.touchAt = -1;
    }
  }

  /** Buttons held now or pressed since the previous call. */
  buttons(): number {
    let b = this.held | this.latched;
    this.latched = 0;
    if (this.touchAt >= 0 && (b & 1) !== 0 && performance.now() - this.touchAt >= LONG_PRESS_MS) b = 2;
    return b;
  }
}

/** editor_enter (0x40330e): team play is off while the editor runs (it colours the player numbers). */
export async function editorEnter(g: Game): Promise<void> {
  const saved = g.settings.team_play;
  g.settings.team_play = 0;
  try {
    await editorMainMenu(g);
  } finally {
    g.settings.team_play = saved;
    // the scheme editor may have changed the current scheme file
    g.app.saveSettings();
  }
}

/** editor_main_menu (0x403184) */
async function editorMainMenu(g: Game): Promise<void> {
  const ui = g.ui;
  const c = ui.col;
  await ui.randomGlue();
  ui.flushInput();
  for (;;) {
    ui.restore();
    // 0x40234e: the title, centred on the screen
    ui.printCentered(ui.msg(700), 320, 10, c.white, c.black);
    ui.print(ui.msg(730), ui.value(813), ui.value(810), ui.value(811), c.yellow, c.black);
    for (let i = 0; i < 3; i++) ui.print(ui.msg(731 + i), ui.value(818), ui.value(815), ui.value(816) + ui.value(817) * i, c.white, c.black);
    const k = await ui.flip();
    if (isRealKey(k)) ui.letter();
    if (k === 0x31) await schemeEditor(g, false);
    else if (k === 0x32) await schemeEditor(g, true);
    else if (k === K.ESC || k === 0x51 || k === 0x71) return;
    else if (k === K.F1) {
      await helpScreen(ui, g.dlg);
      ui.mouseShow();
    }
  }
}

/** options_choose_scheme (0x407582) over the shipped and the saved schemes. */
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

/** scheme_parse (0x403eee) of the file being edited, with its warnings (msgbox_ok, dark red on yellow). */
async function loadScheme(g: Game, name: string): Promise<Scheme> {
  const ui = g.ui;
  const text = schemeFileText(g.app, name);
  if (text === null) {
    await g.dlg.msgboxOk(ui.fmt(711, schemePath(name)), null, ui.col.darkRed, ui.col.yellow);
    return basicGrid(name, g.app.values);
  }
  const warnings: [number, number][] = [];
  const s = parseSchemeText(name, text, g.app.values, (a, b) => warnings.push([a, b]));
  for (const [a, b] of warnings) await g.dlg.msgboxOk(ui.msg(a), ui.msg(b), ui.col.darkRed, ui.col.yellow);
  return s;
}

/** scheme_save (0x403c16) */
async function saveScheme(g: Game, s: Scheme, name: string): Promise<void> {
  const ui = g.ui;
  if (!saveCustomScheme(name, serializeScheme(s, powerComments(g.app)))) {
    await g.dlg.msgboxOk(ui.fmt(710, schemePath(name)), null, ui.col.darkRed, ui.col.yellow);
  }
}

/** The 15x11 cells (0x4022a1): every cell gets the blank tile, then its brick or solid block on top. */
function queueGrid(ui: Ui, s: Scheme): void {
  const blank = tileFrame(ui, 0);
  for (let y = 0; y < SCHEME_H; y++) {
    for (let x = 0; x < SCHEME_W; x++) {
      const px = cellCenterX(x), py = cellFeetY(y);
      ui.sprite(px, py, blank);
      const t = schemeCell(s, x, y);
      if (t !== 0) ui.sprite(px, py, tileFrame(ui, t));
    }
  }
}

/** The scheme editor (0x4028d2). `newFile`: start from the basic grid named msg 729 "Newfile". */
async function schemeEditor(g: Game, newFile: boolean): Promise<void> {
  const ui = g.ui;
  const app = g.app;
  const st = g.settings;
  const c = ui.col;
  const fh = g.gnw.lineHeight;
  await ui.randomGlue();
  const savedName = st.schemefilename;
  let s: Scheme;
  if (newFile) {
    s = basicGrid(ui.msg(729), app.values);
    st.schemefilename = ui.msg(729);
  } else {
    await chooseScheme(g);
    s = await loadScheme(g, st.schemefilename);
  }
  ui.mouseShow();
  // (the original polls the keyboard 10 times, with "delay(10)" doing nothing, then flushes it)
  ui.flushInput();
  const mouse = new EditorMouse(app);
  let brick = 0;
  let player = 0;
  let changes = 0;
  let exit = false;
  while (!exit) {
    ui.restore();
    queueGrid(ui, s);
    const mx = mouse.x, my = mouse.y;
    const buttons = mouse.buttons();
    ui.sprite(mx, my, tileFrame(ui, brick));
    // 0x415b22: the cells and the selected brick are drawn now, under the texts
    ui.flushSprites();
    ui.print(ui.fmt(742, st.schemefilename, s.name), 500, 20, 5, c.white, c.black);
    ui.print(ui.fmt(743, s.density), 500, 20, 23, c.white, c.black);
    ui.print(ui.fmt(738, player + 1), 200, 20, 41, c.white, c.black);
    ui.print(ui.msg(737), 500, 20, 476 - fh, c.white, c.black);
    for (let i = 0; i < SCHEME_PLAYERS; i++) {
      const [sx, sy, team] = s.starts[i];
      const x = cellCenterX(sx) - 20, y = cellFeetY(sy) - 36;
      const [fg, outline] = c.player(i, -1);
      ui.print(sprintf('%u', i + 1), 40, x, y, fg, outline);
      ui.sprite(x, y, ui.seqFrame(`teamring${team}`, 0));
    }
    const k = await ui.flip();
    mouse.update(ui.input.pointer);
    if (buttons & 1) {
      // left button: paint the selected brick (counts as a change even outside the field)
      setSchemeCell(s, pxToCx(mx), pyToCy(my), brick);
      changes++;
    }
    if (buttons & 2) {
      // right button: the selected player starts on the nearest cell
      const cx = Math.max(0, Math.min(SCHEME_W - 1, pxToCx(mx)));
      const cy = Math.max(0, Math.min(SCHEME_H - 1, pyToCy(my)));
      s.starts[player] = [cx, cy, s.starts[player][2]];
      changes++;
    }
    switch (k) {
      case K.F1:
        await helpScreen(ui, g.dlg);
        ui.mouseShow();
        break;
      case 0x2b: // '+'
      case 0x3d: // '='
        if (++player >= SCHEME_PLAYERS) player = 0;
        break;
      case 0x2d: // '-'
      case 0x5f: // '_'
        if (--player < 0) player = SCHEME_PLAYERS - 1;
        break;
      case 0x31:
        brick = 0;
        break;
      case 0x32:
        brick = 1;
        break;
      case 0x33:
        brick = 2;
        break;
      case 0x30:
        // graphics / line drawing view
        if (++tileSet > 0) tileSet = -1;
        break;
      case 0x50: // 'P'
      case 0x70:
        await powerupEditor(g, s);
        changes++;
        break;
      case 0x4e: // 'N'
      case 0x6e: {
        const name = await g.dlg.getString(s.name, 30, ui.msg(728), 25, 180);
        if (name !== null) {
          s.name = name;
          changes++;
        }
        break;
      }
      case 0x54: // 'T'
      case 0x74:
        s.starts[player][2] = s.starts[player][2] === 0 ? 1 : 0;
        changes++;
        break;
      case 0x44: // 'D'
      case 0x64: {
        const d = await g.dlg.getString(sprintf('%u', s.density), 30, ui.msg(739), 25, 180);
        if (d !== null) {
          s.density = Math.max(0, Math.min(100, atoi(d)));
          changes++;
        }
        break;
      }
      case K.TAB:
      case K.ENTER:
      case K.SPACE:
        if (++brick > 2) brick = 0;
        break;
      case K.CTRL_F:
        if ((await g.dlg.msgboxYesNo(ui.msg(97), ui.msg(760), c.darkRed, c.yellow)) === 1) {
          for (let y = 0; y < SCHEME_H; y++) for (let x = 0; x < SCHEME_W; x++) setSchemeCell(s, x, y, brick);
          changes++;
        }
        break;
      case K.CTRL_B:
        // scheme_basic_grid also resets the name, density, start positions and power-up table
        if (!changes || (await g.dlg.msgboxYesNo(ui.msg(97), ui.msg(740), c.darkRed, c.yellow)) === 1) resetToBasicGrid(s, app.values);
        changes++;
        break;
      case K.ESC:
      case 0x51: // 'Q'
      case 0x71:
        if (changes && (await g.dlg.msgboxYesNo(ui.msg(95), ui.msg(735), c.white, c.black)) === 1) {
          const name = await g.dlg.getString(st.schemefilename, 30, ui.msg(736), 25, 180);
          if (name !== null) st.schemefilename = schemeFileName(name);
          // Cancel saves under the current name; the original then wrote a name without extension
          // ("Newfile") outside the scheme directory, where nothing could load it again
          else if (!st.schemefilename.includes('.')) st.schemefilename = schemeFileName(st.schemefilename);
          await saveScheme(g, s, st.schemefilename);
        }
        exit = true;
        break;
      case K.UP:
      case K.DOWN:
        // touch screens (no keyboard): the d-pad selects the player like '+' / '-'
        if (app.isTouch) player = (player + (k === K.UP ? 1 : SCHEME_PLAYERS - 1)) % SCHEME_PLAYERS;
        break;
    }
  }
  if ((await g.dlg.msgboxYesNo(ui.fmt(722, st.schemefilename), null, c.white, c.black)) < 1) st.schemefilename = savedName;
  ui.mouseHide();
}

/** The power-up table editor (0x402595): one "Modify" button and line per power-up type. */
async function powerupEditor(g: Game, s: Scheme): Promise<void> {
  const ui = g.ui;
  const c = ui.col;
  const fh = g.gnw.lineHeight;
  const x = 10;
  const buttons = new ScreenButtons(g.gnw);
  // GNW buttons on the main window, sending 5000 + type when pressed
  for (let i = 0; i < SCHEME_POWERS; i++) buttons.add(x, i * 24 + 60 - 4, ui.msg(755), 5000 + i, -1);
  ui.mouseShow();
  ui.flushInput();
  ui.screenButtons = buttons;
  const draw = () => {
    ui.restore();
    ui.print(ui.msg(754), 300, 30, 30, c.cyan, c.black);
    ui.print(ui.msg(737), 500, 20, 476 - fh, c.white, c.black);
    for (let i = 0; i < SCHEME_POWERS; i++) {
      const y = i * 24 + 60;
      const p = s.powerups[i];
      ui.print(ui.fmt(756, ui.msg(850 + i)), 100, x + 80, y, c.yellow, c.black);
      ui.print(ui.fmt(757, p.bornwith, ui.msg(25 + (p.forbidden ? 1 : 0))), 300, x + 200, y, c.white, c.black);
      ui.print(p.hasOverride ? ui.fmt(759, p.override) : ui.msg(758), 160, x + 440, y, c.white, c.black);
    }
    ui.flushSprites();
    buttons.draw();
  };
  // GNW repeats a down-code button only while the mouse button is held; the one left drawn pressed after
  // the dialogs (below) must not fire again, so codes count only after a real press on a button
  const bw = g.gnw.textWidth(ui.msg(755)) + 16, bh = fh + 6;
  const onButton = (px: number, py: number) => px >= x && px < x + bw && py >= 56 && py < 56 + 24 * (SCHEME_POWERS - 1) + bh && (py - 56) % 24 < bh;
  let presses = 0;
  try {
    for (;;) {
      draw();
      let k = await ui.flip();
      for (const p of ui.input.pointer) if (p.type === 'down' && onButton(p.x, p.y)) presses++;
      if (k >= 5000 && k < 5000 + SCHEME_POWERS) {
        if (presses > 0) presses--;
        else if (!g.app.input.pointerDown) k = -1;
      }
      if (k >= 5000 && k < 5000 + SCHEME_POWERS) {
        // GNW draws the pressed button at once, so the dialogs open over it; the release goes to the
        // dialogs and the button keeps its pressed picture afterwards (caps/ref/editor_bornwith_getstr.png,
        // editor_powerups_after_modify.png). A touch screen has no hover to release it later.
        draw();
        await powerupEntry(g, s, k - 5000);
        if (g.app.isTouch) buttons.releaseAll();
      }
      if (k === K.ENTER || k === K.ESC || k === K.SPACE || k === 0x51 || k === 0x71) break;
      if (k === K.F1) {
        await helpScreen(ui, g.dlg);
        ui.mouseShow();
      }
    }
  } finally {
    ui.screenButtons = null;
    buttons.dispose();
  }
}

/** One power-up type (0x4023a2): GNW text input and yes/no questions at (25, 400). */
async function powerupEntry(g: Game, s: Scheme, i: number): Promise<void> {
  const ui = g.ui;
  const dlg = g.dlg;
  const p = s.powerups[i];
  const name = ui.msg(850 + i);
  const x = 25, y = 400;
  const born = await dlg.getString(sprintf('%u', p.bornwith), 20, ui.fmt(762, name), x, y);
  if (born !== null) p.bornwith = atoi(born);
  p.forbidden = await dlg.winYesNo(ui.fmt(764, name), x, y, ui.col.white);
  p.hasOverride = await dlg.winYesNo(ui.fmt(766, name), x, y, ui.col.white);
  if (p.hasOverride) {
    const ov = await dlg.getString(sprintf('%d', p.override), 20, ui.fmt(768, name), x, y);
    if (ov !== null) p.override = atoi(ov);
  } else p.override = 0;
}
