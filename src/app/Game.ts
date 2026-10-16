// The program: start-up, title sequence, main menu and everything reachable from it
// (docs/re/screens.md §1 program flow).

import { leave1997, originalMenus } from './modes.ts';
import type { App } from './App.ts';
import { Ui } from '../ui/ui.ts';
import { Gnw } from '../ui/gnw.ts';
import { Dialogs } from '../ui/dialogs.ts';
import { Session } from './session.ts';
import { titleScreens } from '../screens/title.ts';
import { mainMenu } from '../screens/mainMenu.ts';
import { matchPlay, playMatch, buildParams, rouletteScreen, playCampaign, type MatchParams } from '../screens/match.ts';
import { editorEnter } from '../screens/editor.ts';
import { Menus } from '../menu/index.tsx';
import { showSplash } from '../menu/splash.tsx';
import type { ScreenId } from '../menu/ctx.ts';
import { firstPlayer, initialLineup } from '../menu/local.tsx';
import { playingNow } from '../menu/lineup.ts';
import { classicInput, findSet } from './controls.ts';
import { INPUT_OFF, AI_DEFAULT } from './session.ts';
import { K } from '../ui/menuInput.ts';
import { SCREEN_W, SCREEN_H } from '../engine/constants.ts';

export class Game {
  readonly app: App;
  readonly ui: Ui;
  readonly gnw: Gnw;
  readonly dlg: Dialogs;
  readonly session = new Session();
  /** the match being played (debugging / tests) */
  runner: unknown = null;

  constructor(app: App) {
    this.app = app;
    this.ui = new Ui(app);
    this.gnw = new Gnw(app.gfx);
    this.dlg = new Dialogs(this.ui, this.gnw);
    this.ui.cursorDrawer = (x, y) => this.gnw.drawCursor(x, y);
    app.canvas.style.cursor = 'none'; // App shows the system's cursor beside the picture
    this.ui.onGlobalKey = async (k) => {
      if (k === 0x12e) {
        this.screenDump();
        return true;
      }
      return false;
    };
  }

  get settings() {
    return this.app.settings;
  }

  /**
   * game_init: black window, "Loading data..." progress window while the sprites load (the modern menus
   * show their own loading screen instead).
   */
  async boot(): Promise<void> {
    const ui = this.ui;
    await this.gnw.init();
    if (!originalMenus(this.settings) && !new URLSearchParams(location.search).has('bench')) {
      const splash = showSplash();
      await this.app.gfx.loadSprites((f) => splash.progress(f));
      splash.progress(1);
      this.session.assignDefaults(this.joystickCount(), !!this.settings.assign_keyboards);
      this.session.fromLineup = this.settings.localPlayers.length > 0;
      // the menus take over from the splash (it stays until they are on screen)
      this.removeSplash = () => splash.done();
      return;
    }
    ui.gamePalette();
    ui.mouseHide();
    this.dlg.progressTitleSet(ui.msg(201));
    let pct = 0;
    let done = false;
    const loading = this.app.gfx.loadSprites((f) => (pct = Math.floor(f * 100))).then(() => (done = true));
    ui.gfx.clear(0);
    while (!done) {
      ui.gfx.clear(0);
      this.dlg.progressDraw(Math.min(pct, 99));
      await ui.present();
    }
    await loading;
    ui.gfx.clear(0);
    this.dlg.progressDraw(100);
    await ui.present();
    this.session.assignDefaults(this.joystickCount(), !!this.settings.assign_keyboards);
    // the line-up kept by the modern menus (or an earlier visit of the player setup) comes back at the first setup
    this.session.fromLineup = this.settings.localPlayers.length > 0;
  }

  async run(): Promise<void> {
    await this.boot();
    const params = new URLSearchParams(location.search);
    if (params.has('bench')) {
      // benchmark: endless demo rounds with N computer players (?bench=10&level=4&ai=5)
      this.session.bench = {
        players: Math.max(2, Math.min(10, Number(params.get('bench')) || 10)),
        level: Number(params.get('level') ?? -1),
        ai: Math.max(0, Math.min(5, Number(params.get('ai')) || 0)),
      };
      for (;;) {
        this.session.attract = 1;
        this.session.saveInputs(this.settings.levelno, this.settings.team_play);
        await matchPlay(this);
        this.session.restoreInputs();
        this.session.attract = 0;
      }
    }
    if (originalMenus(this.settings)) await this.classicMenus();
    else await this.modernMenus();
  }

  /**
   * The original program flow: title picture, main menu. The way back to the modern menus is the "Back to
   * today" button in the top right corner, in the style of the time (in the bar beside the picture when there
   * is room for it; over the picture's corner otherwise, faded until pointed at), hidden during rounds, and
   * Ctrl+M at any time.
   */
  private async classicMenus(): Promise<void> {
    this.app.touchAuto = true;
    // (from the modern menus, which hid them: the on-screen controls are back on a touch screen)
    this.app.touch.show(this.app.isTouch);
    const toModern = () => {
      this.settings.classicMenus = 0;
      this.app.saveSettings();
      leave1997();
    };
    const back = document.createElement('button');
    back.className = 'back-today';
    back.textContent = '↩ Back to today';
    back.title = 'Leave 1997 mode for the modern menus (Ctrl+M)';
    back.onclick = toModern;
    document.body.appendChild(back);
    // (measured while shown: a hidden button has no size, and the place it gets must not depend on that)
    let size = { w: 0, h: 0 };
    const place = () => {
      const hide = !!this.runner;
      if (back.hidden !== hide) back.hidden = hide;
      if (hide) return;
      if (back.offsetWidth) size = { w: back.offsetWidth, h: back.offsetHeight };
      const v = this.app.renderer.viewport;
      const room = window.innerWidth - (v.x + v.w) >= size.w + 16 || v.y >= size.h + 16;
      back.classList.toggle('over', !room);
    };
    place();
    window.addEventListener('resize', place);
    setInterval(place, 250);
    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.code === 'KeyM') toModern();
    });
    for (;;) {
      await titleScreens(this);
      const quit = await mainMenu(this);
      if (!quit) break;
      await this.quitScreen();
    }
  }

  menus: Menus | null = null;
  private removeSplash: (() => void) | null = null;

  /** The modern menus (src/menu): they hand over to the original game screens for the matches. */
  private async modernMenus(): Promise<void> {
    this.app.touchAuto = false;
    const menus = new Menus(this);
    this.menus = menus;
    requestAnimationFrame(() => {
      this.removeSplash?.();
      this.removeSplash = null;
    });
    let screen: ScreenId = 'home';
    for (;;) {
      const e = await menus.open(screen);
      if (e.kind === 'classic') {
        await this.classicMenus();
        continue;
      }
      if (e.kind === 'local') {
        await this.playLocal();
        screen = 'local';
      } else if (e.kind === 'net-match') {
        await this.playNet(e.params);
        screen = menus.afterNetMatch();
      } else if (e.kind === 'editor') {
        await editorEnter(this);
        screen = 'options';
      } else if (e.kind === 'campaign') {
        this.slotsFromLocalSetup();
        this.prepareTouch();
        await playCampaign(this);
        screen = 'options';
      }
      this.app.touch.show(false);
    }
  }

  /** Session slots of a campaign: the people of the last Local Game line-up whose device is there. */
  private slotsFromLocalSetup(): void {
    const s = this.session;
    s.slots = s.slots.map((x, i) => ({ ...x, type: INPUT_OFF, dev: 0, owner: 0, ai: AI_DEFAULT, ctl: undefined, team: i & 1 }));
    const players = playingNow(this, initialLineup(this).players, 0);
    (players.length ? players : [firstPlayer(this)]).forEach((p, i) => {
      const c = classicInput(this.settings.controls, p.ctl);
      s.slots[i] = { ...s.slots[i], type: c.type, dev: Math.max(0, c.dev), ctl: p.ctl };
    });
  }

  /** Show the on-screen controls if a player of this device plays with them (one or two players). */
  private prepareTouch(): void {
    const sets = this.session.slots
      .filter((sl, i) => sl.ctl && this.session.isLocalHuman(i))
      .map((sl) => findSet(this.settings.controls, sl.ctl!))
      .filter((x) => x?.kind === 'touch');
    if (!sets.length) {
      this.app.touch.show(false);
      return;
    }
    this.app.touch.setPlayers(sets.some((x) => x!.side !== 'both') ? 2 : 1);
    this.app.touch.show(true);
  }

  /** A local match from the modern menus (session.slots and the settings are ready). */
  private async playLocal(): Promise<void> {
    const s = this.session;
    s.netMode = 0;
    s.attract = 0;
    s.matchEnd = 0;
    if (this.settings.goldman && s.goldPlayer !== -1) {
      await rouletteScreen(this);
      if (s.matchEnd) return;
    }
    this.prepareTouch();
    await playMatch(this, buildParams(this, this.settings.levelno));
  }

  /** A network match started in the lobby (session.slots come from the host). */
  private async playNet(params: MatchParams): Promise<void> {
    this.session.matchEnd = 0;
    this.prepareTouch();
    await playMatch(this, params);
  }

  /** Gamepads currently connected (the original's joysticks). */
  joystickCount(): number {
    return this.app.input.gamepadCount();
  }

  joystickName(j: number): string {
    return this.app.input.gamepads()[j]?.id ?? '';
  }

  /** confirm_exit (0x412987): returns true when the player confirmed. */
  async confirmExit(): Promise<boolean> {
    const ui = this.ui;
    ui.mouseShow();
    const r = await this.dlg.msgboxYesNo(ui.msg(10), null, ui.col.darkRed, ui.col.yellow);
    ui.mouseHide();
    return r === 1;
  }

  /**
   * After "Yes" the original stops the music, plays a quit voice and exits after 4 s. A web page cannot
   * close itself, so we show a black screen afterwards; any key or tap starts the game again.
   */
  private async quitScreen(): Promise<void> {
    const ui = this.ui;
    this.app.audio.stopMusic();
    this.app.audio.playVoiceGroup(2600);
    await ui.delay(4000);
    // the Android TV app can really close (android/)
    (window as unknown as { AndroidHost?: { exit?: () => void } }).AndroidHost?.exit?.();
    ui.clearBackground();
    ui.flushInput();
    for (;;) {
      ui.restore();
      const k = await ui.flip();
      if (k !== -1) break;
    }
  }

  /** debug_info_window (Alt-D, 0x413d45) */
  async debugWindow(): Promise<void> {
    const ui = this.ui;
    const g = this.gnw;
    const win = this.dlg.window(100, 100, 450, 300);
    if (g.winz) win.buf.fillWinz(g.winz);
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;
    const lines: [number, string][] = [
      [20, ui.msg(400)],
      [40, ui.msg(401)],
      [70, ui.fmt(405, mem, 0)],
      [90, ui.fmt(410, 0)],
      [110, ui.fmt(411, 0)],
      [130, ui.fmt(415, 0)],
      [150, ui.fmt(420, 100)],
    ];
    for (const [y, s] of lines) g.print(win, s, 400, 20, y, ui.col.white, ui.col.black);
    await this.dlg.modal(win, (k) => k === K.ENTER || k === K.ESC);
  }

  /** Alt-C: GNW's dump_screen writes scrNNNNN.bmp; here the frame is downloaded as an 8-bit BMP. */
  private screenDump(): void {
    const r = this.app.renderer;
    const idx = r.readIndices();
    const pal = this.app.palette;
    const w = SCREEN_W, h = SCREEN_H;
    const header = 14 + 40 + 1024;
    const buf = new Uint8Array(header + w * h);
    const dv = new DataView(buf.buffer);
    buf[0] = 0x42;
    buf[1] = 0x4d;
    dv.setUint32(2, buf.length, true);
    dv.setUint32(10, header, true);
    dv.setUint32(14, 40, true);
    dv.setInt32(18, w, true);
    dv.setInt32(22, h, true);
    dv.setUint16(26, 1, true);
    dv.setUint16(28, 8, true);
    dv.setUint32(34, w * h, true);
    dv.setUint32(46, 256, true);
    for (let i = 0; i < 256; i++) {
      buf[54 + i * 4] = pal[i * 3 + 2];
      buf[54 + i * 4 + 1] = pal[i * 3 + 1];
      buf[54 + i * 4 + 2] = pal[i * 3];
    }
    for (let y = 0; y < h; y++) buf.set(idx.subarray((h - 1 - y) * w, (h - y) * w), header + y * w);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([buf], { type: 'image/bmp' }));
    a.download = `scr${String(this.dumpNo++).padStart(5, '0')}.bmp`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  private dumpNo = 0;
}
