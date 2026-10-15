// Software model of the GNW window library (Tim Cain's "GNW", shared with Fallout 1) as used by the
// game's dialogs: each window owns an 8-bit buffer that is drawn with GNW's buffer primitives (fills,
// lines, shaded boxes, FON text, lighten_buf, opaque/transparent blits) and composited over the frozen
// screen. Working in a CPU buffer reproduces GNW's pixel rules exactly, including operations that read
// pixels back (lighten_buf). Pixel rules: docs/re/gnw-widgets.md (verified against 91 captures).

import type { Gfx, ScreenImage } from '../engine/gfx.ts';
import type { FontJson } from '../engine/assets.ts';
import type { TextureHandle } from '../engine/gl/Renderer.ts';
import { DrawMode } from '../engine/gl/Renderer.ts';

/** Font flags understood by text drawing (GNW colour argument bits). */
export const TEXT_SHADOW = 0x10000;
export const TEXT_NOFILL = 0x2000000;

/** GNW colour helpers resolved against the game palette (COLOR.PAL). */
export class GnwColors {
  /** colorTable: RGB555 -> nearest palette index (COLOR.PAL offset 768) */
  readonly table: Uint8Array;
  /** lighten_buf's map: intensityTable[c][147] (gnw-widgets.md §1.2) */
  readonly lightenMap = new Uint8Array(256);
  /** GNW_wcolor[0..5] resolved to palette indices: 205, 60, 142, 178, 182, 242 */
  readonly wcolor: number[];
  /** colorTable[0]: 255 */
  readonly black: number;

  constructor(gfx: Gfx) {
    const lut = gfx.lut555;
    this.table = lut;
    const p6 = gfx.gamePalette6;
    const rgb = (r: number, g: number, b: number) => lut[(r << 10) | (g << 5) | b];
    // GNW_wcolor: 0x294A (10,10,10), 0x3DEF (15,15,15), 0x2108 (8,8,8), 0x5294 (20,20,20), 0x7FEB (31,31,11), 0x7C00 (31,0,0)
    this.wcolor = [rgb(10, 10, 10), rgb(15, 15, 15), rgb(8, 8, 8), rgb(20, 20, 20), rgb(31, 31, 11), rgb(31, 0, 0)];
    this.black = lut[0];
    // each 5-bit channel moves (31 - c) * 0x2600 >> 16 towards white; entry 0 of COLOR.PAL is invalid -> 0
    const f = 19 * 0x200;
    for (let c = 1; c < 256; c++) {
      const r = (p6[c * 3] & 63) >> 1;
      const g = (p6[c * 3 + 1] & 63) >> 1;
      const b = (p6[c * 3 + 2] & 63) >> 1;
      this.lightenMap[c] = rgb(r + (((31 - r) * f) >> 16), g + (((31 - g) * f) >> 16), b + (((31 - b) * f) >> 16));
    }
    this.lightenMap[0] = 0;
  }

  rgb(r: number, g: number, b: number): number {
    return this.table[(r << 10) | (g << 5) | b];
  }
}

/** CPU copy of a GNW .FON font. */
export class CpuFont {
  readonly height: number;
  readonly spacing: number;
  readonly widths: number[];
  readonly bits: Uint8Array[];

  constructor(f: FontJson) {
    this.height = f.height;
    this.spacing = f.spacing;
    this.widths = f.glyphs.map((g) => g.w);
    this.bits = f.glyphs.map((g) => {
      const a = new Uint8Array(g.w * f.height);
      for (let i = 0; i < a.length; i++) a[i] = g.bits.charCodeAt(i) === 49 ? 1 : 0;
      return a;
    });
  }

  /** width of byte `code` (0 for codes outside the font, which are skipped without advancing) */
  charWidth(code: number): number {
    return this.widths[code & 0xff] ?? 0;
  }

  width(s: string): number {
    let w = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i) & 0xff;
      if (c < this.widths.length) w += this.widths[c] + this.spacing;
    }
    return w;
  }

  /** text_max: widest glyph + spacing (17 for FONT6, glyph '%') */
  maxWidth(): number {
    let m = 0;
    for (const w of this.widths) m = Math.max(m, w);
    return m + this.spacing;
  }
}

/** An 8-bit window buffer with GNW's drawing primitives. */
export class WinBuf {
  readonly w: number;
  readonly h: number;
  readonly px: Uint8Array;
  version = 0;

  constructor(w: number, h: number, fill = 0) {
    this.w = w;
    this.h = h;
    this.px = new Uint8Array(w * h);
    if (fill) this.px.fill(fill);
  }

  private touch(): void {
    this.version++;
  }

  /** buf_fill: opaque rectangle (w or h <= 0 draws nothing) */
  fill(x: number, y: number, w: number, h: number, c: number): void {
    const x0 = Math.max(0, x), y0 = Math.max(0, y);
    const x1 = Math.min(this.w, x + w), y1 = Math.min(this.h, y + h);
    for (let yy = y0; yy < y1; yy++) this.px.fill(c, yy * this.w + x0, yy * this.w + x1);
    this.touch();
  }

  pixel(x: number, y: number, c: number): void {
    if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.px[y * this.w + x] = c;
  }

  /**
   * draw_line (0x4421a0): a horizontal line covers x1 .. x2-1 (the right end is not drawn), a vertical one
   * y1 .. y2 inclusive.
   */
  line(x1: number, y1: number, x2: number, y2: number, c: number): void {
    if (y1 === y2) {
      for (let x = Math.min(x1, x2); x < Math.max(x1, x2); x++) this.pixel(x, y1, c);
    } else if (x1 === x2) {
      for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) this.pixel(x1, y, c);
    } else {
      let dx = Math.abs(x2 - x1), dy = -Math.abs(y2 - y1);
      const sx = x1 < x2 ? 1 : -1, sy = y1 < y2 ? 1 : -1;
      let err = dx + dy;
      for (;;) {
        this.pixel(x1, y1, c);
        if (x1 === x2 && y1 === y2) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x1 += sx; }
        if (e2 <= dx) { err += dx; y1 += sy; }
      }
    }
    this.touch();
  }

  /** draw_box: top, bottom, left, right -> a complete 1-px rectangle l..r x t..b */
  rect(l: number, t: number, r: number, b: number, c: number): void {
    this.line(l, t, r, t, c);
    this.line(l, b, r, b, c);
    this.line(l, t, l, b, c);
    this.line(r, t, r, b, c);
  }

  /** draw_shaded_box: top and left in `lt`, bottom and right in `rb` (corners: (r,t) and (r,b) rb, (l,b) lt) */
  rectShadowed(l: number, t: number, r: number, b: number, lt: number, rb: number): void {
    this.line(l, t, r, t, lt);
    this.line(l, b, r, b, rb);
    this.line(l, t, l, b, lt);
    this.line(r, t, r, b, rb);
  }

  /** lighten_buf: every pixel of the area goes through the intensity table. */
  lighten(x: number, y: number, w: number, h: number, colors: GnwColors): void {
    const x0 = Math.max(0, x), y0 = Math.max(0, y);
    const x1 = Math.min(this.w, x + w), y1 = Math.min(this.h, y + h);
    const m = colors.lightenMap;
    for (let yy = y0; yy < y1; yy++) {
      const row = yy * this.w;
      for (let xx = x0; xx < x1; xx++) this.px[row + xx] = m[this.px[row + xx]];
    }
    this.touch();
  }

  /**
   * text_to_buf (0x431f70): `s` at (x, y) within `maxw` pixels (whole glyphs), colour = low byte of `color`;
   * TEXT_SHADOW first draws the whole string at (+1,+1) in colorTable[0] (255).
   */
  text(font: CpuFont, s: string, maxw: number, x: number, y: number, color: number, colors: GnwColors): void {
    if (color & TEXT_SHADOW) this.text(font, s, maxw, x + 1, y + 1, (color & ~0xff & ~TEXT_SHADOW) | colors.black, colors);
    const c = color & 0xff;
    let cx = 0;
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i) & 0xff;
      if (code >= font.widths.length) continue;
      const gw = font.widths[code];
      const end = cx + gw + font.spacing;
      if (end > maxw) break;
      const bits = font.bits[code];
      for (let gy = 0; gy < font.height; gy++) {
        const py = y + gy;
        if (py < 0 || py >= this.h) continue;
        for (let gx = 0; gx < gw; gx++) {
          if (!bits[gy * gw + gx]) continue;
          const pxx = x + cx + gx;
          if (pxx >= 0 && pxx < this.w) this.px[py * this.w + pxx] = c;
        }
      }
      cx = end;
    }
    this.touch();
  }

  /** buf_to_buf / trans_buf_to_buf: copy a rectangle of `src` (skipping index 0 when `transparent`). */
  blit(src: Uint8Array, srcPitch: number, sx: number, sy: number, w: number, h: number, dx: number, dy: number, transparent = false): void {
    for (let yy = 0; yy < h; yy++) {
      const ty = dy + yy;
      if (ty < 0 || ty >= this.h) continue;
      const srow = (sy + yy) * srcPitch + sx;
      const drow = ty * this.w;
      for (let xx = 0; xx < w; xx++) {
        const tx = dx + xx;
        if (tx < 0 || tx >= this.w) continue;
        const v = src[srow + xx];
        if (transparent && v === 0) continue;
        this.px[drow + tx] = v;
      }
    }
    this.touch();
  }

  blitBuf(src: WinBuf, dx: number, dy: number, transparent = false): void {
    this.blit(src.px, src.w, 0, 0, src.w, src.h, dx, dy, transparent);
  }

  /** window_fill_winz (0x41726b): nine-slice of WINZ.PCX (72x72, 24x24 tiles), all opaque copies. */
  fillWinz(winz: ScreenImage): void {
    const W = this.w, H = this.h;
    const tw = Math.trunc(winz.w / 3), th = Math.trunc(winz.h / 3);
    const src = winz.pixels, pitch = winz.w;
    for (let y = 0; y < H; y += th) for (let x = 0; x < W; x += tw) this.blit(src, pitch, tw, th, Math.min(tw, W - x), Math.min(th, H - y), x, y);
    for (let x = 0; x < W; x += tw) {
      const w = Math.min(tw, W - x);
      this.blit(src, pitch, tw, 0, w, th, x, 0);
      this.blit(src, pitch, tw, 2 * th, w, th, x, H - th);
    }
    for (let y = 0; y < H; y += th) {
      const h = Math.min(th, H - y);
      this.blit(src, pitch, 0, th, tw, h, 0, y);
      this.blit(src, pitch, 2 * tw, th, tw, h, W - tw, y);
    }
    this.blit(src, pitch, 0, 0, tw, th, 0, 0);
    this.blit(src, pitch, 2 * tw, 0, tw, th, W - tw, 0);
    this.blit(src, pitch, 0, 2 * th, tw, th, 0, H - th);
    this.blit(src, pitch, 2 * tw, 2 * th, tw, th, W - tw, H - th);
  }
}

export interface GnwButton {
  x: number;
  y: number;
  w: number;
  h: number;
  normal: WinBuf | null;
  pressed: WinBuf | null;
  /** key code sent on mouse press, repeated while held (-1 none) */
  downCode: number;
  /** key code sent on mouse release inside the button (-1 none) */
  upCode: number;
  /** key code sent when the pointer enters (-1 none) */
  enterCode: number;
  /** title strip: dragging it moves the window */
  drag: boolean;
  isPressed: boolean;
}

/** GNW mouse repeat of down-code buttons (held arrow / page buttons) */
const REPEAT_DELAY = 500;
const REPEAT_RATE = 80;

/** A GNW window: position, buffer, buttons. */
export class GnwWindow {
  x: number;
  y: number;
  readonly buf: WinBuf;
  readonly buttons: GnwButton[] = [];
  private tex: TextureHandle | null = null;
  private uploaded = -1;
  private captured: GnwButton | null = null;
  private hover: GnwButton | null = null;
  private repeatAt = 0;
  private dragFrom: { px: number; py: number; wx: number; wy: number } | null = null;

  constructor(x: number, y: number, w: number, h: number, fill: number) {
    this.x = x;
    this.y = y;
    this.buf = new WinBuf(w, h, fill);
  }

  get w(): number {
    return this.buf.w;
  }

  get h(): number {
    return this.buf.h;
  }

  addButton(b: Omit<GnwButton, 'isPressed' | 'enterCode' | 'drag'> & { enterCode?: number; drag?: boolean }): GnwButton {
    const btn: GnwButton = { enterCode: -1, drag: false, ...b, isPressed: false };
    this.buttons.push(btn);
    if (btn.normal) this.buf.blitBuf(btn.normal, btn.x, btn.y);
    return btn;
  }

  private setPressed(b: GnwButton, on: boolean): void {
    if (b.isPressed === on) return;
    b.isPressed = on;
    const img = on ? b.pressed : b.normal;
    if (img) this.buf.blitBuf(img, b.x, b.y);
  }

  private hit(x: number, y: number): GnwButton | null {
    const lx = x - this.x, ly = y - this.y;
    for (let i = this.buttons.length - 1; i >= 0; i--) {
      const b = this.buttons[i];
      if (lx >= b.x && ly >= b.y && lx < b.x + b.w && ly < b.y + b.h) return b;
    }
    return null;
  }

  /** The key code of the button under (x, y) if it reports hovering (list rows), else -1. */
  hoverCode(x: number, y: number): number {
    const b = this.hit(x, y);
    this.hover = b;
    return b ? b.enterCode : -1;
  }

  /** Feed one pointer record (game coordinates); returns the key code produced (or -1). */
  pointer(type: 'down' | 'up' | 'move', x: number, y: number, now: number): number {
    if (this.dragFrom) {
      // the window follows the mouse while its title strip is held (clamped on screen)
      const d = this.dragFrom;
      this.x = Math.max(0, Math.min(640 - this.w, d.wx + x - d.px));
      this.y = Math.max(0, Math.min(480 - this.h, d.wy + y - d.py));
      if (type === 'up') this.dragFrom = null;
      return -1;
    }
    const b = this.hit(x, y);
    if (type === 'move') {
      if (this.captured) this.setPressed(this.captured, b === this.captured);
      if (b !== this.hover) {
        this.hover = b;
        if (b && b.enterCode !== -1 && !this.captured) return b.enterCode;
      }
      return -1;
    }
    if (type === 'down') {
      if (!b) return -1;
      if (b.drag) {
        this.dragFrom = { px: x, py: y, wx: this.x, wy: this.y };
        return -1;
      }
      this.captured = b;
      this.setPressed(b, true);
      this.repeatAt = now + REPEAT_DELAY;
      return b.downCode;
    }
    const c = this.captured;
    this.captured = null;
    if (!c) return -1;
    this.setPressed(c, false);
    return b === c ? c.upCode : -1;
  }

  /** Mouse repeat: a held down-code button sends its code again while the mouse button stays down on it. */
  repeat(now: number, held: boolean): number {
    const c = this.captured;
    if (!c || !held || c.downCode === -1 || !c.isPressed || now < this.repeatAt) return -1;
    this.repeatAt = now + REPEAT_RATE;
    return c.downCode;
  }

  /** _GNW_win_refresh: the buttons' current images are drawn over the window contents. */
  draw(gfx: Gfx): void {
    const r = gfx.r;
    if (this.uploaded !== this.buf.version || !this.tex) {
      for (const b of this.buttons) {
        const img = b.isPressed ? b.pressed : b.normal;
        if (img) this.buf.blitBuf(img, b.x, b.y);
      }
      if (!this.tex) this.tex = r.createIndexedTexture(this.buf.w, this.buf.h, [this.buf.px]);
      else r.updateIndexedLayer(this.tex, 0, this.buf.px);
      this.uploaded = this.buf.version;
    }
    r.draw(this.tex, 0, 0, 0, this.buf.w, this.buf.h, this.x, this.y, 0, DrawMode.Opaque);
  }

  dispose(gfx: Gfx): void {
    if (this.tex) gfx.r.deleteTexture(this.tex);
    this.tex = null;
  }
}

/** GNW's default mouse cursor (8x8 at 0x45c310): 1 = outline (colorTable[0x2108] = 142), F = fill (72). */
const CURSOR_ROWS = ['1111111.', '1FFFFF1.', '1FFFF11.', '1FFFF11.', '1FFFFF11', '1F11FFF1', '11111FF1', '....1111'];

/** Shared GNW resources (font, colours, WINZ picture, mouse cursor). */
export class Gnw {
  readonly gfx: Gfx;
  readonly colors: GnwColors;
  readonly font: CpuFont;
  winz: ScreenImage | null = null;
  private cursorTex: TextureHandle | null = null;

  constructor(gfx: Gfx) {
    this.gfx = gfx;
    this.colors = new GnwColors(gfx);
    this.font = new CpuFont(gfx.fontData['font6']);
  }

  async init(): Promise<void> {
    this.winz = await this.gfx.loadScreenPixels('WINZ');
    const px = new Uint8Array(64);
    const outline = this.colors.rgb(8, 8, 8);
    const fill = this.colors.rgb(31, 31, 31);
    CURSOR_ROWS.forEach((row, y) => {
      for (let x = 0; x < 8; x++) px[y * 8 + x] = row[x] === '1' ? outline : row[x] === 'F' ? fill : 0;
    });
    this.cursorTex = this.gfx.r.createIndexedTexture(8, 8, [px]);
  }

  /** Draw the mouse cursor with its hotspot (1,1) at (x, y). */
  drawCursor(x: number, y: number): void {
    if (this.cursorTex) this.gfx.r.draw(this.cursorTex, 0, 0, 0, 8, 8, x - 1, y - 1, 0, DrawMode.Sprite);
  }

  get lineHeight(): number {
    return this.font.height;
  }

  textWidth(s: string): number {
    return this.font.width(s);
  }

  /** win_add(x, y, w, h, 0x100, flags): new window filled with the window colour (wcolor[0] = 205). */
  window(x: number, y: number, w: number, h: number): GnwWindow {
    return new GnwWindow(x, y, w, h, this.colors.wcolor[0]);
  }

  /** win_border (0x43ca60): 5-px lightened rim, black frame, raised outer bevel, sunken inner bevel. */
  border(win: GnwWindow): void {
    const c = this.colors;
    const b = win.buf;
    const W = win.w, H = win.h;
    b.lighten(5, 0, W - 10, 5, c);
    b.lighten(0, 0, 5, H, c);
    b.lighten(W - 5, 0, 5, H, c);
    b.lighten(5, H - 5, W - 10, 5, c);
    b.rect(0, 0, W - 1, H - 1, c.black);
    b.rectShadowed(1, 1, W - 2, H - 2, c.wcolor[1], c.wcolor[2]);
    b.rectShadowed(5, 5, W - 6, H - 6, c.wcolor[2], c.wcolor[1]);
  }

  /** The two images of a GNW text button on a window of colour `face` (§4). */
  buttonImages(label: string, face: number): { normal: WinBuf; pressed: WinBuf; w: number; h: number } {
    const c = this.colors;
    const w = this.font.width(label) + 16;
    const h = this.font.height + 6;
    const normal = new WinBuf(w, h, face);
    const pressed = new WinBuf(w, h, face);
    normal.lighten(0, 0, w, h, c);
    normal.text(this.font, label, w, 8, 3, c.wcolor[3] | TEXT_SHADOW, c);
    normal.rectShadowed(2, 2, w - 3, h - 3, c.wcolor[1], c.wcolor[2]);
    normal.rectShadowed(1, 1, w - 2, h - 2, c.wcolor[1], c.wcolor[2]);
    normal.rect(0, 0, w - 1, h - 1, c.black);
    pressed.text(this.font, label, w, 9, 4, c.wcolor[3] | TEXT_SHADOW, c);
    pressed.rectShadowed(2, 2, w - 3, h - 3, c.wcolor[2], c.wcolor[1]);
    pressed.rectShadowed(1, 1, w - 2, h - 2, c.wcolor[2], c.wcolor[1]);
    pressed.rect(0, 0, w - 1, h - 1, c.black);
    return { normal, pressed, w, h };
  }

  /** win_register_text_button on a dialog window (window colour 205). */
  textButton(win: GnwWindow, x: number, y: number, label: string, downCode: number, upCode: number): GnwButton {
    const { normal, pressed, w, h } = this.buttonImages(label, this.colors.wcolor[0]);
    return win.addButton({ x, y, w, h, normal, pressed, downCode, upCode });
  }

  /** graf_print into a window: outline at the 4 diagonal offsets, text at (1,1), transparent blit. */
  print(win: GnwWindow, s: string, w: number, x: number, y: number, fg: number, outline: number): void {
    const f = this.font, c = this.colors;
    const wt = Math.min(f.width(s), w);
    win.buf.text(f, s, wt, x, y, outline, c);
    win.buf.text(f, s, wt, x + 2, y + 2, outline, c);
    win.buf.text(f, s, wt, x, y + 2, outline, c);
    win.buf.text(f, s, wt, x + 2, y, outline, c);
    win.buf.text(f, s, wt, x + 1, y + 1, fg, c);
  }

  /** graf_print_centered into a window. */
  printCentered(win: GnwWindow, s: string, cx: number, y: number, fg: number, outline: number): void {
    const tw = this.font.width(s);
    this.print(win, s, tw + 2, cx - Math.trunc((tw + 2) / 2), y, fg, outline);
  }

  /** win_print: fills the line background with the window colour unless TEXT_NOFILL, then text_to_buf. */
  windowText(win: GnwWindow, s: string, maxw: number, x: number, y: number, color: number): void {
    const width = maxw || this.font.width(s);
    if (x + width > win.w || y + this.font.height > win.h) return;
    if (!(color & TEXT_NOFILL)) win.buf.fill(x, y, width, this.font.height, this.colors.wcolor[0]);
    win.buf.text(this.font, s, width, x, y, color, this.colors);
  }
}

/**
 * GNW text buttons registered on the main window (keydefs screen): face = the main window's colour
 * colorTable[0] = 255, lightened to 194 when not pressed; drawn over the frame at refresh time; mouse
 * presses produce their key codes (with GNW's mouse repeat for down-codes).
 */
export class ScreenButtons {
  private gnw: Gnw;
  private items: { btn: GnwButton; texN: TextureHandle | null; texP: TextureHandle | null }[] = [];
  private captured: GnwButton | null = null;
  private repeatAt = 0;

  constructor(gnw: Gnw) {
    this.gnw = gnw;
  }

  add(x: number, y: number, label: string, downCode: number, upCode: number): void {
    const { normal, pressed, w, h } = this.gnw.buttonImages(label, this.gnw.colors.black);
    this.items.push({ btn: { x, y, w, h, normal, pressed, downCode, upCode, enterCode: -1, drag: false, isPressed: false }, texN: null, texP: null });
  }

  pointer(type: 'down' | 'up' | 'move', x: number, y: number, now: number): number {
    const hit = this.items.find(({ btn: b }) => x >= b.x && y >= b.y && x < b.x + b.w && y < b.y + b.h)?.btn ?? null;
    if (type === 'move') {
      if (this.captured) this.captured.isPressed = hit === this.captured;
      return -1;
    }
    if (type === 'down') {
      if (!hit) return -1;
      this.captured = hit;
      hit.isPressed = true;
      this.repeatAt = now + REPEAT_DELAY;
      return hit.downCode;
    }
    const c = this.captured;
    this.captured = null;
    if (!c) return -1;
    c.isPressed = false;
    return hit === c ? c.upCode : -1;
  }

  repeat(now: number, held: boolean): number {
    const c = this.captured;
    if (!c || !held || c.downCode === -1 || !c.isPressed || now < this.repeatAt) return -1;
    this.repeatAt = now + REPEAT_RATE;
    return c.downCode;
  }

  draw(): void {
    const r = this.gnw.gfx.r;
    for (const it of this.items) {
      const b = it.btn;
      if (!it.texN && b.normal) it.texN = r.createIndexedTexture(b.w, b.h, [b.normal.px]);
      if (!it.texP && b.pressed) it.texP = r.createIndexedTexture(b.w, b.h, [b.pressed.px]);
      const t = b.isPressed ? it.texP : it.texN;
      if (t) r.draw(t, 0, 0, 0, b.w, b.h, b.x, b.y, 0, DrawMode.Opaque);
    }
  }

  releaseAll(): void {
    for (const b of this.items) b.btn.isPressed = false;
    this.captured = null;
  }

  dispose(): void {
    const r = this.gnw.gfx.r;
    for (const it of this.items) {
      if (it.texN) r.deleteTexture(it.texN);
      if (it.texP) r.deleteTexture(it.texP);
    }
    this.items = [];
  }
}
