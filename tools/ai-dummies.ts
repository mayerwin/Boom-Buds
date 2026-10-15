// Scripted "human-like" opponents for the AI arena: players that are not bots (they never register a bot level,
// so the bots model them as humans) and never attack, to check that the bots go after anyone they meet.
//
//   still   never moves (a camper, an AFK player)
//   wander  walks about at random, changing direction now and then; only avoids stepping into visible flames
//   flee    walks about like `wander`, keeps out of every bomb's blast and runs from bombs with perfect
//           knowledge (a careful player who never attacks)

import { BombState, BombType, type GameState } from '../src/game/sim/types.ts';
import { pxToCx, pyToCy } from '../src/game/sim/map.ts';
import { IN_UP, IN_RIGHT, IN_DOWN, IN_LEFT } from '../src/engine/input.ts';
import { World, NB, NC, MAP_BLANK } from '../src/game/ai/world.ts';
import { Danger, makeSpec, type BombSpec } from '../src/game/ai/danger.ts';
import { Reach, dirBetween, type ReachOpts } from '../src/game/ai/reach.ts';
import { TRIGGER_GRACE } from '../src/game/ai/perception.ts';
import { stepsUntil } from '../src/game/ai/timing.ts';

export type DummyKind = 'still' | 'wander' | 'flee';
export const DUMMY_KINDS: DummyKind[] = ['still', 'wander', 'flee'];

const DIR_BITS = [IN_UP, IN_RIGHT, IN_DOWN, IN_LEFT];

export class Dummy {
  private rng: number;
  private dir = -1;
  private until = 0;
  private w = new World();
  private dg = new Danger();
  private r = new Reach();
  private pool: BombSpec[] = [];
  private specs: BombSpec[] = [];
  private o: ReachOpts = { cell: 0, ox: 0, oy: 0, speed: 1, margin: 1, horizon: 0, useWarps: true, avoid: null, maxSteps: 300 };

  readonly kind: DummyKind;

  constructor(kind: DummyKind, seed: number) {
    this.kind = kind;
    this.rng = (seed >>> 0) || 1;
  }

  private rand(n: number): number {
    // xorshift32
    let x = this.rng;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.rng = x;
    return x % n;
  }

  think(s: GameState, index: number): number {
    const p = s.players[index];
    if (!p.alive || p.dying || this.kind === 'still') return 0;
    const careful = this.kind === 'flee';
    let w: World | null = null;
    if (careful && s.bombs.some((b) => b.active)) {
      w = this.w;
      w.build(s);
      this.build(w, index);
      const me = w.players[index];
      if (me.cell >= 0) {
        const o = this.o;
        o.cell = me.cell;
        o.ox = me.ox;
        o.oy = me.oy;
        o.speed = me.speed;
        o.horizon = w.tick + 240;
        if (this.r.run(w, this.dg, o) && this.r.havens > 0 && this.r.startHi < w.tick + 240) return this.flee(w, me.cell);
      }
    }
    return this.wander(s, index, w);
  }

  /** Run along the quickest way to safety. */
  private flee(w: World, cell: number): number {
    const r = this.r;
    let best = -1;
    for (let c = 0; c < NC; c++) if (r.haven[c] !== Infinity && (best < 0 || r.haven[c] < r.haven[best])) best = c;
    if (best < 0 || best === cell) return 0;
    const path = r.path(r.havenState[best]);
    for (let k = 1; k < path.length; k++) {
      if (path[k].cell === cell) continue;
      // wait where the path waits (the next cell is not safe yet)
      if (path[k].t - w.tick > 14) return 0;
      const d = dirBetween(cell, path[k].cell);
      return d >= 0 ? DIR_BITS[d] : 0;
    }
    return 0;
  }

  /** Keep a direction for a while, turn when blocked or at random; never into flames (or blasts when careful). */
  private wander(s: GameState, index: number, w: World | null): number {
    const p = s.players[index];
    const cx = pxToCx(p.x);
    const cy = pyToCy(p.y);
    if (cx < 0 || cy < 0 || cx >= 15 || cy >= 11) return 0;
    const cell = cy * 15 + cx;
    const open = (d: number): boolean => {
      const n = NB[cell * 4 + d];
      if (n < 0 || s.map[n] !== MAP_BLANK || s.flames[n].state !== 0) return false;
      for (const b of s.bombs) if (b.active && pxToCx(b.x) + pyToCy(b.y) * 15 === n) return false;
      if (w && this.dg.firstBlast[n] !== Infinity) return false;
      return true;
    };
    if (this.dir < 0 || s.tick >= this.until || !open(this.dir)) {
      const opts: number[] = [];
      for (let d = 0; d < 4; d++) if (open(d)) opts.push(d);
      if (!opts.length) {
        this.dir = -1;
        return 0;
      }
      this.dir = opts[this.rand(opts.length)];
      this.until = s.tick + 20 + this.rand(60);
    }
    // a pause now and then, like a player looking around
    if (this.rand(12) === 0) return 0;
    return DIR_BITS[this.dir];
  }

  /** Every bomb as it really is (no reaction delay); other players' trigger bombs may go off at any moment. */
  private build(w: World, me: number): void {
    const specs = this.specs;
    specs.length = 0;
    let used = 0;
    for (const b of w.bombs) {
      if (b.state === BombState.HELD) continue;
      if (used >= this.pool.length) this.pool.push(makeSpec());
      const sp = this.pool[used++];
      sp.slot = b.slot;
      sp.owner = b.owner;
      sp.type = b.type;
      sp.flame = b.flame;
      sp.cell = b.cell;
      sp.track = null;
      sp.alt = null;
      sp.tOwn = b.tOwn;
      sp.from = -Infinity;
      sp.forever = false;
      sp.blind = false;
      sp.noChain = false;
      if (b.state === BombState.FLYING || b.state === BombState.SLIDING || (b.cell >= 0 && w.conv[b.cell] >= 0)) {
        sp.track = w.trackOf(b, false);
        sp.alt = w.trackOf(b, true);
        if (b.state === BombState.FLYING && sp.track) {
          const land = sp.track.land;
          sp.tOwn = land === Infinity ? Infinity : land - 1 + stepsUntil(land - 1, b.fuseLeft);
        }
      }
      if (b.type === BombType.TRIGGER && !b.queued) {
        if (b.owner === me) {
          sp.tOwn = Infinity;
        } else {
          sp.tOwn = w.tick + 1 + TRIGGER_GRACE;
          sp.forever = true;
        }
      }
      if (sp.cell < 0 && !sp.track) continue;
      specs.push(sp);
    }
    this.dg.build(w, specs);
  }
}
