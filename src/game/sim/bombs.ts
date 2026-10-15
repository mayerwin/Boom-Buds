// bombs.c: bomb objects, fuse, kick/slide, punch/flight, hold/throw, explosion and chain reactions
// (docs/re/bombs.md).

import { W, H, REF, DX, DY, MAX_BOMBS, BombState, BombType, type GameState, type Bomb } from './types.ts';
import type { FrameCtx } from './ctx.ts';
import { rand } from './rng.ts';
import { mapGet, mapDrawCellAs, pxToCx, pyToCy, offsetX, offsetY, cellCenterX, cellFeetY, MAP_BLANK, MAP_SOLID, MAP_BRICK } from './map.ts';
import { flameSet, flameAt, remapOf, FLAME_CENTER, FLAME_BRICK } from './flames.ts';
import { powerAt, powerDestroyByHit, powerRevealAt } from './powers.ts';
import { dangerRaise } from './danger.ts';
import { extraAt, EXTRA_ARROW, EXTRA_WARP, EXTRA_CONVEYOR } from './extras.ts';
import { playerAtCell, playerBombHitHead, playersAliveCount } from './players.ts';

export const BOMB_TYPE_NAMES = ['regular', 'trigger', 'jelly'];

function val(s: GameState, id: number): number {
  return s.opts.values[id] ?? 0;
}

export function newBomb(): Bomb {
  return {
    active: 0, type: 0, x: 0, y: 0, startX: 0, startY: 0, dir: 0, state: 0, anim: 0, animAcc: 0, skipDir: 0, stop: 0,
    colour: 0, owner: 0, born: 0, fuseElapsed: 0, step: 0, bounce: 0, fuseLen: 0, flameLen: 0, speed: 0, accum: 0, holder: -1,
  };
}

function resetBomb(b: Bomb): void {
  Object.assign(b, newBomb());
}

/** Convert to a signed 16-bit value (the original stores fuse/anim accumulators in shorts). */
function s16(v: number): number {
  return (v << 16) >> 16;
}

/** bomb_at: first active bomb in the cell that is not flying or held (duds included). */
export function bombAtCell(s: GameState, cx: number, cy: number): number {
  for (let i = 0; i < MAX_BOMBS; i++) {
    const b = s.bombs[i];
    if (!b.active) continue;
    if (b.state === BombState.FLYING || b.state === BombState.HELD) continue;
    if (pxToCx(b.x) === cx && pyToCy(b.y) === cy) return i;
  }
  return -1;
}

/** cell_free_for_bomb @0x41e5c3: no bomb there and the map cell is blank. */
export function cellFreeForBomb(s: GameState, cx: number, cy: number): boolean {
  return bombAtCell(s, cx, cy) < 0 && mapGet(s, cx, cy) === MAP_BLANK;
}

export function bombsCountOwned(s: GameState, owner: number): number {
  let n = 0;
  for (const b of s.bombs) if (b.active && b.owner === owner) n++;
  return n;
}

export function bombExplodeListAdd(s: GameState, bomb: number, dir: number): void {
  if (s.explodeList.length < 100) s.explodeList.push({ bomb, dir: dir & 0xff });
}

/** Wall-clock dud scheduling in game seconds (the original uses time()). */
export function bombDudScheduleNext(s: GameState): void {
  s.nextDudTime = Math.floor(s.nowMs / 1000) + val(s, 320) + (rand(s.rng) % Math.max(val(s, 321), 1));
}

/** bomb_create @0x422ede */
export function bombCreate(s: GameState, cx: number, cy: number, type: number, colour: number, owner: number, flame: number, fuseFrames: number, delayFrames: number): number {
  s.stats.bombsDropped++;
  let slot = -1;
  for (let i = 0; i < MAX_BOMBS; i++) if (!s.bombs[i].active) { slot = i; break; }
  if (slot < 0) return -1;
  const b = s.bombs[slot];
  resetBomb(b);
  b.active = 1;
  if (!s.opts.netMode && type === BombType.REGULAR && Math.floor(s.nowMs / 1000) >= s.nextDudTime) {
    let n = val(s, 322);
    bombDudScheduleNext(s);
    if (n === 0) n = 1;
    if (rand(s.rng) % n === 0) b.active = 2;
  }
  b.type = type;
  b.owner = owner;
  b.x = cellCenterX(cx);
  b.y = cellFeetY(cy);
  b.colour = colour;
  b.flameLen = flame;
  b.fuseLen = s16(fuseFrames * REF);
  b.fuseElapsed = s16(-delayFrames * REF);
  b.born = s.frameCounter;
  return slot;
}

/** bomb_slide_cell_passable @0x4230a5 */
function bombSlideCellPassable(s: GameState, cx: number, cy: number): boolean {
  if (bombAtCell(s, cx, cy) >= 0) return false;
  if (playerAtCell(s, cx, cy) >= 0) return false;
  const pw = powerAt(s, cx, cy);
  if (pw >= 0 && s.powers[pw].state === 2) powerDestroyByHit(s, pw);
  const e = extraAt(s, cx, cy);
  if (e >= 0 && s.extras[e].type === EXTRA_WARP) return false;
  return mapGet(s, cx, cy) === MAP_BLANK;
}

/** bomb_kick @0x42464b (local games: bomb_kick_request goes straight here). */
export function bombKick(s: GameState, ctx: FrameCtx, i: number, dir: number): void {
  const b = s.bombs[i];
  if (b.state !== BombState.REST && b.state !== BombState.SLIDING) return;
  if (b.dir !== dir || b.state === BombState.REST) ctx.sound(120, b.x);
  if (b.state !== BombState.REST && b.dir !== dir) {
    b.x = cellCenterX(pxToCx(b.x));
    b.y = cellFeetY(pyToCy(b.y));
    b.state = BombState.REST;
    b.accum = 0;
  }
  b.dir = dir;
  b.state = BombState.SLIDING;
  b.speed = val(s, 300);
}

export function bombsStopKicked(s: GameState, owner: number): void {
  for (const b of s.bombs) {
    if (b.active && b.owner === owner && b.type !== BombType.JELLY && b.state === BombState.SLIDING) b.stop = 1;
  }
}

/** bomb_punch @0x4248c6 (accepted for REST, SLIDING and HELD bombs). */
export function bombPunch(s: GameState, i: number, dir: number): void {
  const b = s.bombs[i];
  if (b.state !== BombState.REST && b.state !== BombState.SLIDING && b.state !== BombState.HELD) return;
  b.x = cellCenterX(pxToCx(b.x));
  b.y = cellFeetY(pyToCy(b.y));
  b.accum = 0;
  b.dir = dir;
  b.state = BombState.FLYING;
  b.speed = val(s, 301);
  b.stop = 0;
  b.bounce = 0;
  b.step = 0;
  b.startX = b.x;
  b.startY = b.y;
  if (b.holder >= 0) {
    const h = s.players[b.holder];
    if (h && h.held === i) h.held = -1;
  }
  b.holder = -1;
}

export function bombGrab(s: GameState, ctx: FrameCtx, i: number, playerIdx: number): void {
  const b = s.bombs[i];
  const p = s.players[playerIdx];
  b.holder = playerIdx;
  p.held = i;
  b.state = BombState.HELD;
  b.stop = 0;
  ctx.sound(170, p.x);
}

/** bombs_trigger_oldest @0x424b41: one trigger bomb per press. */
export function bombsTriggerOldest(s: GameState, owner: number): void {
  let best = -1;
  for (let i = 0; i < MAX_BOMBS; i++) {
    const b = s.bombs[i];
    if (!b.active || b.owner !== owner || b.type !== BombType.TRIGGER) continue;
    if (b.state === BombState.FLYING || b.state === BombState.HELD) continue;
    if (b.born >= s.frameCounter) continue;
    if (best < 0 || b.born < s.bombs[best].born) best = i;
  }
  if (best >= 0) bombExplodeListAdd(s, best, 0);
}

/** bombs_untrigger @0x424c47 */
export function bombsUntrigger(s: GameState, owner: number): void {
  for (const b of s.bombs) {
    if (b.active && b.owner === owner && b.type === BombType.TRIGGER) {
      b.type = BombType.REGULAR;
      b.fuseElapsed = 0;
    }
  }
}

export function bombDestroy(s: GameState, i: number): void {
  s.bombs[i].active = 0;
}

/** explode(b): inline in bombs_update @0x423f49 */
function bombExplode(s: GameState, ctx: FrameCtx, i: number): void {
  const b = s.bombs[i];
  b.active = 0;
  ctx.sound(200, b.x);
  for (let d = 0; d < 4; d++) {
    if (b.skipDir !== 0 && d + 1 === b.skipDir) continue;
    let cx = pxToCx(b.x);
    let cy = pyToCy(b.y);
    flameSet(s, cx, cy, FLAME_CENTER, b.colour, b.owner);
    let pw = powerAt(s, cx, cy);
    if (pw >= 0 && s.powers[pw].state === 2) powerDestroyByHit(s, pw);
    for (let k = 0; k < b.flameLen; k++) {
      cx += DX[d];
      cy += DY[d];
      const o = bombAtCell(s, cx, cy);
      if (o >= 0) {
        s.bombs[o].owner = b.owner;
        bombExplodeListAdd(s, o, ((d + 2) & 3) + 1);
        break;
      }
      pw = powerAt(s, cx, cy);
      if (pw >= 0 && s.powers[pw].state === 2) {
        powerDestroyByHit(s, pw);
        break;
      }
      const m = mapGet(s, cx, cy);
      if (m === MAP_SOLID) break;
      if (m === MAP_BRICK) {
        flameSet(s, cx, cy, FLAME_BRICK, b.colour, -1);
        s.stats.bricks++;
        mapDrawCellAs(s, cx, cy, 0);
        powerRevealAt(s, cx, cy);
        break;
      }
      flameSet(s, cx, cy, k === b.flameLen - 1 ? d : d + 4, b.colour, b.owner);
    }
  }
}

/** The slide step loop shared by kicked bombs and resting bombs carried by a conveyor (§5.3). */
function slideSteps(s: GameState, ctx: FrameCtx, i: number): void {
  const b = s.bombs[i];
  b.accum += 100;
  b.x -= DX[b.dir];
  b.y -= DY[b.dir];
  while (b.accum > 0) {
    let nx = b.x + DX[b.dir];
    let ny = b.y + DY[b.dir];
    const ox = offsetX(nx);
    const oy = offsetY(ny);
    const along = ox * DX[b.dir] + oy * DY[b.dir];
    const cx = pxToCx(nx);
    const cy = pyToCy(ny);
    if (ox === 0 && oy === 0) {
      const e = extraAt(s, cx, cy);
      if (e >= 0 && s.extras[e].type === EXTRA_ARROW) {
        b.dir = s.extras[e].dir;
        b.stop = 0;
      }
    }
    const ax = cx + DX[b.dir];
    const ay = cy + DY[b.dir];
    let stop = false;
    const f = flameAt(s, cx, cy);
    if (f >= 0) {
      if (s.flames[f].type !== FLAME_BRICK) bombExplodeListAdd(s, i, 0);
      stop = true;
    } else {
      if (!bombSlideCellPassable(s, ax, ay)) b.stop = 1;
      if (b.stop && along >= 0) stop = true;
    }
    if (stop) {
      b.stop = 0;
      nx = cellCenterX(cx);
      ny = cellFeetY(cy);
      b.accum = 0;
      if (b.type === BombType.JELLY) {
        b.dir = (b.dir + 2) & 3;
        if (b.state !== BombState.REST) ctx.soundThrottled(135, b.x);
      } else {
        if (b.state !== BombState.REST) ctx.sound(130, b.x);
        b.state = BombState.REST;
      }
    }
    b.x = nx;
    b.y = ny;
    b.accum -= 100;
  }
}

function flyingSteps(s: GameState, ctx: FrameCtx, i: number): void {
  const b = s.bombs[i];
  while (b.accum > 0) {
    let nx = b.x + DX[b.dir];
    let ny = b.y + DY[b.dir];
    const ox = offsetX(nx);
    const oy = offsetY(ny);
    const cx = pxToCx(nx);
    const cy = pyToCy(ny);
    if (ox === 0 && oy === 0) {
      if (cx >= W + 2) nx -= 18 * 40;
      if (cx <= -2) nx += 18 * 40;
      if (cy >= H + 2) ny -= 14 * 36;
      if (cy <= -2) ny += 14 * 36;
      b.bounce++; // the original's "not in the start cell" test is always true
      if (b.bounce >= 3) {
        if (b.type === BombType.JELLY && cx >= 0 && cx < W && cy >= 0 && cy < H) {
          const v667 = val(s, 667);
          const n = v667 > 1 ? v667 : 1;
          if (rand(s.rng) % n === 0) b.dir = (b.dir + (rand(s.rng) % 2) * 2 - 1) & 3;
        }
        ctx.sound(160, b.x);
        b.step = 0;
        if (mapGet(s, cx, cy) === MAP_BLANK && bombAtCell(s, cx, cy) < 0 && powerAt(s, cx, cy) < 0) {
          const p = playerAtCell(s, cx, cy);
          if (p >= 0) {
            playerBombHitHead(s, ctx, p);
          } else {
            const e = extraAt(s, cx, cy);
            if (!(e >= 0 && s.extras[e].type === EXTRA_WARP)) {
              b.accum = 0;
              b.state = BombState.REST;
              b.x = nx;
              b.y = ny;
              if (flameAt(s, pxToCx(b.x), pyToCy(b.y)) >= 0) bombExplodeListAdd(s, i, 0);
              continue;
            }
          }
        }
      }
    }
    b.x = nx;
    b.y = ny;
    b.accum -= 100;
    b.step++;
  }
}

/** bombs_update(heldPass) @0x42331c */
export function bombsUpdate(s: GameState, ctx: FrameCtx, heldPass: boolean): void {
  const dt = ctx.dt;
  if (s.bombsLastFrame !== s.frameCounter) {
    s.bombsLastFrame = s.frameCounter;
    s.danger.fill(0);
    for (const e of s.explodeList) {
      const b = s.bombs[e.bomb];
      if (b && b.active) {
        b.fuseElapsed = b.fuseLen;
        b.skipDir = e.dir & 0xff;
      }
    }
    s.explodeList.length = 0;
  }
  for (let i = 0; i < MAX_BOMBS; i++) {
    const b = s.bombs[i];
    if (!b.active) continue;
    if ((b.holder >= 0) !== heldPass) continue;
    b.animAcc = s16(b.animAcc + dt);
    while (b.animAcc > 0) {
      b.anim = (b.anim + 1) & 0xffff;
      b.animAcc = s16(b.animAcc - REF);
    }
    switch (b.state) {
      case BombState.REST: {
        const e = extraAt(s, pxToCx(b.x), pyToCy(b.y));
        if (e >= 0 && s.extras[e].type === EXTRA_CONVEYOR) {
          b.dir = s.extras[e].dir;
          b.accum += Math.floor((val(s, 190 + s.opts.conveyorSpeed) * dt) / 50);
          for (let k = 0; k < 2; k++) {
            if (b.dir & 1) {
              const o = offsetY(b.y);
              if (o < 0) b.y++;
              if (o > 0) b.y--;
            } else {
              const o = offsetX(b.x);
              if (o < 0) b.x++;
              if (o > 0) b.x--;
            }
          }
          slideSteps(s, ctx, i);
        }
        break;
      }
      case BombState.SLIDING:
        b.accum += Math.floor((b.speed * dt) / 50);
        slideSteps(s, ctx, i);
        break;
      case BombState.FLYING:
        b.accum += Math.floor((b.speed * dt) / 50);
        flyingSteps(s, ctx, i);
        break;
      case BombState.HELD: {
        const h = b.holder >= 0 ? s.players[b.holder] : null;
        if (!h) {
          b.accum = 0;
          b.state = BombState.REST;
          break;
        }
        // the original zeroes the holder's walk counter here, freezing the "walkbomb" animation
        // (bombs.md Q11 / player.md Q4); the remake keeps the counter so the carry walk animates
        if (h.anim === 4) {
          let k = h.animFrame - 1;
          if (k < 0) k = 0;
          if (k > 3) k = 3;
          b.x = h.x + DX[h.dir] * 10 + DX[h.dir] * val(s, 500 + 2 * k);
          b.y = h.y + DY[h.dir] * 10 - val(s, 501 + 2 * k);
        } else {
          b.x = h.x + DX[h.dir] * 10;
          b.y = h.y + DY[h.dir] * 10 - 40;
        }
        break;
      }
    }
    // sequence
    let name = `bomb ${BOMB_TYPE_NAMES[b.type]} green`;
    if (b.type === BombType.REGULAR && b.active === 2) {
      if (b.anim > val(s, 323)) {
        b.active = 1;
        b.anim = 0;
      } else {
        name += ' dud';
      }
    }
    const seq = ctx.anims.find(name);
    // fuse and explosion
    if (playersAliveCount(s) > 1) {
      if (b.active !== 2 && b.state !== BombState.FLYING && b.state !== BombState.HELD && b.type !== BombType.TRIGGER) {
        b.fuseElapsed = s16(b.fuseElapsed + dt);
      }
      if (b.fuseElapsed >= b.fuseLen) bombExplode(s, ctx, i);
    }
    if (b.active) {
      // danger map
      const v = b.fuseElapsed + 100;
      let cx = pxToCx(b.x);
      let cy = pyToCy(b.y);
      dangerRaise(s, cx, cy, v);
      for (let d = 0; d < 4; d++) {
        let x = cx;
        let y = cy;
        for (let k = 1; k <= b.flameLen; k++) {
          x += DX[d];
          y += DY[d];
          if (mapGet(s, x, y) !== 0 || bombAtCell(s, x, y) >= 0) break;
          dangerRaise(s, x, y, v);
          if (powerAt(s, x, y) >= 0) break;
        }
      }
      void cy;
      // draw
      let dx = b.x;
      let dy = b.y;
      if (b.state === BombState.FLYING) {
        const size = b.dir === 0 || b.dir === 2 ? 36 : 40;
        if (b.bounce < 3) dy = Math.trunc(b.y - Math.sin((b.step * 3.14159) / (size * 3.0)) * val(s, 660));
        else dy = Math.trunc(b.y - Math.sin((b.step * 3.14159) / size) * val(s, 661));
      }
      if (seq >= 0) {
        const n = ctx.anims.states(seq);
        const ref = ctx.anims.ref(seq, b.anim % n);
        ctx.draw(ref.frame, dx, dy, remapOf(b.colour));
      }
      void cx;
    }
  }
}
