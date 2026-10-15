// Time-expanded reachability: Safe Interval Path Planning (SIPP) on the 15 x 11 grid. Every cell has a few
// safe intervals (gaps between its unsafe intervals from the danger model); a search state is (cell, safe
// interval) labelled with the earliest time the bot's anchor can be in that cell inside that interval.
// Waiting is allowed inside a safe interval, so the earliest arrival is optimal. Movement times come from
// the player's real speed (skates, diseases, conveyors) and the pixel distances of player.md §6.2, with the
// corner cutting of the lane alignment (a turn costs only the distance to the next cell boundary).
//
// Continuous time convention: the state passed to think() is at time t0 = s.tick; the movement of step k
// happens during (k-1, k]. A step interval [a, b) of the danger model therefore forbids the anchor to be in
// the cell during the continuous interval [a - 1, b - 1], widened by the safety margin.

import { DX, DY } from '../sim/types.ts';
import { type World, NC, NB, EXIT, ENTER, FULL } from './world.ts';
import { type Danger, KD, KB } from './danger.ts';

/** safe intervals kept per cell */
const K = 8;
const NS = NC * K;
/** id of the start state: the start cell with its deadly-only interval (a bomb under the bot does not block it) */
const SS = NS;
const EPS = 1e-3;
const INF = Infinity;
/** steps a warp takes (spin out + spin in, 2 x 9 animation frames of 50 ms, plus slack) */
export const WARP_STEPS = 56;
/**
 * steps after the trigger from which the bomber can be hurt again at the far end: depending on the animation
 * phase the spin is over 51 to 53 steps after the step that fires it (measured), earlier than WARP_STEPS
 */
export const WARP_SAFE = 51;
/** steps the bot may stand on a conveyor before it is carried away */
const CONV_WAIT = 6;

/** entry codes stored per state besides directions 0..3 */
export const ED_START = 4;
export const ED_CENTER = 5;

export interface ReachOpts {
  cell: number;
  /** anchor offsets inside the start cell */
  ox: number;
  oy: number;
  /** pixels per step */
  speed: number;
  /** safety margin in steps around unsafe intervals */
  margin: number;
  /** absolute step until which a cell must stay safe to count as a haven */
  horizon: number;
  useWarps: boolean;
  /** cells never to enter (e.g. disease power-ups), or null */
  avoid: Uint8Array | null;
  /** do not expand states later than t0 + maxSteps */
  maxSteps: number;
  /** time the search starts in `cell` (default: now) */
  start?: number;
  /** the player stands still in `cell` from now until `start` (reaction delay) instead of arriving there at `start` */
  hold?: boolean;
  /** only find out whether a haven exists: stop at the first one (results are partial) */
  any?: boolean;
}

export interface Waypoint {
  cell: number;
  /** continuous time at which the anchor enters the cell */
  t: number;
  /** direction moved to enter it (-1 for the start, 4 for a warp exit) */
  dir: number;
}

export class Reach {
  t0 = 0;
  /** safe intervals per cell: open (lo, hi), continuous time; slot SS is the start interval */
  readonly lo = new Float64Array(NS + 1);
  readonly hi = new Float64Array(NS + 1);
  readonly n = new Uint8Array(NC);
  readonly g = new Float64Array(NS + 1);
  readonly par = new Int32Array(NS + 1);
  readonly ed = new Int8Array(NS + 1);
  /** warp cell passed to reach a state (-1 none) */
  readonly via = new Int16Array(NS + 1);
  /** time the warp hole was entered (for states reached through one) */
  readonly viaT = new Float64Array(NS + 1);
  readonly closed = new Uint8Array(NS + 1);
  /** earliest arrival per cell in any interval / in a haven interval (safe until the horizon) */
  readonly arrive = new Float64Array(NC);
  readonly haven = new Float64Array(NC);
  /** search state of those arrivals (-1 none) */
  readonly havenState = new Int32Array(NC);
  readonly anyState = new Int32Array(NC);
  startCell = -1;
  /** the start cell stays safe until this time (when the bot must have left it) */
  startHi = INF;
  havens = 0;
  /** number of states expanded (statistics) */
  expanded = 0;
  private heap = new Int32Array(NS * 4 + 8);
  private heapN = 0;
  private opts!: ReachOpts;
  private w!: World;

  /** Safe-interval end of a state (when the bot must have left that cell). */
  hiOf(s: number): number {
    return this.hi[s];
  }

  stateCell(s: number): number {
    return s === SS ? this.startCell : (s / K) | 0;
  }

  /** Run the search. Returns false if the bot is already doomed in its cell under this margin. */
  run(w: World, dg: Danger, o: ReachOpts): boolean {
    this.w = w;
    this.opts = o;
    const t0 = w.tick;
    this.t0 = t0;
    const m = o.margin;
    const tMax = t0 + o.maxSteps;
    this.arrive.fill(INF);
    this.haven.fill(INF);
    this.havenState.fill(-1);
    this.anyState.fill(-1);
    this.havens = 0;
    this.expanded = 0;
    this.startCell = o.cell;
    this.startHi = -INF;
    this.g.fill(INF);
    this.closed.fill(0);
    for (let c = 0; c < NC; c++) this.buildGaps(dg, c, true, m, t0, tMax, c * K);
    const sc = o.cell;
    if (sc < 0) return false;
    // start interval from the deadly intervals only (the bot may stand on a bomb)
    const save = this.n[sc];
    this.buildGaps(dg, sc, false, m, t0, tMax, sc * K);
    let found = false;
    const tS = o.start !== undefined ? o.start : t0;
    const tFrom = o.hold ? t0 : tS;
    for (let j = 0; j < this.n[sc]; j++) {
      if (this.lo[sc * K + j] < tFrom && this.hi[sc * K + j] > tS) {
        this.lo[SS] = this.lo[sc * K + j];
        this.hi[SS] = this.hi[sc * K + j];
        found = true;
        break;
      }
    }
    this.buildGaps(dg, sc, true, m, t0, tMax, sc * K);
    void save;
    if (!found) return false;
    this.startHi = this.hi[SS];
    this.g[SS] = tS;
    this.par[SS] = -1;
    this.ed[SS] = ED_START;
    this.via[SS] = -1;
    this.heapN = 0;
    this.push(SS);
    // standing in a warp hole off its centre: walking to the centre triggers it
    if (o.useWarps && w.warpDest[sc] >= 0 && (o.ox !== 0 || o.oy !== 0)) {
      const dist = Math.max(Math.abs(o.ox), Math.abs(o.oy)) - 1;
      const tTrig = tS + dist / Math.max(o.speed, 0.05);
      if (tTrig < this.startHi) this.relaxWarp(SS, sc, w.warpDest[sc], tTrig);
    }
    const avoid = o.avoid;
    w.work += 40;
    while (this.heapN > 0) {
      const s = this.pop();
      if (this.closed[s]) continue;
      this.closed[s] = 1;
      this.expanded++;
      w.work++;
      const c = this.stateCell(s);
      const gs = this.g[s];
      if (gs < this.arrive[c]) {
        this.arrive[c] = gs;
        this.anyState[c] = s;
      }
      const hiS = this.hi[s];
      // a conveyor carries a standing player along unless its belt runs into a wall
      const cvd = w.conv[c];
      const nc0 = cvd >= 0 ? NB[c * 4 + cvd] : -1;
      const onConv = cvd >= 0 && nc0 >= 0 && w.map[nc0] === 0;
      if (hiS >= o.horizon && !onConv && gs < this.haven[c]) {
        if (this.haven[c] === INF) this.havens++;
        this.haven[c] = gs;
        this.havenState[c] = s;
        if (o.any) break;
      }
      if (gs > tMax) continue;
      const e = this.ed[s];
      for (let d = 0; d < 4; d++) {
        const nc = NB[c * 4 + d];
        if (nc < 0) continue;
        if (avoid !== null && avoid[nc]) continue;
        if (w.tramp[nc]) continue;
        let D: number;
        // walking across a warp hole's centre sets it off: from inside one, only directions that need not
        // cross the centre leave it on foot (the warp itself is the start state's warp transition)
        if (e === ED_START && w.warpDest[c] >= 0 && o.ox * DX[d] + o.oy * DY[d] < 0) continue;
        if (e === ED_START) D = EXIT[d] - (o.ox * DX[d] + o.oy * DY[d]);
        else if (e === ED_CENTER) D = EXIT[d];
        else if (e === d) D = FULL[d];
        else if (e === ((d + 2) & 3)) D = 1;
        else D = EXIT[d];
        let u = o.speed;
        const cd = w.conv[c];
        if (cd >= 0) {
          if (cd === d) u += w.convSpeed;
          else if (cd === ((d + 2) & 3)) u -= w.convSpeed;
        }
        if (u <= 0.05) continue;
        const tReady = gs + D / u;
        if (tReady >= hiS) continue;
        const warp = o.useWarps ? w.warpDest[nc] : -1;
        const nb = nc * K;
        for (let j = 0; j < this.n[nc]; j++) {
          const lo2 = this.lo[nb + j];
          const hi2 = this.hi[nb + j];
          if (hi2 <= tReady) continue;
          const tx = tReady > lo2 + EPS ? tReady : lo2 + EPS;
          if (tx >= hiS) break;
          if (tx >= hi2) continue;
          if (onConv && tx > tReady + CONV_WAIT) break;
          if (warp >= 0) {
            this.warpEdge(s, nc, d, tx, tReady, hiS, hi2, warp);
            continue;
          }
          const ns = nb + j;
          if (tx < this.g[ns]) {
            this.g[ns] = tx;
            this.par[ns] = s;
            this.ed[ns] = d;
            this.via[ns] = -1;
            this.push(ns);
          }
        }
      }
    }
    return true;
  }

  /** Warp triggered at tTrig from state s: reappear at the destination's centre after the spin. */
  private relaxWarp(s: number, wc: number, dest: number, tTrig: number): void {
    const db = dest * K;
    const tD = tTrig + WARP_STEPS;
    for (let j = 0; j < this.n[dest]; j++) {
      // safe from the soonest end of the spin until the bot moves on
      if (this.lo[db + j] >= tTrig + WARP_SAFE || this.hi[db + j] <= tD) continue;
      const ns = db + j;
      if (tD < this.g[ns]) {
        this.g[ns] = tD;
        this.par[ns] = s;
        this.ed[ns] = ED_CENTER;
        this.via[ns] = wc;
        this.viaT[ns] = tTrig;
        this.push(ns);
      }
    }
  }

  /** Entering a warp hole: spin (invulnerable) and reappear at the destination's centre. */
  private warpEdge(s: number, wc: number, d: number, tx: number, tReady: number, hiS: number, hiW: number, dest: number): void {
    const toCenter = (ENTER[d] - 1) / Math.max(this.opts.speed, 0.05);
    const db = dest * K;
    for (let j = 0; j < this.n[dest]; j++) {
      const lo3 = this.lo[db + j];
      const hi3 = this.hi[db + j];
      // the warp fires one pixel before the centre; the far end must be safe from the soonest end of the spin
      let tT = tx + toCenter;
      if (tT + WARP_SAFE <= lo3 + EPS) tT = lo3 + EPS - WARP_SAFE;
      const tD = tT + WARP_STEPS;
      if (tD >= hi3) continue;
      const tx2 = tT - toCenter;
      if (tx2 < tReady - EPS || tx2 >= hiS || tT >= hiW) continue;
      const ns = db + j;
      if (tD < this.g[ns]) {
        this.g[ns] = tD;
        this.par[ns] = s;
        this.ed[ns] = ED_CENTER;
        this.via[ns] = wc;
        this.viaT[ns] = tx2;
        this.push(ns);
      }
    }
  }

  /** Safe gaps of cell c (deadly intervals, plus blocked ones if `withBlocked`) written at `base`. */
  private buildGaps(dg: Danger, c: number, withBlocked: boolean, m: number, t0: number, tMax: number, base: number): void {
    let k = 0;
    let cur = -INF;
    let i = 0;
    let j = 0;
    const n1 = dg.dN[c];
    const n2 = withBlocked ? dg.bN[c] : 0;
    const d1 = c * KD;
    const d2 = c * KB;
    while (i < n1 || j < n2) {
      const ta = i < n1 ? dg.dA[d1 + i] : INF;
      const tb = j < n2 ? dg.bA[d2 + j] : INF;
      let a: number;
      let b: number;
      if (ta <= tb) {
        a = ta;
        b = dg.dB[d1 + i];
        i++;
      } else {
        a = tb;
        b = dg.bB[d2 + j];
        j++;
      }
      const ua = a === -INF ? -INF : a - 1 - m;
      const ub = b === INF ? INF : b - 1 + m;
      if (ua > cur) {
        if (ua > t0 - 1 && k < K) {
          this.lo[base + k] = cur;
          this.hi[base + k] = ua;
          k++;
        }
        if (ua > tMax) {
          cur = INF;
          break;
        }
      }
      if (ub > cur) cur = ub;
      if (cur === INF) break;
    }
    if (cur !== INF && k < K) {
      this.lo[base + k] = cur;
      this.hi[base + k] = INF;
      k++;
    }
    this.n[c] = k;
  }

  /** Waypoints from the start to search state `s` (inclusive). */
  path(s: number): Waypoint[] {
    const out: Waypoint[] = [];
    while (s >= 0) {
      const c = this.stateCell(s);
      const e = this.ed[s];
      out.push({ cell: c, t: this.g[s], dir: e === ED_START ? -1 : e === ED_CENTER ? 4 : e });
      if (this.via[s] >= 0) {
        // the warp hole entered just before the teleport (unless the bot already stands in it)
        const p = this.par[s];
        const from = p >= 0 ? this.stateCell(p) : c;
        if (from !== this.via[s]) out.push({ cell: this.via[s], t: this.viaT[s], dir: dirBetween(from, this.via[s]) });
      }
      s = this.par[s];
    }
    out.reverse();
    return out;
  }

  private push(s: number): void {
    const h = this.heap;
    let i = this.heapN++;
    const gs = this.g[s];
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.g[h[p]] <= gs) break;
      h[i] = h[p];
      i = p;
    }
    h[i] = s;
  }

  private pop(): number {
    const h = this.heap;
    const top = h[0];
    const last = h[--this.heapN];
    const n = this.heapN;
    const gl = this.g[last];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && this.g[h[c + 1]] < this.g[h[c]]) c++;
      if (this.g[h[c]] >= gl) break;
      h[i] = h[c];
      i = c;
    }
    h[i] = last;
    return top;
  }
}

/** Direction from cell a to an adjacent cell b (-1 if not adjacent). */
export function dirBetween(a: number, b: number): number {
  for (let d = 0; d < 4; d++) if (NB[a * 4 + d] === b) return d;
  return -1;
}
