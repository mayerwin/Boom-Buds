// flame.c: one flame per cell, newest overwrites; 500 ms lifetime; brick disintegration
// (docs/re/flames-map-powerups.md §2).

import { W, H, REF, type GameState } from './types.ts';
import type { FrameCtx } from './ctx.ts';
import { inBounds, mapGet, mapSet, cellCenterX, cellFeetY, MAP_BRICK } from './map.ts';
import { dangerRaise } from './danger.ts';

export const FLAME_NAMES = ['tipnorth', 'tipeast', 'tipsouth', 'tipwest', 'midnorth', 'mideast', 'midsouth', 'midwest', 'center', 'brick'];
export const FLAME_CENTER = 8;
export const FLAME_BRICK = 9;

export function flameSet(s: GameState, cx: number, cy: number, type: number, colour: number, owner: number): void {
  if (!inBounds(cx, cy)) return;
  dangerRaise(s, cx, cy, 1000);
  const f = s.flames[cy * W + cx];
  f.state = 1;
  f.type = type;
  f.frame = 0;
  f.acc = 0;
  f.colour = colour;
  f.owner = owner;
  f.age = 0;
}

export function flameAt(s: GameState, cx: number, cy: number): number {
  if (!inBounds(cx, cy)) return -1;
  return s.flames[cy * W + cx].state !== 0 ? cy * W + cx : -1;
}

export function flameKill(s: GameState, idx: number): void {
  s.flames[idx].state = 0;
}

/** flame_update_draw @0x426d06 */
export function flamesUpdate(s: GameState, ctx: FrameCtx): void {
  const dt = ctx.dt;
  const v10 = s.opts.values[10];
  const v20 = s.opts.values[20];
  const level = s.opts.level;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const f = s.flames[y * W + x];
      if (f.state === 0) continue;
      f.age += dt;
      let seqName: string;
      const brick = f.type === FLAME_BRICK;
      if (brick) {
        seqName = `flame brick ${level}`;
        if (f.age > v20 * REF) {
          if (mapGet(s, x, y) === MAP_BRICK) mapSet(s, x, y, 0);
          f.state = -1;
        }
      } else {
        dangerRaise(s, x, y, 1000);
        seqName = `flame ${FLAME_NAMES[f.type]} green`;
        if (f.age > v10 * REF) f.state = 0;
      }
      if (f.state !== 0) {
        const seq = ctx.anims.find(seqName);
        if (seq >= 0) {
          const n = ctx.anims.states(seq);
          if (brick && f.frame >= n) f.frame = n - 1;
          const ref = ctx.anims.ref(seq, f.frame % n);
          if (!brick) {
            ctx.draw(ref.frame, cellCenterX(x) + ref.dx, cellFeetY(y) + ref.dy - 18, remapOf(f.colour));
          } else {
            ctx.draw(ref.frame, cellCenterX(x), cellFeetY(y), remapOf(f.colour));
          }
        }
        if (f.state === -1) f.state = 0;
      }
      f.acc += dt;
      while (f.acc > 0) {
        f.frame++;
        f.acc -= REF;
      }
    }
  }
}

/** Colour byte (0..9) to renderer remap table index (table 0 is identity). */
export function remapOf(colour: number): number {
  const c = colour < 0 ? 0 : colour > 9 ? 9 : colour;
  return c + 1;
}
