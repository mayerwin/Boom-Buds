// map.c: grid helpers, generation from a scheme and start-area clearing (docs/re/flames-map-powerups.md §1).

import { W, H, type GameState } from './types.ts';
import { rand } from './rng.ts';

export const MAP_BLANK = 0;
export const MAP_SOLID = 1;
export const MAP_BRICK = 2;

/** Integer division truncating toward zero, like C. */
export function idiv(a: number, b: number): number {
  return Math.trunc(a / b);
}

export function cellCenterX(cx: number): number {
  return 40 + 40 * cx;
}

export function cellFeetY(cy: number): number {
  return 103 + 36 * cy;
}

/** px_to_cell_x with the original's broken floor emulation for negative coordinates. */
export function pxToCx(px: number): number {
  let v = px;
  if (v < 20) v -= 20;
  return idiv(v - 20, 40);
}

export function pyToCy(py: number): number {
  let v = py;
  if (py - 68 - 17 < 0) v = py - 67;
  return idiv(v - 68 - 17, 36);
}

export function offsetX(px: number): number {
  let v = px;
  while (v < 20) v += 40;
  return ((v - 20) % 40) - 20;
}

export function offsetY(py: number): number {
  let v = py;
  while (v - 85 < 0) v += 36;
  return ((v - 85) % 36) - 18;
}

export function inBounds(cx: number, cy: number): boolean {
  return cx >= 0 && cy >= 0 && cx < W && cy < H;
}

export function mapGet(s: GameState, cx: number, cy: number): number {
  if (!inBounds(cx, cy)) return MAP_SOLID;
  return s.map[cy * W + cx];
}

/** map_set_raw: change the cell value without repainting the background. */
export function mapSetRaw(s: GameState, cx: number, cy: number, v: number): void {
  if (!inBounds(cx, cy)) return;
  s.map[cy * W + cx] = v;
}

/** map_set: change the cell value and repaint its tile in the background buffer. */
export function mapSet(s: GameState, cx: number, cy: number, v: number): void {
  if (!inBounds(cx, cy)) return;
  s.map[cy * W + cx] = v;
  s.tiles[cy * W + cx] = v;
}

/** map_draw_cell_as: repaint the cell as value v while keeping the stored map value. */
export function mapDrawCellAs(s: GameState, cx: number, cy: number, v: number): void {
  if (!inBounds(cx, cy)) return;
  s.tiles[cy * W + cx] = v;
}

/**
 * map_generate @0x4260f5: scheme cells, bricks kept when rand()%100 < density.
 * `rows` are the scheme rows ('#' solid, ':' brick, else blank).
 */
export function mapGenerate(s: GameState, rows: string[], density: number): void {
  for (let i = 0; i < W * H; i++) s.map[i] = 0;
  for (let y = 0; y < H; y++) {
    const row = rows[y] ?? '';
    for (let x = 0; x < W; x++) {
      const ch = row[x];
      let v = ch === '#' ? MAP_SOLID : ch === ':' ? MAP_BRICK : MAP_BLANK;
      if (v === MAP_BRICK && rand(s.rng) % 100 >= density) v = MAP_BLANK;
      s.map[y * W + x] = v;
    }
  }
  // map_draw_all
  for (let i = 0; i < W * H; i++) s.tiles[i] = s.map[i];
}
