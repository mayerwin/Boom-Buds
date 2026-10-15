// Per-step snapshot of what the computer players read from the simulation state. It is built once per state
// object and step and shared by every bot (think() never mutates the state; this is derived data only).
// It holds only what a human can see on screen: no hidden power-ups, no RNG state.

import { W, H, DX, DY, MAX_PLAYERS, MAX_BOMBS, REF, BombState, BombType, type GameState } from '../sim/types.ts';
import { pxToCx, pyToCy, offsetX, offsetY } from '../sim/map.ts';
import { EXTRA_ARROW, EXTRA_WARP, EXTRA_CONVEYOR, EXTRA_TRAMPOLINE, warpFindDest } from '../sim/extras.ts';
import { D_MOLASSES, D_CRACK, D_CRACK_POOPS, D_CONSTIPATION, D_POOPS, D_SHORT_FLAME, D_SHORT_FUZE } from '../sim/diseases.ts';
import { A_TRAMPOLINE, A_WARP_OUT, A_WARP_IN, A_PICKUP, CTRL_OFF } from '../sim/players.ts';
import { playersAliveCount } from '../sim/players.ts';
import { TICK_DT } from '../sim/sim.ts';
import { stepsUntil, unitsPerStep } from './timing.ts';
import { trackSlide, trackFlight, type Track } from './motion.ts';

export const NC = W * H;
export const MAP_BLANK = 0;
export const MAP_SOLID = 1;
export const MAP_BRICK = 2;
/** Pixels from a cell's anchor until the anchor leaves the cell, moving in direction d (N, E, S, W). */
export const EXIT = [19, 20, 18, 21];
/** Pixels from entering a cell (moving in direction d) to its anchor. */
export const ENTER = [17, 20, 18, 19];
/** Pixels to cross a whole cell moving in direction d. */
export const FULL = [36, 40, 36, 40];

/** NB[c * 4 + d] = neighbour cell of c in direction d, or -1 outside the field. */
export const NB = new Int16Array(NC * 4);
for (let c = 0; c < NC; c++) {
  for (let d = 0; d < 4; d++) {
    const x = (c % W) + DX[d];
    const y = Math.floor(c / W) + DY[d];
    NB[c * 4 + d] = x < 0 || y < 0 || x >= W || y >= H ? -1 : y * W + x;
  }
}

export function cellOf(px: number, py: number): number {
  const cx = pxToCx(px);
  const cy = pyToCy(py);
  return cx < 0 || cy < 0 || cx >= W || cy >= H ? -1 : cy * W + cx;
}

export function manhattan(a: number, b: number): number {
  return Math.abs((a % W) - (b % W)) + Math.abs(Math.floor(a / W) - Math.floor(b / W));
}

export interface PlayerInfo {
  index: number;
  /** in play, alive and not dying */
  alive: boolean;
  ctrl: number;
  team: number;
  x: number;
  y: number;
  cell: number;
  ox: number;
  oy: number;
  dir: number;
  /** pixels per step when walking */
  speed: number;
  capacity: number;
  /** active bombs owned (flying / held / dud included) */
  active: number;
  /** a drop press would create a bomb (capacity left, not constipated) */
  canDrop: boolean;
  flame: number;
  fuseMs: number;
  /** type of the next dropped bomb */
  bombType: number;
  kicker: boolean;
  punch: boolean;
  grab: boolean;
  spooge: boolean;
  trigger: boolean;
  skates: number;
  /** input is ignored this step (stun, warp, trampoline, pickup pause, round start) */
  busy: boolean;
  /** cannot be killed right now (warp or trampoline animation) */
  immune: boolean;
  /** held bomb slot, -1 none */
  held: number;
  anim: number;
  diseased: boolean;
  poops: boolean;
  counts: number[];
}

export interface BombInfo {
  slot: number;
  owner: number;
  type: number;
  state: number;
  dud: boolean;
  x: number;
  y: number;
  cell: number;
  dir: number;
  flame: number;
  /** milliseconds of fuse left */
  fuseLeft: number;
  /** step at which it explodes when left alone (Infinity: trigger bomb, held, or unknown) */
  tOwn: number;
  /** in the explode list: explodes in the next step */
  queued: boolean;
  born: number;
  accum: number;
  stop: number;
  bounce: number;
  holder: number;
  /** predicted motion (sliding / conveyor / flying), computed on demand */
  track: Track | null;
  /** same, with the other players treated as static obstacles */
  trackP: Track | null;
}

export class World {
  s!: GameState;
  /** step number of the state (the next step is tick + 1) */
  tick = -1;
  /** round number of the state (roundStart keeps the step counter) */
  round = -1;
  readonly map = new Uint8Array(NC);
  /** bomb slot found by bomb_at (resting / sliding / dud, not flying or held), -1 none */
  readonly bombCell = new Int16Array(NC);
  /** visible power-up type, -1 none */
  readonly power = new Int8Array(NC);
  /** step at which the current flame is gone for players (0 = no flame); bombs still see it during that step */
  readonly flameEnd = new Float64Array(NC);
  readonly flameBrick = new Uint8Array(NC);
  /** destination cell of an active warp hole, -1 none */
  readonly warpDest = new Int16Array(NC);
  readonly tramp = new Uint8Array(NC);
  /** conveyor direction, -1 none */
  readonly conv = new Int8Array(NC);
  /** arrow direction, -1 none */
  readonly arrow = new Int8Array(NC);
  /** step at which the enclosement makes the cell solid (Infinity: not within the prediction window) */
  readonly hurryStep = new Float64Array(NC);
  /** bitmask of players (alive, not dying) per anchor cell */
  readonly playerMask = new Uint16Array(NC);
  readonly players: PlayerInfo[] = [];
  readonly bombs: BombInfo[] = [];
  /** bombs by slot (null when inactive) */
  readonly bombBySlot: (BombInfo | null)[] = new Array(MAX_BOMBS).fill(null);
  hasWarps = false;
  hasTramps = false;
  hasConveyors = false;
  hasArrows = false;
  /** px per step of a conveyor belt, a kicked bomb and a flying bomb */
  convSpeed = 0;
  /** accumulator units per 50 ms: conveyor, kick, flight */
  convV = 0;
  kickV = 0;
  flyV = 0;
  /** steps a new flame lasts */
  flameSteps = 30;
  /** enclosement: running, first predicted drop, step it starts (if in the future) */
  hurryOn = false;
  hurryNext = Infinity;
  hurryStart = Infinity;
  teamPlay = false;
  aliveCount = 0;
  /** milliseconds of round time left (Infinity when unlimited) */
  remainingMs = Infinity;
  /** work done by all bots on this step (search states + danger builds), for the shared per-step budget */
  work = 0;
  /** budget scale: the per-step work caps are sized for 9 bots and grow when fewer bots share the step */
  budget = 1;

  build(s: GameState): void {
    this.s = s;
    this.tick = s.tick;
    this.round = s.round;
    this.work = 0;
    const v = s.opts.values;
    const tick = s.tick;
    this.teamPlay = !!s.opts.teamPlay;
    this.aliveCount = playersAliveCount(s);
    this.convV = v[190 + s.opts.conveyorSpeed] ?? 350;
    this.kickV = v[300] ?? 1000;
    this.flyV = v[301] ?? 1300;
    this.convSpeed = unitsPerStep(this.convV) / 100;
    this.flameSteps = stepsUntil(tick, (v[10] ?? 10) * REF, true) - 1;
    this.remainingMs = s.opts.playtime > 0 ? (s.opts.playtime + 1) * 1000 - s.elapsedMs : Infinity;
    for (let i = 0; i < NC; i++) {
      this.map[i] = s.map[i];
      const f = s.flames[i];
      if (f.state !== 0) {
        const brick = f.type === 9;
        const lim = (brick ? v[20] : v[10]) * REF;
        this.flameEnd[i] = tick + stepsUntil(tick, lim - f.age, true);
        this.flameBrick[i] = brick ? 1 : 0;
      } else {
        this.flameEnd[i] = 0;
        this.flameBrick[i] = 0;
      }
      const p = s.powers[i];
      this.power[i] = p.state === 2 && s.map[i] === MAP_BLANK ? p.type : -1;
      this.bombCell[i] = -1;
      this.warpDest[i] = -1;
      this.tramp[i] = 0;
      this.conv[i] = -1;
      this.arrow[i] = -1;
      this.playerMask[i] = 0;
    }
    // extras (extra_at returns the first active extra of a cell)
    this.hasWarps = this.hasTramps = this.hasConveyors = this.hasArrows = false;
    for (let i = s.extras.length - 1; i >= 0; i--) {
      const e = s.extras[i];
      if (!e.active || e.cx < 0 || e.cy < 0 || e.cx >= W || e.cy >= H) continue;
      const c = e.cy * W + e.cx;
      this.warpDest[c] = -1;
      this.tramp[c] = 0;
      this.conv[c] = -1;
      this.arrow[c] = -1;
      if (e.type === EXTRA_WARP) {
        const [wx, wy] = warpFindDest(s, i);
        this.warpDest[c] = wy * W + wx;
        this.hasWarps = true;
      } else if (e.type === EXTRA_TRAMPOLINE) {
        this.tramp[c] = 1;
        this.hasTramps = true;
      } else if (e.type === EXTRA_CONVEYOR) {
        this.conv[c] = e.dir;
        this.hasConveyors = true;
      } else if (e.type === EXTRA_ARROW) {
        this.arrow[c] = e.dir;
        this.hasArrows = true;
      }
    }
    this.buildPlayers(s);
    let bots = 0;
    for (const p of this.players) if (p.alive && p.ctrl === 1) bots++;
    this.budget = Math.min(3, 7.5 / Math.max(2.5, bots));
    this.buildBombs(s);
    this.predictHurry(s);
  }

  private buildPlayers(s: GameState): void {
    const v = s.opts.values;
    const freeze = s.pl.roundFreezeMs - TICK_DT[s.tick % 3] > 0;
    const owned = new Array(MAX_PLAYERS).fill(0);
    for (const b of s.bombs) if (b.active && b.owner >= 0 && b.owner < MAX_PLAYERS) owned[b.owner]++;
    this.players.length = 0;
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const p = s.players[i];
      const alive = p.ctrl !== CTRL_OFF && p.alive !== 0 && !p.dying;
      let spd = p.speed + p.counts[4] * (v[90] ?? 150) - p.counts[13] * (v[91] ?? 150);
      if (p.disease[D_MOLASSES]) spd = Math.trunc(spd / 3);
      if (p.disease[D_CRACK] || p.disease[D_CRACK_POOPS]) spd = Math.trunc((spd * 3) / 2);
      let flame = p.counts[1];
      if (p.disease[D_SHORT_FLAME]) flame = 1;
      if (p.counts[8]) flame = Math.max(W, H);
      let fuse = p.fuse;
      if (p.disease[D_SHORT_FUZE]) fuse = Math.trunc(fuse / 3);
      let type: number = BombType.REGULAR;
      if (p.counts[10]) type = BombType.JELLY;
      if (p.counts[9] && p.triggerUsed < p.counts[0]) type = BombType.TRIGGER;
      const busy = freeze || p.stun > 0 || p.anim === A_TRAMPOLINE || p.anim === A_WARP_OUT || p.anim === A_WARP_IN ||
        (p.anim === A_PICKUP && p.animFrame <= (v[665] ?? 2));
      const cell = cellOf(p.x, p.y);
      const info: PlayerInfo = {
        index: i,
        alive,
        ctrl: p.ctrl,
        team: p.team,
        x: p.x,
        y: p.y,
        cell,
        ox: offsetX(p.x),
        oy: offsetY(p.y),
        dir: p.dir,
        speed: unitsPerStep(spd) / 100,
        capacity: p.counts[0],
        active: owned[i],
        canDrop: p.counts[0] > owned[i] && !p.disease[D_CONSTIPATION],
        flame,
        fuseMs: fuse * REF,
        bombType: type,
        kicker: p.counts[3] > 0,
        punch: p.counts[5] > 0,
        grab: p.counts[6] > 0,
        spooge: p.counts[7] > 0,
        trigger: p.counts[9] > 0,
        skates: p.counts[4],
        busy,
        immune: p.anim === A_TRAMPOLINE || p.anim === A_WARP_OUT || p.anim === A_WARP_IN,
        held: p.held,
        anim: p.anim,
        diseased: p.diseaseMs !== 0,
        poops: !!(p.disease[D_POOPS] || p.disease[D_CRACK_POOPS]),
        counts: p.counts,
      };
      this.players.push(info);
      if (alive && cell >= 0) this.playerMask[cell] |= 1 << i;
    }
  }

  private buildBombs(s: GameState): void {
    const v = s.opts.values;
    const tick = s.tick;
    this.bombs.length = 0;
    const queued = new Uint8Array(MAX_BOMBS);
    for (const e of s.explodeList) if (e.bomb >= 0 && e.bomb < MAX_BOMBS) queued[e.bomb] = 1;
    for (let i = 0; i < MAX_BOMBS; i++) {
      const b = s.bombs[i];
      if (!b.active) {
        this.bombBySlot[i] = null;
        continue;
      }
      const cell = cellOf(b.x, b.y);
      const dud = b.active === 2;
      const info: BombInfo = {
        slot: i, owner: b.owner, type: b.type, state: b.state, dud, x: b.x, y: b.y, cell, dir: b.dir,
        flame: b.flameLen, fuseLeft: b.fuseLen - b.fuseElapsed, tOwn: Infinity, queued: !!queued[i], born: b.born,
        accum: b.accum, stop: b.stop, bounce: b.bounce, holder: b.holder, track: null, trackP: null,
      };
      if (info.queued && b.state !== BombState.HELD) {
        info.tOwn = tick + 1;
      } else if (b.state === BombState.HELD || b.type === BombType.TRIGGER) {
        info.tOwn = Infinity;
      } else if (dud) {
        // a dud wakes up when its animation counter passes V323, then the fuse resumes
        const need = (v[323] ?? 120) + 1 - b.anim;
        const wake = need <= 0 ? tick + 1 : tick + stepsUntil(tick, -b.animAcc + (need - 1) * REF, true);
        info.tOwn = wake - 1 + stepsUntil(wake - 1, info.fuseLeft);
      } else if (b.state !== BombState.FLYING) {
        info.tOwn = tick + stepsUntil(tick, info.fuseLeft);
      }
      this.bombs.push(info);
      this.bombBySlot[i] = info;
      if (b.state !== BombState.FLYING && b.state !== BombState.HELD && cell >= 0 && this.bombCell[cell] < 0) this.bombCell[cell] = i;
    }
  }

  /** Predicted motion of a moving bomb (null for bombs that stay put). */
  trackOf(b: BombInfo, withPlayers: boolean): Track | null {
    const moving = b.state === BombState.SLIDING || b.state === BombState.FLYING ||
      (b.state === BombState.REST && b.cell >= 0 && this.conv[b.cell] >= 0);
    if (!moving) return null;
    let t = withPlayers ? b.trackP : b.track;
    if (!t) {
      if (b.state === BombState.FLYING) {
        t = trackFlight(this, b, withPlayers);
      } else {
        const limit = Math.min(b.tOwn, this.tick + 400);
        t = trackSlide(this, b, limit, withPlayers);
      }
      if (withPlayers) b.trackP = t;
      else b.track = t;
    }
    return t;
  }

  private predictHurry(s: GameState): void {
    this.hurryStep.fill(Infinity);
    this.hurryNext = Infinity;
    this.hurryStart = Infinity;
    this.hurryOn = false;
    const depth = s.opts.enclosementDepth;
    if (s.opts.playtime <= 0 || depth <= 0) return;
    const v101 = s.opts.values[101] ?? 60;
    const total = (s.opts.playtime + 1) * 1000;
    const hu = s.hurry;
    const tick = s.tick;
    const started = hu.needsReset === 1 && Math.floor((total - s.elapsedMs) / 1000) <= v101 - 5;
    const h = { x: 0, y: 0, ring: 0, dir: 1 };
    let last: number;
    if (started) {
      this.hurryOn = true;
      h.x = hu.x;
      h.y = hu.y;
      h.ring = hu.ring;
      h.dir = hu.dir;
      last = hu.lastMs;
    } else {
      if (!s.timerRunning) return;
      // first step whose elapsed time satisfies floor((total - elapsed) / 1000) <= V101 - 5
      const thr = total - (v101 - 4) * 1000;
      const n = stepsUntil(tick, thr - s.elapsedMs, true);
      if (n > 60 * 60) return;
      this.hurryStart = tick + n;
      last = s.nowMs + sumDt(tick, n);
    }
    // block j falls in the first step whose clock passes last + 250 j (one block per 250 ms)
    for (let j = 1; j <= 200; j++) {
      if (h.ring >= 2 * depth) break;
      const step = tick + stepsUntil(tick, last + 250 * j - s.nowMs, true);
      if (step - tick > 60 * 60) break;
      if (h.x >= 0 && h.y >= 0 && h.x < W && h.y < H) {
        const c = h.y * W + h.x;
        if (step < this.hurryStep[c]) this.hurryStep[c] = step;
      }
      if (j === 1) this.hurryNext = step;
      if (!spiralStep(h, depth)) break;
    }
  }
}

/** Sum of the durations of the n steps after `tick`. */
export function sumDt(tick: number, n: number): number {
  let sum = Math.floor(n / 3) * 50;
  for (let k = n - (n % 3); k < n; k++) sum += TICK_DT[(tick + k) % 3];
  return sum;
}

/** The enclosement cursor step (enclosure.ts spiralStep). */
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

const cache = new WeakMap<GameState, World>();

/** The shared snapshot of `s` for its current step. */
export function getWorld(s: GameState): World {
  let w = cache.get(s);
  if (!w) {
    w = new World();
    cache.set(s, w);
  }
  if (w.tick !== s.tick || w.round !== s.round) w.build(s);
  return w;
}

/** True if players a and b are on the same side (team play) or the same player. */
export function allied(w: World, a: number, b: number): boolean {
  if (a === b) return true;
  if (!w.teamPlay) return false;
  return w.players[a].team === w.players[b].team;
}
