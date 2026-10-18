// Application shell: owns the renderer, assets, input and audio, and drives screens.
//
// Screens are written as async loops in the same style as the original game's code:
//   while (running) { const f = await app.frame(); ...update...; ...draw...; }
// app.frame() presents what was drawn since the previous call and resolves at the next display frame
// (requestAnimationFrame), with the elapsed time and the input events received in between.

import { Renderer } from '../engine/gl/Renderer.ts';
import { Gfx } from '../engine/gfx.ts';
import { Input, type KeyEventRecord, type PointerRecord } from '../engine/input.ts';
import { AudioEngine } from '../engine/audio.ts';
import { TouchControls, isTouchDevice } from '../engine/touch.ts';
import { enterFullscreenLandscape } from '../engine/mobile.ts';
import { loadJson, type TextJson } from '../engine/assets.ts';
import { loadSettings, saveSettings, type Settings } from './settings.ts';
import { diagParam, showDiag } from './diag.ts';
import { isTvApp } from './controls.ts';
import { SCREEN_W, SCREEN_H } from '../engine/constants.ts';
import { flattenValues } from '../game/sim/sim.ts';

export interface FrameInfo {
  /** elapsed real milliseconds since the previous frame (clamped to 250) */
  dt: number;
  now: number;
  keys: KeyEventRecord[];
  pointer: PointerRecord[];
}

export class App {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: Renderer;
  readonly gfx: Gfx;
  readonly input: Input;
  readonly audio = new AudioEngine();
  readonly touch: TouchControls;
  settings: Settings;
  text!: TextJson;
  /** VALUELST flattened by id */
  values: number[] = [];
  private waiters: ((f: FrameInfo) => void)[] = [];
  private lastNow = 0;
  private frameOpen = false;
  /** palette currently applied (before fade), 8-bit RGB */
  private basePalette = new Uint8Array(768);
  private fadeLevel = 1; // 0..1 brightness multiplier
  fps = 0;
  private fpsFrames = 0;
  private fpsT = 0;
  showFps = false;
  private fpsEl: HTMLDivElement | null = null;
  /** touch mode: on-screen controls shown, taps navigate menus (switches on the first touch) */
  isTouch: boolean;
  private fullscreenTried = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new Renderer(canvas);
    this.gfx = new Gfx(this.renderer);
    this.input = new Input(canvas);
    this.settings = loadSettings();
    this.isTouch = isTouchDevice();
    window.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      if (!this.isTouch) this.setTouchMode(true);
      // phones: use the whole screen (needs a user gesture; not available on iPhone Safari)
      if (!this.fullscreenTried) {
        this.fullscreenTried = true;
        void enterFullscreenLandscape();
      }
    }, { capture: true });
    window.addEventListener('keydown', (e) => {
      if (this.isTouch && e.isTrusted && !(document.activeElement instanceof HTMLInputElement) && e.key !== 'Unidentified') this.setTouchMode(false);
    }, { capture: true });
    this.touch = new TouchControls(document.body);
    this.input.onGesture = () => this.audio.unlock();
    // iOS only accepts some events as the gesture that may start audio
    for (const ev of ['touchend', 'click', 'keyup']) window.addEventListener(ev, () => this.audio.unlock(), { capture: true });
    // on-screen ESC: Esc, or Ctrl-Q when held (quits a round)
    this.touch.onMenu = (long) => (long ? this.input.injectKey(0x10, true) : this.input.injectKey(0x01));
    this.input.toGame = (cx, cy) => {
      const v = this.renderer.viewport;
      return [Math.floor((cx - v.x) / v.scale), Math.floor((cy - v.y) / v.scale)];
    };
    // over the game picture the game draws its own cursor (or none); beside it, in the bars, the mouse is the
    // system's, so that buttons there can be reached
    window.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      const v = this.renderer.viewport;
      const inside = e.clientX >= v.x && e.clientX < v.x + v.w && e.clientY >= v.y && e.clientY < v.y + v.h;
      const want = inside ? 'none' : 'default';
      if (canvas.style.cursor !== want) canvas.style.cursor = want;
    });
    // the TV app: the menus leave out what costs a television too much (menu.css .tv-app)
    if (isTvApp()) document.documentElement.classList.add('tv-app');
    const params = new URLSearchParams(location.search);
    this.showFps = params.has('fps');
    window.addEventListener('resize', () => this.layout());
    window.visualViewport?.addEventListener('resize', () => this.layout());
  }

  async init(): Promise<void> {
    // the sprite atlas is loaded afterwards, under the "Loading data..." progress window (Game.boot)
    const [text] = await Promise.all([loadJson<TextJson>('text.json'), this.gfx.loadBase()]);
    this.text = text;
    this.values = flattenValues(text.values);
    await this.audio.init(text.sounds);
    this.audio.setSfxVolume(this.settings.sfxVolume);
    this.audio.setMusicVolume(this.settings.musicVolume);
    this.layout();
    showDiag(diagParam() || !!this.settings.diagnostics);
    if (this.showFps) {
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;left:4px;top:4px;color:#0f0;font:12px monospace;z-index:20;pointer-events:none;text-shadow:1px 1px #000';
      document.body.appendChild(el);
      this.fpsEl = el;
    }
    this.schedule();
  }

  /** classic menus: the on-screen controls follow the touch mode; the modern menus show them per match */
  touchAuto = true;

  setTouchMode(on: boolean): void {
    this.isTouch = on;
    if (this.touchAuto || !on) this.touch.show(on);
    this.layout();
  }

  layout(): void {
    const vv = window.visualViewport;
    const w = vv ? vv.width : window.innerWidth;
    const h = vv ? vv.height : window.innerHeight;
    this.renderer.layout(w, h, window.devicePixelRatio || 1, !!this.settings.integerScale);
    this.touch.layout(w, h, this.renderer.viewport);
  }

  private rafPending = false;

  private schedule(): void {
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame((t) => this.onAnimationFrame(t));
  }

  private onAnimationFrame(now: number): void {
    this.rafPending = false;
    if (this.waiters.length === 0) {
      // no screen waits for a frame (the HTML menus are open): the loop sleeps until frame() is called
      this.lastNow = 0;
      return;
    }
    this.schedule();
    const dt = this.lastNow ? Math.min(250, Math.max(0, now - this.lastNow)) : 16;
    this.lastNow = now;
    this.fpsFrames++;
    if (now - this.fpsT >= 500) {
      this.fps = (this.fpsFrames * 1000) / (now - this.fpsT);
      this.fpsFrames = 0;
      this.fpsT = now;
      if (this.fpsEl) this.fpsEl.textContent = `${this.fps.toFixed(1)} fps`;
    }
    const waiters = this.waiters;
    this.waiters = [];
    this.renderer.beginFrame();
    this.frameOpen = true;
    const info: FrameInfo = { dt, now, keys: this.input.takeKeys(), pointer: this.input.takePointer() };
    for (const w of waiters) w(info);
  }

  /** Present the current frame (if one is open) and wait for the next display frame. */
  frame(): Promise<FrameInfo> {
    if (this.frameOpen) {
      this.renderer.endFrame();
      this.frameOpen = false;
    }
    const next = new Promise<FrameInfo>((res) => this.waiters.push(res));
    this.schedule();
    return next;
  }

  private tickAcc = 0;
  private tickKeys: KeyEventRecord[] = [];
  private tickPointer: PointerRecord[] = [];

  /**
   * Present and wait for the next 60 Hz logic tick. The original menu loops run one iteration per
   * rendered frame with no limiter (docs/re/screens.md U1); we pin them to 60 iterations per second
   * whatever the display refresh rate is. Input received during skipped display frames is carried over.
   */
  async tick(): Promise<FrameInfo> {
    const STEP = 1000 / 60;
    let dt = 0;
    for (;;) {
      const f = await this.frame();
      dt += f.dt;
      this.tickAcc += f.dt;
      if (f.keys.length) this.tickKeys.push(...f.keys);
      if (f.pointer.length) this.tickPointer.push(...f.pointer);
      if (this.tickAcc >= STEP - 2) {
        this.tickAcc = Math.min(this.tickAcc - STEP, STEP);
        if (this.tickAcc < 0) this.tickAcc = 0;
        const out: FrameInfo = { dt, now: f.now, keys: this.tickKeys, pointer: this.tickPointer };
        this.tickKeys = [];
        this.tickPointer = [];
        return out;
      }
    }
  }

  /** Drop input queued so far (GNW input_flush). */
  flushInput(): void {
    this.input.takeKeys();
    this.input.takePointer();
    this.input.clearState();
    this.tickKeys = [];
    this.tickPointer = [];
  }

  // ---------------------------------------------------------------------------------- random numbers

  /**
   * The C library rand() used by the menus (glue pictures, cursor blink, level preview, roulette...):
   * Watcom's LCG (the original seeds it with srand(time(NULL)); we add entropy so that two machines
   * started in the same second differ, e.g. their default node names). The match simulation uses
   * its own copy (GameState.rng) so that netplay stays deterministic.
   */
  private seed = (Date.now() ^ Math.floor(Math.random() * 0x100000000)) >>> 0;

  rand(): number {
    this.seed = (Math.imul(this.seed, 1103515245) + 12345) >>> 0;
    return (this.seed >>> 16) & 0x7fff;
  }

  // ---------------------------------------------------------------------------------- palette & fades

  setPalette(rgb8: Uint8Array): void {
    this.basePalette.set(rgb8.subarray(0, 768));
    this.applyPalette();
  }

  get palette(): Uint8Array {
    return this.basePalette;
  }

  setFade(level: number): void {
    this.fadeLevel = Math.max(0, Math.min(1, level));
    this.applyPalette();
  }

  private applyPalette(): void {
    const p = this.basePalette;
    const k = this.fadeLevel;
    const out = new Uint8Array(768);
    for (let i = 0; i < 768; i++) out[i] = Math.round(p[i] * k);
    this.renderer.setPalette(out);
  }

  /** Fade the palette over `ms` milliseconds; `draw` is called every frame to redraw the scene. */
  async fade(to: number, ms: number, draw: () => void): Promise<void> {
    const from = this.fadeLevel;
    let t = 0;
    while (t < ms) {
      const f = await this.frame();
      t += f.dt;
      this.setFade(from + (to - from) * Math.min(1, t / ms));
      draw();
    }
    this.setFade(to);
  }

  saveSettings(): void {
    saveSettings(this.settings);
  }

  msg(id: number): string {
    return this.text.messages[id] ?? `<<FM:${id}!!>>`;
  }

  /** VALUELST entry (lines with several values fill consecutive ids). */
  value(id: number, index = 0): number {
    return this.values[id + index] ?? 0;
  }

  get width(): number {
    return SCREEN_W;
  }

  get height(): number {
    return SCREEN_H;
  }
}
