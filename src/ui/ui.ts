// Screen toolkit shared by every menu screen: background buffer, text, the sprite queue, the blinking
// cursor, UI sounds and the per-iteration menu key, mirroring the original's graf.c helpers and
// input_get_menu_key (docs/re/screens.md §0).
//
// A menu loop looks exactly like the original:
//   for (;;) { ui.restore(); ui.print(...); ui.cursor(x, y); const k = await ui.flip(); ...handle k... }
// flip() draws the queued sprites on top of everything drawn this frame (graf_flip), presents, waits for
// the next 60 Hz iteration and returns one GNW key code (-1 = none, -2 = mouse button / tap).

import type { App } from '../app/App.ts';
import type { Gfx, ScreenImage } from '../engine/gfx.ts';
import type { TextureHandle } from '../engine/gl/Renderer.ts';
import { DrawMode } from '../engine/gl/Renderer.ts';
import { ownPalette } from '../engine/gfx.ts';
import { textColours, type TextColours } from '../game/render/textColours.ts';
import { grafPrint, grafPrintCentered, textWidth, sprintf } from './text.ts';
import { MenuInput, K } from './menuInput.ts';
import { SCREEN_W, SCREEN_H } from '../engine/constants.ts';
import type { GnwWindow, ScreenButtons } from './gnw.ts';
import { originalMouse, originalWaits } from '../app/modes.ts';

export interface Tap {
  x: number;
  y: number;
}

export class Ui {
  readonly app: App;
  readonly gfx: Gfx;
  readonly col: TextColours;
  readonly input: MenuInput;
  /** queued sprites: x, y, frame */
  private queue: number[] = [];
  private keys: number[] = [];
  /** the background buffer: a picture, or a frozen copy of the screen */
  private bgImage: ScreenImage | null = null;
  private bgSnap: TextureHandle | null = null;
  private snapTex: TextureHandle | null = null;
  /** graf_cursor state (persists across screens like the original's globals) */
  private cursorState = 0;
  private cursorNext = 0;
  /** 0 local game, 1 network server, 2 network client */
  netMode = 0;
  /** pointer presses received with the last key poll (game coordinates) */
  taps: Tap[] = [];
  /** keys injected by the network layer (input_push_menu_key) */
  private injected: number[] = [];
  /** called for global keys handled inside get_input (Alt-P pause, Alt-C screen dump) */
  onGlobalKey: ((k: number) => Promise<boolean>) | null = null;
  /** GNW mouse cursor visibility (mouse_show / mouse_hide) */
  private mouseShown = false;
  /** when the mouse last moved, and when a key was last pressed (performance.now) */
  private mouseMoved = -1e9;
  private keyPressed = 0;
  /** the mouse is over the game picture (beside it, the system's cursor shows instead) */
  private mouseInside = true;
  /** open GNW windows (topmost last); pointer input goes to the top one's buttons */
  readonly windows: GnwWindow[] = [];
  /** GNW buttons registered on the main window (keydefs screen) */
  screenButtons: ScreenButtons | null = null;

  constructor(app: App) {
    this.app = app;
    this.gfx = app.gfx;
    this.col = textColours(app.gfx);
    this.input = new MenuInput(app);
  }

  // ------------------------------------------------------------------------------- data helpers

  msg(id: number): string {
    return this.app.msg(id);
  }

  fmt(id: number, ...args: (string | number)[]): string {
    return sprintf(this.app.msg(id), ...args);
  }

  value(id: number, index = 0): number {
    return this.app.value(id, index);
  }

  rand(): number {
    return this.app.rand();
  }

  // ------------------------------------------------------------------------------- background

  /** Load a remapped picture into the background buffer (graf_target_background + graf_load_pcx_to_target). */
  async setBackground(name: string): Promise<ScreenImage> {
    const img = await this.gfx.loadScreen(name);
    this.bgImage = img;
    this.bgSnap = null;
    return img;
  }

  /** graf_show_random_glue: GLUE<rand() % V16> as the background of a menu screen. */
  async randomGlue(): Promise<void> {
    const n = Math.max(this.value(16), 1);
    const i = this.rand() % n;
    const forced = this.glueQueue.length ? this.glueQueue.shift()! : this.forceGlue;
    await this.setBackground(`GLUE${forced !== null && forced >= 0 ? forced : i}`);
  }

  /** tests: use these GLUE pictures instead of random ones (comparisons with captures of the original) */
  forceGlue: number | null = null;
  glueQueue: number[] = [];

  /** Use the current screen contents as the background (what GNW keeps under a modal window). */
  freezeScreen(): void {
    this.snapTex = this.gfx.r.snapshot(this.snapTex);
    this.bgSnap = this.snapTex;
    this.bgImage = null;
  }

  /** Take a snapshot of the screen as it is now without changing the background. */
  snapshot(reuse: TextureHandle | null = null): TextureHandle {
    return this.gfx.r.snapshot(reuse);
  }

  drawSnapshot(t: TextureHandle): void {
    this.gfx.r.draw(t, 0, 0, 0, SCREEN_W, SCREEN_H, 0, 0, 0, DrawMode.Opaque);
  }

  clearBackground(): void {
    this.bgImage = null;
    this.bgSnap = null;
  }

  /** graf_restore_background */
  restore(): void {
    if (this.bgImage) this.gfx.drawScreen(this.bgImage);
    else if (this.bgSnap) this.drawSnapshot(this.bgSnap);
    else this.gfx.clear(0);
  }

  // ------------------------------------------------------------------------------- palettes

  gamePalette(): void {
    this.app.setPalette(this.gfx.gamePalette);
  }

  /** Show a full-screen picture with its own palette (graf_show_pcx_own_palette), as the background. */
  async ownPaletteScreen(name: string): Promise<void> {
    const img = await this.gfx.loadScreen(name);
    this.app.setPalette(img.ownPalette ? ownPalette(img.palette) : this.gfx.gamePalette);
    this.bgImage = img;
    this.bgSnap = null;
  }

  // ------------------------------------------------------------------------------- drawing

  print(s: string, w: number, x: number, y: number, fg: number, outline: number): void {
    grafPrint(this.gfx, s, w, x, y, fg, outline);
  }

  printCentered(s: string, cx: number, y: number, fg: number, outline: number): void {
    grafPrintCentered(this.gfx, s, cx, y, fg, outline);
  }

  textWidth(s: string): number {
    return textWidth(this.gfx, s);
  }

  /** sprite_queue(x, y, frame): drawn at flip time, after all text of the frame. */
  sprite(x: number, y: number, frame: number): void {
    this.queue.push(x, y, frame);
  }

  /** ani frame number of state `state` of sequence `name` (ani_seqno_to_frameno). */
  seqFrame(name: string, state: number): number {
    const states = this.gfx.seqList[this.gfx.seq(name)];
    const st = states[((state % states.length) + states.length) % states.length];
    return st[0][0];
  }

  seqLength(name: string): number {
    return this.gfx.seqList[this.gfx.seq(name)].length;
  }

  /** graf_cursor (0x413bd6): the bomber dude that blinks every 2-3 seconds. */
  cursor(x: number, y: number): void {
    const now = Math.floor(Date.now() / 1000);
    if (now >= this.cursorNext) {
      this.cursorState = 1;
      this.cursorNext = now + this.value(690) + (this.rand() % Math.max(this.value(691), 1));
    } else if (this.cursorState !== 0) {
      this.cursorState++;
      if (this.cursorState >= this.seqLength('cursor1')) this.cursorState = 0;
    }
    this.sprite(x, y, this.seqFrame('cursor1', this.cursorState));
  }

  /** draw_press_f1_help (0x413fb9) */
  pressF1(): void {
    this.printCentered(this.msg(330), this.value(790), this.value(791), this.col.cyan, this.col.black);
  }

  /** Draw the queued sprites (graf_flip's first half). */
  flushSprites(): void {
    const q = this.queue;
    for (let i = 0; i < q.length; i += 3) this.gfx.drawFrame(q[i + 2], q[i], q[i + 1], 0);
    q.length = 0;
  }

  /** graf_flip + input_get_menu_key: present this frame and return one key for the next iteration. */
  async flip(): Promise<number> {
    this.flushSprites();
    this.drawMouse();
    for (;;) {
      const f = await this.app.tick();
      const codes = this.input.poll(f.keys, f.pointer, f.now);
      this.taps = this.input.taps.map((p) => ({ x: p.x, y: p.y }));
      // the GNW mouse cursor follows the real mouse (touches do not move it), hotspot kept on screen
      for (const p of this.input.pointer) {
        if (p.kind === 'touch') continue;
        this.cursorX = Math.max(0, Math.min(SCREEN_W - 1, p.x));
        this.cursorY = Math.max(0, Math.min(SCREEN_H - 1, p.y));
        this.mouseInside = p.x >= 0 && p.x < SCREEN_W && p.y >= 0 && p.y < SCREEN_H;
        this.mouseMoved = f.now;
      }
      const top = this.windows[this.windows.length - 1];
      if (top) {
        // GNW buttons turn mouse presses/releases into their key codes
        for (const p of this.input.pointer) {
          const c = top.pointer(p.type, p.x, p.y, f.now);
          if (c !== -1) codes.push(c);
        }
        const r = top.repeat(f.now, this.app.input.pointerDown);
        if (r !== -1) codes.push(r);
      } else if (this.screenButtons) {
        for (const p of this.input.pointer) {
          const c = this.screenButtons.pointer(p.type, p.x, p.y, f.now);
          if (c !== -1) codes.push(c);
        }
        const r = this.screenButtons.repeat(f.now, this.app.input.pointerDown);
        if (r !== -1) codes.push(r);
      } else if (this.taps.length) codes.push(K.MOUSE);
      if (codes.some((c) => c !== K.MOUSE)) this.keyPressed = f.now;
      this.keys.push(...codes);
      const k = this.nextKey();
      // (GNW's Alt-P pause is disabled in this game: graf_init registers no pause key)
      if (k === 0x12e /* Alt-C */ && this.onGlobalKey && (await this.onGlobalKey(k))) continue;
      return k;
    }
  }

  /** GNW mouse cursor position (hotspot); starts at the screen centre like GNW's (319,239) image. */
  cursorX = 320;
  cursorY = 240;
  /** set by Game: draws GNW's cursor bitmap with its hotspot at (x, y) */
  cursorDrawer: ((x: number, y: number) => void) | null = null;

  /**
   * The GNW cursor is drawn last, while shown (not on touch screens, nor while the mouse is beside the picture,
   * where the system's cursor shows). The original hid it outside dialogs;
   * unless the 1997 mouse is wanted, it also shows on every other menu screen once the mouse moves, until a
   * key is pressed.
   */
  drawMouse(): void {
    if (this.app.isTouch || !this.cursorDrawer || !this.mouseInside) return;
    const inUse = !originalMouse(this.app.settings) && this.mouseMoved > this.keyPressed;
    if (this.mouseShown || inUse) this.cursorDrawer(this.cursorX, this.cursorY);
  }

  /** Mouse clicks act on menu screens like taps on touch screens (the original ignored the mouse there). */
  get pointerMenus(): boolean {
    return this.app.isTouch || !originalMouse(this.app.settings);
  }

  /** Present without consuming input (used by frozen screens such as the 1.5 s pause on the results). */
  async present(): Promise<void> {
    this.flushSprites();
    const f = await this.app.tick();
    // keep keys for later, like GNW's buffer
    this.keys.push(...this.input.poll(f.keys, f.pointer, f.now));
  }

  private nextKey(): number {
    if (this.injected.length) return this.injected.shift()!;
    return this.keys.length ? this.keys.shift()! : -1;
  }

  /** input_push_menu_key: a key received from the network, returned before local input. */
  injectKey(k: number): void {
    if (this.injected.length < 10) this.injected.push(k);
  }

  /** input_flush */
  flushInput(): void {
    this.keys.length = 0;
    this.injected.length = 0;
    this.app.flushInput();
    this.input.resetPads();
  }

  /** Wait `ms` milliseconds while presenting the current picture (delay_pumping). */
  async delay(ms: number, draw?: () => void): Promise<void> {
    const end = performance.now() + ms;
    while (performance.now() < end) {
      if (draw) draw();
      else this.restore();
      await this.present();
    }
  }

  /** graf_clear + graf_flip: one black frame. */
  async blackFrame(): Promise<void> {
    this.clearBackground();
    this.gfx.clear(0);
    await this.present();
  }

  // ------------------------------------------------------------------------------- mouse

  /** mouse_show: GNW draws its own cursor (the system cursor stays hidden over the game). */
  mouseShow(): void {
    this.mouseShown = true;
  }

  mouseHide(): void {
    this.mouseShown = false;
  }

  get mouseVisible(): boolean {
    return this.mouseShown;
  }

  // ------------------------------------------------------------------------------- sounds

  /** snd 20 group: every real key on a menu screen */
  letter(): void {
    this.app.audio.playGroup(20);
  }

  /** snd 10: confirm / leave */
  menuExit(): void {
    this.app.audio.playGroup(10);
  }

  /** snd 40 group: refused action */
  refuse(): void {
    this.app.audio.playGroup(40);
  }

  /**
   * screen_min_wait_secs: 1 for local games, V13 (3) in network games, before a screen between rounds can be
   * left; none unless the 1997 waits are wanted.
   */
  minWaitSecs(): number {
    if (!originalWaits(this.app.settings)) return 0;
    return this.netMode === 0 ? 1 : this.value(13);
  }
}

export function isRealKey(k: number): boolean {
  return k !== -1 && k !== -2;
}
