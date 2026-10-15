// Danger model: for every cell, the steps during which it burns ("deadly") and the steps during which it
// cannot be entered ("blocked": walls, bricks until they burn away, bombs until they explode, enclosement
// blocks). Built from the bombs as the bot perceives them plus optional hypothetical bombs, with chain
// reactions resolved in time order (a bomb hit by a flame explodes one step later), bricks that burn away
// (arms of later explosions pass through), visible power-ups that absorb an arm, moving bombs (kicked,
// conveyor, flying) and remote-controlled trigger bombs (which may go off at any moment).
//
// Intervals are half-open in step numbers: [a, b) = steps a .. b-1 (see timing.ts for the step convention).

import { BombType } from '../sim/types.ts';
import { type World, NC, NB, MAP_SOLID, MAP_BRICK } from './world.ts';
import { trackCellAt, type Track } from './motion.ts';

/** A bomb as the planner sees it (a perceived sim bomb or a hypothetical one). */
export interface BombSpec {
  /** sim slot, or -1 for a hypothetical bomb */
  slot: number;
  owner: number;
  type: number;
  flame: number;
  /** cell of a bomb that stays put (when `track` is null) */
  cell: number;
  /** motion prediction of a moving bomb */
  track: Track | null;
  /** alternative motion (players as obstacles): both final positions are treated as dangerous */
  alt: Track | null;
  /** explosion step if nothing else sets it off (Infinity: never on its own) */
  tOwn: number;
  /** step from which a hypothetical bomb exists (dropped later); -Infinity for bombs already there */
  from: number;
  /** remote-controlled trigger bomb: may go off at any moment from tOwn on, its blast never expires */
  forever: boolean;
  /** its blast is not perceived (it still blocks and still sets off other bombs) */
  blind: boolean;
  /** chain reactions setting this bomb off are not perceived */
  noChain: boolean;
}

export function makeSpec(): BombSpec {
  return { slot: -1, owner: -1, type: 0, flame: 1, cell: -1, track: null, alt: null, tOwn: Infinity, from: -Infinity, forever: false, blind: false, noChain: false };
}

/** interval capacity per cell: deadly / blocked lists */
export const KD = 10;
export const KB = 4;
const INF = Infinity;

function addIv(A: Float64Array, B: Float64Array, N: Uint8Array, K: number, c: number, a: number, b: number): void {
  if (!(b > a)) return;
  const base = c * K;
  let n = N[c];
  for (;;) {
    let i = 0;
    while (i < n && B[base + i] < a) i++;
    let j = i;
    let na = a;
    let nb = b;
    while (j < n && A[base + j] <= b) {
      if (A[base + j] < na) na = A[base + j];
      if (B[base + j] > nb) nb = B[base + j];
      j++;
    }
    const removed = j - i;
    if (removed > 0) {
      A[base + i] = na;
      B[base + i] = nb;
      for (let k = j; k < n; k++) {
        A[base + k - removed + 1] = A[base + k];
        B[base + k - removed + 1] = B[base + k];
      }
      N[c] = n - removed + 1;
      return;
    }
    if (n < K) {
      for (let k = n; k > i; k--) {
        A[base + k] = A[base + k - 1];
        B[base + k] = B[base + k - 1];
      }
      A[base + i] = a;
      B[base + i] = b;
      N[c] = n + 1;
      return;
    }
    // full: widen the new interval to swallow its nearest neighbour (conservative) and retry
    const gl = i > 0 ? a - B[base + i - 1] : INF;
    const gr = i < n ? A[base + i] - b : INF;
    if (gl <= gr) a = A[base + i - 1];
    else b = B[base + i];
  }
}

export class Danger {
  /** step number of the state the model was built from (steps t0+1, t0+2, ... are the future) */
  t0 = 0;
  readonly dA = new Float64Array(NC * KD);
  readonly dB = new Float64Array(NC * KD);
  readonly dN = new Uint8Array(NC);
  readonly bA = new Float64Array(NC * KB);
  readonly bB = new Float64Array(NC * KB);
  readonly bN = new Uint8Array(NC);
  /** first step a brick cell can be walked on (Infinity while it is not going to burn) */
  readonly brickOpen = new Float64Array(NC);
  /** first step an explosion arm passes through a brick cell */
  readonly armOpen = new Float64Array(NC);
  /** step at which a visible power-up gets destroyed by an arm (Infinity: survives) */
  readonly powerGone = new Float64Array(NC);
  /** earliest step any explosion covers the cell (Infinity: none) */
  readonly firstBlast = new Float64Array(NC);
  /** let visible power-ups stop explosion arms (optimistic; off for safety checks) */
  powerShield = false;
  /** effective explosion step per spec */
  tExpl = new Float64Array(64);
  forever = new Uint8Array(64);
  specs: BombSpec[] = [];
  /** owner credited for each cell's first blast (-1 none) */
  readonly blastOwner = new Int8Array(NC);
  private staticAt = new Int16Array(NC);
  private staticNext = new Int16Array(64);
  private moving: number[] = [];
  private done = new Uint8Array(64);

  addDeadly(c: number, a: number, b: number): void {
    addIv(this.dA, this.dB, this.dN, KD, c, a, b);
  }

  addBlocked(c: number, a: number, b: number): void {
    addIv(this.bA, this.bB, this.bN, KB, c, a, b);
  }

  /** True if the cell burns during some step in [a, b). */
  deadlyIn(c: number, a: number, b: number): boolean {
    const base = c * KD;
    for (let i = 0; i < this.dN[c]; i++) if (this.dA[base + i] < b && this.dB[base + i] > a) return true;
    return false;
  }

  /** First step >= t at which the cell burns (Infinity if never). */
  nextDeadly(c: number, t: number): number {
    const base = c * KD;
    for (let i = 0; i < this.dN[c]; i++) {
      if (this.dB[base + i] > t) return Math.max(t, this.dA[base + i]);
    }
    return INF;
  }

  blockedIn(c: number, a: number, b: number): boolean {
    const base = c * KB;
    for (let i = 0; i < this.bN[c]; i++) if (this.bA[base + i] < b && this.bB[base + i] > a) return true;
    return false;
  }

  /**
   * Build the model. `specs` are the bombs to consider; `hurry` enables the enclosement blocks.
   */
  build(w: World, specs: BombSpec[], hurry = true): void {
    const t0 = w.tick;
    w.work += 150 + 20 * specs.length;
    this.t0 = t0;
    this.specs = specs;
    this.dN.fill(0);
    this.bN.fill(0);
    this.powerGone.fill(INF);
    this.firstBlast.fill(INF);
    this.blastOwner.fill(-1);
    for (let c = 0; c < NC; c++) {
      const m = w.map[c];
      this.brickOpen[c] = m === MAP_BRICK ? INF : -INF;
      this.armOpen[c] = this.brickOpen[c];
      const fe = w.flameEnd[c];
      if (fe > t0) {
        if (w.flameBrick[c]) {
          this.brickOpen[c] = fe;
          this.armOpen[c] = fe + 1;
        } else {
          this.addDeadly(c, t0 + 1, fe);
        }
      }
      if (hurry) {
        const h = w.hurryStep[c];
        if (h !== INF) this.addDeadly(c, h, INF);
      }
    }
    this.resolve(w, specs, hurry);
    for (let c = 0; c < NC; c++) {
      const m = w.map[c];
      if (m === MAP_SOLID) this.addBlocked(c, -INF, INF);
      else if (m === MAP_BRICK) this.addBlocked(c, -INF, this.brickOpen[c]);
    }
  }

  private resolve(w: World, specs: BombSpec[], hurry: boolean): void {
    const n = specs.length;
    if (this.tExpl.length < n) {
      const sz = Math.max(n, this.tExpl.length * 2);
      this.tExpl = new Float64Array(sz);
      this.forever = new Uint8Array(sz);
      this.staticNext = new Int16Array(sz);
      this.done = new Uint8Array(sz);
    }
    const t = this.tExpl;
    const fv = this.forever;
    this.staticAt.fill(-1);
    this.moving.length = 0;
    for (let i = 0; i < n; i++) {
      const sp = specs[i];
      t[i] = sp.tOwn;
      fv[i] = sp.forever ? 1 : 0;
      this.done[i] = 0;
      if (sp.track) {
        const tr = sp.track;
        if (tr.boom < t[i]) t[i] = tr.boom;
        // a falling enclosement block also sets off a sliding bomb that is in its cell at that moment
        if (hurry && w.s.opts.stompedBombsDetonate) {
          for (let k = 0; k < tr.cells.length; k++) {
            const c = tr.cells[k];
            if (c < 0) continue;
            const h = w.hurryStep[c];
            if (h === INF) continue;
            const a = k === 0 ? (tr.land >= 0 ? tr.land : -INF) : tr.from[k];
            const b = k + 1 < tr.cells.length ? tr.from[k + 1] : INF;
            if (h >= a && h < b && h + 1 < t[i]) {
              t[i] = h + 1;
              fv[i] = 0;
            }
          }
        }
        this.moving.push(i);
      } else if (sp.cell >= 0) {
        this.staticNext[i] = this.staticAt[sp.cell];
        this.staticAt[sp.cell] = i;
        // a falling enclosement block sets off the bomb under it in the next step
        if (hurry && w.hurryStep[sp.cell] + 1 < t[i] && w.s.opts.stompedBombsDetonate) {
          t[i] = w.hurryStep[sp.cell] + 1;
          fv[i] = 0;
        }
      }
    }
    const fs = w.flameSteps;
    for (;;) {
      let best = -1;
      let bt = INF;
      for (let i = 0; i < n; i++) if (!this.done[i] && t[i] < bt) { bt = t[i]; best = i; }
      if (best < 0) break;
      this.done[best] = 1;
      const sp = specs[best];
      const T = bt;
      const forever = fv[best] === 1;
      const end = forever ? INF : T + fs;
      const p1 = sp.track ? trackCellAt(sp.track, T) : sp.cell;
      if (p1 >= 0) this.blast(w, best, p1, T, end, forever);
      if (sp.alt) {
        const p2 = trackCellAt(sp.alt, T);
        if (p2 >= 0 && p2 !== p1) this.blast(w, best, p2, T, end, forever);
      }
    }
    // bombs block their cells until they explode
    for (let i = 0; i < n; i++) {
      const sp = specs[i];
      const te = t[i];
      if (!sp.track) {
        if (sp.cell >= 0) this.addBlocked(sp.cell, sp.from, te);
        continue;
      }
      const tr = sp.track;
      const start = tr.land >= 0 ? tr.land : -INF;
      for (let k = 0; k < tr.cells.length; k++) {
        const c = tr.cells[k];
        if (c < 0) continue;
        const a = k === 0 ? Math.max(start, sp.from) : tr.from[k];
        const b = k + 1 < tr.cells.length ? tr.from[k + 1] + 1 : te;
        if (a < te) this.addBlocked(c, a, Math.min(b, te));
      }
    }
  }

  /** The unexploded bomb (other than `self`) at cell c at step T, or -1. */
  private bombAt(c: number, T: number, self: number): number {
    for (let i = this.staticAt[c]; i >= 0; i = this.staticNext[i]) if (i !== self && !this.done[i] && this.specs[i].from <= T) return i;
    for (const i of this.moving) {
      if (i === self || this.done[i] || this.specs[i].from > T) continue;
      if (trackCellAt(this.specs[i].track!, T) === c) return i;
    }
    return -1;
  }

  private blast(w: World, i: number, p: number, T: number, end: number, forever: boolean): void {
    const sp = this.specs[i];
    const t = this.tExpl;
    const show = !sp.blind;
    if (show) this.burn(p, T, end, sp.owner);
    for (let d = 0; d < 4; d++) {
      let c = p;
      // past a visible power-up the arm is only assumed for safety: it opens no bricks there
      let shielded = false;
      for (let k = 0; k < sp.flame; k++) {
        c = NB[c * 4 + d];
        if (c < 0) break;
        const j = this.bombAt(c, T, i);
        if (j >= 0) {
          if (!this.specs[j].noChain && T + 1 < t[j]) {
            t[j] = T + 1;
            this.forever[j] = forever ? 1 : 0;
          }
          break;
        }
        if (w.hurryStep[c] <= T) break;
        const m = w.map[c];
        if (m === MAP_SOLID) break;
        if (w.power[c] >= 0 && this.powerGone[c] > T) {
          // a visible power-up absorbs the arm, but anybody may pick it up before: for safety the arm goes on
          if (!forever) this.powerGone[c] = T;
          if (this.powerShield) break;
          shielded = true;
        }
        if (m === MAP_BRICK && this.armOpen[c] > T) {
          if (!forever && !shielded) {
            this.brickOpen[c] = T + this.flameStepsOf(w);
            this.armOpen[c] = T + this.flameStepsOf(w) + 1;
          }
          if (show && T < this.firstBlast[c]) this.firstBlast[c] = T;
          break;
        }
        if (show) this.burn(c, T, end, sp.owner);
      }
    }
  }

  private flameStepsOf(w: World): number {
    return w.flameSteps;
  }

  private burn(c: number, a: number, b: number, owner: number): void {
    this.addDeadly(c, a, b);
    if (a < this.firstBlast[c]) {
      this.firstBlast[c] = a;
      this.blastOwner[c] = owner;
    }
  }
}

/** Is `type` a bomb whose owner decides when it explodes? */
export function isTrigger(type: number): boolean {
  return type === BombType.TRIGGER;
}
