// Threat checks: could an enemy trap the bot with a single bomb of its own? Each nearby enemy may walk to any
// cell it reaches within a short time and drop a bomb there; every such candidate is tested on its own (one
// bomb at a time, which is what a real opponent can do), with the bot searching for a haven against it.

import { DX, DY, BombType } from '../sim/types.ts';
import { type World, type PlayerInfo, NC, NB, EXIT, MAP_BLANK, allied, manhattan } from './world.ts';
import { Danger, makeSpec, type BombSpec } from './danger.ts';
import { Reach, WARP_STEPS, type ReachOpts, type Waypoint } from './reach.ts';
import { stepsUntil } from './timing.ts';
import { trackDropped } from './motion.ts';
import { botLevel } from './opponents.ts';

/** how far ahead an enemy's trap is feared, by its bot level (0: human): weak bots barely set traps */
const SKILL_HORIZON = [1.3, 0.8, 1.4, 1, 1.5, 1.8];

/** extra delays (steps) at which an enemy drop is also tried */
const LATER = [0, 12, 24];
/** shared per-step work (see World.work) beyond which threat checks stop */
const WORK_CAP = 12000;
/** enemies considered per check, and how far from the bot their drops matter */
const MAX_ENEMIES = 2;
const RADIUS = 6;
/** steps after which an enemy's trigger bomb is assumed to go off (as soon as its owner is clear of it) */
const TRIGGER_FAST = 20;

export interface EnemyDrop {
  cell: number;
  /** step at which the enemy could drop there */
  t: number;
  owner: number;
  flame: number;
  fuseMs: number;
  /** type of the bomb the enemy would drop */
  type: number;
}

export class Threats {
  readonly drops: EnemyDrop[] = [];
  /** scale each enemy's threat horizon by its skill (bots that know their opponents) */
  skillScaled = false;
  /** number of single-drop searches run (statistics) */
  checks = 0;
  private dg = new Danger();
  private r = new Reach();
  private specs: BombSpec[] = [];
  private spec: BombSpec = makeSpec();
  private dist = new Float64Array(NC);
  private q = new Int16Array(NC + 4);
  private order: number[] = [];
  private nearE: number[] = [];

  /**
   * Collect drop candidates of the enemies within `range` (Manhattan) of `around`: every cell an enemy reaches
   * within `horizon` steps (its own cell first). `ready(e)` is the step from which enemy e has a bomb again.
   */
  collect(w: World, me: PlayerInfo, around: number, range: number, horizon: number, ready: (e: PlayerInfo) => number): number {
    const drops = this.drops;
    drops.length = 0;
    // the nearest enemies only (crowded games would otherwise multiply the work)
    const near = this.nearE;
    near.length = 0;
    for (const e of w.players) {
      if (!e.alive || e.immune || e.index === me.index || allied(w, me.index, e.index) || e.cell < 0) continue;
      const md = manhattan(e.cell, around);
      if (md > range) continue;
      near.push(md * 16 + e.index);
    }
    near.sort((a, b) => a - b);
    for (let k = 0; k < Math.min(near.length, MAX_ENEMIES); k++) {
      const e = w.players[near[k] & 15];
      const hz = this.skillScaled ? horizon * (SKILL_HORIZON[botLevel(w.s, e.index)] ?? 1) : horizon;
      if (hz <= 0) continue;
      const t1 = ready(e);
      if (t1 - w.tick > hz) continue;
      const dist = this.dist;
      dist.fill(Infinity);
      const q = this.q;
      let qh = 0;
      let qt = 0;
      dist[e.cell] = 0;
      q[qt++] = e.cell;
      const sp = Math.max(e.speed, 0.5);
      while (qh < qt) {
        const x = q[qh++];
        const t = Math.max(t1, w.tick + Math.max(1, Math.ceil(dist[x] / sp)));
        if (w.warpDest[x] < 0 && w.map[x] === MAP_BLANK && w.bombCell[x] < 0 && manhattan(x, around) <= RADIUS) {
          drops.push({ cell: x, t: Math.ceil(t), owner: e.index, flame: e.flame, fuseMs: e.fuseMs, type: e.bombType });
        }
        for (let d = 0; d < 4; d++) {
          const nb = NB[x * 4 + d];
          if (nb < 0 || dist[nb] !== Infinity || w.map[nb] !== MAP_BLANK || w.bombCell[nb] >= 0) continue;
          // a bomb can be dropped as soon as the anchor has crossed into a cell
          const nd = dist[x] + (x === e.cell ? EXIT[d] - (e.ox * DX[d] + e.oy * DY[d]) : d & 1 ? 40 : 36);
          if (nd / sp > hz) continue;
          dist[nb] = nd;
          q[qt++] = nb;
        }
      }
    }
    return drops.length;
  }

  /**
   * Block every collected candidate cell from the moment an enemy could have dropped a bomb there: a path or a
   * haven through such cells could be cut off. Used to pick robust escape paths.
   */
  contest(dg: Danger, skip: number): void {
    for (const d of this.drops) if (d.cell !== skip) dg.addBlocked(d.cell, d.t + 1, Infinity);
  }

  /**
   * True if the bot keeps a haven with the bombs `base` plus any single collected enemy drop. Candidates are
   * tried nearest to `near` first, at most `maxChecks` of them.
   */
  safeAgainst(w: World, base: BombSpec[], o: ReachOpts, near: number, maxChecks: number, notBefore = -Infinity, outOfTime = false): boolean {
    const n = this.sortDrops(w, near, null, maxChecks);
    for (let k = 0; k < n; k++) {
      // the step's AI budget is gone: give the caller's conservative answer
      if (w.work > WORK_CAP * w.budget) return outOfTime;
      const dr = this.drops[this.order[k] & 4095];
      if (this.deadly(w, base, dr, Math.max(dr.t, notBefore), o, null)) return false;
    }
    return true;
  }

  /**
   * Is following `path` (from the bot's current position `o`) robust? For the most relevant enemy drops, the bot
   * is placed where the path has it when the enemy drops, and must still find a haven from there.
   */
  pathSafe(w: World, base: BombSpec[], o: ReachOpts, path: Waypoint[], maxChecks: number): boolean {
    if (!this.drops.length || path.length < 2) return true;
    const n = this.sortDrops(w, o.cell, path, maxChecks);
    for (let k = 0; k < n; k++) {
      if (w.work > WORK_CAP * w.budget) return false;
      const dr = this.drops[this.order[k] & 4095];
      if (this.deadly(w, base, dr, dr.t, o, path)) return false;
    }
    return true;
  }

  /**
   * Would enemy drop `dr` trap the bot while the enemy itself gets away? Tried at the earliest drop time and a
   * little later (a later drop can still cut us off while giving the enemy the timing it needs).
   */
  private deadly(w: World, base: BombSpec[], dr: EnemyDrop, t0: number, o: ReachOpts, path: Waypoint[] | null): boolean {
    for (let j = 0; j < LATER.length; j++) {
      const t = t0 + LATER[j];
      if (!this.prepare(w, base, dr, t)) return false;
      const po = this.place(w, o, path, t);
      this.checks++;
      if (this.r.run(w, this.dg, po) && this.r.havens > 0) return false;
      // it would trap us; a sane enemy only drops it if it can get away from it itself (a trigger bomb it
      // simply sets off once it is clear)
      if (dr.type === BombType.TRIGGER) this.prepare(w, base, dr, t, false);
      if (this.enemySurvives(w, dr, t)) return true;
      if (this.debug) this.debug(`  drop ${dr.cell % 15},${Math.floor(dr.cell / 15)}@${Math.round(t - w.tick)} traps us but the enemy would die`);
    }
    return false;
  }

  /** Search options for the bot at time t: where `path` has it then (or its current position). */
  private place(w: World, o: ReachOpts, path: Waypoint[] | null, t: number): ReachOpts {
    const po = this.po;
    Object.assign(po, o);
    po.any = true;
    if (!path) return po;
    let i = 0;
    while (i + 1 < path.length && path[i + 1].t <= t) i++;
    // spinning in a warp hole by then (unhurt): the drop meets the bot where it comes out
    if (i + 1 < path.length && path[i + 1].dir === 4 && t >= path[i + 1].t - WARP_STEPS) i++;
    if (i === 0) {
      po.start = Math.max(t, w.tick);
      po.hold = true;
    } else {
      po.cell = path[i].cell;
      po.ox = 0;
      po.oy = 0;
      po.start = Math.max(t, path[i].t);
      po.hold = false;
    }
    return po;
  }
  debug: ((m: string) => void) | null = null;
  private po: ReachOpts = { cell: 0, ox: 0, oy: 0, speed: 1, margin: 0, horizon: 0, useWarps: false, avoid: null, maxSteps: 300 };

  /** Order the candidates by relevance (close to `near` or to the path, and early) into this.order. */
  private sortDrops(w: World, near: number, path: Waypoint[] | null, maxChecks: number): number {
    const drops = this.drops;
    const order = this.order;
    order.length = 0;
    for (let i = 0; i < drops.length; i++) {
      const c = drops[i].cell;
      let d = manhattan(c, near);
      if (path) for (const wp of path) d = Math.min(d, manhattan(c, wp.cell));
      const pri = d * 8 + Math.max(0, drops[i].t - w.tick) / 4;
      order.push(Math.min(4095, Math.round(pri * 4)) * 4096 + i);
    }
    order.sort((a, b) => a - b);
    return Math.min(order.length, maxChecks);
  }

  /** Build this.dg with `base` plus enemy drop `dr` at step t; false if the drop is impossible there. */
  private prepare(w: World, base: BombSpec[], dr: EnemyDrop, t: number, fastTrigger = true): boolean {
    const sp = this.spec;
    sp.slot = -1;
    sp.owner = dr.owner;
    sp.type = BombType.REGULAR;
    sp.flame = dr.flame;
    sp.cell = dr.cell;
    sp.alt = null;
    sp.forever = false;
    sp.blind = false;
    sp.noChain = false;
    sp.from = t;
    sp.tOwn = dr.type === BombType.TRIGGER && fastTrigger ? t + TRIGGER_FAST : t + stepsUntil(t, dr.fuseMs);
    sp.track = trackDropped(w, dr.cell, t, sp.tOwn);
    const specs = this.specs;
    specs.length = 0;
    for (const b of base) {
      // the enemy cannot drop where a bomb already is
      if (!b.track && b.cell === dr.cell && b.from <= t) return false;
      specs.push(b);
    }
    specs.push(sp);
    this.dg.build(w, specs);
    return true;
  }

  /** Can the enemy who drops `dr` at step t (standing in its cell) escape in the current model (this.dg)? */
  private enemySurvives(w: World, dr: EnemyDrop, t: number): boolean {
    const e = w.players[dr.owner];
    const o = this.eo;
    o.cell = dr.cell;
    o.ox = 0;
    o.oy = 0;
    o.speed = e.speed;
    o.margin = 0;
    o.horizon = w.tick + 240;
    o.start = t;
    this.checks++;
    return this.r.run(w, this.dg, o) && this.r.havens > 0;
  }
  private eo: ReachOpts = { cell: 0, ox: 0, oy: 0, speed: 1, margin: 0, horizon: 0, useWarps: true, avoid: null, maxSteps: 300, any: true };
}
