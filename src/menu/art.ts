// Pictures for the menus, drawn with the game's own renderer from the original sprites: the power-ups,
// the bomber in each of the ten player colours, and a snapshot of every arena (its first frame).

import type { Game } from '../app/Game.ts';
import { createGame, roundStart, step, flattenValues, type MatchConfig } from '../game/sim/sim.ts';
import { FrameCtx } from '../game/sim/ctx.ts';
import { AnimDB } from '../game/sim/anims.ts';
import { GameRenderer } from '../game/render/GameRenderer.ts';
import { POWER_NAMES } from '../game/sim/powers.ts';
import { remapOf } from '../game/sim/flames.ts';
import { ownPalette } from '../engine/gfx.ts';

export const ARENA_COUNT = 11;

/** Copy the index buffer region into an image (index 0 transparent when `alpha`). */
function toImage(idx: Uint8Array, pal: Uint8Array, x0: number, y0: number, w: number, h: number, alpha: boolean): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx[(y0 + y) * 640 + x0 + x];
      const o = (y * w + x) * 4;
      if (alpha && i === 0) continue;
      img.data[o] = pal[i * 3];
      img.data[o + 1] = pal[i * 3 + 1];
      img.data[o + 2] = pal[i * 3 + 2];
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Bounding box of the non-transparent pixels inside a region. */
function bounds(idx: Uint8Array, x0: number, y0: number, w: number, h: number): [number, number, number, number] {
  let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (!idx[y * 640 + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? [x0, y0, 1, 1] : [minX, minY, maxX - minX + 1, maxY - minY + 1];
}

export class MenuArt {
  readonly powers: Record<string, string> = {};
  readonly bombers: string[] = [];
  private arenas = new Map<number, Promise<string>>();
  private g: Game;

  constructor(g: Game) {
    this.g = g;
    this.drawSprites();
  }

  /** Power-up icons and the ten bombers, drawn in one frame and read back once. */
  private drawSprites(): void {
    const gfx = this.g.app.gfx;
    const r = gfx.r;
    r.beginFrame();
    r.fillRect(0, 0, 640, 480, 0);
    POWER_NAMES.forEach((name, k) => {
      if (gfx.hasSeq(`power ${name}`)) gfx.drawSeqByName(`power ${name}`, 0, 30 + (k % 7) * 60, 40 + Math.floor(k / 7) * 60);
    });
    for (let i = 0; i < 10; i++) gfx.drawSeqByName('stand south', 0, 32 + i * 60, 300, remapOf(i));
    const idx = r.readIndices();
    r.fillRect(0, 0, 640, 480, 0);
    const pal = gfx.gamePalette;
    POWER_NAMES.forEach((name, k) => {
      const cx = 30 + (k % 7) * 60, cy = 40 + Math.floor(k / 7) * 60;
      const [x, y, w, h] = bounds(idx, cx - 29, cy - 39, 58, 58);
      this.powers[name] = toImage(idx, pal, x, y, w, h, true).toDataURL('image/png');
    });
    for (let i = 0; i < 10; i++) {
      const [x, y, w, h] = bounds(idx, 32 + i * 60 - 30, 200, 60, 140);
      this.bombers.push(toImage(idx, pal, x, y, w, h, true).toDataURL('image/png'));
    }
  }

  /** Walk cycle cell size and frame count of the strips made by walkStrip(). */
  static readonly WALK_W = 60;
  static readonly WALK_H = 90;
  static readonly WALK_FRAMES = 15;
  private walks = new Map<string, string>();

  /**
   * The walk cycle of the bomber in colour `colour` facing east or west, as a strip of WALK_FRAMES cells
   * (feet on a common baseline), for CSS sprite animation.
   */
  walkStrip(colour: number, dir: 'east' | 'west'): string {
    const key = `${colour}:${dir}`;
    const have = this.walks.get(key);
    if (have) return have;
    const gfx = this.g.app.gfx;
    const r = gfx.r;
    const seq = gfx.seq(`walk ${dir}`);
    const n = MenuArt.WALK_FRAMES, W = MenuArt.WALK_W, H = MenuArt.WALK_H;
    r.beginFrame();
    r.fillRect(0, 0, 640, 480, 0);
    // ten cells per row, the rows 40 px apart so that no frame spills into the cell below; the sprite's anchor
    // 20 px above the cell's bottom (the frames reach up to 18 px below their anchor and 55 px above it)
    const pitch = H + 40;
    const cell = (k: number): [number, number] => [(k % 10) * W, Math.floor(k / 10) * pitch];
    for (let k = 0; k < n; k++) gfx.drawSeq(seq, k, cell(k)[0] + W / 2, cell(k)[1] + H - 20, remapOf(colour));
    const idx = r.readIndices();
    r.fillRect(0, 0, 640, 480, 0);
    // the west frames hang lower below their anchor than the east ones: put the feet 5 px above the bottom
    // in both directions, over a soft shadow
    let bottom = 0, left = W, right = 0;
    for (let k = 0; k < n; k++) {
      const [x, y, w, h] = bounds(idx, ...cell(k), W, H);
      bottom = Math.max(bottom, y + h - 1 - cell(k)[1]);
      left = Math.min(left, x - cell(k)[0]);
      right = Math.max(right, x + w - 1 - cell(k)[0]);
    }
    const dy = H - 5 - bottom;
    const out = document.createElement('canvas');
    out.width = W * n;
    out.height = H;
    const ctx = out.getContext('2d')!;
    const shadow = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    shadow.addColorStop(0, 'rgba(0, 0, 0, 0.5)');
    shadow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    for (let k = 0; k < n; k++) {
      ctx.setTransform(16, 0, 0, 5, k * W + (left + right + 1) / 2, H - 6);
      ctx.fillStyle = shadow;
      ctx.fillRect(-1, -1, 2, 2);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(toImage(idx, gfx.gamePalette, ...cell(k), W, H, true), k * W, dy);
    }
    const url = out.toDataURL('image/png');
    this.walks.set(key, url);
    return url;
  }

  /** The Boom Buds logo, cut out of the title picture. */
  async logo(): Promise<string> {
    const gfx = this.g.app.gfx;
    const img = await gfx.loadScreen('title');
    const r = gfx.r;
    r.beginFrame();
    gfx.drawScreen(img);
    const idx = r.readIndices();
    r.fillRect(0, 0, 640, 480, 0);
    const pal = img.ownPalette ? ownPalette(img.palette) : gfx.gamePalette;
    return toImage(idx, pal, 190, 6, 310, 172, false).toDataURL('image/png');
  }

  /** The first frame of a round on arena `level` (four bombers, the basic scheme), field area only. */
  arena(level: number): Promise<string> {
    let p = this.arenas.get(level);
    if (!p) {
      p = this.drawArena(level);
      this.arenas.set(level, p);
    }
    return p;
  }

  private async drawArena(level: number): Promise<string> {
    const app = this.g.app;
    const gfx = app.gfx;
    const scheme = app.text.schemes.find((s) => s.file === 'BASIC.SCH') ?? app.text.schemes[0];
    const cfg: MatchConfig = {
      slots: Array.from({ length: 10 }, (_, i) => ({ ctrl: i < 4 ? 2 : 0, team: i & 1 })),
      values: flattenValues(app.text.values),
      scheme,
      extras: app.text.extras,
      levelno: level,
      numToWin: 3,
      winByKills: 0,
      teamPlay: 0,
      randomStart: 0,
      enclosementDepth: 1,
      conveyorSpeed: 1,
      stompedBombsDetonate: 1,
      diseasesDestroyable: 1,
      playtime: 150,
      netMode: 0,
      goldWinner: -1,
      goldPrize: -1,
      attract: 0,
      seed: 20261012 + level,
    };
    const s = createGame(cfg);
    roundStart(s, cfg.scheme, cfg.extras);
    const ctx = new FrameCtx(new AnimDB(gfx.sprites.seqs));
    step(s, ctx, new Uint8Array(11));
    const gr = new GameRenderer(gfx);
    gr.values = s.opts.values;
    gr.messages = app.text.messages;
    await gr.prepareLevel(level);
    const r = gfx.r;
    r.beginFrame();
    gr.render(s, ctx);
    const idx = r.readIndices();
    r.fillRect(0, 0, 640, 480, 0);
    const full = toImage(idx, gfx.gamePalette, 0, 52, 640, 428, false);
    const out = document.createElement('canvas');
    out.width = 384;
    out.height = 257;
    const c2 = out.getContext('2d')!;
    c2.imageSmoothingQuality = 'high';
    c2.drawImage(full, 0, 0, out.width, out.height);
    return out.toDataURL('image/webp', 0.9);
  }
}
