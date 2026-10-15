// AI 0: the original game's computer player (BM95.EXE ai.c / search.c), reproduced from
// docs/re/ai-original.md (section numbers below refer to that document).
//
// What it does (§11): it never stands in or walks into a marked blast line, bombs bricks it touches and
// enemies within one cell, now and then heads for a power-up close by or chases a random player, and otherwise
// wanders in straight lines. There is no escape planning: the only check before a drop is that the bot's cell is
// safe and one neighbour is free and safe (§11). Every think tries eight strategies in priority order (§2); the
// first one that returns true ends the think.
//
// How the original's per-frame logic maps onto Boom Buds' fixed 60 Hz steps:
//  - Rate. The original thinks once per rendered frame, so every chance below is a chance per frame (§1.3). By
//    default this bot thinks at the game's nominal 20 frames per second (VALUELST 30: every third step, at the
//    start of each 50 ms reference frame, the rate the remake already uses for the original's other per-frame
//    counters, docs/DIFFERENCES.md §2) and keeps its input for the three steps of that frame, as a frame of the
//    original lasts 50 ms at 20 fps. With `hz = 60` it thinks every step (the original running at 60 fps). Its
//    two timers add the game time of the frame (dt).
//  - View. think() runs before step(), so it sees the state at the end of the previous step, where the original
//    thinks in the middle of a frame, after the bombs, flames and map were updated. The danger map is therefore
//    rebuilt here the way the original sees it (§3.1: free bombs with their fuse, live flames, the enclosement
//    look-ahead) instead of reading s.danger, which still lacks the bombs dropped in the last step and holds the
//    held bombs (marked after the players, never seen by the original AI). All bots of a step see the same state,
//    so the original's "blocked grid built by the first AI of the frame" (quirk 15) cannot occur.
//  - Input. dir_in becomes one direction bit and btn1 / btn2 IN_ACT1 / IN_ACT2. To drop, pick up or punch, the
//    original also clears btn1_prev / btn2_prev, a press even if the button was held the frame before (§1.2);
//    IN_FRESH does that in the player code for AI players. Its immunity to reversed controls and the ice delay
//    is the player code's (players.ts), as in the original.
//  - Randomness. The game's own generator (Watcom rand(), src/game/sim/rng.ts) with one seed per bot, so a bot is
//    reproducible and independent of the other bots and of the simulation's random numbers (only the host runs
//    the bots of a network game and sends their inputs). The original shares one generator with the whole game,
//    so its exact sequence cannot be replayed anyway (§7); the draws are made in the original's order.

import { W, H, DX, DY, REF, MAX_BOMBS, MAX_PLAYERS, BombState, type GameState, type Player } from '../sim/types.ts';
import { rand, type RngState } from '../sim/rng.ts';
import { mapGet, pxToCx, pyToCy, inBounds, MAP_BLANK, MAP_BRICK } from '../sim/map.ts';
import { flameAt, FLAME_BRICK } from '../sim/flames.ts';
import { powerAt, P_BOMB, P_PUNCH, P_GRAB, P_TRIGGER } from '../sim/powers.ts';
import { bombsCountOwned } from '../sim/bombs.ts';
import { extraAt, EXTRA_WARP } from '../sim/extras.ts';
import { D_CONSTIPATION } from '../sim/diseases.ts';
import { A_PICKUP, A_TRAMPOLINE, A_WARP_OUT, A_WARP_IN, CTRL_OFF, CTRL_AI, playersAliveCount } from '../sim/players.ts';
import { timeRemainingS } from '../sim/enclosure.ts';
import { TICK_DT } from '../sim/sim.ts';
import { IN_UP, IN_RIGHT, IN_DOWN, IN_LEFT, IN_ACT1, IN_ACT2 } from '../../engine/input.ts';
import type { AiPlayer } from './index.ts';

/** AI-only input bit: the player code clears btn1_prev and btn2_prev, so a set button counts as a fresh press. */
export const IN_FRESH = 0x80;
/** Think rate of createAi({ level: 0 }): the game's nominal frame rate (VALUELST 30). */
export const ORIGINAL_HZ = 20;

const DIR_BITS = [IN_UP, IN_RIGHT, IN_DOWN, IN_LEFT];
const NC = W * H;
/** VALUELST: pickup pause (states), hurry time, enclosement look-ahead, brick chance, power-up search passes */
const V_PICKUP_PAUSE = 665;
const V_HURRY = 101;
const V_LOOKAHEAD = 910;
const V_BRICK_CHANCE = 915;
const V_POWER_PASSES = 920;
/** maxIter of the flee, safest-cell and chase searches (hard-coded) */
const SEARCH_ITERS = 20;
/** walker pool of search_init (0x409264) */
const WALKERS = 100;
/** chase and power-up time limit: 10 reference frames (500 ms) */
const CHASE_MS = 10 * REF;
/** attack offsets ODX / ODY (0x45bab0 / 0x45ba9c): west, north, own cell, south, east */
const ODX = [-1, 0, 0, 0, 1];
const ODY = [0, -1, 0, 1, 0];
/** goal tests of the three searches (§4.4) */
const GOAL_PATH = 0;
const GOAL_SAFEST = 1;
const GOAL_POWERUP = 2;

function val(s: GameState, id: number): number {
  return s.opts.values[id] ?? 0;
}

/**
 * Would the player code read this player's input in the coming step (player_update @0x41f29b, §1.1)? The
 * original only calls ai_think then. The round-start freeze is counted down at the start of the players update
 * and tested after that.
 */
function takesInput(s: GameState, p: Player): boolean {
  if (!p.alive || p.dying || p.stun > 0) return false;
  if (p.anim === A_TRAMPOLINE || p.anim === A_WARP_OUT || p.anim === A_WARP_IN) return false;
  if (p.anim === A_PICKUP && p.animFrame <= val(s, V_PICKUP_PAUSE)) return false;
  return s.pl.roundFreezeMs - TICK_DT[s.tick % 3] <= 0;
}

/** One step of the enclosement spiral cursor, as in map_update (enclosure.ts). */
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

export class OriginalAi implements AiPlayer {
  /** thinks per second: 20 (every third step, the default) or 60 (every step) */
  readonly hz: number;
  private rng: RngState;

  // ai_state (§9.1), zeroed at every round start by ai_round_reset (0x40a140). Only personality 0 exists.
  private flee = 0;
  private fleeX = 0;
  private fleeY = 0;
  private fleeVal = 0;
  private chaseActive = 0;
  private chaseTimer = 0;
  private chaseTarget = -1;
  private chaseDir = 0;
  private puActive = 0;
  private puTimer = 0;
  /** power-up cell index (the original keeps a pointer to the grid entry), -1 none */
  private puTarget = -1;
  private puDir = 0;
  /** markers only: 9 after a brick bomb, cleared by cancel_if_flame (nothing reads them) */
  private mode = 0;
  private modeDir = 0;
  private wdir = 0;
  /** the cell at the start of the think (A.cellX / A.cellY) */
  private cx = 0;
  private cy = 0;

  // the player's input fields as ai_think leaves them: dir_in, btn1, btn2, and whether it cleared btn1_prev /
  // btn2_prev (a forced fresh press)
  private dirIn = -1;
  private btn1 = 0;
  private btn2 = 0;
  private fresh1 = false;
  private fresh2 = false;

  // what the bot sees this think: bomb_at per cell, the blocked grid (§4.1) and the danger map (§3)
  private bombCell = new Int16Array(NC);
  private blocked = new Uint8Array(NC);
  private danger = new Int32Array(NC);
  // search.c: visited grid and walker pool {active, x, y, first, dir, state} (§4.2)
  private visited = new Uint8Array(NC);
  private wActive = new Uint8Array(WALKERS);
  private wX = new Int8Array(WALKERS);
  private wY = new Int8Array(WALKERS);
  private wFirst = new Uint8Array(WALKERS);
  private wDir = new Uint8Array(WALKERS);
  private wState = new Uint8Array(WALKERS);
  // search results: pass of the find (or passes run), safest cell seen, power-up found
  private iters = 0;
  private bestV = 0;
  private bestX = 0;
  private bestY = 0;
  private bestFirst = 0;
  private foundPower = -1;

  private s: GameState | null = null;
  private p: Player | null = null;
  /** game time of this frame (ms) */
  private dt = 0;
  /** input of the last think, kept for the rest of its 20 Hz frame (without IN_FRESH) */
  private held = 0;
  /** bits returned by the previous think() call */
  private lastOut = 0;

  constructor(seed: number, hz = ORIGINAL_HZ) {
    this.rng = { seed: seed >>> 0 };
    this.hz = hz >= 60 ? 60 : 20;
  }

  reset(): void {
    this.flee = 0;
    this.fleeX = 0;
    this.fleeY = 0;
    this.fleeVal = 0;
    this.chaseActive = 0;
    this.chaseTimer = 0;
    this.chaseTarget = -1;
    this.chaseDir = 0;
    this.puActive = 0;
    this.puTimer = 0;
    this.puTarget = -1;
    this.puDir = 0;
    this.mode = 0;
    this.modeDir = 0;
    this.wdir = 0;
    this.held = 0;
    this.lastOut = 0;
  }

  think(s: GameState, index: number): number {
    const every = this.hz === 60 ? 1 : 3;
    let bits: number;
    if (s.tick % every !== 0) {
      // the rest of a 20 Hz frame: same direction, buttons still down (no new press)
      bits = this.held;
    } else {
      bits = this.frame(s, index, every);
      this.held = bits & ~IN_FRESH;
    }
    this.lastOut = bits;
    return bits;
  }

  /** One frame of the original: ai_think if the player code would read this player's input. */
  private frame(s: GameState, index: number, every: number): number {
    if (index < 0 || index >= MAX_PLAYERS) return 0;
    const p = s.players[index];
    if (!takesInput(s, p)) return 0;
    let dt = 0;
    for (let k = 0; k < every; k++) dt += TICK_DT[(s.tick + k) % 3];
    this.s = s;
    this.p = p;
    this.dt = dt;
    this.aiThink(s, p, index);
    const bits = this.encode(p);
    this.s = null;
    this.p = null;
    return bits;
  }

  /** ai_think (0x40a1c6, §2) */
  private aiThink(s: GameState, p: Player, index: number): void {
    rand(this.rng); // free(malloc(rand() % 1000 + 100)): debug heap exercise, no effect
    this.buildView(s);
    this.dirIn = -1;
    this.btn1 = 0;
    this.btn2 = 0;
    this.fresh1 = false;
    this.fresh2 = false;
    this.cx = pxToCx(p.x);
    this.cy = pyToCy(p.y);
    // (the original stops with a fatal "player %u offscreen" error here; the bot just stands still)
    if (p.x < 0 || p.y < 0 || this.cx < 0 || this.cy < 0) return;
    // strategy table of personality 0 (g_ai_strategies_p0, 0x45ba78): the first that returns true ends the think
    void (this.grabThrow() || this.punch() || this.fleeDanger() || this.blastBricks() || this.attack(index) ||
      this.goForPowerup() || this.chasePlayer(index) || this.wander());
    rand(this.rng); // the second debug malloc
  }

  /**
   * The input bits for the player fields ai_think wrote. IN_FRESH clears both previous button states, so it is
   * only added when a forced press might otherwise read as held (the button was down in the previous step).
   */
  private encode(p: Player): number {
    let bits = this.dirIn >= 0 ? DIR_BITS[this.dirIn & 3] : 0;
    if (this.btn1) bits |= IN_ACT1;
    if (this.btn2) bits |= IN_ACT2;
    const down1 = (this.lastOut & IN_ACT1) !== 0 || p.btn1 !== 0;
    const down2 = (this.lastOut & IN_ACT2) !== 0 || p.btn2 !== 0;
    if ((this.btn1 && this.fresh1 && down1) || (this.btn2 && this.fresh2 && down2)) bits |= IN_FRESH;
    return bits;
  }

  // -------------------------------------------------------------------------------------------------------
  // what the bot sees

  /**
   * bomb_at per cell, ai_blocked_rebuild (0x4090e7: solid, brick or bomb) and the danger map as the original
   * builds it each frame (§3.1): every bomb without a holder marks its cell and blast lines with fuse elapsed +
   * 100 (lines stop before walls, bricks and bombs and after a power-up), every live flame but burning bricks
   * 1000, and the enclosement the next V910 spiral positions with 250, 240, ... 110 (the cell the next block
   * hits is not marked, quirk 3).
   */
  private buildView(s: GameState): void {
    const bc = this.bombCell;
    bc.fill(-1);
    for (let i = MAX_BOMBS - 1; i >= 0; i--) {
      const b = s.bombs[i];
      if (!b.active || b.state === BombState.FLYING || b.state === BombState.HELD) continue;
      const x = pxToCx(b.x);
      const y = pyToCy(b.y);
      // descending slots: the lowest one wins, as bomb_at returns the first bomb found
      if (inBounds(x, y)) bc[y * W + x] = i;
    }
    for (let c = 0; c < NC; c++) this.blocked[c] = s.map[c] !== MAP_BLANK || bc[c] >= 0 ? 1 : 0;
    this.danger.fill(0);
    for (let i = 0; i < MAX_BOMBS; i++) {
      const b = s.bombs[i];
      if (!b.active || b.holder >= 0) continue;
      const v = b.fuseElapsed + 100;
      const bx = pxToCx(b.x);
      const by = pyToCy(b.y);
      this.raise(bx, by, v);
      for (let d = 0; d < 4; d++) {
        let x = bx;
        let y = by;
        for (let k = 1; k <= b.flameLen; k++) {
          x += DX[d];
          y += DY[d];
          if (mapGet(s, x, y) !== MAP_BLANK || this.bombAt(x, y) >= 0) break;
          this.raise(x, y, v);
          if (powerAt(s, x, y) >= 0) break;
        }
      }
    }
    for (let c = 0; c < NC; c++) {
      const f = s.flames[c];
      if (f.state !== 0 && f.type !== FLAME_BRICK && this.danger[c] < 1000) this.danger[c] = 1000;
    }
    const h = s.hurry;
    const depth = s.opts.enclosementDepth;
    if (playersAliveCount(s) > 1 && timeRemainingS(s) <= val(s, V_HURRY) - 5 && h.ring < 2 * depth) {
      const cur = { x: h.x, y: h.y, ring: h.ring, dir: h.dir };
      const n = val(s, V_LOOKAHEAD);
      let v = n * 10 + 100;
      for (let k = 0; k < n; k++) {
        if (!spiralStep(cur, depth)) break;
        this.raise(cur.x, cur.y, v);
        v -= 10;
      }
    }
  }

  /** danger_raise (0x424dfe) */
  private raise(x: number, y: number, v: number): void {
    if (!inBounds(x, y)) return;
    const c = y * W + x;
    if (this.danger[c] < v) this.danger[c] = v;
  }

  /** danger_get (0x424d37): 0 outside the field */
  private dangerAt(x: number, y: number): number {
    return inBounds(x, y) ? this.danger[y * W + x] : 0;
  }

  /** bomb_at (0x422e48): resting, sliding or dud bomb in the cell (not flying or held), -1 none */
  private bombAt(x: number, y: number): number {
    return inBounds(x, y) ? this.bombCell[y * W + x] : -1;
  }

  /** ai_cell_free_and_safe (0x40a59d) */
  private freeAndSafe(x: number, y: number): boolean {
    const s = this.s!;
    return this.bombAt(x, y) < 0 && mapGet(s, x, y) === MAP_BLANK && flameAt(s, x, y) < 0 && this.dangerAt(x, y) === 0;
  }

  /** bomb_cell_free_ai (0x423188): the drop test of the player code, not an escape check */
  private canDropHere(x: number, y: number): boolean {
    const s = this.s!;
    if (this.bombAt(x, y) >= 0) return false;
    const e = extraAt(s, x, y);
    if (e >= 0 && s.extras[e].type === EXTRA_WARP) return false;
    return mapGet(s, x, y) === MAP_BLANK;
  }

  /** player_at (0x421cb5) with the bot's own slot hidden (attack clears its state around the call) */
  private playerAt(x: number, y: number, self: number): number {
    const s = this.s!;
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const q = s.players[i];
      if (i !== self && q.alive && !q.dying && pxToCx(q.x) === x && pyToCy(q.y) === y) return i;
    }
    return -1;
  }

  /** ai_cancel_dir_if_flame (0x40a76e): never step into a flame */
  private cancelIfFlame(): void {
    const d = this.dirIn;
    if (d >= 0 && d <= 3 && flameAt(this.s!, this.cx + DX[d], this.cy + DY[d]) >= 0) {
      this.mode = 0;
      this.modeDir = -1;
      this.dirIn = -1;
    }
  }

  // -------------------------------------------------------------------------------------------------------
  // search.c (§4)

  private vget(x: number, y: number): number {
    return x < 0 || y < 0 || x >= W || y >= H ? 1 : this.visited[y * W + x];
  }

  private vset(x: number, y: number, v: number): void {
    if (x >= 0 && y >= 0 && x < W && y < H) this.visited[y * W + x] = v;
  }

  /** search_walker_alloc (0x4091c9): the first free slot (slots freed in this pass are reused at once), -1 none */
  private alloc(): number {
    for (let i = 0; i < WALKERS; i++) if (!this.wActive[i]) return i;
    return -1;
  }

  /** The goal test of a search at (x, y) for a walker whose first step was `first - 1`. */
  private goal(kind: number, x: number, y: number, first: number, tx: number, ty: number): boolean {
    if (kind === GOAL_PATH) return x === tx && y === ty;
    if (kind === GOAL_SAFEST) {
      const v = this.dangerAt(x, y);
      if (v < this.bestV) {
        this.bestV = v;
        this.bestX = x;
        this.bestY = y;
        this.bestFirst = first;
      }
      return v === 0;
    }
    const pw = powerAt(this.s!, x, y);
    if (pw < 0) return false;
    this.foundPower = pw;
    return true;
  }

  /**
   * The walker flood fill shared by search_path (0x4092a1, goal: the cell (tx, ty)), search_safest (0x40970b,
   * goal: a cell without danger, else the lowest danger seen) and search_powerup (0x409c1f, goal: any power-up),
   * §4.3, including the slot order, the reuse of freed slots, the "state 2" rule and the random side order: it is
   * not an exact breadth-first search and the order decides which first step wins. Blocked cells (walls, bricks,
   * bombs) are never entered; players, flames, danger and extras are ignored. Returns the first step + 1 (0 =
   * not found; search_safest then returns the first step towards the lowest danger seen) and sets this.iters to
   * the 0-based pass of the find (0 = path distance 1 or 2, or start = target), or the passes run.
   */
  private search(kind: number, sx: number, sy: number, maxIter: number, tx: number, ty: number): number {
    const turn = (rand(this.rng) % 2) * 2 - 1;
    this.visited.set(this.blocked);
    this.bestV = 10000;
    this.bestX = sx;
    this.bestY = sy;
    this.bestFirst = 0;
    this.foundPower = -1;
    if (kind === GOAL_PATH && sx === tx && sy === ty) {
      this.iters = 0;
      return 0;
    }
    const act = this.wActive;
    const wx = this.wX;
    const wy = this.wY;
    const wf = this.wFirst;
    const wd = this.wDir;
    const ws = this.wState;
    act.fill(0);
    for (let d = 0; d < 4; d++) {
      const nx = sx + DX[d];
      const ny = sy + DY[d];
      if (this.vget(nx, ny) !== 0) continue;
      // initial walkers are not marked visited (the pool is empty: the original's fatal 0x69 cannot happen)
      const w = this.alloc();
      act[w] = 1;
      wx[w] = nx;
      wy[w] = ny;
      wf[w] = d + 1;
      wd[w] = d;
      ws[w] = 1;
    }
    // search_powerup tests the walker's own cell in the side and forward checks (quirk 2: power-ups in dead-end
    // side pockets are never found)
    const own = kind === GOAL_POWERUP;
    let iters = 0;
    let count: number;
    do {
      count = 0;
      for (let w = 0; w < WALKERS; w++) {
        if (!act[w]) continue;
        count++;
        if (ws[w] === 2) {
          // created later in the pool during this pass: skip once
          ws[w] = 1;
          continue;
        }
        const x = wx[w];
        const y = wy[w];
        const f = wf[w];
        const dir = wd[w];
        const stale = ws[w] === 0 && this.vget(x, y) !== 0;
        ws[w] = 0;
        if (this.vget(x, y) === 0 && this.goal(kind, x, y, f, tx, ty)) return this.found(f, iters);
        if (!stale) this.vset(x, y, f + 10);
        for (let k = -1; k <= 1; k += 2) {
          const nd = (k * turn + dir) & 3;
          const nx = x + DX[nd];
          const ny = y + DY[nd];
          if (this.vget(nx, ny) !== 0) continue;
          if (this.goal(kind, own ? x : nx, own ? y : ny, f, tx, ty)) return this.found(f, iters);
          const c = this.alloc();
          // (a full pool is the original's fatal error 10 "can't clone to the side"; not reachable on 15x11)
          if (c < 0) continue;
          count++;
          act[c] = 1;
          wx[c] = nx;
          wy[c] = ny;
          wf[c] = f;
          wd[c] = nd;
          ws[c] = c > w ? 2 : 1;
          this.vset(nx, ny, f + 10);
        }
        const nx = x + DX[dir];
        const ny = y + DY[dir];
        if (this.vget(nx, ny) === 0 && this.goal(kind, own ? x : nx, own ? y : ny, f, tx, ty)) return this.found(f, iters);
        if (stale || this.vget(nx, ny) !== 0) act[w] = 0;
        // (moves even when it just died)
        wx[w] = nx;
        wy[w] = ny;
      }
      iters++;
      if (iters > maxIter) count = 0;
    } while (count !== 0);
    this.iters = iters;
    return kind === GOAL_SAFEST ? this.bestFirst : 0;
  }

  private found(first: number, iters: number): number {
    this.iters = iters;
    return first;
  }

  // -------------------------------------------------------------------------------------------------------
  // the strategies (§5), in priority order

  /** 5.1 grab and throw (0x40bd44) */
  private grabThrow(): boolean {
    const p = this.p!;
    if (!p.counts[P_GRAB]) return false;
    if (p.held >= 0) {
      // button up: the player code throws the bomb along the facing direction
      this.btn1 = 0;
      this.fresh1 = true;
      return true;
    }
    const b = this.bombAt(this.cx, this.cy);
    if (b >= 0 && this.s!.bombs[b].owner === p.id && rand(this.rng) % 2 !== 0) {
      // fresh press on its own bomb: pick it up (grab wins over spooge)
      this.btn1 = 1;
      this.fresh1 = true;
      return true;
    }
    return false;
  }

  /** 5.2 punch (0x40be02): any bomb next to it, 1 in 4 */
  private punch(): boolean {
    if (!this.p!.counts[P_PUNCH]) return false;
    if (rand(this.rng) % 4 !== 0) return false;
    for (let d = 0; d < 4; d++) {
      if (this.bombAt(this.cx + DX[d], this.cy + DY[d]) >= 0) {
        this.dirIn = d;
        this.btn2 = 1;
        this.fresh2 = true;
        return true;
      }
    }
    return false;
  }

  /** 5.3 flee from danger (0x40b20f), with the trigger detonation */
  private fleeDanger(): boolean {
    const p = this.p!;
    const cx = this.cx;
    const cy = this.cy;
    if (this.dangerAt(cx, cy) === 0) {
      // safe: set off the oldest trigger bomb now and then (no forced press; never with a punch glove)
      if (p.counts[P_TRIGGER] && !p.counts[P_PUNCH] && rand(this.rng) % 10 === 0) this.btn2 = 1;
      for (let d = 0; d < 4; d++) {
        if (this.freeAndSafe(cx + DX[d], cy + DY[d])) {
          this.flee = 0;
          return false;
        }
      }
      // no free and safe neighbour: hold still
      this.flee = 0;
      return true;
    }
    // in danger: the chosen safe cell has become dangerous: plan again
    if (this.flee && this.fleeVal === 0 && this.dangerAt(this.fleeX, this.fleeY) !== 0) this.flee = 0;
    if (this.flee) {
      const d1 = this.search(GOAL_PATH, cx, cy, SEARCH_ITERS, this.fleeX, this.fleeY);
      if (d1 === 0) {
        this.flee = 0;
        return false;
      }
      this.dirIn = d1 - 1;
      this.cancelIfFlame();
      return this.dirIn !== -1;
    }
    const d1 = this.search(GOAL_SAFEST, cx, cy, SEARCH_ITERS, 0, 0);
    if (d1 === 0) {
      // nothing reachable: the lower strategies run (and may drop another bomb)
      this.flee = 0;
      return false;
    }
    this.flee = 1;
    const bx = this.bestX;
    const by = this.bestY;
    if (this.dangerAt(cx, cy) > this.dangerAt(bx, by)) {
      this.fleeX = bx;
      this.fleeY = by;
      this.fleeVal = this.dangerAt(bx, by);
      this.dirIn = d1 - 1;
      this.cancelIfFlame();
      return this.dirIn !== -1;
    }
    // the best reachable cell is no better: stand still (flee_val is not updated, quirk 9)
    this.fleeX = cx;
    this.fleeY = cy;
    this.dirIn = -1;
    return true;
  }

  /** 5.4 blast bricks (0x40ad8d): a brick next to it, 1 in V915 */
  private blastBricks(): boolean {
    const s = this.s!;
    const p = this.p!;
    const cx = this.cx;
    const cy = this.cy;
    if (bombsCountOwned(s, p.id) >= p.counts[P_BOMB]) {
      if (this.mode === 9) this.mode = 0;
      return false;
    }
    if (p.disease[D_CONSTIPATION]) return false;
    let n = 0;
    for (let d = 0; d < 4; d++) if (mapGet(s, cx + DX[d], cy + DY[d]) === MAP_BRICK) n++;
    if (n === 0) {
      if (this.mode === 9) this.mode = 0;
      return false;
    }
    if (!this.canDropHere(cx, cy)) return false;
    const v = val(s, V_BRICK_CHANCE);
    if (rand(this.rng) % (v < 2 ? 1 : v) === 0) {
      this.fresh1 = true;
      this.btn1 = 1;
      this.mode = 9;
      return true;
    }
    return false;
  }

  /** 5.5 attack (0x40abed): a player in its own or an adjacent cell, 1 in 5 (constipation not checked) */
  private attack(index: number): boolean {
    const s = this.s!;
    const p = this.p!;
    const cx = this.cx;
    const cy = this.cy;
    if (bombsCountOwned(s, p.id) >= p.counts[P_BOMB]) return false;
    // not near its start point (or the exit of the last warp it used)
    if (Math.abs(cx - pxToCx(p.homeX)) + Math.abs(cy - pyToCy(p.homeY)) < 3) return false;
    for (let i = 0; i < 5; i++) {
      const q = this.playerAt(cx + ODX[i], cy + ODY[i], index);
      if (q < 0) continue;
      // the first player found is a teammate: give up
      if (s.opts.teamPlay && s.players[q].team === p.team) return false;
      if (!this.canDropHere(cx, cy)) return false;
      if (rand(this.rng) % 5 === 0) {
        this.fresh1 = true;
        this.btn1 = 1;
        return true;
      }
      return false;
    }
    return false;
  }

  /** 5.6 go for a power-up (0x40baf5) */
  private goForPowerup(): boolean {
    const s = this.s!;
    const cx = this.cx;
    const cy = this.cy;
    const passes = val(s, V_POWER_PASSES);
    if (!this.puActive && rand(this.rng) % 50 === 0) {
      this.search(GOAL_POWERUP, cx, cy, passes, 0, 0);
      if (this.foundPower >= 0 && this.iters <= passes + 1) {
        this.puActive = 1;
        // quirk 1: resets the player-chase timer instead of pu_timer, so power-up hunting gets 500 ms per round
        this.chaseTimer = 0;
        this.puTarget = this.foundPower;
      }
    }
    if (!this.puActive) return false;
    this.puTimer += this.dt;
    if (this.puTimer >= CHASE_MS) {
      this.puActive = 0;
      return false;
    }
    const pu = this.puTarget;
    if (pu < 0 || s.powers[pu].state !== 2) {
      // gone, or not visible
      this.puActive = 0;
      return false;
    }
    const d1 = this.search(GOAL_PATH, cx, cy, passes + 1, pu % W, Math.floor(pu / W));
    // within path distance 2: 50% chance to end the chase (it still moves now)
    if (this.iters === 0 && rand(this.rng) % 2 !== 0) this.puActive = 0;
    if (d1 === 0) {
      this.puActive = 0;
      return false;
    }
    this.puDir = d1 - 1;
    // wait rather than step into danger (any power-up type, skulls included)
    this.dirIn = this.freeAndSafe(cx + DX[this.puDir & 3], cy + DY[this.puDir & 3]) ? this.puDir : -1;
    return true;
  }

  /** 5.7 chase a player (0x40b8c2) */
  private chasePlayer(index: number): boolean {
    const s = this.s!;
    const cx = this.cx;
    const cy = this.cy;
    if (!this.chaseActive && rand(this.rng) % 50 === 0) {
      const t = this.pickChaseTarget(index);
      if (t >= 0) {
        this.chaseActive = 1;
        this.chaseTimer = 0;
        this.chaseTarget = t;
      }
    }
    if (!this.chaseActive) return false;
    this.chaseTimer += this.dt;
    if (this.chaseTimer >= CHASE_MS && rand(this.rng) % 50 === 0) {
      this.chaseActive = 0;
      return false;
    }
    if (this.chaseTarget < 0) {
      this.chaseActive = 0;
      return false;
    }
    const t = s.players[this.chaseTarget];
    if (t.dying || t.alive !== 1) {
      this.chaseActive = 0;
      return false;
    }
    const d1 = this.search(GOAL_PATH, cx, cy, SEARCH_ITERS, pxToCx(t.x), pyToCy(t.y));
    // target within path distance 2 (or in the same cell): 50% chance to end the chase
    if (this.iters === 0 && rand(this.rng) % 2 !== 0) this.chaseActive = 0;
    if (d1 === 0) {
      // unreachable (a target standing on a bomb, too far) or in the same cell
      this.chaseActive = 0;
      return false;
    }
    this.chaseDir = d1 - 1;
    this.dirIn = this.freeAndSafe(cx + DX[this.chaseDir & 3], cy + DY[this.chaseDir & 3]) ? this.chaseDir : -1;
    return true;
  }

  /** ai_pick_chase_target (0x422718): humans first, from a random slot (not the nearest player) */
  private pickChaseTarget(index: number): number {
    const s = this.s!;
    const p = this.p!;
    for (let pass = 0; pass < 2; pass++) {
      const r = rand(this.rng) % 10;
      for (let k = 0; k < 10; k++) {
        const i = (r + k) % 10;
        const q = s.players[i];
        if (i === index || q.ctrl === CTRL_OFF || (pass === 0 && q.ctrl === CTRL_AI)) continue;
        if (!q.alive || q.dying || (s.opts.teamPlay && q.team === p.team)) continue;
        return i;
      }
    }
    return -1;
  }

  /** 5.8 wander (0x40a81f): straight runs, a 90 degree turn now and then, a new random direction when blocked */
  private wander(): boolean {
    const cx = this.cx;
    const cy = this.cy;
    if (rand(this.rng) % 25 === 0) {
      const nd = (this.wdir + (rand(this.rng) % 2) * 2 - 1) & 3;
      // quirk 10: tests the old direction's cell, not the new one
      if (this.freeAndSafe(cx + DX[this.wdir & 3], cy + DY[this.wdir & 3])) this.wdir = nd;
    }
    if (this.freeAndSafe(cx + DX[this.wdir & 3], cy + DY[this.wdir & 3])) {
      this.dirIn = this.wdir;
      return true;
    }
    // blocked: stand still now, new random direction for the next frame
    this.wdir = rand(this.rng) % 4;
    return false;
  }
}
