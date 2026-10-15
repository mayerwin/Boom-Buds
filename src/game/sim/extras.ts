// extra.c: arrows, warp holes, conveyors and trampolines (docs/re/extras-levels.md §5-§7).

import { W, H, DX, DY, type GameState, type Extra } from './types.ts';
import type { FrameCtx } from './ctx.ts';
import { rand } from './rng.ts';
import { mapGet, mapSet, cellCenterX, cellFeetY } from './map.ts';
import type { ExtraDef } from '../../engine/assets.ts';

export const EXTRA_ARROW = 0;
export const EXTRA_WARP = 1;
export const EXTRA_CONVEYOR = 2;
export const EXTRA_TRAMPOLINE = 3;

const DIR_NAMES = ['north', 'east', 'south', 'west'];

export function newExtra(): Extra {
  return { type: 0, active: 0, cx: 0, cy: 0, x: 0, y: 0, dir: 0, id: 0, link: 0, anim: 0, gfx: 0, firstUpdate: 0 };
}

function parseDir(s: string): number {
  switch ((s[0] ?? '').toLowerCase()) {
    case 'n': return 0;
    case 'e': return 1;
    case 's': return 2;
    case 'w': return 3;
  }
  return -1;
}

function coord(s: string, size: number): number {
  let v = parseInt(s, 10);
  if (Number.isNaN(v)) v = 0;
  while (v < 0) v += size;
  if (v >= size) v = size - 1;
  return v;
}

/** extra_at: first active extra in the cell (slot order), or -1. */
export function extraAt(s: GameState, cx: number, cy: number): number {
  const ex = s.extras;
  for (let i = 0; i < ex.length; i++) {
    const e = ex[i];
    if (e.active !== 0 && e.cx === cx && e.cy === cy) return i;
  }
  return -1;
}

/** extras_level_load / extra_load_res @0x404e99 (local or host side). */
export function extrasLevelLoad(s: GameState, defs: ExtraDef[] | undefined): void {
  s.extras.length = 0;
  if (!defs) return;
  for (const d of defs) {
    if (s.extras.length >= 100) break;
    const e = newExtra();
    if (d.kind === 'A' || d.kind === 'C') {
      if (d.args.length !== 3) continue;
      const dir = parseDir(d.args[0]);
      if (dir < 0) continue;
      e.active = 1;
      e.type = d.kind === 'A' ? EXTRA_ARROW : EXTRA_CONVEYOR;
      e.dir = dir;
      e.cx = coord(d.args[1], W);
      e.cy = coord(d.args[2], H);
    } else if (d.kind === 'W') {
      if (d.args.length !== 5) continue;
      e.active = 1;
      e.type = EXTRA_WARP;
      e.gfx = parseInt(d.args[0], 10) || 0; // graphic number ("extra warp %u"), 0 = invisible
      e.id = parseInt(d.args[1], 10) || 0;
      e.cx = coord(d.args[2], W);
      e.cy = coord(d.args[3], H);
      e.link = parseInt(d.args[4], 10) || 0;
      e.firstUpdate = 0;
    } else if (d.kind === 'T') {
      // trampolines only exist in local games in the original; netplay here is fully deterministic so they
      // are kept in every mode (documented improvement).
      if (d.args.length !== 2) continue;
      let x: number;
      let y: number;
      if ((d.args[0][0] ?? '').toUpperCase() === 'H') {
        x = 0;
        y = 0;
        for (let t = 0; t < 100; t++) {
          x = rand(s.rng) % 15;
          y = rand(s.rng) % 11;
          if ((x & 1) !== (y & 1) && extraAt(s, x, y) < 0) break;
        }
      } else {
        x = coord(d.args[0], W);
        y = coord(d.args[1], H);
      }
      e.active = 1;
      e.type = EXTRA_TRAMPOLINE;
      e.cx = x;
      e.cy = y;
    } else {
      continue;
    }
    e.x = cellCenterX(e.cx);
    e.y = cellFeetY(e.cy);
    s.extras.push(e);
  }
}

/** warp_find_dest @0x405a81 */
export function warpFindDest(s: GameState, w: number): [number, number] {
  const src = s.extras[w];
  for (let i = 0; i < s.extras.length; i++) {
    const e = s.extras[i];
    if (i !== w && e.active !== 0 && e.type === EXTRA_WARP && e.id === src.link) return [e.cx, e.cy];
  }
  return [src.cx, src.cy];
}

/** extras_remove_for_hurry @0x405d0c */
export function extrasRemoveForHurry(s: GameState): void {
  for (const e of s.extras) if (e.active && (e.type === EXTRA_WARP || e.type === EXTRA_TRAMPOLINE)) e.active = 0;
}

function seqFrame(ctx: FrameCtx, name: string, state: number): number {
  const seq = ctx.anims.find(name);
  if (seq < 0) return -1;
  const n = ctx.anims.states(seq);
  return ctx.anims.ref(seq, (state >>> 0) % n).frame;
}

/** extras_update_draw @0x4056ca */
export function extrasUpdate(s: GameState, ctx: FrameCtx): void {
  for (let i = 0; i < s.extras.length; i++) {
    const e = s.extras[i];
    if (e.active === 0) continue;
    const px = cellCenterX(e.cx);
    const py = cellFeetY(e.cy);
    switch (e.type) {
      case EXTRA_ARROW:
        if (mapGet(s, e.cx, e.cy) === 0) {
          e.anim = (e.anim + s.refTick) & 0xffff;
          const f = seqFrame(ctx, `extra arrow ${DIR_NAMES[e.dir & 3]}`, e.anim);
          if (f >= 0) ctx.draw(f, px, py);
        }
        break;
      case EXTRA_WARP:
        if (e.firstUpdate === 0) {
          e.firstUpdate = 1;
          if (s.opts.netMode !== 1) {
            mapSet(s, e.cx, e.cy, 0);
            let nx = 0;
            let ny = 0;
            do {
              const r = rand(s.rng) % 4;
              nx = e.cx + DX[r];
              ny = e.cy + DY[r];
            } while (nx < 0 || nx >= W || ny < 0 || ny >= H);
            mapSet(s, nx, ny, 0);
          }
        }
        if (e.gfx !== 0) {
          e.anim = (e.anim + s.refTick) & 0xffff;
          const f = seqFrame(ctx, `extra warp ${e.gfx}`, e.anim);
          if (f >= 0) ctx.draw(f, px, py);
        }
        break;
      case EXTRA_CONVEYOR:
        e.anim = (e.anim + s.refTick) & 0xffff;
        if (mapGet(s, e.cx, e.cy) === 0) {
          const f = seqFrame(ctx, `extra conveyor ${DIR_NAMES[e.dir & 3]}`, Math.floor(e.anim / 3));
          if (f >= 0) ctx.draw(f, px, py);
        }
        break;
      case EXTRA_TRAMPOLINE:
        if (mapGet(s, e.cx, e.cy) === 0) {
          const name = 'extra trampoline';
          if (e.anim !== 0 && s.refTick) {
            e.anim++;
            const seq = ctx.anims.find(name);
            if (seq >= 0 && e.anim > ctx.anims.states(seq)) e.anim = 0;
          }
          const f = seqFrame(ctx, name, e.anim);
          if (f >= 0) ctx.draw(f, px, py);
        }
        break;
    }
  }
}
