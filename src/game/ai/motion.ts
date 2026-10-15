// Predicted paths of moving bombs: kicked (sliding), carried by a conveyor, punched or thrown (flying).
// The step loops of bombs.ts (slideSteps / flyingSteps) are emulated pixel by pixel on the static snapshot
// of the map, so the prediction is exact as long as nothing else changes (players may move into the path,
// which is why callers also ask for a variant with the players as obstacles).

import { W, H, DX, DY, BombState, BombType } from '../sim/types.ts';
import { pxToCx, pyToCy, offsetX, offsetY, cellCenterX, cellFeetY } from '../sim/map.ts';
import { TICK_DT } from '../sim/sim.ts';
import type { World, BombInfo } from './world.ts';

export interface Track {
  /** anchor cells in visiting order; the bomb stays in the last one once it has come to rest */
  cells: number[];
  /** first step at which the anchor is in cells[i] */
  from: number[];
  /** step from which the bomb rests for good (Infinity if still moving at the end of the prediction) */
  rest: number;
  /** flying bombs: step at which it lands (Infinity if it did not land within the window); -1 otherwise */
  land: number;
  /** step at which it explodes early because it slid into / landed on a flame (Infinity otherwise) */
  boom: number;
}

function cellAt(px: number, py: number): number {
  const cx = pxToCx(px);
  const cy = pyToCy(py);
  return cx < 0 || cy < 0 || cx >= W || cy >= H ? -1 : cy * W + cx;
}

/** Cell at step t of a track (-1 before a flying bomb lands). */
export function trackCellAt(t: Track, step: number): number {
  if (t.land >= 0 && step < t.land) return -1;
  let c = t.cells[0];
  for (let i = 1; i < t.cells.length; i++) {
    if (t.from[i] > step) break;
    c = t.cells[i];
  }
  return c;
}

/** bomb_slide_cell_passable on the snapshot (power-ups are crushed, i.e. passable). */
function slidePassable(w: World, cx: number, cy: number, self: number, withPlayers: boolean): boolean {
  if (cx < 0 || cy < 0 || cx >= W || cy >= H) return false;
  const c = cy * W + cx;
  const b = w.bombCell[c];
  if (b >= 0 && b !== self) return false;
  if (withPlayers && w.playerMask[c] !== 0) return false;
  if (w.warpDest[c] >= 0) return false;
  return w.map[c] === 0;
}

/** Sliding bomb or a resting bomb on a conveyor, predicted up to step `limit`. */
export function trackSlide(w: World, b: BombInfo, limit: number, withPlayers: boolean): Track {
  let x = b.x;
  let y = b.y;
  let dir = b.dir;
  let state = b.state;
  let accum = b.accum;
  let stop = b.stop;
  const jelly = b.type === BombType.JELLY;
  const cells = [cellAt(x, y)];
  const from = [w.tick];
  let rest = Infinity;
  let boom = Infinity;
  for (let k = w.tick + 1; k <= limit; k++) {
    const dt = TICK_DT[(k - 1) % 3];
    if (state === BombState.REST) {
      const c = cellAt(x, y);
      if (c < 0 || w.conv[c] < 0) {
        rest = k - 1;
        break;
      }
      dir = w.conv[c];
      accum += Math.floor((w.convV * dt) / 50);
      for (let i = 0; i < 2; i++) {
        if (dir & 1) {
          const o = offsetY(y);
          if (o < 0) y++;
          if (o > 0) y--;
        } else {
          const o = offsetX(x);
          if (o < 0) x++;
          if (o > 0) x--;
        }
      }
    } else {
      accum += Math.floor((w.kickV * dt) / 50);
    }
    accum += 100;
    x -= DX[dir];
    y -= DY[dir];
    while (accum > 0) {
      let nx = x + DX[dir];
      let ny = y + DY[dir];
      const ox = offsetX(nx);
      const oy = offsetY(ny);
      const along = ox * DX[dir] + oy * DY[dir];
      const cx = pxToCx(nx);
      const cy = pyToCy(ny);
      const c = cx < 0 || cy < 0 || cx >= W || cy >= H ? -1 : cy * W + cx;
      if (ox === 0 && oy === 0 && c >= 0 && w.arrow[c] >= 0) {
        dir = w.arrow[c];
        stop = 0;
      }
      let halt = false;
      if (c >= 0 && w.flameEnd[c] >= k) {
        if (!w.flameBrick[c]) boom = Math.min(boom, k + 1);
        halt = true;
      } else {
        if (!slidePassable(w, cx + DX[dir], cy + DY[dir], b.slot, withPlayers)) stop = 1;
        if (stop && along >= 0) halt = true;
      }
      if (halt) {
        stop = 0;
        nx = cellCenterX(cx);
        ny = cellFeetY(cy);
        accum = 0;
        if (jelly) dir = (dir + 2) & 3;
        else state = BombState.REST;
      }
      x = nx;
      y = ny;
      accum -= 100;
      const nc = cellAt(x, y);
      if (nc !== cells[cells.length - 1]) {
        cells.push(nc);
        from.push(k);
      }
    }
    if (boom !== Infinity) {
      rest = k;
      break;
    }
    if (state === BombState.REST) {
      const c = cellAt(x, y);
      if (c < 0 || w.conv[c] < 0) {
        rest = k;
        break;
      }
    }
  }
  return { cells, from, rest, land: -1, boom };
}

/** Punched or thrown bomb: where and when it lands (straight flight; jelly turns are random and ignored). */
export function trackFlight(w: World, b: BombInfo, withPlayers: boolean): Track {
  let x = b.x;
  let y = b.y;
  const dir = b.dir;
  let accum = b.accum;
  let bounce = b.bounce;
  for (let k = w.tick + 1; k <= w.tick + 600; k++) {
    accum += Math.floor((w.flyV * TICK_DT[(k - 1) % 3]) / 50);
    while (accum > 0) {
      let nx = x + DX[dir];
      let ny = y + DY[dir];
      const ox = offsetX(nx);
      const oy = offsetY(ny);
      const cx = pxToCx(nx);
      const cy = pyToCy(ny);
      if (ox === 0 && oy === 0) {
        if (cx >= W + 2) nx -= 18 * 40;
        if (cx <= -2) nx += 18 * 40;
        if (cy >= H + 2) ny -= 14 * 36;
        if (cy <= -2) ny += 14 * 36;
        bounce++;
        if (bounce >= 3 && cx >= 0 && cy >= 0 && cx < W && cy < H) {
          const c = cy * W + cx;
          if (w.map[c] === 0 && w.bombCell[c] < 0 && w.power[c] < 0 && !(withPlayers && w.playerMask[c] !== 0) && w.warpDest[c] < 0) {
            const boom = w.flameEnd[c] >= k ? k + 1 : Infinity;
            return { cells: [c], from: [k], rest: k, land: k, boom };
          }
        }
      }
      x = nx;
      y = ny;
      accum -= 100;
    }
  }
  return { cells: [-1], from: [w.tick], rest: Infinity, land: Infinity, boom: Infinity };
}

/** Where a bomb kicked now from `cell` in direction `dir` comes to rest, and when (static map, no arrows' loops). */
export function kickTarget(w: World, cell: number, dir: number, jelly: boolean): { cell: number; steps: number } {
  // a kicked bomb slides center to center at V300 until the cell ahead is blocked (jelly bombs bounce back)
  const pxPerStep = (w.kickV / 100) * (3 / 3) / 3;
  let c = cell;
  let d = dir;
  let px = 0;
  for (let n = 0; n < 40; n++) {
    if (w.arrow[c] >= 0 && n > 0) d = w.arrow[c];
    const x = (c % W) + DX[d];
    const y = Math.floor(c / W) + DY[d];
    if (!slidePassable(w, x, y, -1, true)) {
      if (jelly) return { cell: c, steps: Infinity };
      break;
    }
    c = y * W + x;
    px += d & 1 ? 40 : 36;
  }
  return { cell: c, steps: px / Math.max(pxPerStep, 0.1) };
}

/**
 * Track of a bomb that will be dropped at `cell` during step `drop` (null unless a conveyor carries it).
 * A resting bomb on a belt moves with it (bombs.md §5.2).
 */
export function trackDropped(w: World, cell: number, drop: number, limit: number): Track | null {
  if (w.conv[cell] < 0) return null;
  const cx = cell % W;
  const cy = Math.floor(cell / W);
  const b: BombInfo = {
    slot: -1, owner: -1, type: BombType.REGULAR, state: BombState.REST, dud: false, x: cellCenterX(cx), y: cellFeetY(cy),
    cell, dir: w.conv[cell], flame: 1, fuseLeft: 0, tOwn: limit, queued: false, born: 0, accum: 0, stop: 0, bounce: 0,
    holder: -1, track: null, trackP: null,
  };
  // the bomb starts moving in the step after the drop; emulate from now and shift the times
  const shift = Math.max(0, drop - w.tick);
  const t = trackSlide(w, b, Math.min(limit - shift, w.tick + 400), false);
  for (let i = 1; i < t.from.length; i++) t.from[i] += shift;
  t.from[0] = drop;
  if (t.rest !== Infinity) t.rest += shift;
  if (t.boom !== Infinity) t.boom += shift;
  return t;
}
