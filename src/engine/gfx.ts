// High level drawing API: sprites from the packed atlases, sequences, fonts and full screen images.

import { Renderer, DrawMode, identityTable, type TextureHandle } from './gl/Renderer.ts';
import { loadGz, loadJson, loadBinary, type SpriteManifest, type FontJson, type ScreenIndex } from './assets.ts';
import { SCREEN_W, SCREEN_H } from './constants.ts';

export interface FontGlyph {
  x: number;
  y: number;
  w: number;
}

export interface Font {
  height: number;
  spacing: number;
  glyphs: FontGlyph[];
  layer: number;
}

export interface ScreenImage {
  tex: TextureHandle;
  /** palette indices, w * h, row-major (CPU copy for GNW window buffers) */
  pixels: Uint8Array;
  palette: Uint8Array; // 768, 8-bit RGB as stored in the PCX
  ownPalette: boolean;
  w: number;
  h: number;
}

export class Gfx {
  readonly r: Renderer;
  atlas!: TextureHandle;
  sprites!: SpriteManifest;
  /** sequence name -> index into seqList */
  private seqIndex = new Map<string, number>();
  seqList: [number, number, number][][][] = [];
  fontTex!: TextureHandle;
  fonts: Record<string, Font> = {};
  /** raw font data (CPU rendering into GNW window buffers) */
  fontData: Record<string, FontJson> = {};
  screenIndex: ScreenIndex = {};
  private screens = new Map<string, Promise<ScreenImage>>();
  /** Game palette, 8-bit RGB (expanded from the 6-bit COLOR.PAL values). */
  gamePalette: Uint8Array = new Uint8Array(768);
  gamePalette6: Uint8Array = new Uint8Array(768);
  lut555: Uint8Array = new Uint8Array(32768);
  /** Raw .RMP files (10 x 259 bytes). */
  rmp: Uint8Array = new Uint8Array(0);

  constructor(r: Renderer) {
    this.r = r;
  }

  /** Everything except the sprite atlas: palette, colour tables, fonts, remaps, screen index. */
  async loadBase(): Promise<void> {
    const [manifest, pal, lut, rmp, fonts, screenIndex] = await Promise.all([
      loadJson<SpriteManifest>('sprites/sprites.json'),
      loadBinary('palette.bin'),
      loadBinary('lut555.bin'),
      loadBinary('remap.bin'),
      loadJson<Record<string, FontJson>>('fonts.json'),
      loadJson<ScreenIndex>('screens/index.json'),
    ]);
    this.sprites = manifest;
    this.screenIndex = screenIndex;
    this.gamePalette6 = pal;
    this.gamePalette = expandPalette6(pal);
    this.lut555 = lut;
    this.rmp = rmp;
    for (const [name, states] of Object.entries(manifest.seqs)) {
      this.seqIndex.set(name, this.seqList.length);
      this.seqList.push(states);
    }
    this.fontData = fonts;
    this.buildFonts(fonts);
    // remap tables: N.RMP, where 0 means "unchanged" (graf_load_remap); table k+1 = player colour k
    const tables = [identityTable()];
    for (let i = 0; i < 10; i++) {
      const t = new Uint8Array(256);
      for (let j = 0; j < 256; j++) t[j] = rmp[i * 259 + j] || j;
      tables.push(t);
    }
    this.r.setRemapTables(tables);
  }

  /** The sprite atlas pages (the bulk of the data); `progress` receives 0..1. */
  async loadSprites(progress?: (f: number) => void): Promise<void> {
    const n = this.sprites.pages;
    const done = new Array(n).fill(0);
    const total = new Array(n).fill(1);
    const report = () => progress?.(done.reduce((a, b) => a + b, 0) / Math.max(1, total.reduce((a, b) => a + b, 0)));
    const pages = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        loadGz(`sprites/atlas${i}.bin.gz`, (got, size) => {
          done[i] = got;
          total[i] = size;
          report();
        }),
      ),
    );
    this.atlas = this.r.createIndexedTexture(this.sprites.pageSize, this.sprites.pageSize, pages);
  }

  async load(): Promise<void> {
    await this.loadBase();
    await this.loadSprites();
  }

  private buildFonts(fonts: Record<string, FontJson>): void {
    const W = 1024;
    let H = 0;
    // simple shelf layout: one row of glyphs per font row
    const layout: { name: string; f: FontJson; y: number; positions: FontGlyph[] }[] = [];
    let y = 0;
    for (const [name, f] of Object.entries(fonts)) {
      let x = 0;
      let rowY = y;
      const positions: FontGlyph[] = [];
      for (const g of f.glyphs) {
        if (x + g.w > W) { x = 0; rowY += f.height + 1; }
        positions.push({ x, y: rowY, w: g.w });
        x += g.w + 1;
      }
      layout.push({ name, f, y, positions });
      y = rowY + f.height + 1;
    }
    H = Math.max(1, y);
    const data = new Uint8Array(W * H);
    for (const { f, positions } of layout) {
      f.glyphs.forEach((g, i) => {
        const p = positions[i];
        for (let gy = 0; gy < f.height; gy++) for (let gx = 0; gx < g.w; gx++) {
          if (g.bits.charCodeAt(gy * g.w + gx) === 49) data[(p.y + gy) * W + p.x + gx] = 1;
        }
      });
    }
    this.fontTex = this.r.createIndexedTexture(W, H, [data]);
    for (const { name, f, positions } of layout) {
      this.fonts[name] = { height: f.height, spacing: f.spacing, glyphs: positions, layer: 0 };
    }
  }

  seq(name: string): number {
    const i = this.seqIndex.get(name);
    if (i === undefined) throw new Error(`unknown sequence '${name}'`);
    return i;
  }

  hasSeq(name: string): boolean {
    return this.seqIndex.has(name);
  }

  seqStates(seq: number): number {
    return this.seqList[seq].length;
  }

  /** Draw a single atlas frame with its hotspot at (x, y). */
  drawFrame(frame: number, x: number, y: number, remap = 0, mode: DrawMode = DrawMode.Sprite): void {
    const f = this.sprites.frames[frame];
    if (!f || f[3] === 0) return;
    this.r.draw(this.atlas, f[0], f[1], f[2], f[3], f[4], x - f[5], y - f[6], remap, mode);
  }

  /** Draw frame silhouette in a single palette color. */
  drawFrameMask(frame: number, x: number, y: number, color: number): void {
    const f = this.sprites.frames[frame];
    if (!f || f[3] === 0) return;
    this.r.drawMask(this.atlas, f[0], f[1], f[2], f[3], f[4], x - f[5], y - f[6], color);
  }

  /** Draw state `state` of sequence `seq` positioned at (x, y). */
  drawSeq(seq: number, state: number, x: number, y: number, remap = 0): void {
    const states = this.seqList[seq];
    if (!states || states.length === 0) return;
    const st = states[state < 0 ? 0 : state >= states.length ? states.length - 1 : state | 0];
    for (const [frame, dx, dy] of st) this.drawFrame(frame, x + dx, y + dy, remap);
  }

  drawSeqByName(name: string, state: number, x: number, y: number, remap = 0): void {
    this.drawSeq(this.seq(name), state, x, y, remap);
  }

  textWidth(font: string, s: string): number {
    const f = this.fonts[font];
    let w = 0;
    for (let i = 0; i < s.length; i++) {
      const g = f.glyphs[s.charCodeAt(i) & 0xff];
      if (!g) continue;
      w += g.w + f.spacing;
    }
    return w;
  }

  /** Draw text (top-left at x, y) in palette color `color`. Returns the advance width. */
  drawText(font: string, s: string, x: number, y: number, color: number): number {
    const f = this.fonts[font];
    let cx = x;
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i) & 0xff;
      const g = f.glyphs[code];
      if (!g) continue;
      if (g.w > 0) this.r.drawMask(this.fontTex, 0, g.x, g.y, g.w, f.height, cx, y, color);
      cx += g.w + f.spacing;
    }
    return cx - x;
  }

  loadScreen(name: string): Promise<ScreenImage> {
    const key = name.toUpperCase();
    let p = this.screens.get(key);
    if (!p) {
      p = (async () => {
        const info = this.screenIndex[key];
        if (!info) throw new Error(`unknown screen ${name}`);
        const [px, pal] = await Promise.all([loadGz(`screens/${key}.bin.gz`), loadBinary(`screens/${key}.pal`)]);
        const tex = this.r.createIndexedTexture(info.w, info.h, [px]);
        return { tex, pixels: px, palette: pal, ownPalette: info.ownPalette, w: info.w, h: info.h };
      })();
      this.screens.set(key, p);
    }
    return p;
  }

  /** Same as loadScreen; the CPU pixel copy is always kept. */
  loadScreenPixels(name: string): Promise<ScreenImage> {
    return this.loadScreen(name);
  }

  /** Blit a full screen image (opaque). */
  drawScreen(img: ScreenImage, x = 0, y = 0, remap = 0): void {
    this.r.draw(img.tex, 0, 0, 0, img.w, img.h, x, y, remap, DrawMode.Opaque);
  }

  /** Blit part of a screen image (opaque). */
  drawScreenPart(img: ScreenImage, sx: number, sy: number, w: number, h: number, dx: number, dy: number): void {
    this.r.draw(img.tex, 0, sx, sy, w, h, dx, dy, 0, DrawMode.Opaque);
  }

  fill(x: number, y: number, w: number, h: number, color: number): void {
    this.r.fillRect(x, y, w, h, color);
  }

  clear(color = 0): void {
    this.r.fillRect(0, 0, SCREEN_W, SCREEN_H, color);
  }
}

/**
 * Game palette as displayed by the original: GNW95_SetPalette uses v << 2 for each 6-bit value (0..252),
 * and COLOR.PAL entry 0 (an invalid 255,255,255) is forced to black.
 */
export function expandPalette6(p6: Uint8Array): Uint8Array {
  const out = new Uint8Array(768);
  for (let i = 0; i < 768; i++) out[i] = (p6[i] & 63) << 2;
  out[0] = out[1] = out[2] = 0;
  return out;
}

/** Own-palette picture screens: the hardware shows the 8-bit PCX palette as (v >> 2) << 2. */
export function ownPalette(p8: Uint8Array): Uint8Array {
  const out = new Uint8Array(768);
  for (let i = 0; i < 768; i++) out[i] = p8[i] & 0xfc;
  return out;
}
