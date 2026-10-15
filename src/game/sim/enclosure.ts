// map_update @0x426818: regenerating bricks (haunted house) and the hurry enclosement spiral
// (docs/re/flames-map-powerups.md §4, §5).

import { W, H, DX, DY, type GameState } from './types.ts';
import type { FrameCtx } from './ctx.ts';
import { rand } from './rng.ts';
import { mapGet, mapSet, MAP_BLANK, MAP_SOLID, MAP_BRICK } from './map.ts';
import { powerAt, powerDestroy } from './powers.ts';
import { bombAtCell, bombExplodeListAdd, bombDestroy } from './bombs.ts';
import { flameAt, flameKill } from './flames.ts';
import { playerAtCellLocal, playerKillAttempt, playersAliveCount, noPlayerWithin } from './players.ts';
import { extrasRemoveForHurry } from './extras.ts';
import { dangerRaise } from './danger.ts';

function val(s: GameState, id: number): number {
  return s.opts.values[id] ?? 0;
}

/** time_remaining_s(): floor((total - elapsed)/1000) with total = playtime + 1 s; 1001 when infinite. */
export function timeRemainingS(s: GameState): number {
  if (s.opts.playtime <= 0) return 1001;
  const total = (s.opts.playtime + 1) * 1000;
  return Math.floor((total - s.elapsedMs) / 1000);
}

function regenTick(s: GameState): void {
  const period = val(s, 340 + s.opts.level);
  if (period === 0 || s.opts.netMode === 1) return;
  if ((s.nowMs - s.regenLastMs) >>> 0 <= period * 1000) return;
  s.regenLastMs = s.nowMs;
  for (let t = 0; t < 100; t++) {
    const x = rand(s.rng) % 15;
    const y = rand(s.rng) % 11;
    if (mapGet(s, x, y) === MAP_BLANK && powerAt(s, x, y) < 0 && bombAtCell(s, x, y) < 0 && noPlayerWithin(s, x, y, val(s, 695))) {
      if (mapGet(s, x, y) !== MAP_BRICK) mapSet(s, x, y, MAP_BRICK);
      return;
    }
  }
}

function dropBlock(s: GameState, ctx: FrameCtx, x: number, y: number): void {
  ctx.soundId(140 + s.hurry.sound);
  mapSet(s, x, y, MAP_SOLID);
  for (let k = 0; k < 100; k++) {
    const pi = playerAtCellLocal(s, x, y);
    if (pi < 0) break;
    playerKillAttempt(s, ctx, s.players[pi], -1);
  }
  for (let k = 0; k < 100; k++) {
    const pw = powerAt(s, x, y);
    if (pw < 0) break;
    powerDestroy(s, pw);
  }
  for (let k = 0; k < 100; k++) {
    const b = bombAtCell(s, x, y);
    if (b < 0) break;
    if (s.opts.stompedBombsDetonate) {
      bombExplodeListAdd(s, b, -1);
      break;
    }
    bombDestroy(s, b);
  }
  for (let k = 0; k < 100; k++) {
    const f = flameAt(s, x, y);
    if (f < 0) break;
    flameKill(s, f);
  }
}

/** Advance the spiral cursor by one step; returns false when the last ring is finished. */
function spiralStep(h: { x: number; y: number; ring: number; dir: number }, depth: number): boolean {
  let nx = h.x + DX[h.dir];
  let ny = h.y + DY[h.dir];
  if (nx >= W - h.ring || ny >= H - h.ring || nx < h.ring || ny < h.ring) {
    h.dir = (h.dir + 1) & 3;
    if (h.dir === 1) {
      if (2 * depth <= h.ring) return false;
      h.ring++;
      h.x++;
      h.y++;
    }
    nx = h.x;
    ny = h.y;
  }
  h.x = nx;
  h.y = ny;
  return true;
}

export function mapUpdate(s: GameState, ctx: FrameCtx): void {
  if (playersAliveCount(s) <= 1) return;
  regenTick(s);
  const hu = s.hurry;
  const remaining = timeRemainingS(s);
  const v101 = val(s, 101);
  if (remaining > v101 - 5) {
    // a pending reset (the flag starts at 1, so the first frame of every round resets)
    if (hu.needsReset) {
      hu.x = 0;
      hu.y = 0;
      hu.ring = 0;
      hu.dir = 1;
      hu.needsReset = 0;
    }
    return;
  }
  if (!hu.needsReset) {
    hu.sound = rand(s.rng) % 3;
    hu.needsReset = 1;
    hu.lastMs = s.nowMs;
    extrasRemoveForHurry(s);
  }
  const depth = s.opts.enclosementDepth;
  if (hu.ring >= 2 * depth) return;
  // AI warning: mark the next V910 spiral positions (the imminent cell itself is not marked: original quirk)
  {
    const sim = { x: hu.x, y: hu.y, ring: hu.ring, dir: hu.dir };
    const steps = val(s, 910);
    let v = steps * 10 + 100;
    for (let k = 0; k < steps; k++) {
      if (!spiralStep(sim, depth)) break;
      dangerRaise(s, sim.x, sim.y, v);
      v -= 10;
    }
  }
  let n = 5;
  while (hu.lastMs + 250 < s.nowMs && --n > 0) {
    hu.lastMs += 250;
    dropBlock(s, ctx, hu.x, hu.y);
    if (!spiralStep(hu, depth)) return;
  }
}
