// you.c: players — spawning, input processing, movement, animations, bomb actions, death
// (docs/re/player.md).

import { W, H, REF, DX, DY, MAX_PLAYERS, type GameState, type Player } from './types.ts';
import type { FrameCtx } from './ctx.ts';
import { rand } from './rng.ts';
import { mapGet, mapSet, pxToCx, pyToCy, offsetX, offsetY, cellCenterX, cellFeetY, inBounds, MAP_SOLID } from './map.ts';
import { flameAt, remapOf } from './flames.ts';
import { powerAt, powerDestroy, playerPickupPower, playerDropAllPowers, playerLosePowersOnHeadHit, mapClearCellKeepPower } from './powers.ts';
import { bombAtCell, cellFreeForBomb, bombKick, bombsStopKicked, bombPunch, bombsTriggerOldest, bombGrab, bombsCountOwned, bombCreate, bombsUntrigger } from './bombs.ts';
import { extraAt, warpFindDest, EXTRA_WARP, EXTRA_TRAMPOLINE, EXTRA_CONVEYOR } from './extras.ts';
import { playerDiseaseTick, playerCureDiseases, D_MOLASSES, D_CRACK, D_CONSTIPATION, D_POOPS, D_SHORT_FLAME, D_CRACK_POOPS, D_SHORT_FUZE, D_REVERSED } from './diseases.ts';
import { IN_UP, IN_RIGHT, IN_DOWN, IN_LEFT, IN_ACT1, IN_ACT2 } from '../../engine/input.ts';

export const CTRL_OFF = 0, CTRL_AI = 1, CTRL_KEY = 2, CTRL_JOY = 3, CTRL_NET = 4;
export const A_NORMAL = 0, A_KICK = 1, A_PUNCH = 2, A_STUN = 3, A_PICKUP = 4, A_TRAMPOLINE = 5, A_WARP_OUT = 6, A_WARP_IN = 7, A_CORNER = 20;

const DIR_NAMES = ['north', 'east', 'south', 'west'];

function val(s: GameState, id: number): number {
  return s.opts.values[id] ?? 0;
}

function u16(v: number): number {
  return v & 0xffff;
}

function s16(v: number): number {
  return (v << 16) >> 16;
}

export function newPlayer(index: number): Player {
  return {
    alive: 0, deathAnim: 0, dying: 0, bombSeq: 0, ctrl: 0, ctrlSub: 0, homeX: 0, homeY: 0, x: 0, y: 0, stepDx: 0, stepDy: 0,
    dir: 2, wantDir: -1, walk: 0, deathMs: 0, btn1Prev: 0, btn2Prev: 0, btn1: 0, btn2: 0, stun: 0, colour: index, id: index,
    fuse: 40, anim: 0, animFrame: 0, animMs: 0, team: index & 1, triggerUsed: 0, counts: new Array(15).fill(0), awesome: 0,
    invulnMs: 0, lives: 0, score: 0, kills: 0, speed: 923, accum: 0, diseaseMs: 0, diseaseLen: 0, diseaseFresh: 0,
    disease: new Array(14).fill(0), startCleared: 0, held: -1, index, tauntRolled: 0, flicker: -1,
  };
}

/** player_at_cell @0x421cb5: first alive, non-dying player whose anchor cell matches. */
export function playerAtCell(s: GameState, cx: number, cy: number): number {
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const p = s.players[i];
    if (p.alive && !p.dying && pxToCx(p.x) === cx && pyToCy(p.y) === cy) return i;
  }
  return -1;
}

/** player_at_cell_local @0x421d3f: same, excluding network players. */
export function playerAtCellLocal(s: GameState, cx: number, cy: number): number {
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const p = s.players[i];
    if (p.alive && !p.dying && p.ctrl !== CTRL_NET && pxToCx(p.x) === cx && pyToCy(p.y) === cy) return i;
  }
  return -1;
}

/** no_player_within @0x422351: false if any of the 10 slots (even unused) is within Manhattan distance r. */
export function noPlayerWithin(s: GameState, cx: number, cy: number, r: number): boolean {
  for (const p of s.players) {
    if (Math.abs(cx - pxToCx(p.x)) + Math.abs(cy - pyToCy(p.y)) <= r) return false;
  }
  return true;
}

/** players_alive_count @0x421969 (value latched by the previous players loop). */
export function playersAliveCount(s: GameState): number {
  if (s.pl.campaign) return 2;
  return s.opts.teamPlay ? s.pl.teamsAliveLatched : s.pl.aliveLatched;
}

/** players_round_start @0x4214bc */
export function playersRoundStart(s: GameState): void {
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const hist = s.pl.inputHistory[i];
    for (let k = 0; k < 30; k++) {
      hist[k * 2] = 0;
      hist[k * 2 + 1] = -1;
    }
  }
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const p = s.players[i];
    p.alive = 0;
    let sx = s.pl.startX[i];
    let sy = s.pl.startY[i];
    while (sx < 0) sx += 15;
    while (sy < 0) sy += 11;
    sx = Math.min(sx, 14);
    sy = Math.min(sy, 10);
    p.homeX = cellCenterX(sx);
    p.homeY = cellFeetY(sy);
    p.startCleared = 0;
    p.triggerUsed = 0;
    p.anim = 0;
    p.animFrame = 0;
    p.dir = 2;
    p.invulnMs = 0;
    p.lives = 1;
    p.colour = s.opts.teamPlay ? (p.team ? 2 : 0) : i;
    p.id = i;
    p.fuse = val(s, 41);
    p.speed = val(s, 42);
    for (let t = 0; t < 15; t++) p.counts[t] = val(s, 50 + t);
    p.awesome = 0;
    const prize = s.pl.goldPrize;
    if (prize >= 0 && prize < 15) {
      const side = s.opts.teamPlay ? (p.team ? 2 : 0) : i;
      if (side === s.pl.goldWinner) p.counts[prize]++;
    }
    playerCureDiseases(s, p);
    // remake: do not keep a stale held pointer across rounds (player.md Q2)
    p.held = -1;
  }
  s.pl.roundFreezeMs = val(s, 30) * REF;
  s.pl.trueColoursMs = val(s, 32) * REF;
}

/** players_match_start @0x421793: scores reset and random start shuffle. */
export function playersMatchStart(s: GameState, randomStart: boolean): void {
  s.pl.kfacePlayer = -1;
  for (const p of s.players) {
    p.score = 0;
    p.kills = 0;
  }
  if (randomStart) {
    for (let k = 0; k < 200; k++) {
      const i = rand(s.rng) % 10;
      const j = rand(s.rng) % 10;
      if (i !== j) {
        let t = s.pl.startX[i]; s.pl.startX[i] = s.pl.startX[j]; s.pl.startX[j] = t;
        t = s.pl.startY[i]; s.pl.startY[i] = s.pl.startY[j]; s.pl.startY[j] = t;
      }
    }
  }
}

/** map_clear_start_area @0x42583b */
/** clear_start_area: the cell and its 4 non-solid neighbours become blank (power-ups are moved away). */
export function mapClearStartArea(s: GameState, x: number, y: number): void {
  const set = (cx: number, cy: number, v: number) => mapSet(s, cx, cy, v);
  mapClearCellKeepPower(s, x, y, 0, set);
  if (mapGet(s, x, y - 1) !== MAP_SOLID) mapClearCellKeepPower(s, x, y - 1, 0, set);
  if (mapGet(s, x + 1, y) !== MAP_SOLID) mapClearCellKeepPower(s, x + 1, y, 0, set);
  if (mapGet(s, x, y + 1) !== MAP_SOLID) mapClearCellKeepPower(s, x, y + 1, 0, set);
  if (mapGet(s, x - 1, y) !== MAP_SOLID) mapClearCellKeepPower(s, x - 1, y, 0, set);
}

/** player_death_start @0x41dcb2 (alias player_kill). */
function playerDeathStart(s: GameState, ctx: FrameCtx, p: Player, killer: number): void {
  if (p.invulnMs !== 0 || p.dying) return;
  if (killer >= 0 && killer < 10) {
    if (killer === p.index) {
      if (!s.pl.winByKills) s.players[killer].kills--;
    } else {
      s.players[killer].kills++;
      if (s.pl.campaign && p.ctrl === CTRL_AI) s.players[killer].score += val(s, 1300);
    }
  }
  if (p.held >= 0) {
    s.bombs[p.held].active = 0;
    p.held = -1; // remake: clear the stale pointer (player.md Q2 / bombs.md Q8)
  }
  ctx.sound(300, p.x);
  ctx.soundId(340 + p.deathAnim, p.x);
  p.dying = 1;
  p.walk = 0;
  ctx.event('death', p.index, killer);
}

/** player_kill_attempt @0x41de63 (old name player_net_death). Returns 1 when the caller must run the dying code. */
export function playerKillAttempt(s: GameState, ctx: FrameCtx, p: Player, killer: number): number {
  if (p.ctrl === CTRL_NET) return 0;
  if (p.anim === A_TRAMPOLINE || p.anim === A_WARP_OUT || p.anim === A_WARP_IN) return 0;
  let n = val(s, 105);
  if (n < 2) n = 1;
  p.deathAnim = (rand(s.rng) % n) + 1;
  playerDeathStart(s, ctx, p, killer);
  return 1;
}

/** player_bomb_hit_head @0x421f7e (local games only in the original; the remake applies it in netplay too). */
export function playerBombHitHead(s: GameState, ctx: FrameCtx, pi: number): void {
  const p = s.players[pi];
  void ctx;
  p.stun = 16;
  p.anim = A_STUN;
  p.animFrame = 0;
  playerLosePowersOnHeadHit(s, p);
}

/** The bits for one player from the tick's input array (human, AI and network peers alike). */
function readInput(s: GameState, p: Player, bits: number): void {
  const pressed = [(bits & IN_UP) !== 0, (bits & IN_RIGHT) !== 0, (bits & IN_DOWN) !== 0, (bits & IN_LEFT) !== 0];
  if (bits & IN_ACT1) p.btn1 = 1;
  if (bits & IN_ACT2) p.btn2 = 1;
  const cx = pxToCx(p.x);
  const cy = pyToCy(p.y);
  let count = 0;
  for (const v of pressed) if (v) count++;
  if (count > 1) {
    let anyFree = false;
    for (let d = 0; d < 4; d++) if (pressed[d] && cellFreeForBomb(s, cx + DX[d], cy + DY[d])) anyFree = true;
    if (anyFree) for (let d = 0; d < 4; d++) if (pressed[d] && !cellFreeForBomb(s, cx + DX[d], cy + DY[d])) pressed[d] = false;
  }
  let last = -1;
  for (let d = 0; d < 4; d++) if (pressed[d]) last = d;
  if (last >= 0) p.wantDir = last;
}

/** player_move_step @0x41ec84: returns 1 if the player died. */
function playerMoveStep(s: GameState, ctx: FrameCtx, p: Player): number {
  while (p.accum > 0) {
    p.stepDx = 0;
    p.stepDy = 0;
    if (p.wantDir !== -1) {
      const d = p.wantDir;
      p.dir = d;
      const ox = offsetX(p.x);
      const oy = offsetY(p.y);
      const along = ox * DX[d] + oy * DY[d];
      const perp = oy * DX[d] - ox * DY[d];
      const cx = pxToCx(p.x);
      const cy = pyToCy(p.y);
      const nx = cx + DX[d];
      const ny = cy + DY[d];
      if (along === -1) {
        const e = extraAt(s, cx, cy);
        if (e >= 0 && s.extras[e].type === EXTRA_WARP) {
          p.anim = A_WARP_OUT;
          p.animFrame = 0;
          const [wx, wy] = warpFindDest(s, e);
          p.homeX = cellCenterX(wx);
          p.homeY = cellFeetY(wy);
          ctx.sound(1330, p.x);
        }
        if (e >= 0 && s.extras[e].type === EXTRA_TRAMPOLINE) {
          s.extras[e].anim = 1;
          p.anim = A_TRAMPOLINE;
          p.animFrame = 0;
          ctx.sound(350, p.x);
        }
      }
      if (along === 0 && p.counts[3]) {
        const b = bombAtCell(s, nx, ny);
        if (b >= 0 && cellFreeForBomb(s, nx + DX[d], ny + DY[d])) {
          bombKick(s, ctx, b, d);
          if (p.anim !== A_KICK) {
            p.anim = A_KICK;
            p.animFrame = 0;
          }
        }
      }
      if (along < 0 || cellFreeForBomb(s, nx, ny)) {
        p.stepDx = DX[d];
        p.stepDy = DY[d];
        if (perp !== 0) {
          const nd = perp < 0 ? (d + 1) & 3 : (d - 1) & 3;
          p.stepDx += DX[nd];
          p.stepDy += DY[nd];
          p.dir = nd;
        }
      } else if (perp < 0) {
        const sd = (d - 1) & 3;
        if (cellFreeForBomb(s, cx + DX[sd], cy + DY[sd]) && cellFreeForBomb(s, cx + DX[sd] + DX[d], cy + DY[sd] + DY[d])) {
          p.stepDx = DX[sd];
          p.stepDy = DY[sd];
        }
      } else if (perp > 0) {
        const sd = (d + 1) & 3;
        if (cellFreeForBomb(s, cx + DX[sd], cy + DY[sd]) && cellFreeForBomb(s, cx + DX[sd] + DX[d], cy + DY[sd] + DY[d])) {
          p.stepDx = DX[sd];
          p.stepDy = DY[sd];
        }
      } else if (along > 0) {
        p.stepDx = DX[(d + 2) & 3] * along;
        p.stepDy = DY[(d + 2) & 3] * along;
      }
      p.x += p.stepDx;
      p.y += p.stepDy;
      if (!p.dying) {
        const f = flameAt(s, pxToCx(p.x), pyToCy(p.y));
        if (f >= 0 && playerKillAttempt(s, ctx, p, s.flames[f].owner)) return 1;
      }
      const pw = powerAt(s, pxToCx(p.x), pyToCy(p.y));
      if (pw >= 0 && s.powers[pw].state === 2) {
        playerPickupPower(s, ctx, p, pw);
        powerDestroy(s, pw);
      }
      p.walk = u16(p.walk + 1);
    }
    p.accum -= 100;
  }
  return 0;
}

function seqFrameRef(ctx: FrameCtx, name: string, state: number): { frame: number; dx: number; dy: number } | null {
  const seq = ctx.anims.find(name);
  if (seq < 0) return null;
  const n = ctx.anims.states(seq);
  return ctx.anims.ref(seq, ((state % n) + n) % n);
}

function advanceAnim(p: Player, dt: number): void {
  p.animMs = s16(p.animMs + dt);
  while (p.animMs > 0) {
    p.animFrame = s16(p.animFrame + 1);
    p.animMs = s16(p.animMs - REF);
  }
}

/** Dying code (label DYING in player_update). */
function playerDying(s: GameState, ctx: FrameCtx, p: Player): void {
  const dt = ctx.dt;
  const seqName = `die green ${p.deathAnim}`;
  const seq = ctx.anims.find(seqName);
  const n = seq >= 0 ? ctx.anims.states(seq) : 1;
  if (seq >= 0) {
    const ref = ctx.anims.ref(seq, p.walk % n);
    ctx.draw(ref.frame, p.x, p.y, remapOf(p.colour));
  }
  let finish = false;
  if (p.deathAnim === 9) {
    p.accum += dt;
    while (p.accum > 0) {
      p.y -= val(s, 106);
      p.accum -= 50;
    }
    if (p.y < -20) finish = true;
  }
  const doFinish = () => {
    playerDropAllPowers(s, p);
    p.alive = 0;
    p.dying = 0;
    bombsUntrigger(s, p.id);
    ctx.event('gone', p.index, 0);
  };
  if (finish) {
    doFinish();
  } else {
    p.deathMs = s16(p.deathMs + dt);
    while (p.deathMs > 0) {
      p.walk = u16(p.walk + 1);
      if (p.walk >= n) {
        doFinish();
      }
      p.deathMs = s16(p.deathMs - 50);
      if (!p.alive) break;
    }
  }
  // Post-death taunt at death state 25 (evaluated once, see audio.md uncertain note)
  if (p.walk === 25 && !p.tauntRolled) {
    p.tauntRolled = 1;
    if (rand(s.rng) % Math.max(val(s, 95), 1) === 0) ctx.sound(700, p.x);
  }
  if (p.walk < val(s, 25)) {
    s.pl.aliveAcc++;
    if (s.opts.teamPlay) s.pl.teamAlive[p.team]++;
  }
}

/** player_update @0x41f29b */
function playerUpdate(s: GameState, ctx: FrameCtx, p: Player, inputBits: number): void {
  const dt = ctx.dt;
  if (p.ctrl === CTRL_OFF) return;
  if (!p.startCleared) {
    p.startCleared = 1;
    mapClearStartArea(s, pxToCx(p.homeX), pyToCy(p.homeY));
  }
  if (!p.alive) {
    if (p.lives === 0) return;
    p.lives--;
    p.deathAnim = 0;
    p.alive = 1;
    p.dying = 0;
    p.tauntRolled = 0;
    p.x = p.homeX;
    p.y = p.homeY;
    if (s.pl.campaign && p.ctrl !== CTRL_AI && s.pl.remainingS >= val(s, 101)) {
      p.lives = 1;
      p.invulnMs = 20 * REF;
      p.startCleared = 0;
    }
  }
  if (!s.opts.teamPlay) s.pl.presentAcc++;
  else if (!s.pl.teamPresent[p.team]) {
    s.pl.teamPresent[p.team] = 1;
    s.pl.presentAcc++;
  }
  if (p.dying) {
    playerDying(s, ctx, p);
    return;
  }
  s.pl.aliveAcc++;
  if (s.opts.teamPlay) s.pl.teamAlive[p.team]++;
  if (p.invulnMs > 0) {
    p.invulnMs = s16(p.invulnMs - dt);
    if (p.invulnMs < 0) p.invulnMs = 0;
  }
  {
    const f = flameAt(s, pxToCx(p.x), pyToCy(p.y));
    if (f >= 0 && playerKillAttempt(s, ctx, p, s.flames[f].owner)) {
      playerDying(s, ctx, p);
      return;
    }
  }
  {
    const pw = powerAt(s, pxToCx(p.x), pyToCy(p.y));
    if (pw >= 0 && s.powers[pw].state === 2) {
      playerPickupPower(s, ctx, p, pw);
      powerDestroy(s, pw);
    }
  }
  // per-frame counter in the original; advanced per 20 Hz reference frame here (docs/DIFFERENCES.md)
  if (p.diseaseFresh) p.diseaseFresh = Math.max(0, p.diseaseFresh - s.refTick);
  playerDiseaseTick(s, ctx, p);
  p.btn1Prev = p.btn1;
  p.btn2Prev = p.btn2;
  p.btn1 = 0;
  p.btn2 = 0;
  p.wantDir = -1;
  let canInput = true;
  if (p.stun > 0) {
    canInput = false;
    p.stun = Math.max(0, p.stun - s.refTick);
    if (p.stun === 0 && p.anim === A_STUN) {
      p.anim = 0;
      p.animFrame = 0;
    }
  }
  // cornerhead: boxed in on all four sides
  {
    const cx = pxToCx(p.x);
    const cy = pyToCy(p.y);
    let blocked = 0;
    for (let d = 0; d < 4; d++) if (!cellFreeForBomb(s, cx + DX[d], cy + DY[d])) blocked++;
    if (blocked < 4) {
      if (p.anim >= 20 && p.anim < 40) p.anim = 0;
    } else if (p.anim === 0) {
      p.anim = A_CORNER + (rand(s.rng) % Math.max(val(s, 330), 1));
      p.animFrame = 0;
    }
  }
  if (p.anim === A_TRAMPOLINE || p.anim === A_WARP_OUT || p.anim === A_WARP_IN) canInput = false;
  if (p.anim === A_PICKUP && p.animFrame <= val(s, 665)) {
    canInput = false;
    p.btn1 = 1;
  }
  if (canInput && s.pl.roundFreezeMs === 0) {
    // campaign_reset_clear_timer: a stage is only cleared once no computer player is thinking any more
    if (p.ctrl === CTRL_AI) s.camp.clearMs = 0;
    if (p.ctrl === CTRL_AI && inputBits & 0x80) {
      // AI extension bit: force a fresh press (the original AI clears the previous button state)
      p.btn1Prev = 0;
      p.btn2Prev = 0;
    }
    // joystick easter egg (you_getinput): up + buttons 2,4,7 = this player wears the "kface"; 2,4,8 = nobody.
    // The input layer reports it as bit 0x40 (0x40|0x80 = off).
    if (p.ctrl !== CTRL_AI && inputBits & 0x40) s.pl.kfacePlayer = inputBits & 0x80 ? -1 : p.index;
    readInput(s, p, inputBits);
  }
  // direction post-processing
  if (p.wantDir !== -1) {
    if (p.disease[D_REVERSED] && p.ctrl !== CTRL_AI) p.wantDir = (p.wantDir + 2) & 3;
    if (p.dir !== p.wantDir && (p.anim === A_KICK || p.anim === A_PUNCH)) {
      p.anim = 0;
      p.animFrame = 0;
    }
    p.dir = p.wantDir;
  }
  // control delay (ice), not for AI
  if (p.ctrl !== CTRL_AI) {
    const h = s.pl.inputHistory[p.index];
    for (let k = 0; k < 30; k++) h[k * 2] += dt;
    for (let k = 29; k >= 1; k--) {
      h[k * 2] = h[(k - 1) * 2];
      h[k * 2 + 1] = h[(k - 1) * 2 + 1];
    }
    h[0] = 0;
    h[1] = p.wantDir;
    const delay = val(s, 450 + s.opts.level);
    for (let k = 0; k < 30; k++) {
      p.wantDir = h[k * 2 + 1];
      if (h[k * 2] >= delay) break;
    }
  }
  // movement (network players are not simulated locally in the original; the remake simulates everyone)
  if (p.wantDir === -1) {
    const e = extraAt(s, pxToCx(p.x), pyToCy(p.y));
    if (e >= 0 && s.extras[e].type === EXTRA_CONVEYOR) {
      p.wantDir = s.extras[e].dir;
      const saved = p.dir;
      p.accum += Math.floor((val(s, 190 + s.opts.conveyorSpeed) * dt) / 50);
      if (playerMoveStep(s, ctx, p)) {
        playerDying(s, ctx, p);
        return;
      }
      p.wantDir = -1;
      p.dir = saved;
    }
  } else {
    let spd = p.speed + p.counts[4] * val(s, 90) - p.counts[13] * val(s, 91);
    if (p.disease[D_MOLASSES]) spd = Math.trunc(spd / 3);
    if (p.disease[D_CRACK] || p.disease[D_CRACK_POOPS]) spd = Math.trunc((spd * 3) / 2);
    spd = Math.floor(((spd * dt) >>> 0) / 50);
    const e = extraAt(s, pxToCx(p.x), pyToCy(p.y));
    if (e >= 0 && s.extras[e].type === EXTRA_CONVEYOR) {
      const c = Math.floor((val(s, 190 + s.opts.conveyorSpeed) * dt) / 50);
      if (s.extras[e].dir === p.wantDir) spd += c;
      if (s.extras[e].dir === ((p.dir + 2) & 3)) spd -= c;
    }
    p.accum += spd;
    if (playerMoveStep(s, ctx, p)) {
      playerDying(s, ctx, p);
      return;
    }
  }
  // animation selection + drawing
  playerAnimate(s, ctx, p);
  // bomb actions
  playerBombActions(s, ctx, p);
}

function playerAnimate(s: GameState, ctx: FrameCtx, p: Player): void {
  const dt = ctx.dt;
  let base: string;
  if (p.wantDir !== -1) {
    base = `${p.held >= 0 ? 'walkbomb' : 'walk'} ${DIR_NAMES[p.dir & 3]}`;
  } else {
    p.walk = u16(p.walk + 1);
    const d = p.stun !== 0 ? p.animFrame & 3 : p.dir;
    base = `${p.held >= 0 ? 'standbomb' : 'stand'} ${DIR_NAMES[d & 3]}`;
  }
  let ref: { frame: number; dx: number; dy: number } | null = null;
  let lift = 0;
  let trampoline = false;
  const walkState = Math.floor(p.walk / 3);
  switch (p.anim) {
    case A_NORMAL:
      ref = seqFrameRef(ctx, base, walkState);
      break;
    case A_KICK:
      ref = seqFrameRef(ctx, `kick ${DIR_NAMES[p.dir & 3]}`, p.animFrame);
      advanceAnim(p, dt);
      if (p.animFrame >= 8) { p.anim = 0; p.animFrame = 0; }
      break;
    case A_PUNCH:
      ref = seqFrameRef(ctx, `punch ${DIR_NAMES[p.dir & 3]}`, p.animFrame);
      advanceAnim(p, dt);
      if (p.animFrame > 10) { p.anim = 0; p.animFrame = 0; }
      break;
    case A_STUN:
      ref = seqFrameRef(ctx, base, walkState);
      advanceAnim(p, dt);
      break;
    case A_PICKUP:
      // the original draws pickup[walk/3] (stuck on frame 0, player.md Q3); the remake plays the animation
      ref = seqFrameRef(ctx, `pickup ${DIR_NAMES[p.dir & 3]}`, p.animFrame);
      advanceAnim(p, dt);
      if (p.animFrame > 10) { p.anim = 0; p.animFrame = 0; }
      break;
    case A_TRAMPOLINE: {
      trampoline = true;
      advanceAnim(p, dt);
      const v680 = val(s, 680);
      const v681 = val(s, 681);
      if (p.animFrame >= v680) {
        p.anim = 0;
        p.animFrame = 0;
      }
      ref = seqFrameRef(ctx, base, walkState);
      if (p.animFrame === (v680 >> 1)) {
        const cx = pxToCx(p.x);
        const cy = pyToCy(p.y);
        for (let t = 0; t < 100; t++) {
          const tx = (rand(s.rng) % 5) + cx - 2;
          const ty = (rand(s.rng) % 5) + cy - 2;
          if (tx === cx || ty === cy) continue;
          if (mapGet(s, tx, ty) !== 0) continue;
          if (bombAtCell(s, tx, ty) >= 0) continue;
          p.x = cellCenterX(tx);
          p.y = cellFeetY(ty);
          break;
        }
        p.animFrame++;
      }
      lift = p.animFrame < (v680 >> 1) ? p.animFrame * v681 : (v680 - p.animFrame) * v681;
      if (p.anim === 0) lift = 0;
      break;
    }
    case A_WARP_OUT:
      ref = seqFrameRef(ctx, 'spin', p.animFrame);
      advanceAnim(p, dt);
      if (p.animFrame > 8) {
        p.anim = A_WARP_IN;
        p.animFrame = 0;
        p.x = p.homeX;
        p.y = p.homeY;
      }
      break;
    case A_WARP_IN:
      ref = seqFrameRef(ctx, 'spin', p.animFrame);
      advanceAnim(p, dt);
      if (p.animFrame > 8) { p.anim = 0; p.animFrame = 0; }
      break;
    default:
      if (p.anim >= 20 && p.anim < 40) {
        ref = seqFrameRef(ctx, `cornerhead ${p.anim - 20}`, p.animFrame);
        advanceAnim(p, dt);
        if (p.animFrame >= 50) { p.anim = 0; p.animFrame = 0; }
      } else {
        p.anim = 0;
        ref = seqFrameRef(ctx, base, walkState);
      }
  }
  if (!ref) return;
  if (trampoline) {
    ctx.draw(ref.frame, p.x, p.y - lift, remapOf(p.colour), p.index);
    return;
  }
  const shadow = seqFrameRef(ctx, 'shadow', 0);
  if (shadow) ctx.draw(shadow.frame, p.x, p.y, 0, p.index);
  if (s.refTick) p.flicker = p.diseaseMs & 8 ? rand(s.rng) % 10 : -1;
  if (!p.diseaseMs) p.flicker = -1;
  let colour: number;
  if (p.flicker >= 0) colour = p.flicker;
  else if (s.pl.trueColoursMs !== 0) colour = p.index;
  else colour = p.colour;
  ctx.draw(ref.frame, p.x, p.y, remapOf(colour), p.index);
  if (p.index === s.pl.kfacePlayer) {
    const kf = seqFrameRef(ctx, `kface ${DIR_NAMES[p.dir & 3]}`, 0);
    if (kf) ctx.draw(kf.frame, p.x - 4, p.y - 34, 0);
  }
}

function playerDropBomb(s: GameState, p: Player, cx: number, cy: number, n: number): void {
  let type = 0;
  if (p.counts[10]) type = 2;
  if (p.counts[9] && p.triggerUsed < p.counts[0]) {
    type = 1;
    p.triggerUsed++;
  }
  let flame = p.counts[1];
  if (p.disease[D_SHORT_FLAME]) flame = 1;
  if (p.counts[8]) flame = Math.max(W, H);
  let fuse = p.fuse;
  if (p.disease[D_SHORT_FUZE]) fuse = Math.trunc(fuse / 3);
  bombCreate(s, cx, cy, type, p.colour, p.id, flame, fuse, n);
}

function playerBombActions(s: GameState, ctx: FrameCtx, p: Player): void {
  let poop = false;
  if (p.disease[D_POOPS] || p.disease[D_CRACK_POOPS]) {
    p.btn1 = 1;
    p.btn1Prev = 0;
    poop = true;
  }
  if (p.held >= 0 && (poop || !p.btn1)) {
    const bi = p.held;
    const b = s.bombs[bi];
    b.x = p.x;
    b.y = p.y;
    b.fuseElapsed = 0;
    bombPunch(s, bi, p.dir);
    p.held = -1;
    b.holder = -1;
  }
  if (p.btn2 && !p.btn2Prev) {
    if (p.counts[3]) bombsStopKicked(s, p.id);
    if (p.counts[5] && !p.btn1) {
      // player_punch_bomb @0x424a50: always returns 1
      const b = bombAtCell(s, pxToCx(p.x) + DX[p.dir], pyToCy(p.y) + DY[p.dir]);
      if (b >= 0) {
        const bs = s.bombs[b].state;
        bombPunch(s, b, p.dir);
        if (bs === 0 || bs === 1 || bs === 3) ctx.sound(150, p.x);
      }
      p.anim = A_PUNCH;
      p.animFrame = 0;
    }
    if (p.counts[9]) bombsTriggerOldest(s, p.id);
  }
  if (p.btn1 && !p.btn1Prev && !p.disease[D_CONSTIPATION]) {
    let cx = pxToCx(p.x);
    let cy = pyToCy(p.y);
    if (p.counts[6]) {
      const b = bombAtCell(s, cx, cy);
      if (b >= 0 && s.bombs[b].owner === p.id) {
        bombGrab(s, ctx, b, p.index);
        p.anim = A_PICKUP;
        p.animFrame = 0;
        return;
      }
    }
    if (p.counts[7] && !poop) {
      const b = bombAtCell(s, cx, cy);
      if (b >= 0 && s.bombs[b].owner === p.id) {
        let n = 0;
        for (;;) {
          cx += DX[p.dir];
          cy += DY[p.dir];
          if (playerAtCell(s, cx, cy) >= 0 || powerAt(s, cx, cy) >= 0 || !cellFreeForBomb(s, cx, cy)) break;
          if (bombsCountOwned(s, p.id) >= p.counts[0]) break;
          n++;
          playerDropBomb(s, p, cx, cy, n);
        }
        return;
      }
    }
    const active = bombsCountOwned(s, p.id);
    if (p.counts[0] > active && cellFreeForBomb(s, cx, cy)) {
      const e = extraAt(s, cx, cy);
      if (e >= 0 && s.extras[e].type === EXTRA_WARP) {
        if (!poop) ctx.sound(40, p.x);
        return;
      }
      if (p.counts[0] >= val(s, 651) && p.counts[0] - 1 === active) {
        if (rand(s.rng) % Math.max(val(s, 650), 1) === 0) ctx.sound(1200, p.x);
      }
      ctx.sound(poop ? 550 : 100, p.x);
      playerDropBomb(s, p, cx, cy, 0);
    }
  }
}

/** players_update_all @0x420f07 */
export function playersUpdate(s: GameState, ctx: FrameCtx, inputs: Uint8Array): void {
  const dt = ctx.dt;
  const pl = s.pl;
  if (pl.roundFreezeMs > 0) {
    pl.roundFreezeMs -= dt;
    if (pl.roundFreezeMs < 0) pl.roundFreezeMs = 0;
  }
  if (pl.trueColoursMs > 0) {
    pl.trueColoursMs -= dt;
    if (pl.trueColoursMs < 0) pl.trueColoursMs = 0;
  }
  pl.presentAcc = 0;
  pl.aliveAcc = 0;
  pl.teamPresent[0] = pl.teamPresent[1] = 0;
  pl.teamAlive[0] = pl.teamAlive[1] = 0;
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const p = s.players[i];
    playerUpdate(s, ctx, p, inputs[i] ?? 0);
    if (!pl.attract && pl.goldWinner >= 0 && s.refTick) {
      const side = s.opts.teamPlay ? (p.team ? 2 : 0) : i;
      if (side === pl.goldWinner && p.alive) goldmanSparkleSpawn(s, p);
    }
  }
  pl.presentLatched = pl.presentAcc;
  pl.aliveLatched = pl.aliveAcc;
  pl.teamsAliveLatched = (pl.teamAlive[0] !== 0 ? 1 : 0) + (pl.teamAlive[1] !== 0 ? 1 : 0);
  goldmanSparklesDraw(s, ctx);
}

function goldmanSparkleSpawn(s: GameState, p: Player): void {
  const sp = s.pl.sparkles;
  let slot = -1;
  for (let i = 0; i < sp.length; i++) if (!sp[i].active) { slot = i; break; }
  if (slot < 0) return;
  const v1010 = val(s, 1010);
  if (v1010 !== 0 && Math.floor(s.elapsedMs / 1000) >= v1010) return;
  if (rand(s.rng) % 6 === 0) return;
  sp[slot].active = 1;
  sp[slot].x = p.x + (rand(s.rng) % 40) - 20;
  sp[slot].y = p.y + (rand(s.rng) % 50) - 48;
  sp[slot].state = 0;
}

function goldmanSparklesDraw(s: GameState, ctx: FrameCtx): void {
  const seq = ctx.anims.find('goldman');
  for (const sp of s.pl.sparkles) {
    if (!sp.active) continue;
    if (seq >= 0) {
      const ref = ctx.anims.ref(seq, sp.state % 13);
      ctx.draw(ref.frame, sp.x, sp.y, remapOf(0));
    }
    if (s.refTick) {
      sp.state++;
      if (sp.state > 13) sp.active = 0;
    }
  }
}

export { inBounds };
