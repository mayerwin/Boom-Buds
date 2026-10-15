// Hidden campaign mode: per-stage setup, the "aliens" (rovers and ghosts) and the stage status checked
// every frame. docs/re/match-flow.md §9, decompilation campaign.c (0x401010-0x4017be) and aliens.c
// (0x4017fa-0x40200b).

import { W, H, REF, DX, DY, MAX_PLAYERS, type GameState, type Alien } from './types.ts';
import type { FrameCtx } from './ctx.ts';
import { rand } from './rng.ts';
import { pxToCx, pyToCy, offsetX, offsetY, mapGet, cellCenterX, cellFeetY } from './map.ts';
import { bombAtCell } from './bombs.ts';
import { flameAt } from './flames.ts';
import { playerAtCell, noPlayerWithin, playerKillAttempt, mapClearStartArea, CTRL_AI, CTRL_OFF } from './players.ts';
import { timeRemainingS } from './enclosure.ts';

export const ALIEN_ROVER = 1;
export const ALIEN_GHOST = 2;
export const MAX_ALIENS = 100;

/** Stage status: 0 running, 1 cleared (every alien and computer player gone for 2 s), 2 failed. */
export const CAMP_RUNNING = 0;
export const CAMP_CLEARED = 1;
export const CAMP_FAILED = 2;

const DIR_NAMES = ['north', 'east', 'south', 'west'];

export function newAlien(): Alien {
  return { active: 0, type: 0, dying: 0, homeX: 0, homeY: 0, x: 0, y: 0, dir: 0, anim: 0, speed: 0, acc: 0, startCleared: 0 };
}

const val = (s: GameState, id: number) => s.opts.values[id] ?? 0;

/** alien_cell_passable (0x4017fa): no bomb; ghosts fly over bricks (anything but solid), rovers need an empty cell. */
function passable(s: GameState, cx: number, cy: number, type: number): boolean {
  if (bombAtCell(s, cx, cy) >= 0) return false;
  const t = mapGet(s, cx, cy);
  return type === ALIEN_GHOST ? t !== 1 : t === 0;
}

/** alien_spawn_random (0x4019c2): 200 tries for a non-solid cell with no player record within 3 cells. */
function spawn(s: GameState, type: number, speed: number): void {
  const a = s.aliens.find((x) => !x.active);
  if (!a) return;
  Object.assign(a, newAlien());
  for (let i = 0; i < 200; i++) {
    const cx = rand(s.rng) % W;
    const cy = rand(s.rng) % H;
    if (mapGet(s, cx, cy) !== 1 && noPlayerWithin(s, cx, cy, 3)) {
      a.active = 1;
      a.x = a.homeX = cellCenterX(cx);
      a.y = a.homeY = cellFeetY(cy);
      a.type = type;
      a.speed = speed;
      return;
    }
  }
}

/** campaign_stage_setup (0x40151b), at the end of round_start. */
export function campaignStageSetup(s: GameState): void {
  const st = s.camp.stage;
  s.camp.status = CAMP_RUNNING;
  s.camp.retry = 0;
  // every computer player is switched off, then `ais` random empty slots become computer players
  for (const p of s.players) if (p.ctrl === CTRL_AI) p.ctrl = CTRL_OFF;
  for (let k = 0; k < st.ais; k++) {
    for (let i = 0; i < 100; i++) {
      const slot = rand(s.rng) % 10;
      if (s.players[slot].ctrl === CTRL_OFF) {
        s.players[slot].ctrl = CTRL_AI;
        break;
      }
    }
  }
  for (const a of s.aliens) Object.assign(a, newAlien());
  s.camp.aliensActive = 1;
  s.camp.clearMs = 0;
  for (let i = 0; i < st.ghosts; i++) spawn(s, ALIEN_GHOST, st.ghostSpeed);
  for (let i = 0; i < st.rovers; i++) spawn(s, ALIEN_ROVER, st.roverSpeed);
}

/** alien_update (aliens_create @0x401b5c) */
function alienUpdate(s: GameState, ctx: FrameCtx, a: Alien): void {
  if (a.type === ALIEN_ROVER && !a.startCleared) {
    a.startCleared = 1;
    mapClearStartArea(s, pxToCx(a.x), pyToCy(a.y));
  }
  if (a.dying) {
    a.active = 0;
    return;
  }
  a.acc += Math.trunc((ctx.dt * a.speed) / REF) + 100;
  a.x -= DX[a.dir];
  a.y -= DY[a.dir];
  while (a.acc > 0) {
    const nx = a.x + DX[a.dir];
    const ny = a.y + DY[a.dir];
    a.anim = (a.anim + 1) << 16 >> 16;
    a.acc -= 100;
    const along = offsetX(nx) * DX[a.dir] + offsetY(ny) * DY[a.dir];
    if (along === 0) {
      // at a cell centre: blocked ahead -> stop and turn; otherwise turn with a 1 in V1200 chance
      let turn = false;
      if (!passable(s, pxToCx(nx) + DX[a.dir], pyToCy(ny) + DY[a.dir], a.type)) {
        a.acc = 0;
        turn = true;
      } else {
        turn = rand(s.rng) % Math.max(val(s, 1200), 1) === 0;
      }
      if (turn) {
        a.dir = (rand(s.rng) % 2 === 0 ? a.dir - 1 : a.dir + 1) & 3;
        if (!passable(s, pxToCx(nx) + DX[a.dir], pyToCy(ny) + DY[a.dir], a.type)) a.acc = 0;
      }
    }
    const cx = pxToCx(nx);
    const cy = pyToCy(ny);
    // a flame kills the alien (removed next frame); the flame's owner gets the points
    const f = flameAt(s, cx, cy);
    if (f >= 0) {
      a.dying = 1;
      const owner = s.flames[f].owner;
      const pts = a.type === ALIEN_ROVER ? val(s, 1310) : val(s, 1320);
      if (owner >= 0 && owner < MAX_PLAYERS) s.players[owner].score = (s.players[owner].score + pts) << 16 >> 16;
    }
    // every human player in the cell dies (computer players are never hurt); up to 11 tries
    for (let n = 10; ; n--) {
      const pi = playerAtCell(s, cx, cy);
      if (pi < 0) break;
      const p = s.players[pi];
      if (p.ctrl !== CTRL_AI) playerKillAttempt(s, ctx, p, -1);
      if (!(n > 0)) break;
    }
    a.x = nx;
    a.y = ny;
  }
  const seq = ctx.anims.find(`${a.type === ALIEN_GHOST ? 'ghost' : 'rover'} ${DIR_NAMES[a.dir]}`);
  if (seq >= 0) {
    const n = ctx.anims.states(seq);
    ctx.drawSeq(seq, ((a.anim % n) + n) % n, a.x, a.y, 0);
  }
}

/** campaign_update (0x4016da), every frame after the players. */
export function campaignUpdate(s: GameState, ctx: FrameCtx): void {
  // aliens_update_all (0x401f76)
  let active = 0;
  for (const a of s.aliens) {
    if (!a.active) continue;
    active++;
    if (a.type !== ALIEN_ROVER && a.type !== ALIEN_GHOST) a.active = 0;
    else alienUpdate(s, ctx, a);
  }
  s.camp.aliensActive = active;
  if (timeRemainingS(s) < 2) s.camp.status = CAMP_FAILED;
  if (active === 0) {
    // (also reset whenever a computer player reads its input: every computer player must be gone too)
    s.camp.clearMs += ctx.dt;
    if (s.camp.clearMs > val(s, 25) * REF * 2) s.camp.status = CAMP_CLEARED;
  } else s.camp.clearMs = 0;
  for (const p of s.players) {
    if (p.ctrl !== CTRL_AI && p.ctrl !== CTRL_OFF && p.alive) return;
  }
  // no human left: the same stage again
  s.camp.retry = 1;
  s.camp.status = CAMP_FAILED;
}
