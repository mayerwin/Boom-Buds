// One computer player: perception -> danger model -> time-expanded search -> goal choice -> input bits.
//
// Every step the bot rebuilds its danger model (cheap) and checks that the current plan is still safe; it
// re-plans periodically (level dependent), when its perception changes or when the plan breaks. A plan is a
// SIPP path to a target cell plus an action to perform there (drop a bomb, kick, punch...). Dropping a bomb
// is always verified by re-running the search with the bomb added (escape must exist), and offensive drops
// by running the search for the threatened enemies (no escape = trap).

import { DX, DY, BombState, BombType, type GameState } from '../sim/types.ts';
import { IN_UP, IN_RIGHT, IN_DOWN, IN_LEFT, IN_ACT1, IN_ACT2 } from '../../engine/input.ts';
import { getWorld, allied, manhattan, NC, NB, EXIT, ENTER, MAP_BLANK, MAP_SOLID, MAP_BRICK, type World, type PlayerInfo, type BombInfo } from './world.ts';
import { Danger, makeSpec, KD, KB, type BombSpec } from './danger.ts';
import { Reach, dirBetween, WARP_STEPS, WARP_SAFE, type Waypoint, type ReachOpts } from './reach.ts';
import { Perception, TRIGGER_GRACE } from './perception.ts';
import { profileFor, type Profile } from './profile.ts';
import { Rng } from './rng.ts';
import { stepsUntil, msToSteps } from './timing.ts';
import { powerValue, isBadPower } from './values.ts';
import { Threats } from './threat.ts';
import { trackDropped, trackSlide, trackFlight } from './motion.ts';
import { registerBot, reactSteps, kicksBombs } from './opponents.ts';
import { A_WARP_OUT } from '../sim/players.ts';

const DIR_BITS = [IN_UP, IN_RIGHT, IN_DOWN, IN_LEFT];
const INF = Infinity;
/** a haven must stay safe this many steps ahead (every regular bomb on the field has burnt out by then) */
const HORIZON = 240;
/** search window */
const MAX_STEPS = 420;
/** utility time constant: a goal this many steps away is worth half */
const TAU = 55;
/**
 * Shared per-step AI work (all bots; search states expanded plus danger builds, see World.work) after which
 * non-urgent re-plans wait and plans skip the optional deep analysis. Counted in work units rather than wall
 * time so that bots stay deterministic; roughly 10 000 - 15 000 units take 1 ms on a desktop.
 */
const BUSY_WORK = 13000;
const LIGHT_WORK = 8000;
const HARD_WORK = 17000;
/** shared per-step work beyond which optional deep analysis (trap refinement, combos) stops; the rest waits for later steps */
const OPT_WORK = 9000;
/** last part of a timed round (enclosement closing): L4/L5 stop waiting and force the issue */
const LATE_MS = 60000;
/** own trigger bombs older than this are set off when safe (mines that nobody walks into) */
const MINE_STEPS = 360;
/** a bot that has not moved for this many steps without a reason starts wandering */
const IDLE_STEPS = 150;
/** steps of detour worth avoiding one path cell an enemy could bomb first */
const RISK_W = 22;
/** a trampoline bounce, from the step that sets it off to the landing (measured; nothing hurts the bomber meanwhile) */
const TRAMP_STEPS = 84;
/** a cell to land on must stay out of blasts this long after the landing (time to walk away from the next one) */
const CALM_STEPS = 30;

const ACT_NONE = 0;
const ACT_BOMB = 1;
/** walk into the adjacent bomb in plan.dir (the kicker kicks it away) */
const ACT_KICK = 2;
/** face the adjacent bomb in plan.dir and punch it (boxing glove) */
const ACT_PUNCH = 3;
/** steps a bomb landing on a head stuns that player (16 animation units of 50 ms) */
const STUN_STEPS = 48;

const G_IDLE = 0;
const G_FLEE = 1;
const G_POWER = 2;
const G_BRICK = 3;
const G_ATTACK = 4;
const G_SURVIVE = 5;
const G_WANDER = 6;

interface Plan {
  path: Waypoint[];
  idx: number;
  target: number;
  action: number;
  goal: number;
  made: number;
  value: number;
  /** built on a danger model other than the bot's base model: keep its timing exactly */
  strict: boolean;
  /** direction of a kick action */
  dir: number;
  /** made assuming enemy trigger bombs need a moment to go off (crossing mines) */
  relaxed?: boolean;
}

interface DropEval {
  ok: boolean;
  bricks: number;
  powerLoss: number;
  kills: number;
  pressure: number;
  /** escape state in reach2 */
  escape: number;
  /** reach2 state of a cell where a second bomb completes a trap, or -1 */
  combo: number;
  /** search that holds `escape` */
  escR: Reach | null;
  /** certain kills (no escape even with an instant reaction) */
  sure?: number;
  /** relative squeeze of the most affected enemy's safe room (0..1) */
  rel?: number;
}

export class Bot {
  readonly prof: Profile;
  private rng: Rng;
  private per = new Perception();
  private dg = new Danger();
  private dg2 = new Danger();
  private reach = new Reach();
  private reach2 = new Reach();
  private reachE = new Reach();
  /** single enemy bombs that could trap the bot (threat model) */
  private threats = new Threats();
  private readyFn = (e: PlayerInfo): number => this.enemyReady(e);
  private plan: Plan | null = null;
  private nextPlan = 0;
  private planVersion = -1;
  private prev = 0;
  private me = 0;
  private hyp: BombSpec = makeSpec();
  private specs2: BombSpec[] = [];
  private failed = new Float64Array(NC);
  private brickGain = new Float32Array(NC);
  private powerLoss = new Float32Array(NC);
  private attackVal = new Float32Array(NC);
  private noise = new Float32Array(NC);
  private noiseAt = -1;
  private avoid = new Uint8Array(NC);
  private stillTicks = 0;
  /** step of the last position change (idle bots must not park for long) */
  private movedAt = 0;
  private lastX = -1;
  private lastY = -1;
  /** a drop decided at this tick for this cell */
  private dropCell = -1;
  private act2 = false;
  private ownReturn = INF;
  private world: World | null = null;
  /** optional debug sink (tools only) */
  debug: ((msg: string) => void) | null = null;
  /** debug counters (drops by reason, plans by mode) */
  readonly stats: Record<string, number> = {};
  private nextTrigger = 0;
  /** plan without the optional deep analysis (time budget exhausted) */
  private light = false;
  /** step of our last drop (pressure clock) */
  private lastDrop = 0;
  /** in a warp spin (counts each warp once) */
  private warping = false;
  /** cell where we have made up our mind to lay a bomb (-1 none), and the step the button gets pressed (decision lag) */
  private pendCell = -1;
  private pendAt = 0;
  /** judging a bomb already decided on once more, after the lag: the decision itself is not made again (no new dice) */
  private recheck = false;

  constructor(level: number, seed: number) {
    this.prof = profileFor(level);
    this.rng = new Rng(seed);
    this.threats.skillScaled = this.prof.foeRead >= 0.8;
  }

  reset(): void {
    this.lastDrop = 0;
    this.per.reset();
    this.plan = null;
    this.nextPlan = 0;
    this.prev = 0;
    this.failed.fill(0);
    this.noiseAt = -1;
    this.stillTicks = 0;
    this.movedAt = -1;
    this.dropCell = -1;
    this.pendCell = -1;
  }

  think(s: GameState, index: number): number {
    registerBot(s, index, this.prof.level);
    return this.decide(getWorld(s), index);
  }

  /** Steps enemy e is assumed to stand still after a bomb appears next to it (judging traps). */
  private foeDelay(w: World, e: PlayerInfo): number {
    return Math.max(this.prof.assumeReact, Math.round(this.prof.foeRead * reactSteps(w.s, e.index)));
  }

  private decide(w: World, index: number): number {
    this.world = w;
    this.me = index;
    const me = w.players[index];
    if (!me.alive || me.cell < 0) {
      this.plan = null;
      this.prev = 0;
      return 0;
    }
    this.per.update(w, index, this.prof, this.rng);
    // warp holes taken (statistics): as planned, or stumbled into
    if (me.anim === A_WARP_OUT && !this.warping) this.count(this.plan?.path[this.plan.idx + 1]?.dir === 4 ? 'warp' : 'warpStray');
    this.warping = me.anim === A_WARP_OUT;
    if (me.busy || this.movedAt < 0) this.movedAt = w.tick;
    if (me.busy) {
      // during the round-start freeze, plan ahead once (staggered) so the first input step stays cheap
      if (w.s.pl.roundFreezeMs > 0 && !this.plan && (w.tick + index * 5) % 12 === 0 && w.work < BUSY_WORK * w.budget) {
        this.dg.build(w, this.per.specs);
        this.replan(w, me);
      }
      this.prev = 0;
      return 0;
    }
    this.dg.build(w, this.per.specs);
    this.ownReturn = INF;
    for (let i = 0; i < this.per.specs.length; i++) {
      const sp = this.per.specs[i];
      if (sp.owner === index && this.dg.tExpl[i] < this.ownReturn) this.ownReturn = this.dg.tExpl[i];
    }
    this.trackStill(me);
    this.dropCell = -1;
    this.act2 = false;
    // a bomb decided on lapses when we leave its cell or do not get round to it
    if (this.pendCell >= 0 && (me.cell !== this.pendCell || w.tick > this.pendAt + 30)) this.pendCell = -1;
    // a changed perception only schedules a re-plan (staggered between bots); a broken plan re-plans now
    if (this.per.version !== this.planVersion) {
      this.planVersion = this.per.version;
      this.nextPlan = Math.min(this.nextPlan, w.tick + (index & 1));
    }
    const urgent = !this.plan || !this.planOk(w, me);
    if ((urgent && w.work < HARD_WORK * w.budget) || (w.tick >= this.nextPlan && w.work < BUSY_WORK * w.budget)) {
      // when the step's AI budget is used up, plan without the optional deep analysis
      this.light = w.work >= LIGHT_WORK * w.budget;
      this.replan(w, me);
    }
    let bits = this.steer(w, me);
    if (!(bits & (IN_UP | IN_RIGHT | IN_DOWN | IN_LEFT)) && w.tick - this.movedAt > IDLE_STEPS * 2) bits |= this.fidget(w, me);
    if (me.trigger && w.tick >= this.nextTrigger && this.dropCell < 0 && !(this.prev & IN_ACT2)) {
      this.nextTrigger = w.tick + (this.prof.level >= 4 ? 2 : 6);
      if (this.shouldTrigger(w, me)) {
        // detonate, and follow the escape computed for the state after the explosion
        this.act2 = true;
        const s = this.bestHaven(w, me, this.reach2);
        if (s >= 0) {
          this.setPlan(w, this.reach2, s, this.reach2.stateCell(s), ACT_NONE, G_FLEE, 0);
          bits = this.steer(w, me);
        }
      }
    }
    if (this.dropCell >= 0 && this.dropCell === me.cell && w.bombCell[me.cell] < 0 && !(this.prev & IN_ACT1)) {
      // the bomb lands in the anchor cell after this step's movement: do not cross a boundary now
      const d = dirOf(bits);
      if (d >= 0) {
        const dist = EXIT[d] - (me.ox * DX[d] + me.oy * DY[d]);
        if (dist <= me.speed + 2) bits &= ~(IN_UP | IN_RIGHT | IN_DOWN | IN_LEFT);
      }
      bits |= IN_ACT1;
      this.lastDrop = w.tick;
      this.nextPlan = 0;
    }
    if (this.act2 && !(this.prev & IN_ACT2)) {
      bits |= IN_ACT2;
      this.nextPlan = 0;
    }
    this.prev = bits;
    return bits;
  }

  // ---------------------------------------------------------------------------------------------------
  // planning

  /** Search options for player p as it stands (warp holes included: fixed destinations, so they are planned exactly). */
  private opts(w: World, p: PlayerInfo, margin: number, avoid: Uint8Array | null): ReachOpts {
    return { cell: p.cell, ox: p.ox, oy: p.oy, speed: p.speed, margin, horizon: w.tick + HORIZON, useWarps: true, avoid, maxSteps: MAX_STEPS };
  }

  private buildAvoid(w: World, me: PlayerInfo): void {
    const a = this.avoid;
    for (let c = 0; c < NC; c++) {
      let v = 0;
      const pt = w.power[c];
      if (pt >= 0 && isBadPower(pt, this.prof)) v = 1;
      a[c] = v;
    }
    a[me.cell] = 0;
  }

  private replan(w: World, me: PlayerInfo): void {
    const t0 = w.tick;
    const prof = this.prof;
    this.nextPlan = t0 + prof.replanSteps;
    this.planVersion = this.per.version;
    if (this.noiseAt < 0 || t0 - this.noiseAt > 120) {
      this.noiseAt = t0;
      for (let c = 0; c < NC; c++) this.noise[c] = 1 + prof.noise * (this.rng.next() - 0.5) * 2;
    }
    this.buildAvoid(w, me);
    const r = this.reach;
    let ok = r.run(w, this.dg, this.opts(w, me, prof.margin, this.avoid)) && r.havens > 0;
    if (!ok) ok = r.run(w, this.dg, this.opts(w, me, 0, this.avoid)) && r.havens > 0;
    if (!ok) ok = r.run(w, this.dg, this.opts(w, me, 0, null)) && r.havens > 0;
    if (!ok && this.relaxTriggers(w, me)) ok = r.run(w, this.dg2, this.opts(w, me, 0, null)) && r.havens > 0;
    if (!ok) {
      this.survive(w, me);
      return;
    }
    if (r.startHi < t0 + HORIZON) {
      if (this.strikeNow(w, me)) return;
      // in danger: keep heading for the current goal if it is still a haven (its path leaves the danger in
      // time), otherwise flee; switching back and forth between the two is how bots die
      const p = this.plan;
      if (p && p.goal !== G_FLEE && p.goal !== G_SURVIVE && p.goal !== G_WANDER && p.target !== me.cell && r.haven[p.target] !== INF &&
        (!prof.threatPlan || this.routeSafe(w, me, r, r.havenState[p.target]))) {
        this.setPlan(w, r, r.havenState[p.target], p.target, p.action, p.goal, p.value);
        return;
      }
      this.flee(w, me);
      return;
    }
    if (prof.threatPlan && !(prof.late > 0 && this.endgame(w)) && !this.positionSafe(w, me, me.cell, t0)) {
      // a nearby enemy could trap us here with one bomb: move to a safer spot first
      this.count('threatFlee');
      this.flee(w, me);
      return;
    }
    this.chooseGoal(w, me);
  }

  /**
   * Doomed if an enemy trigger bomb went off right now: build dg2 assuming its owner needs a moment (a human
   * does), so the bot at least runs out of the blast instead of freezing. False if no such bomb is perceived.
   */
  private relaxTriggers(w: World, me: PlayerInfo): boolean {
    const specs = this.specs2;
    specs.length = 0;
    let any = false;
    for (const sp of this.per.specs) {
      if (sp.forever && sp.owner !== me.index && sp.tOwn <= w.tick + 1 + TRIGGER_GRACE) {
        specs.push({ ...sp, tOwn: w.tick + 45 });
        any = true;
      } else specs.push(sp);
    }
    if (any) this.dg2.build(w, specs);
    return any;
  }

  /** Penalty for standing in cell c (dead ends, enemies close by, enclosement soon). */
  private standPenalty(w: World, me: PlayerInfo, c: number, t: number): number {
    let p = 0;
    if (this.prof.deadEnd > 0) {
      let open = 0;
      for (let d = 0; d < 4; d++) {
        const n = NB[c * 4 + d];
        if (n >= 0 && w.map[n] === MAP_BLANK && w.bombCell[n] < 0) open++;
      }
      if (open <= 1) p += 18 * this.prof.deadEnd;
      else if (open === 2) p += 4 * this.prof.deadEnd;
      for (const e of w.players) {
        if (!e.alive || allied(w, me.index, e.index)) continue;
        const md = manhattan(c, e.cell);
        if (md <= 2) p += (3 - md) * 6 * this.prof.deadEnd;
      }
    }
    const h = w.hurryStep[c];
    if (h !== INF && h - t < 420) p += 300 - Math.max(0, h - t) * 0.5;
    return p;
  }

  private flee(w: World, me: PlayerInfo): void {
    const r = this.reach;
    this.ctimeOn = false;
    if (this.prof.threatRange > 0 && this.threats.collect(w, me, me.cell, this.prof.threatRange, this.prof.threatHorizon, this.readyFn) > 0) this.fillCtime();
    let best = -1;
    let bestS = INF;
    const prevTarget = this.plan ? this.plan.target : -1;
    const cand = this.fleeCand;
    cand.length = 0;
    for (let c = 0; c < NC; c++) {
      const t = r.haven[c];
      if (t === INF) continue;
      let sc = t - w.tick + this.standPenalty(w, me, c, t);
      if (c === prevTarget) sc -= 3;
      if (this.ctimeOn) sc += this.pathRisk(r, r.havenState[c]) * RISK_W;
      cand.push(Math.round(sc * 16) * 256 + c);
      if (sc < bestS) {
        bestS = sc;
        best = c;
      }
    }
    if (this.prof.threatPlan && cand.length > 1) {
      // prefer the first haven (by score) that no single enemy bomb can cut off on the way or trap us in
      cand.sort((a, b) => a - b);
      const k = this.light ? Math.min(4, this.prof.pathChecks) : this.prof.pathChecks;
      const o = this.opts(w, me, this.prof.margin * 0.5, this.avoid);
      for (let i = 0; i < Math.min(cand.length, this.light ? 1 : 4); i++) {
        const c = cand[i] & 255;
        if (k > 0 && this.ctimeOn) {
          this.threats.collect(w, me, me.cell, this.prof.threatRange, this.prof.threatHorizon, this.readyFn);
          if (!this.threats.pathSafe(w, this.per.specs, o, r.path(r.havenState[c]), k)) continue;
        }
        if (this.positionSafe(w, me, c, r.haven[c])) {
          best = c;
          break;
        }
      }
    }
    if (best < 0) {
      this.survive(w, me);
      return;
    }
    if (best === me.cell && w.tick - this.movedAt > IDLE_STEPS && this.wander(w, me)) return;
    this.setPlan(w, r, r.havenState[best], best, ACT_NONE, G_FLEE, 0);
  }

  /** No haven anywhere: go where death comes last (something may still change). */
  private survive(w: World, me: PlayerInfo): void {
    const r = this.reach;
    if (this.prof.kick && me.kicker && this.tryKick(w, me, true)) return;
    // a bounce off a trampoline may still save us (a hop under way goes on)
    if (this.plan?.relaxed && w.tramp[this.plan.target] && w.tick - this.plan.made < 90) return;
    if (this.escapeTrampoline(w, me)) return;
    if (r.startCell < 0 || r.startHi === -INF) {
      this.plan = null;
      return;
    }
    let best = -1;
    let bestHi = -INF;
    for (let c = 0; c < NC; c++) {
      const s = r.anyState[c];
      if (s < 0) continue;
      const hi = r.hiOf(s);
      if (hi > bestHi) {
        bestHi = hi;
        best = s;
      }
    }
    if (best < 0) {
      this.plan = null;
      return;
    }
    this.setPlan(w, r, best, r.stateCell(best), ACT_NONE, G_SURVIVE, 0);
    void me;
  }

  /**
   * No haven left, but a trampoline next to us: nothing hurts a bouncing bomber, and the bounce sets it down on a
   * free cell two steps away diagonally, at random. Hop if the bot reaches the trampoline's centre unhurt and at
   * least half of those cells stay calm for a while after the landing.
   */
  private escapeTrampoline(w: World, me: PlayerInfo): boolean {
    if (!w.hasTramps) return false;
    const t0 = w.tick;
    const u = Math.max(me.speed, 0.05);
    for (let d = 0; d < 4; d++) {
      const tc = NB[me.cell * 4 + d];
      if (tc < 0 || !w.tramp[tc] || w.map[tc] !== MAP_BLANK || w.bombCell[tc] >= 0) continue;
      const tOut = t0 + (EXIT[d] - (me.ox * DX[d] + me.oy * DY[d])) / u;
      // the bounce starts one pixel before the centre
      const tHop = tOut + (ENTER[d] - 1) / u;
      if (this.unsafe(me.cell, t0, tOut, 0, false) || this.unsafe(tc, tOut, tHop, 0, false)) continue;
      const land = Math.ceil(tHop) + TRAMP_STEPS;
      const cx = tc % 15;
      const cy = Math.floor(tc / 15);
      let n = 0;
      let calm = 0;
      for (let y = cy - 2; y <= cy + 2; y++) {
        for (let x = cx - 2; x <= cx + 2; x++) {
          if (x === cx || y === cy || x < 0 || y < 0 || x >= 15 || y >= 11) continue;
          const c = y * 15 + x;
          if (w.map[c] !== MAP_BLANK || w.bombCell[c] >= 0) continue;
          n++;
          if (!this.dg.deadlyIn(c, land, land + CALM_STEPS)) calm++;
        }
      }
      // (with nowhere to land, the bounce comes down on the trampoline itself)
      if (n === 0 ? this.dg.deadlyIn(tc, land, land + CALM_STEPS) : calm * 2 < n) continue;
      this.count('trampolineEscape');
      this.plan = {
        path: [{ cell: me.cell, t: t0, dir: -1 }, { cell: tc, t: tOut, dir: d }],
        idx: 0, target: tc, action: ACT_NONE, goal: G_FLEE, made: t0, value: 0, strict: false, dir: -1, relaxed: true,
      };
      return true;
    }
    return false;
  }

  private setPlan(w: World, r: Reach, state: number, target: number, action: number, goal: number, value: number): void {
    if (!this.plan || this.plan.target !== target || this.plan.goal !== goal) this.goalSince = w.tick;
    this.plan = { path: r.path(state), idx: 0, target, action, goal, made: w.tick, value, strict: r !== this.reach, dir: -1 };
  }
  /** step since which the bot heads for its current goal */
  private goalSince = 0;

  private count(k: string): void {
    this.stats[k] = (this.stats[k] ?? 0) + 1;
  }

  private countDrop(ev: DropEval): void {
    if (this.debug && (ev.sure ?? 0) >= 1) this.debug(`sure kill drop`);
    this.count((ev.sure ?? 0) >= 1 ? 'dropSureKill' : ev.kills >= 1 ? 'dropKill' : ev.combo >= 0 ? 'dropCombo' : ev.kills > 0 ? 'dropProbable' : ev.bricks - ev.powerLoss > 0 ? 'dropBrick' : 'dropPressure');
  }

  /** Plan after deciding a drop: run to the combo cell for the second bomb, else to the best escape. */
  private afterDrop(w: World, ev: DropEval): void {
    const r2 = this.reach2;
    if (ev.combo >= 0) this.setPlan(w, r2, ev.combo, r2.stateCell(ev.combo), ACT_BOMB, G_ATTACK, 10);
    else if (ev.escape >= 0 && ev.escR) this.setPlan(w, ev.escR, ev.escape, ev.escR.stateCell(ev.escape), ACT_NONE, G_FLEE, 0);
  }

  /**
   * Kick a resting bomb next to the bot (the bot walks into it from its cell centre). As an attack the kicked
   * bomb must trap or squeeze a nearby enemy; as an escape (`escape`) it must open a haven. Either way the bot
   * must stay safe. Sets the plan and returns true when a kick is chosen.
   */
  private tryKick(w: World, me: PlayerInfo, escape: boolean): boolean {
    const t0 = w.tick;
    let bestD = -1;
    let bestV = 0;
    for (let d = 0; d < 4; d++) {
      const bc = NB[me.cell * 4 + d];
      if (bc < 0) continue;
      const slot = w.bombCell[bc];
      if (slot < 0) continue;
      const b = w.bombBySlot[slot];
      if (!b || b.state !== BombState.REST || (b.type === BombType.TRIGGER && b.owner !== me.index)) continue;
      const beyond = NB[bc * 4 + d];
      if (beyond < 0 || w.map[beyond] !== MAP_BLANK || w.bombCell[beyond] >= 0) continue;
      // reaching the cell centre takes a few steps; the bomb must not go off before
      const along = me.ox * DX[d] + me.oy * DY[d];
      if (along > 0) continue;
      if (b.tOwn - t0 < 8 - along / Math.max(me.speed, 0.5)) continue;
      if (!escape) this.count('kickCand');
      const specs = this.kickSpecs(w, b, d);
      this.dg4.build(w, specs);
      // our own escape with the bomb on its new way
      const o = this.opts(w, me, this.prof.margin, this.avoid);
      o.any = true;
      if (!(this.reach4.run(w, this.dg4, o) && this.reach4.havens > 0)) {
        if (!escape) this.count('kickUnsafe');
        continue;
      }
      let v = escape ? 1 : 0;
      if (!escape) {
        const res = { kills: 0, pressure: 0, sure: 0 };
        this.judgeEnemies(w, me, this.dg4, bc, res);
        if (res.kills >= 1) v = 10 + res.kills;
        else if (res.kills > 0 && this.prof.trap >= 3) v = 5;
        else if (res.pressure >= 0.8 && this.prof.trap >= 4) v = res.pressure;
      }
      if (v > bestV) {
        bestV = v;
        bestD = d;
      }
    }
    if (bestD < 0) return false;
    this.count(escape ? 'kickEscape' : 'kickAttack');
    this.plan = {
      path: [{ cell: me.cell, t: t0, dir: -1 }], idx: 0, target: me.cell, action: ACT_KICK, goal: escape ? G_FLEE : G_ATTACK,
      made: t0, value: bestV, strict: false, dir: bestD,
    };
    return true;
  }

  /**
   * Cells from which a resting bomb could be kicked down a line toward an enemy (the bot stands behind the
   * bomb and walks into it). Rough values; the kick itself is judged precisely by tryKick on arrival.
   */
  private computeKickSpots(w: World, me: PlayerInfo): boolean {
    const kv = this.kickVal;
    kv.fill(0);
    let any = false;
    if (this.prof.punch && me.punch) any = this.punchSpots(w, me);
    if (!(this.prof.kick && me.kicker)) return any;
    for (const b of w.bombs) {
      if (b.state !== BombState.REST || b.type === BombType.TRIGGER || b.cell < 0) continue;
      const left = b.tOwn - w.tick;
      if (left < 30 || left > 100) continue;
      for (let d = 0; d < 4; d++) {
        const k = NB[b.cell * 4 + ((d + 2) & 3)];
        const beyond = NB[b.cell * 4 + d];
        if (k < 0 || beyond < 0 || w.map[k] !== MAP_BLANK || w.bombCell[k] >= 0 || w.map[beyond] !== MAP_BLANK || w.bombCell[beyond] >= 0) continue;
        // walk the line the bomb would slide along
        let c = b.cell;
        for (let n = 0; n < 10; n++) {
          c = NB[c * 4 + d];
          if (c < 0 || w.map[c] !== MAP_BLANK || w.bombCell[c] >= 0) break;
          let hit = false;
          for (const e of w.players) {
            if (e.alive && e.cell === c && !allied(w, me.index, e.index)) hit = true;
          }
          if (hit) {
            const v = 7 * this.prof.attack;
            if (v > kv[k]) kv[k] = v;
            any = true;
            break;
          }
        }
      }
    }
    return any;
  }
  private kickVal = new Float32Array(NC);

  /**
   * Cells next to a resting bomb from which a punch throws it near an enemy (three cells on, over anything).
   * Rough values; the punch is judged by tryPunch once there.
   */
  private punchSpots(w: World, me: PlayerInfo): boolean {
    const kv = this.kickVal;
    let any = false;
    for (const b of w.bombs) {
      if (b.state !== BombState.REST || b.type === BombType.TRIGGER || b.cell < 0) continue;
      const left = b.tOwn - w.tick;
      if (left < 12 || left > 110) continue;
      for (let d = 0; d < 4; d++) {
        const k = NB[b.cell * 4 + ((d + 2) & 3)];
        if (k < 0 || w.map[k] !== MAP_BLANK || w.bombCell[k] >= 0) continue;
        // a kicker would kick it if it can slide
        const beyond = NB[b.cell * 4 + d];
        if (me.kicker && beyond >= 0 && w.map[beyond] === MAP_BLANK && w.bombCell[beyond] < 0) continue;
        const lx = (b.cell % 15) + 3 * DX[d];
        const ly = Math.floor(b.cell / 15) + 3 * DY[d];
        if (lx < 0 || ly < 0 || lx >= 15 || ly >= 11) continue;
        const land = ly * 15 + lx;
        for (const e of w.players) {
          if (!e.alive || e.immune || allied(w, me.index, e.index) || e.cell < 0) continue;
          if (manhattan(e.cell, land) > 1) continue;
          const v = (e.cell === land ? 9 : 6) * this.prof.attack;
          if (v > kv[k]) kv[k] = v;
          any = true;
        }
      }
    }
    return any;
  }

  /** The perceived bombs with bomb b kicked now in direction d (it slides from its cell centre). */
  private kickSpecs(w: World, b: BombInfo, d: number): BombSpec[] {
    const cx = b.cell % 15;
    const cy = Math.floor(b.cell / 15);
    const kb: BombInfo = { ...b, state: BombState.SLIDING, dir: d, x: 40 + 40 * cx, y: 103 + 36 * cy, accum: 0, stop: 0, track: null, trackP: null };
    const limit = Math.min(b.tOwn, w.tick + 400);
    const tr = trackSlide(w, kb, limit, false);
    const alt = trackSlide(w, kb, limit, true);
    const specs = this.kickList;
    specs.length = 0;
    for (const sp of this.per.specs) {
      if (sp.slot === b.slot) specs.push({ ...sp, track: tr, alt, tOwn: Math.min(sp.tOwn, b.tOwn) });
      else specs.push(sp);
    }
    return specs;
  }
  private kickList: BombSpec[] = [];

  /**
   * Punch (boxing glove): Special throws the bomb in the cell we face three cells on, over walls and bricks; it
   * lands on the first free cell from there (bouncing off a head, which stuns that player for 0.8 s) and its
   * fuse only runs on after landing. Judged like a kick: we stay safe, and it must trap an enemy. Sets the plan.
   */
  private tryPunch(w: World, me: PlayerInfo): boolean {
    // the same press also sets off our oldest trigger bomb and stops our kicked bombs: not then
    for (const b of w.bombs) if (b.owner === me.index && (b.type === BombType.TRIGGER || b.state === BombState.SLIDING)) return false;
    let bestD = -1;
    let bestV = 0;
    for (let d = 0; d < 4; d++) {
      const bc = NB[me.cell * 4 + d];
      if (bc < 0) continue;
      const slot = w.bombCell[bc];
      if (slot < 0) continue;
      const b = w.bombBySlot[slot];
      if (!b || b.state !== BombState.REST || b.type === BombType.TRIGGER || b.tOwn === INF) continue;
      // a kicker walking into a bomb that can slide kicks it instead
      const beyond = NB[bc * 4 + d];
      if (me.kicker && beyond >= 0 && w.map[beyond] === MAP_BLANK && w.bombCell[beyond] < 0) continue;
      // turning to face it takes a step or two
      if (b.tOwn - w.tick < 6) continue;
      const specs = this.punchSpecs(w, b, d);
      if (!specs) continue;
      this.dg4.build(w, specs);
      // turning to face the bomb takes a step or two before it flies
      const o = this.opts(w, me, this.prof.margin + this.prof.dropMargin + 2, this.avoid);
      o.any = true;
      if (!(this.reach4.run(w, this.dg4, o) && this.reach4.havens > 0)) {
        this.stunFoe = -1;
        continue;
      }
      const res = { kills: 0, pressure: 0, sure: 0 };
      this.judgeEnemies(w, me, this.dg4, this.punchLand, res);
      this.stunFoe = -1;
      let v = 0;
      if (res.kills >= 1) v = 10 + res.kills;
      else if (res.kills > 0 && this.prof.trap >= 3) v = 5;
      if (v > bestV) {
        bestV = v;
        bestD = d;
      }
    }
    if (bestD < 0) return false;
    this.count('punch');
    this.plan = {
      path: [{ cell: me.cell, t: w.tick, dir: -1 }], idx: 0, target: me.cell, action: ACT_PUNCH, goal: G_ATTACK,
      made: w.tick, value: bestV, strict: false, dir: bestD,
    };
    return true;
  }

  /** The perceived bombs with bomb b punched now in direction d; sets punchLand and a possible stun. */
  private punchSpecs(w: World, b: BombInfo, d: number): BombSpec[] | null {
    const cx = b.cell % 15;
    const cy = Math.floor(b.cell / 15);
    const fb: BombInfo = { ...b, state: BombState.FLYING, dir: d, x: 40 + 40 * cx, y: 103 + 36 * cy, accum: 0, bounce: 0, stop: 0, track: null, trackP: null };
    const tr = trackFlight(w, fb, false);
    const alt = trackFlight(w, fb, true);
    if (tr.land === INF) return null;
    const land = alt.land !== INF ? alt : tr;
    this.punchLand = land.cells[0];
    // the fuse stands still in the air
    const tOwn = land.land - 1 + stepsUntil(land.land - 1, b.fuseLeft);
    // a player still standing where it first comes down gets it on the head: stunned, cannot run
    this.stunFoe = -1;
    const hit = tr.cells[0];
    if (hit >= 0 && hit !== land.cells[0]) {
      for (const e of w.players) {
        if (!e.alive || e.cell !== hit || allied(w, this.me, e.index)) continue;
        // it needs its reaction time plus about a cell's walk to get out from under it
        if (tr.land - w.tick < reactSteps(w.s, e.index) + 10) {
          this.stunFoe = e.index;
          this.stunUntil = tr.land + STUN_STEPS;
        }
      }
    }
    const specs = this.kickList;
    specs.length = 0;
    for (const sp of this.per.specs) {
      if (sp.slot === b.slot) specs.push({ ...sp, track: tr, alt, tOwn });
      else specs.push(sp);
    }
    return specs;
  }
  private punchLand = -1;
  /** enemy stunned by the punch being judged (-1 none) and the step its stun ends */
  private stunFoe = -1;
  private stunUntil = 0;

  /**
   * A drop press here would create a bomb: capacity left, free cell, no warp hole. Pressing drop on a cell with
   * our own bomb would grab it or lay a spooge line instead, so never do that by accident.
   */
  private canDropHere(w: World, me: PlayerInfo): boolean {
    return me.canDrop && w.bombCell[me.cell] < 0 && w.map[me.cell] === MAP_BLANK && w.warpDest[me.cell] < 0;
  }

  private canBombAt(me: PlayerInfo, t: number): boolean {
    if (me.canDrop) return true;
    if (me.capacity <= 0) return false;
    return this.ownReturn < t - 2 && me.active <= me.capacity;
  }

  /** Steps between seeing a chance to lay a bomb and pressing the button: the level's lag, 0.5 to 1.5 times it. */
  private lagSteps(): number {
    return this.prof.dropLag > 0 ? msToSteps(this.prof.dropLag * (0.5 + this.rng.next())) : 0;
  }

  /**
   * Lay the bomb judged in `ev` in our cell, after the level's decision lag: people do not drop the instant a chance
   * shows. The first sight only starts the clock (holding still here meanwhile if `hold`); once the lag is over
   * the chance is judged again by the caller and taken if it is still there. True if the bomb goes down now.
   */
  private layBomb(w: World, me: PlayerInfo, ev: DropEval, goal: number, hold: boolean): boolean {
    if (this.pendCell !== me.cell) {
      this.pendCell = me.cell;
      this.pendAt = w.tick + this.lagSteps();
    }
    if (w.tick < this.pendAt) {
      if (hold) this.holdFor(w, me, goal);
      return false;
    }
    this.pendCell = -1;
    this.dropCell = me.cell;
    this.countDrop(ev);
    this.afterDrop(w, ev);
    return true;
  }

  /** Stay in our cell, about to lay a bomb there (tryTargetDrop takes over once the decision lag is over). */
  private holdFor(w: World, me: PlayerInfo, goal: number): void {
    this.plan = { path: [{ cell: me.cell, t: w.tick, dir: -1 }], idx: 0, target: me.cell, action: ACT_BOMB, goal, made: w.tick, value: 0, strict: false, dir: -1 };
  }

  private chooseGoal(w: World, me: PlayerInfo): void {
    const r = this.reach;
    const t0 = w.tick;
    const prof = this.prof;
    this.computeBrickGain(w, me);
    this.computeAttack(w, me);
    const kicks = ((prof.kick && me.kicker) || (prof.punch && me.punch)) && this.computeKickSpots(w, me);
    if (kicks) this.count('kickSpots');
    if (prof.trapBudget > 0 && me.canDrop) {
      if ((++this.refineCount % 3 === 1 || this.enemyNear(w, me, me.cell, 6)) && !this.light) this.refineAttack(w, me);
      else this.reuseRefined();
    }
    // kick an adjacent bomb at an enemy?
    if (prof.kick && me.kicker && !this.light && this.tryKick(w, me, false)) return;
    // punch an adjacent bomb onto or next to an enemy?
    if (prof.punch && me.punch && !this.light && this.tryPunch(w, me)) return;
    // a drop right here, now?
    if (this.canDropHere(w, me) && this.failed[me.cell] <= t0) {
      const here = this.brickGain[me.cell] - this.powerLoss[me.cell];
      const enemyNear = this.enemyNear(w, me, me.cell, me.flame + 2);
      if (here > 0 || enemyNear) {
        // already made up our mind here: the decision lag runs on
        if (this.pendCell === me.cell && t0 < this.pendAt) {
          this.holdFor(w, me, enemyNear ? G_ATTACK : G_BRICK);
          return;
        }
        const ev = this.evalDrop(w, me, me.cell, enemyNear && prof.trap >= 1);
        this.recheck = this.pendCell === me.cell;
        const want = ev.ok && this.wantDrop(w, me, ev, enemyNear);
        this.recheck = false;
        if (want) {
          this.layBomb(w, me, ev, enemyNear ? G_ATTACK : G_BRICK, true);
          return;
        }
      }
    }
    const cur0 = this.plan;
    if (cur0 && cur0.goal === G_WANDER && cur0.idx < cur0.path.length - 1 && t0 - cur0.made < 150 && r.haven[cur0.target] !== INF) {
      // keep strolling to the spot picked earlier
      this.setPlan(w, r, r.havenState[cur0.target], cur0.target, ACT_NONE, G_WANDER, 0);
      this.plan!.made = cur0.made;
      return;
    }
    if (this.rng.chance(prof.wander) && this.wander(w, me)) return;
    // parked too long with nothing to do (e.g. every target failed the threat check): move somewhere
    if (t0 - this.movedAt > IDLE_STEPS * 2 && this.wander(w, me)) return;
    // score every haven once, then try the best few in order
    const cand = this.goalCand;
    cand.length = 0;
    const cur = this.plan;
    // hunting: bricks on the way to the nearest enemy are worth more, much more while no enemy can be reached
    const hunt = this.huntWeight(w, me);
    for (let c = 0; c < NC; c++) {
      if (this.failed[c] > t0) continue;
      if (r.haven[c] === INF) {
        // a kill spot we only pass through (escape already checked by the refinement)
        if (!this.strike[c] || r.arrive[c] === INF || c === me.cell) continue;
        const v = this.attackVal[c];
        const u = (v / (1 + (r.arrive[c] - t0) / TAU)) * this.noise[c];
        cand.push({ u, c, act: ACT_BOMB, goal: G_ATTACK, v });
        continue;
      }
      const ta = r.haven[c];
      const dt = ta - t0;
      let v = 0;
      let act = ACT_NONE;
      let goal = G_IDLE;
      const pt = w.power[c];
      if (pt >= 0 && this.dg.powerGone[c] > ta + 3) {
        const pv = powerValue(pt, me, prof);
        if (pv > 0) {
          v += pv;
          goal = G_POWER;
        }
      }
      if (kicks && this.kickVal[c] > 0 && c !== me.cell) {
        v += this.kickVal[c];
        goal = G_ATTACK;
      }
      if (this.canBombAt(me, ta) && w.warpDest[c] < 0 && (c !== me.cell || this.canDropHere(w, me))) {
        const bv = this.brickGain[c] - this.powerLoss[c];
        const av = this.attackVal[c];
        if ((bv > 0 || av > 0) && this.quickEscape(w, me, c, ta)) {
          v += Math.max(0, bv) + av;
          if (bv > 0 && hunt > 0) v += hunt * Math.max(0, this.foeDist[me.cell] - this.foeDist[c]);
          act = ACT_BOMB;
          if (goal !== G_POWER) goal = av > bv ? G_ATTACK : G_BRICK;
        }
      }
      if (v <= 0) continue;
      // the drop here was just rejected: only worth staying for a power-up
      if (c === me.cell && act === ACT_BOMB && goal !== G_POWER) continue;
      let u = (v / (1 + dt / TAU)) * this.noise[c];
      u -= this.standPenalty(w, me, c, ta) * 0.02;
      if (cur && cur.target === c && cur.goal === goal) u *= 1.25;
      if (u <= 0) continue;
      cand.push({ u, c, act, goal, v });
    }
    cand.sort((a, b) => b.u - a.u);
    // commitment: keep heading for the current goal for a while unless another is clearly better (switching
    // between two targets on every re-plan leaves a bot dithering on the spot)
    if (cur && cur.target !== me.cell && t0 - this.goalSince < prof.commit && r.haven[cur.target] !== INF && this.failed[cur.target] <= t0 &&
      (cur.goal === G_ATTACK || cur.goal === G_POWER || cur.goal === G_BRICK || cur.goal === G_IDLE)) {
      let curU = 0;
      for (const g of cand) if (g.c === cur.target && g.goal === cur.goal) curU = g.u;
      // no bomb for a while with an enemy close by: an attack spot almost reached is kept whatever its value does
      // meanwhile (the drop is judged on arrival) - values that flip between re-plans otherwise send the bot
      // hopping from spot to spot without ever dropping
      const stalled = t0 - this.lastDrop > prof.pressGap && this.enemyNear(w, me, me.cell, 5);
      const close = stalled && cur.goal === G_ATTACK && curU > 0 && r.haven[cur.target] - t0 < 30;
      if (close || !cand.length || cand[0].c === cur.target || cand[0].u < curU * 1.6 + 1) {
        this.setPlan(w, r, r.havenState[cur.target], cur.target, cur.action, cur.goal, cur.value);
        return;
      }
    }
    const tries = Math.min(cand.length, this.light ? 1 : w.work > OPT_WORK * w.budget ? 2 : 3);
    for (let i = 0; i < tries; i++) {
      const g = cand[i];
      if (prof.threatPlan && g.c !== me.cell && i < tries - 1 && !this.strike[g.c] &&
        (!this.positionSafe(w, me, g.c, r.haven[g.c]) || !this.routeSafe(w, me, r, r.havenState[g.c]))) {
        // standing there would let a nearby enemy trap us with one bomb: try the next best
        this.failed[g.c] = t0 + 30; this.count(g.goal === G_ATTACK ? "posUnsafeAtk" : "posUnsafe");
        continue;
      }
      this.setPlan(w, r, this.stateOf(g.c), g.c, g.act, g.goal, g.v);
      return;
    }
    this.idle(w, me);
  }

  /**
   * Weight of getting closer to the enemies through bricks (fills foeDist: Manhattan distance from each cell to
   * the nearest enemy). Small while an enemy can be reached on foot, large while none can.
   */
  private huntWeight(w: World, me: PlayerInfo): number {
    const fd = this.foeDist;
    fd.fill(99);
    let reachable = false;
    let any = false;
    for (const e of w.players) {
      if (!e.alive || e.index === me.index || allied(w, me.index, e.index) || e.cell < 0) continue;
      any = true;
      if (this.reach.arrive[e.cell] !== INF) reachable = true;
      for (let c = 0; c < NC; c++) {
        const d = manhattan(c, e.cell);
        if (d < fd[c]) fd[c] = d;
      }
    }
    if (!any) return 0;
    return this.prof.attack * (reachable ? 0.15 : 1.5);
  }
  private foeDist = new Uint8Array(NC);

  /** Nothing to gain: shadow the nearest enemy from a safe distance (to hunt), or wander; never park for long. */
  private idle(w: World, me: PlayerInfo): void {
    const r = this.reach;
    let best = -1;
    let bestS = INF;
    if (w.tick - this.movedAt > IDLE_STEPS && this.wander(w, me)) return;
    if (this.prof.attack > 0.2) {
      // shadow the nearest enemy; close in on it (to where a bomb reaches it) when a pressure drop is due
      const press = w.tick - this.lastDrop >= this.prof.pressGap - 30 && me.capacity - me.active >= 1;
      for (let c = 0; c < NC; c++) {
        const ta = r.haven[c];
        if (ta === INF) continue;
        let dmin = INF;
        for (const e of w.players) {
          if (!e.alive || allied(w, me.index, e.index)) continue;
          const md = manhattan(c, e.cell);
          if (md < dmin) dmin = md;
        }
        if (dmin === INF) continue;
        let sc = Math.abs(dmin - (press ? 1 : 3)) * 10 + (ta - w.tick) * 0.1 + this.standPenalty(w, me, c, ta) * 0.5 + this.noise[c] * 4;
        if (press && this.pressReach(w, me, c)) sc -= 12;
        if (sc < bestS) {
          bestS = sc;
          best = c;
        }
      }
    }
    if (best >= 0) {
      this.setPlan(w, r, r.havenState[best], best, ACT_NONE, G_IDLE, 0);
      return;
    }
    if (!this.wander(w, me)) this.plan = null;
  }

  private wander(w: World, me: PlayerInfo): boolean {
    const r = this.reach;
    let pick = this.pickWander(w, me, r);
    if (pick < 0 && w.tick - this.movedAt > IDLE_STEPS && this.relaxTriggers(w, me)) {
      // penned in by enemy trigger bombs kept as mines: cross their blast, their owner needs a moment to react
      if (r.run(w, this.dg2, this.opts(w, me, this.prof.margin, this.avoid))) {
        pick = this.pickWander(w, me, r);
        if (pick >= 0) {
          this.setPlan(w, r, r.havenState[pick], pick, ACT_NONE, G_WANDER, 0);
          this.plan!.relaxed = true;
          return true;
        }
      }
    }
    if (pick < 0 && w.tick - this.movedAt > IDLE_STEPS) {
      // penned in: hop onto a trampoline next to us (it throws us somewhere close), or at least move about
      if (this.hopTrampoline(w, me)) return true;
      let n = 0;
      for (let c = 0; c < NC; c++) {
        if (c === me.cell || r.arrive[c] === INF || r.arrive[c] - w.tick > 60) continue;
        n++;
        if (this.rng.int(n) === 0) pick = c;
      }
      if (pick < 0) return false;
      this.setPlan(w, r, r.anyState[pick], pick, ACT_NONE, G_WANDER, 0);
      return true;
    }
    if (pick < 0) return false;
    this.setPlan(w, r, r.havenState[pick], pick, ACT_NONE, G_WANDER, 0);
    return true;
  }

  /** Walk onto an adjacent trampoline while no bomb is about (the landing spot is random, two cells around). */
  private hopTrampoline(w: World, me: PlayerInfo): boolean {
    if (!w.hasTramps) return false;
    for (let d = 0; d < 4; d++) {
      const tc = NB[me.cell * 4 + d];
      if (tc < 0 || !w.tramp[tc] || w.map[tc] !== MAP_BLANK || w.bombCell[tc] >= 0) continue;
      let calm = true;
      for (let c = 0; c < NC && calm; c++) if (manhattan(c, tc) <= 3 && this.dg.firstBlast[c] !== INF) calm = false;
      if (!calm) continue;
      const t0 = w.tick;
      this.plan = {
        path: [{ cell: me.cell, t: t0, dir: -1 }, { cell: tc, t: t0 + 12, dir: d }],
        idx: 0, target: tc, action: ACT_NONE, goal: G_WANDER, made: t0, value: 0, strict: false, dir: -1, relaxed: true,
      };
      this.count('trampoline');
      return true;
    }
    return false;
  }

  private pickWander(w: World, me: PlayerInfo, r: Reach): number {
    let n = 0;
    let pick = -1;
    let far = -1;
    for (let c = 0; c < NC; c++) {
      const ta = r.haven[c];
      if (ta === INF || c === me.cell) continue;
      if (far < 0 || ta < r.haven[far]) far = c;
      if (ta - w.tick > 150) continue;
      n++;
      if (this.rng.int(n) === 0) pick = c;
    }
    // nothing close (e.g. a long way round on conveyor belts): the nearest haven, however far
    return pick >= 0 ? pick : far;
  }

  private enemyNear(w: World, me: PlayerInfo, c: number, dist: number): boolean {
    for (const e of w.players) {
      if (!e.alive || e.index === me.index || allied(w, me.index, e.index)) continue;
      if (manhattan(c, e.cell) <= dist) return true;
    }
    return false;
  }

  /** Bricks (not already doomed) and power-ups a bomb with my flame would hit, per cell. */
  private computeBrickGain(w: World, me: PlayerInfo): void {
    const dg = this.dg;
    const f = me.flame;
    for (let c = 0; c < NC; c++) {
      let gain = 0;
      let loss = 0;
      if (w.map[c] === MAP_BLANK && w.bombCell[c] < 0) {
        for (let d = 0; d < 4; d++) {
          let n = c;
          for (let k = 0; k < f; k++) {
            n = NB[n * 4 + d];
            if (n < 0 || w.bombCell[n] >= 0) break;
            const m = w.map[n];
            if (m === MAP_SOLID) break;
            if (w.power[n] >= 0) {
              if (dg.powerGone[n] === INF) loss += Math.max(0, powerValue(w.power[n], me, this.prof));
              break;
            }
            if (m === MAP_BRICK) {
              if (dg.brickOpen[n] === INF) gain++;
              break;
            }
          }
        }
      }
      this.brickGain[c] = gain;
      this.powerLoss[c] = loss;
    }
  }

  /** Rough value of standing in each cell to bomb an enemy from there (refined by evalDrop on arrival). */
  private computeAttack(w: World, me: PlayerInfo): void {
    const av = this.attackVal;
    av.fill(0);
    const prof = this.prof;
    if (prof.attack <= 0) return;
    const f = me.flame;
    for (const e of w.players) {
      if (!e.alive || e.immune || e.index === me.index || allied(w, me.index, e.index) || e.cell < 0) continue;
      const mob = this.mobility(w, e.cell, 4);
      const trapF = 1 + 2.5 * Math.max(0, (14 - mob) / 14);
      const base = 2.2 * prof.attack * trapF;
      av[e.cell] = Math.max(av[e.cell], base * 0.6);
      for (let d = 0; d < 4; d++) {
        let n = e.cell;
        for (let k = 1; k <= f; k++) {
          n = NB[n * 4 + d];
          if (n < 0 || w.map[n] !== MAP_BLANK || w.bombCell[n] >= 0) break;
          const v = base * (k <= 2 ? 1 : 0.7);
          if (v > av[n]) av[n] = v;
        }
      }
    }
    if (prof.trapBudget > 0) {
      this.chainSpots(w, me);
      this.havenSpots(w, me);
    }
  }

  /**
   * Ambush spots: an enemy running from a bomb (usually its own) heads for the nearest safe cell, often a pocket
   * next to the blast. A bomb covering that pocket while the blast blocks the way back traps it.
   */
  private havenSpots(w: World, me: PlayerInfo): void {
    const av = this.attackVal;
    const f = me.flame;
    for (const e of w.players) {
      if (!e.alive || e.immune || e.index === me.index || allied(w, me.index, e.index) || e.cell < 0) continue;
      if (manhattan(e.cell, me.cell) > f + 6) continue;
      this.foeStart(w, e, 0);
      const path = this.foePath[e.index];
      if (path.length < 2) continue;
      const h = path[path.length - 1].cell;
      const v = 3 * this.prof.attack;
      if (v > av[h]) av[h] = v;
      for (let d = 0; d < 4; d++) {
        let n = h;
        for (let k = 1; k <= f; k++) {
          n = NB[n * 4 + d];
          if (n < 0 || w.map[n] !== MAP_BLANK || w.bombCell[n] >= 0) break;
          if (v > av[n]) av[n] = v;
        }
      }
    }
  }

  /**
   * Chain ambush spots: a bomb dropped in the arm of a bomb that goes off soon explodes with it, so an enemy in
   * its blast has only the rest of that fuse (minus its reaction time) to get out.
   */
  private chainSpots(w: World, me: PlayerInfo): void {
    const av = this.attackVal;
    const t0 = w.tick;
    const specs = this.per.specs;
    for (let i = 0; i < specs.length; i++) {
      const sp = specs[i];
      const te = this.dg.tExpl[i];
      if (te < t0 + 12 || te > t0 + 100 || sp.track || sp.cell < 0) continue;
      for (let d = 0; d < 4; d++) {
        let n = sp.cell;
        for (let k = 0; k < sp.flame; k++) {
          n = NB[n * 4 + d];
          if (n < 0 || w.map[n] !== MAP_BLANK || w.bombCell[n] >= 0 || w.power[n] >= 0) break;
          for (const e of w.players) {
            if (!e.alive || e.immune || e.index === me.index || allied(w, me.index, e.index) || e.cell < 0) continue;
            if (n !== e.cell && !this.lineClear(w, n, e.cell, me.flame)) continue;
            const v = 4 * this.prof.attack;
            if (v > av[n]) av[n] = v;
          }
        }
      }
    }
  }

  /**
   * Precise look at the most promising attack spots: drop there on arrival, does a nearby enemy (noticing it
   * late by the assumed reaction time) still escape, and do we? Turns heuristic values into kill values.
   */
  private refineAttack(w: World, me: PlayerInfo): void {
    const r = this.reach;
    const t0 = w.tick;
    const av = this.attackVal;
    const cand = this.attackCand;
    cand.length = 0;
    for (let c = 0; c < NC; c++) {
      // spots we only pass through (a chain ambush in the arm of a bomb about to go off) count for kills only
      const ta = r.haven[c] !== INF ? r.haven[c] : r.arrive[c];
      if (av[c] <= 0 || ta === INF || ta - t0 > 120 || c === me.cell) continue;
      cand.push(Math.round((av[c] / (1 + (ta - t0) / TAU)) * 1000) * 256 + c);
    }
    if (!cand.length || w.work > OPT_WORK * w.budget) {
      // nothing to look at, or no time left in this step: the last verdicts stand (raw values would make
      // spots looked at before seem better than they are)
      this.reuseRefined();
      return;
    }
    this.refined.fill(NaN);
    this.strike.fill(0);
    cand.sort((a, b) => b - a);
    const n = Math.min(cand.length, this.trapBudget(w));
    const res: { kills: number; pressure: number; rel?: number } = { kills: 0, pressure: 0 };
    let anyKill = false;
    let examined = 0;
    for (let i = 0; i < n; i++) {
      if (examined > 0 && w.work > OPT_WORK * w.budget) break;
      const c = cand[i] & 255;
      const haven = r.haven[c] !== INF;
      const ta = haven ? r.haven[c] : r.arrive[c];
      const b = this.ourBomb(0, me, c, Math.ceil(ta) + 1);
      this.buildWith(w, this.dg4, [b]);
      this.judgeEnemies(w, me, this.dg4, c, res, Math.ceil(ta) + 1);
      if (res.kills < 1 && !haven) {
        av[c] = 0;
      } else if (res.kills <= 0 && res.pressure < 0.2) {
        av[c] *= 0.3;
      } else if (res.kills <= 0) {
        // no kill but pressure: blend smoothly from the plain discount up to the pressure bonus (a hard threshold
        // made the verdict flip between re-plans and sent the bot hopping from spot to spot without dropping)
        const k = Math.min(1, (res.pressure - 0.2) / 0.2);
        const boosted = this.escapeFrom(w, me, this.dg4, c, ta + 1, this.reach4) ? av[c] + 6 * this.prof.attack * res.pressure : 0;
        av[c] = av[c] * 0.3 * (1 - k) + boosted * k;
      } else if (!this.escapeFrom(w, me, this.dg4, c, ta + 1, this.reach4)) {
        av[c] = 0;
      } else {
        const a = this.prof.attack;
        av[c] = res.kills >= 1 ? 30 * a : 14 * a;
        if (res.kills >= 1) this.strike[c] = 1;
      }
      this.refined[c] = av[c];
      if (res.kills > 0) anyKill = true;
      examined++;
    }
    // the most promising spots were looked at and none kills: the others would not either, so they must not
    // look better than the examined ones (else every re-plan heads for a spot not examined yet and the bot
    // hops between spots without ever dropping)
    if (!anyKill && examined > 0) {
      for (let c = 0; c < NC; c++) {
        if (av[c] > 0 && Number.isNaN(this.refined[c])) {
          av[c] *= 0.3;
          this.refined[c] = av[c];
        }
      }
    }
  }
  /** refined spots where a drop on arrival kills (havens or not), from the last refinement */
  private strike = new Uint8Array(NC);

  /** Deep trap evaluations per plan: the full budget in small games, less when many bots share the step. */
  private trapBudget(w: World): number {
    return Math.max(1, Math.round(this.prof.trapBudget * Math.min(1, Math.max(0.2, (w.budget - 0.5) / 2))));
  }

  /** Best refined kill spot (reachable, escape checked) or -1. */
  private bestStrike(w: World): number {
    const r = this.reach;
    let best = -1;
    let bestU = 0;
    for (let c = 0; c < NC; c++) {
      if (!this.strike[c] || this.failed[c] > w.tick) continue;
      const ta = r.haven[c] !== INF ? r.haven[c] : r.arrive[c];
      if (ta === INF) continue;
      const u = this.attackVal[c] / (1 + (ta - w.tick) / TAU);
      if (u > bestU) {
        bestU = u;
        best = c;
      }
    }
    return best;
  }

  /** Search state reaching cell c in the main search: its haven state, else its earliest arrival. */
  private stateOf(c: number): number {
    const r = this.reach;
    return r.haven[c] !== INF ? r.havenState[c] : r.anyState[c];
  }

  /**
   * In danger, attacks still come first: a drop right here that kills (often a chain with the bomb we are
   * fleeing), else a refined kill spot on the way. True if a plan was made.
   */
  private strikeNow(w: World, me: PlayerInfo): boolean {
    const prof = this.prof;
    if (prof.trapBudget <= 0 || !me.canDrop || this.light || !this.enemyNear(w, me, me.cell, me.flame + 3)) return false;
    if (this.canDropHere(w, me) && this.failed[me.cell] <= w.tick) {
      const ev = this.evalDrop(w, me, me.cell, true);
      // (in danger nobody stands and waits for the lag to pass: only a later look from this cell drops)
      if (ev.ok && ev.kills >= 1 && this.layBomb(w, me, ev, G_ATTACK, false)) return true;
    }
    if (prof.kick && me.kicker && this.tryKick(w, me, false)) return true;
    if (prof.punch && me.punch && this.tryPunch(w, me)) return true;
    const p = this.plan;
    if (p && p.goal === G_ATTACK && p.action === ACT_BOMB && this.strike[p.target] && p.target !== me.cell) {
      const s = this.stateOf(p.target);
      if (s >= 0) {
        this.setPlan(w, this.reach, s, p.target, ACT_BOMB, G_ATTACK, p.value);
        return true;
      }
    }
    this.computeAttack(w, me);
    this.refineAttack(w, me);
    const c = this.bestStrike(w);
    if (c < 0) return false;
    const s = this.stateOf(c);
    if (s < 0) return false;
    this.count('strike');
    this.setPlan(w, this.reach, s, c, ACT_BOMB, G_ATTACK, this.attackVal[c]);
    return true;
  }
  private attackCand: number[] = [];
  private refineCount = 0;
  /** refined attack values from the last refinement (cell -> value, NaN = not refined) */
  private refined = new Float32Array(NC).fill(NaN);

  private reuseRefined(): void {
    for (let c = 0; c < NC; c++) if (!Number.isNaN(this.refined[c])) this.attackVal[c] = this.refined[c];
  }

  /** Number of cells reachable from c within `depth` moves over currently open floor. */
  private mobility(w: World, c: number, depth: number): number {
    const seen = this.mobSeen;
    seen.fill(0);
    let frontier = [c];
    seen[c] = 1;
    let count = 1;
    for (let k = 0; k < depth && frontier.length; k++) {
      const next: number[] = [];
      for (const x of frontier) {
        for (let d = 0; d < 4; d++) {
          const n = NB[x * 4 + d];
          if (n < 0 || seen[n] || w.map[n] !== MAP_BLANK || w.bombCell[n] >= 0) continue;
          if (this.dg.firstBlast[n] < w.tick + 60) continue;
          seen[n] = 1;
          count++;
          next.push(n);
        }
      }
      frontier = next;
    }
    return count;
  }
  private mobSeen = new Uint8Array(NC);

  /**
   * Cheap test that a bomb dropped at c at time ta leaves an escape: some open cell outside its blast,
   * reachable in time over the current floor and not threatened by other bombs.
   */
  private quickEscape(w: World, me: PlayerInfo, c: number, ta: number): boolean {
    const f = me.flame;
    const inBlast = this.blastMark;
    inBlast.fill(0);
    inBlast[c] = 1;
    for (let d = 0; d < 4; d++) {
      let n = c;
      for (let k = 0; k < f; k++) {
        n = NB[n * 4 + d];
        if (n < 0 || w.map[n] !== MAP_BLANK || w.bombCell[n] >= 0 || w.power[n] >= 0) break;
        inBlast[n] = 1;
      }
    }
    const fuseSteps = stepsUntil(w.tick, me.fuseMs);
    const budget = (fuseSteps - 8) * me.speed;
    const dist = this.bfsDist;
    dist.fill(INF);
    dist[c] = 0;
    const q = this.bfsQ;
    let qh = 0;
    let qt = 0;
    q[qt++] = c;
    while (qh < qt) {
      const x = q[qh++];
      if (!inBlast[x] && this.dg.firstBlast[x] > ta + fuseSteps + 35 && w.hurryStep[x] > ta + HORIZON) return true;
      for (let d = 0; d < 4; d++) {
        const n = NB[x * 4 + d];
        if (n < 0 || dist[n] !== INF || w.map[n] !== MAP_BLANK || w.bombCell[n] >= 0 || this.avoid[n]) continue;
        const nd = dist[x] + (d & 1 ? 40 : 36);
        if (nd > budget) continue;
        if (this.dg.deadlyIn(n, ta, ta + Math.ceil(nd / Math.max(me.speed, 0.1)) + 8)) continue;
        dist[n] = nd;
        q[qt++] = n;
      }
    }
    return false;
  }
  private blastMark = new Uint8Array(NC);
  private bfsDist = new Float64Array(NC);
  private bfsQ = new Int16Array(NC + 4);

  /** Step from which enemy e can drop a bomb (Infinity if it cannot). */
  private enemyReady(e: PlayerInfo): number {
    if (e.canDrop) return this.dg.t0;
    if (e.capacity <= 0) return INF;
    let back = INF;
    const specs = this.per.specs;
    for (let i = 0; i < specs.length; i++) if (specs[i].owner === e.index && this.dg.tExpl[i] < back) back = this.dg.tExpl[i];
    return back;
  }

  /** Could a nearby enemy trap the bot with one bomb once it stands in `cell` (arriving at `start`)? */
  private positionSafe(w: World, me: PlayerInfo, cell: number, start: number): boolean {
    const prof = this.prof;
    // the bot's own cell is re-checked often: reuse the answer while nothing relevant changed
    let key = 0;
    if (cell === me.cell && start <= w.tick) {
      key = cell * 7919 + this.per.version * 131 + 1;
      for (const e of w.players) if (e.alive && e.index !== me.index) key = (key * 31 + e.cell) | 0;
      if (key === this.posKey && w.tick - this.posTick < 8) return this.posSafe;
    }
    if (this.threats.collect(w, me, cell, prof.threatRange, prof.threatHorizon + Math.max(0, start - w.tick), this.readyFn) === 0) return true;
    const o = this.opts(w, me, prof.margin * 0.5, this.avoid);
    o.cell = cell;
    if (cell !== me.cell) {
      o.ox = 0;
      o.oy = 0;
    }
    o.start = Math.max(start, w.tick);
    const safe = this.threats.safeAgainst(w, this.per.specs, o, cell, Math.min(prof.threatChecks, this.light ? 6 : prof.posChecks), o.start, true);
    if (key !== 0) {
      this.posKey = key;
      this.posTick = w.tick;
      this.posSafe = safe;
    }
    return safe;
  }
  private posKey = 0;
  private posTick = -100;
  private posSafe = true;

  /** Can a nearby enemy cut the bot off with one bomb while it follows the path to search state s? */
  private routeSafe(w: World, me: PlayerInfo, r: Reach, s: number): boolean {
    const prof = this.prof;
    if (prof.pathChecks <= 0 || this.light) return true;
    if (this.threats.collect(w, me, me.cell, prof.threatRange, prof.threatHorizon, this.readyFn) === 0) return true;
    const o = this.opts(w, me, prof.margin * 0.5, this.avoid);
    return this.threats.pathSafe(w, this.per.specs, o, r.path(s), prof.pathChecks);
  }
  private fleeCand: number[] = [];
  private goalCand: { u: number; c: number; act: number; goal: number; v: number }[] = [];

  /** A hypothetical bomb of ours dropped at `cell` during step `drop` (from a small pool, slot `i`). */
  private ourBomb(i: number, me: PlayerInfo, cell: number, drop: number): BombSpec {
    while (this.hypPool.length <= i) this.hypPool.push(makeSpec());
    const sp = this.hypPool[i];
    sp.slot = -1;
    sp.owner = me.index;
    sp.type = me.bombType;
    sp.flame = me.flame;
    sp.cell = cell;
    sp.track = null;
    sp.alt = null;
    sp.blind = false;
    sp.noChain = false;
    sp.tOwn = drop + stepsUntil(drop, me.fuseMs);
    // a trigger bomb must be left like a timed one (we want to be able to set it off)
    sp.forever = me.bombType === BombType.TRIGGER;
    sp.from = drop;
    sp.track = trackDropped(this.world!, cell, drop, sp.tOwn);
    return sp;
  }
  private hypPool: BombSpec[] = [];

  /** dg.build with the perceived bombs plus `extra`. */
  private buildWith(w: World, dg: Danger, extra: BombSpec[]): BombSpec[] {
    const specs = this.specs2;
    specs.length = 0;
    for (const sp of this.per.specs) specs.push(sp);
    for (const sp of extra) specs.push(sp);
    dg.build(w, specs);
    return specs;
  }

  /**
   * How well enemy e escapes the danger in `dg`. The enemy is assumed to notice new bombs `delay` steps late
   * (standing still meanwhile); a trap that only works thanks to the delay is a "probable" kill (0.5).
   */
  private enemyEscape(w: World, e: PlayerInfo, dg: Danger, delay: number, phase1: Danger | null = null): { dead: number; near: number } {
    const r = this.reachE;
    const o = this.opts(w, e, 0, null);
    // havens beyond a few seconds do not change the verdict; full searches are what make judging expensive
    o.maxSteps = 150 + Math.max(0, delay);
    w.work += 150;
    if (delay > 0) {
      // until it notices the new bomb the enemy acts on what it already knows: it keeps fleeing from known
      // danger (its quickest way out) or, out of danger, is assumed to stay where it is
      const f = this.foeStart(w, e, delay, phase1);
      o.start = w.tick + delay;
      o.hold = f < 0;
      if (f >= 0) {
        o.cell = f;
        o.ox = 0;
        o.oy = 0;
      }
      if (r.run(w, dg, o) && r.havens > 0) return { dead: 0, near: this.nearHavens(r, w.tick) };
      o.cell = e.cell;
      o.ox = e.ox;
      o.oy = e.oy;
      o.start = undefined;
      o.hold = false;
      if (r.run(w, dg, o) && r.havens > 0) return { dead: 0.5, near: this.nearHavens(r, w.tick) };
      return { dead: 1, near: 0 };
    }
    if (r.run(w, dg, o) && r.havens > 0) return { dead: 0, near: this.nearHavens(r, w.tick) };
    return { dead: 1, near: 0 };
  }

  /**
   * Cell enemy e is in `delay` steps from now while it flees from the bombs it already knows (its quickest way
   * out in the base model, power-ups shielding), or -1 if it is not in danger (then it is held in place).
   */
  private foeStart(w: World, e: PlayerInfo, delay: number, phase1: Danger | null = null): number {
    if (this.foeTick !== w.tick) {
      this.foeTick = w.tick;
      this.foeDone.fill(0);
      this.dgB.powerShield = true;
      this.dgB.build(w, this.per.specs);
    }
    const i = e.index;
    // a phase-1 model other than the base one (the first bomb of a combo): own cache per combo search
    const done = phase1 ? this.foeDoneP : this.foeDone;
    const paths = phase1 ? this.foePathP : this.foePath;
    if (phase1 && this.foeStampP !== this.comboStamp) {
      this.foeStampP = this.comboStamp;
      this.foeDoneP.fill(0);
    }
    if (!done[i]) {
      done[i] = 1;
      const path = paths[i];
      path.length = 0;
      const r = this.reachF;
      const o = this.opts(w, e, 0, null);
      o.maxSteps = 300;
      if (r.run(w, phase1 ?? this.dgB, o) && r.havens > 0 && r.startHi < w.tick + HORIZON) {
        let best = -1;
        for (let c = 0; c < NC; c++) if (r.haven[c] !== INF && (best < 0 || r.haven[c] < r.haven[best])) best = c;
        if (best >= 0) for (const wp of r.path(r.havenState[best])) path.push(wp);
      }
    }
    const path = paths[i];
    if (!path.length) return -1;
    const t = w.tick + delay;
    let c = path[0].cell;
    for (const wp of path) {
      if (wp.t > t) break;
      c = wp.cell;
    }
    return c;
  }
  private foeTick = -1;
  private foeDone = new Uint8Array(16);
  private foeDoneP = new Uint8Array(16);
  private foePathP: Waypoint[][] = Array.from({ length: 16 }, () => []);
  private foeStampP = -1;
  private comboStamp = 0;
  private foePath: Waypoint[][] = Array.from({ length: 16 }, () => []);
  private dgB = new Danger();
  private reachF = new Reach();

  private nearHavens(r: Reach, t0: number): number {
    let n = 0;
    for (let c = 0; c < NC; c++) if (r.haven[c] - t0 < 90) n++;
    return n;
  }

  /** Kills (1 = certain, 0.5 = needs the enemy to react late) and pressure on the enemies near `cell`. */
  private judgeEnemies(w: World, me: PlayerInfo, dg: Danger, cell: number, res: { kills: number; pressure: number; sure?: number; rel?: number }, drop = w.tick + 1, phase1: Danger | null = null): void {
    res.kills = 0;
    res.pressure = 0;
    res.sure = 0;
    res.rel = 0;
    // the two nearest enemies in reach of the blast
    const near = this.judgeNear;
    near.length = 0;
    for (const e of w.players) {
      if (!e.alive || e.immune || e.index === me.index || allied(w, me.index, e.index)) continue;
      const md = manhattan(e.cell, cell);
      if (md <= me.flame + 3) near.push(md * 16 + e.index);
    }
    near.sort((a, b) => a - b);
    if (!near.length) return;
    // judge the enemies optimistically for them: power-ups stop explosion arms (they do, unless picked up first)
    let dj = dg;
    if (this.powersOut(w)) {
      dj = this.dgJ;
      dj.powerShield = true;
      dj.build(w, dg.specs);
    }
    for (let k = 0; k < Math.min(near.length, 2); k++) {
      const e = w.players[near[k] & 15];
      let delay = Math.max(0, drop - w.tick - 1) + this.foeDelay(w, e);
      if (e.index === this.stunFoe) delay = Math.max(delay, this.stunUntil - w.tick);
      const esc = this.enemyEscape(w, e, dj, delay, phase1);
      if (esc.dead > 0 && this.foeKicks(w, e, dj.specs)) {
        // a kicker just kicks the cork away: still a squeeze
        res.pressure += 0.5;
        continue;
      }
      if (esc.dead >= 1) {
        res.kills += 1;
        res.sure = (res.sure ?? 0) + 1;
      }
      else if (esc.dead > 0) res.kills += this.prof.trap >= 4 ? 1 : 0.5;
      else {
        // pressure: how much of the enemy's nearby safe room the bomb takes away
        res.pressure += Math.max(0, 9 - esc.near) / 9;
        // relative squeeze: how much of the enemy's nearby safe room the bomb takes away (late-game pushes)
        const before = this.enemyRoom(w, e);
        const rel = Math.min(1, Math.max(0, 1 - esc.near / Math.max(1, before)));
        if (rel > (res.rel ?? 0)) res.rel = rel;
      }
    }
  }

  private judgeNear: number[] = [];

  /** Any visible power-up on the field (cached per step)? */
  private powersOut(w: World): boolean {
    if (this.powTick !== w.tick) {
      this.powTick = w.tick;
      this.powAny = false;
      for (let c = 0; c < NC; c++) if (w.power[c] >= 0) { this.powAny = true; break; }
    }
    return this.powAny;
  }
  private powTick = -1;
  private powAny = false;
  private dgJ = new Danger();

  /** Could enemy e kick one of our new (hypothetical) bombs out of its way, walking into it from nearby? */
  private foeKicks(w: World, e: PlayerInfo, specs: BombSpec[]): boolean {
    if (!e.kicker || !kicksBombs(w.s, e.index)) return false;
    const me = this.me;
    // cells the enemy reaches within three moves over open floor
    const seen = this.mobSeen;
    seen.fill(0);
    const q = this.bfsQ;
    let qh = 0;
    let qt = 0;
    q[qt++] = e.cell;
    seen[e.cell] = 1;
    const depth = this.kickDepth;
    depth[e.cell] = 0;
    while (qh < qt) {
      const x = q[qh++];
      if (depth[x] >= 3) continue;
      for (let d = 0; d < 4; d++) {
        const n = NB[x * 4 + d];
        if (n < 0 || seen[n] || w.map[n] !== MAP_BLANK || w.bombCell[n] >= 0) continue;
        seen[n] = 1;
        depth[n] = depth[x] + 1;
        q[qt++] = n;
      }
    }
    for (const sp of specs) {
      if (sp.slot !== -1 || sp.owner !== me || sp.track && sp.track.cells.length > 1) continue;
      const h = sp.cell;
      if (h < 0) continue;
      for (let d = 0; d < 4; d++) {
        const a = NB[h * 4 + ((d + 2) & 3)];
        const b = NB[h * 4 + d];
        if (a < 0 || b < 0 || !seen[a] || w.map[b] !== MAP_BLANK || w.bombCell[b] >= 0) continue;
        let blocked = false;
        for (const o of specs) if (o !== sp && o.slot === -1 && o.cell === b) blocked = true;
        if (!blocked) return true;
      }
    }
    return false;
  }
  private kickDepth = new Uint8Array(NC);

  /** Haven cells enemy e reaches within 1.5 s in the base model (cached per step). */
  private enemyRoom(w: World, e: PlayerInfo): number {
    if (this.roomTick[e.index] !== w.tick) {
      this.roomTick[e.index] = w.tick;
      this.room[e.index] = this.enemyEscape(w, e, this.dg, 0).near;
    }
    return this.room[e.index];
  }
  private room = new Float64Array(16);
  private roomTick = new Float64Array(16).fill(-1);

  /** Late in the round (or with infinite time never): play for the kill. */
  private endgame(w: World): boolean {
    return w.remainingMs < LATE_MS;
  }

  /** Can the bot (starting at `cell`'s centre at time `start`) reach a haven in `dg`? */
  private escapeFrom(w: World, me: PlayerInfo, dg: Danger, cell: number, start: number, r: Reach): boolean {
    const o = this.opts(w, me, this.prof.margin + this.prof.dropMargin, this.avoid);
    o.cell = cell;
    if (cell !== me.cell) {
      o.ox = 0;
      o.oy = 0;
    }
    o.start = start;
    o.any = true;
    return r.run(w, dg, o) && r.havens > 0;
  }

  /** Simulate a drop at `cell` now: does the bot keep an escape, what does it destroy, who gets trapped? */
  private evalDrop(w: World, me: PlayerInfo, cell: number, withEnemies: boolean): DropEval {
    const t0 = w.tick;
    const prof = this.prof;
    const hyp = this.ourBomb(0, me, cell, t0 + 1);
    const dg2 = this.dg2;
    const specs = this.buildWith(w, dg2, [hyp]);
    const r2 = this.reach2;
    const res: DropEval = { ok: false, bricks: 0, powerLoss: 0, kills: 0, pressure: 0, escape: -1, combo: -1, escR: r2 };
    let ok = r2.run(w, dg2, this.opts(w, me, prof.margin + prof.dropMargin, this.avoid)) && r2.havens > 0;
    if (!ok && this.rng.chance(prof.mistake)) ok = true;
    if (!ok) { if (withEnemies) this.count("evalNoEsc"); return res; }
    // allies must keep an escape too
    for (const a of w.players) {
      if (!a.alive || a.index === me.index || !allied(w, me.index, a.index) || a.immune) continue;
      if (manhattan(a.cell, cell) > me.flame + 3) continue;
      const okA = this.reachE.run(w, dg2, this.opts(w, a, 0.5, null)) && this.reachE.havens > 0;
      if (!okA) return res;
    }
    if (prof.threatPlan && this.kickedAway(w, me, cell, hyp)) {
      if (withEnemies) this.count('evalKick');
      return res;
    }
    for (let c = 0; c < NC; c++) {
      if (dg2.brickOpen[c] !== INF && this.dg.brickOpen[c] === INF && w.map[c] === MAP_BRICK) res.bricks++;
      if (dg2.powerGone[c] !== INF && this.dg.powerGone[c] === INF && w.power[c] >= 0) {
        res.powerLoss += Math.max(0, powerValue(w.power[c], me, prof));
      }
    }
    // a trigger bomb is modelled as going off at any time (no brick opens): count what its blast will hit
    if (hyp.forever) {
      res.bricks = Math.max(res.bricks, this.brickGain[cell]);
      res.powerLoss = Math.max(res.powerLoss, this.powerLoss[cell]);
    }
    if (withEnemies) this.judgeEnemies(w, me, dg2, cell, res);
    this.ctimeOn = false;
    const horizon = prof.late > 0 && this.endgame(w) ? Math.min(prof.threatHorizon, 20) : prof.threatHorizon;
    if (prof.threatRange > 0 && this.threats.collect(w, me, cell, prof.threatRange, horizon, this.readyFn) > 0) {
      this.fillCtime();
      // nearby enemies may answer with a bomb of their own: the escape must survive any single one
      const o = this.opts(w, me, prof.margin, this.avoid);
      const safe = (res.sure ?? 0) >= 1 || this.threats.safeAgainst(w, specs, o, cell, this.light ? Math.min(prof.threatChecks, 10) : prof.threatChecks);
      if (this.debug) {
        const ds = this.threats.drops.map((d) => `${d.cell % 15},${Math.floor(d.cell / 15)}@${d.t - t0}`).join(' ');
        this.debug(`evalDrop ${cell % 15},${Math.floor(cell / 15)} threats [${ds}] safe=${safe}`);
      }
      if (!safe) { if (withEnemies) this.count(res.kills >= 1 ? "killThreat" : "evalThreat"); return res; }
    } else if (this.debug) {
      this.debug(`evalDrop ${cell % 15},${Math.floor(cell / 15)} no threats, kills ${res.kills}`);
    }
    res.escape = this.bestHaven(w, me, r2, specs);
    if (!this.havenSafe && (res.sure ?? 0) < 1) {
      // every way out could be corked by a nearby enemy: not worth the risk
      if (withEnemies) this.count(res.kills >= 1 ? "killPath" : "evalPath");
      return res;
    }
    res.ok = true;
    if (withEnemies && res.kills < 1 && (res.pressure > 0.2 || prof.trap >= 3) && prof.trapBudget > 0 && !this.light && w.work < OPT_WORK * w.budget) {
      // reach2 / dg2 still describe the single drop here (the threat checks use their own buffers)
      res.combo = this.findCombo(w, me, cell);
    }
    return res;
  }

  /**
   * An enemy kicker next to the drop cell may walk into the new bomb and kick it (on purpose or on its way):
   * it then slides on (maybe into flames, going off at once). True if such a kick would leave us no escape.
   */
  private kickedAway(w: World, me: PlayerInfo, cell: number, hyp: BombSpec): boolean {
    for (const e of w.players) {
      if (!e.alive || e.index === me.index || allied(w, me.index, e.index) || !e.kicker || !kicksBombs(w.s, e.index)) continue;
      if (manhattan(e.cell, cell) !== 1) continue;
      const d = dirBetween(e.cell, cell);
      const beyond = d >= 0 ? NB[cell * 4 + d] : -1;
      if (beyond < 0 || w.map[beyond] !== MAP_BLANK || w.bombCell[beyond] >= 0) continue;
      const cx = cell % 15;
      const cy = Math.floor(cell / 15);
      const kb: BombInfo = {
        slot: -1, owner: me.index, type: hyp.type, state: BombState.SLIDING, dud: false, x: 40 + 40 * cx, y: 103 + 36 * cy, cell, dir: d,
        flame: hyp.flame, fuseLeft: me.fuseMs, tOwn: hyp.tOwn, queued: false, born: 0, accum: 0, stop: 0, bounce: 0, holder: -1, track: null, trackP: null,
      };
      const limit = Math.min(hyp.tOwn, w.tick + 400);
      const k = this.kickHyp;
      Object.assign(k, hyp);
      k.track = trackSlide(w, kb, limit, false);
      k.alt = trackSlide(w, kb, limit, true);
      if (k.track.boom < k.tOwn) k.tOwn = k.track.boom;
      // own buffer: the caller's spec list (this.specs2) is still in use
      const list = this.kickSpecList;
      list.length = 0;
      for (const sp of this.per.specs) list.push(sp);
      list.push(k);
      this.dg4.build(w, list);
      const o = this.opts(w, me, this.prof.margin, this.avoid);
      o.any = true;
      if (!(this.reach4.run(w, this.dg4, o) && this.reach4.havens > 0)) return true;
    }
    return false;
  }
  private kickHyp: BombSpec = makeSpec();
  private kickSpecList: BombSpec[] = [];

  /** Earliest haven of a search, avoiding dead ends and danger spots (state id or -1). */
  private bestHaven(w: World, me: PlayerInfo, r: Reach, base: BombSpec[] | null = null): number {
    const cand = this.havenCand;
    cand.length = 0;
    for (let c = 0; c < NC; c++) {
      const t = r.haven[c];
      if (t === INF) continue;
      let sc = t - w.tick + this.standPenalty(w, me, c, t);
      if (this.ctimeOn) sc += this.pathRisk(r, r.havenState[c]) * RISK_W;
      cand.push(Math.min(65535, Math.max(0, Math.round(sc * 8))) * 256 + c);
    }
    if (!cand.length) return -1;
    cand.sort((a, b) => a - b);
    const best = r.havenState[cand[0] & 255];
    const k = this.light ? 0 : this.prof.pathChecks;
    this.havenSafe = true;
    if (!base || !this.ctimeOn || k <= 0) return best;
    // prefer the first candidate whose path no single enemy bomb can cut
    const o = this.opts(w, me, this.prof.margin * 0.5, this.avoid);
    for (let i = 0; i < Math.min(4, cand.length); i++) {
      const s = r.havenState[cand[i] & 255];
      if (this.threats.pathSafe(w, base, o, r.path(s), k)) return s;
    }
    this.havenSafe = false;
    return best;
  }
  /** the last bestHaven() found a path no single enemy bomb cuts (or did not check) */
  private havenSafe = true;
  private havenCand: number[] = [];

  /** Earliest step a nearby enemy could drop a bomb in each cell (from the collected threat candidates). */
  private fillCtime(): void {
    const ct = this.ctime;
    ct.fill(INF);
    for (const d of this.threats.drops) if (d.t < ct[d.cell]) ct[d.cell] = d.t;
    this.ctimeOn = true;
  }
  private ctime = new Float64Array(NC);
  private ctimeOn = false;

  /** Number of cells on the path to search state s that an enemy could bomb before the bot is through them. */
  private pathRisk(r: Reach, s: number): number {
    let risk = 0;
    const ct = this.ctime;
    let tNext = INF;
    let first = true;
    while (s >= 0) {
      const c = r.stateCell(s);
      const t = r.g[s];
      const leave = first ? t + 30 : tNext;
      if (ct[c] < leave + 6) risk++;
      tNext = t;
      first = false;
      s = r.par[s];
      if (s >= 0 && r.par[s] < 0) break; // the start cell is ours
    }
    return risk;
  }

  /**
   * Two-bomb trap: with our bomb about to be dropped at `cell` (dg2 / reach2 hold that state), find a cell y the
   * bot reaches soon where a second bomb leaves a nearby enemy without escape. Returns the reach2 state of y or -1.
   */
  private findCombo(w: World, me: PlayerInfo, cell: number): number {
    if (me.capacity - me.active < 2) return -1;
    const t0 = w.tick;
    const r2 = this.reach2;
    const cand = this.comboCand;
    cand.length = 0;
    // the enemies first see bomb A alone and flee from it; bomb B (a second drop at y) comes as a surprise
    this.comboStamp++;
    const dgA = this.dgA;
    dgA.powerShield = true;
    const listA = this.comboBase;
    listA.length = 0;
    for (const sp of this.per.specs) listA.push(sp);
    listA.push(this.ourBomb(0, me, cell, t0 + 1));
    dgA.build(w, listA);
    // cells in the arms of A: a bomb there goes off together with A (a chain), whenever it was dropped
    const arm = this.blastMark;
    arm.fill(0);
    for (let d = 0; d < 4; d++) {
      let n = cell;
      for (let k = 0; k < me.flame; k++) {
        n = NB[n * 4 + d];
        if (n < 0 || w.map[n] !== MAP_BLANK || w.bombCell[n] >= 0 || w.power[n] >= 0) break;
        arm[n] = 1;
      }
    }
    for (const e of w.players) {
      if (!e.alive || e.immune || e.index === me.index || allied(w, me.index, e.index)) continue;
      if (manhattan(e.cell, cell) > me.flame + 4) continue;
      // where it runs to from A
      this.foeStart(w, e, 0, dgA);
      const fp = this.foePathP[e.index];
      const hv = fp.length ? fp[fp.length - 1].cell : e.cell;
      for (let c = 0; c < NC; c++) {
        const ta = r2.arrive[c];
        if (ta === INF || ta - t0 > 90 || c === cell || w.warpDest[c] >= 0) continue;
        const md = Math.min(manhattan(c, e.cell), manhattan(c, hv));
        if (md > me.flame + 1) continue;
        const lined = md <= 1 || this.lineClear(w, c, e.cell, me.flame) || this.lineClear(w, c, hv, me.flame);
        if (!lined) continue;
        const pri = Math.round(ta - t0 + md * 6 - (arm[c] ? 20 : 0) + 40);
        cand.push(c * 1000 + Math.max(0, Math.min(999, pri)));
      }
    }
    if (!cand.length) return -1;
    cand.sort((a, b) => (a % 1000) - (b % 1000));
    const n = Math.min(cand.length, this.trapBudget(w));
    const res = { kills: 0, pressure: 0 };
    const states = this.comboStates;
    states.length = 0;
    for (let i = 0; i < n; i++) states.push(r2.anyState[Math.floor(cand[i] / 1000)]);
    for (let i = 0; i < n; i++) {
      if (w.work > OPT_WORK * w.budget) break;
      const y = Math.floor(cand[i] / 1000);
      const s = states[i];
      if (s < 0) continue;
      const ty = r2.g[s];
      const a = this.ourBomb(0, me, cell, t0 + 1);
      const b = this.ourBomb(1, me, y, Math.ceil(ty) + 1);
      this.buildWith(w, this.dg4, [a, b]);
      this.judgeEnemies(w, me, this.dg4, y, res, Math.ceil(ty) + 1, dgA);
      if (res.kills < 1) continue;
      if (!this.escapeFrom(w, me, this.dg4, y, ty + 1, this.reach4)) continue;
      // the walk to y usually heads for the enemy: it must not be cut off on the way
      if (this.ctimeOn && this.prof.pathChecks > 0) {
        const baseA = this.comboBase;
        baseA.length = 0;
        for (const sp of this.per.specs) baseA.push(sp);
        baseA.push(this.ourBomb(0, me, cell, t0 + 1));
        const o = this.opts(w, me, this.prof.margin * 0.5, this.avoid);
        if (!this.threats.pathSafe(w, baseA, o, r2.path(s), this.prof.pathChecks)) continue;
      }
      return s;
    }
    return -1;
  }
  private comboBase: BombSpec[] = [];
  private dgA = new Danger();
  private comboCand: number[] = [];
  private comboStates: number[] = [];
  private dg4 = new Danger();
  private reach4 = new Reach();

  /** Is there a straight open line of at most `len` cells from a to b? */
  private lineClear(w: World, a: number, b: number, len: number): boolean {
    for (let d = 0; d < 4; d++) {
      let n = a;
      for (let k = 0; k < len; k++) {
        n = NB[n * 4 + d];
        if (n < 0 || w.map[n] !== MAP_BLANK || w.bombCell[n] >= 0) break;
        if (n === b) return true;
      }
    }
    return false;
  }

  /** Decide whether an evaluated drop is worth it. */
  private wantDrop(w: World, me: PlayerInfo, ev: DropEval, enemyNear: boolean): boolean {
    const prof = this.prof;
    if (ev.kills >= 1 || ev.combo >= 0) return true;
    const value = ev.bricks - ev.powerLoss;
    if (value > 0) return true;
    if (!enemyNear) return false;
    if (this.pressDrop(w, me)) return true;
    switch (prof.trap) {
      case 0:
        // now and then a poke at someone in line, no planning
        return this.inLineWithEnemy(w, me) && (this.recheck || this.rng.chance(0.12 * prof.attack));
      case 1:
        return this.inLineWithEnemy(w, me);
      default: {
        if (ev.kills > 0) return true;
        const spare = me.capacity - me.active;
        // set-up bomb next to the enemy, keeping one for the follow-up: the second can chain with it (a chain
        // ambush leaves the enemy only the rest of the first fuse) or cut off the way the enemy flees
        if (prof.trap >= 3 && prof.setup && spare >= 2 && me.active === 0 && (this.slowFoeNear(w, me, 3) || (prof.late > 0 && this.endgame(w) && this.enemyNear(w, me, me.cell, 3)))) {
          this.count('setup');
          return true;
        }
        let need = prof.trap >= 3 && spare >= 2 ? 0.45 : 0.7;
        if (prof.late > 0 && this.endgame(w)) {
          // late game: keep the enemy moving with every safe bomb next to it instead of waiting for the clock
          if (spare >= 1 && this.enemyNear(w, me, me.cell, 2 + Math.round(prof.late))) {
            this.count('lateDrop');
            return true;
          }
          if (spare >= 1 && (ev.rel ?? 0) >= 0.5 - 0.25 * prof.late) return true;
          need *= 1 - 0.5 * prof.late;
        }
        // (a cornered enemy has little room anyway: the bomb must take a good share of it)
        return ev.pressure >= need && (ev.rel ?? 0) >= 0.25;
      }
    }
  }

  /**
   * Keep the pressure on (every level, by its own clock): once a while has passed without a bomb, a safe drop
   * that reaches a nearby enemy (in line within the blast, or right next to it) is worth it even without a sure
   * kill - it cuts the enemy's room, makes it run and sets up chains. Clumsy levels skip some chances.
   */
  private pressDrop(w: World, me: PlayerInfo): boolean {
    const prof = this.prof;
    if (w.tick - this.lastDrop < prof.pressGap || me.capacity - me.active < 1) return false;
    if (!this.pressReach(w, me, me.cell)) return false;
    if (!this.recheck && !this.rng.chance(prof.pressChance)) {
      // missed it: look again in half a second
      this.lastDrop = w.tick - prof.pressGap + 30;
      return false;
    }
    this.count('press');
    return true;
  }

  /** A bomb at c would reach an enemy: it stands next to c or in line within the blast. */
  private pressReach(w: World, me: PlayerInfo, c: number): boolean {
    for (const e of w.players) {
      if (!e.alive || e.immune || e.index === me.index || allied(w, me.index, e.index) || e.cell < 0) continue;
      const md = manhattan(c, e.cell);
      if (md <= 1 || (md <= me.flame && this.lineClear(w, c, e.cell, me.flame))) return true;
    }
    return false;
  }

  /** An enemy within `dist` that reacts slowly (set-up bombs only pay off against those: humans, levels 1-3). */
  private slowFoeNear(w: World, me: PlayerInfo, dist: number): boolean {
    for (const e of w.players) {
      if (!e.alive || e.index === me.index || allied(w, me.index, e.index)) continue;
      if (manhattan(me.cell, e.cell) <= dist && reactSteps(w.s, e.index) >= 14) return true;
    }
    return false;
  }

  private inLineWithEnemy(w: World, me: PlayerInfo): boolean {
    for (const e of w.players) {
      if (!e.alive || e.index === me.index || allied(w, me.index, e.index)) continue;
      if (e.cell === me.cell || this.lineClear(w, me.cell, e.cell, me.flame)) return true;
    }
    return false;
  }

  /** Detonate the oldest own trigger bomb now? Only if the bot survives it and it achieves something. */
  private shouldTrigger(w: World, me: PlayerInfo): boolean {
    let oldest = -1;
    let born = INF;
    for (const b of w.bombs) {
      if (b.owner !== me.index || b.type !== BombType.TRIGGER || b.state === BombState.FLYING || b.state === BombState.HELD) continue;
      if (b.born >= w.s.frameCounter) continue;
      if (b.born < born) {
        born = b.born;
        oldest = b.slot;
      }
    }
    if (oldest < 0) return false;
    // the oldest is already going off (a chain): this press would set off the next one instead
    if (w.bombBySlot[oldest]?.queued) return false;
    const t0 = w.tick;
    const specs = this.specs2;
    specs.length = 0;
    let found = false;
    for (const sp of this.per.specs) {
      let cp = sp;
      if (sp.slot === oldest) {
        cp = { ...sp, tOwn: t0 + 2, forever: false };
        found = true;
      }
      // the same press also stops our own kicked bombs (kicker): they halt at the next cell centre
      const b = sp.slot >= 0 ? w.bombBySlot[sp.slot] : null;
      if (me.kicker && b && b.owner === me.index && b.state === BombState.SLIDING && b.type !== BombType.JELLY) {
        if (cp === sp) cp = { ...sp };
        const stopped = { ...b, stop: 1, track: null, trackP: null };
        const limit = Math.min(cp.tOwn, t0 + 400);
        cp.track = trackSlide(w, stopped, limit, false);
        cp.alt = trackSlide(w, stopped, limit, true);
      }
      specs.push(cp);
    }
    if (!found) return false;
    const dg2 = this.dg2;
    dg2.build(w, specs);
    // the bot must not be caught: its cell must stay clear for the next steps and a haven must exist
    if (dg2.deadlyIn(me.cell, t0 + 1, t0 + 8)) return false;
    const ok = this.reach2.run(w, dg2, this.opts(w, me, 0.5, null)) && this.reach2.havens > 0;
    if (!ok) return false;
    for (const a of w.players) {
      if (!a.alive || a.index === me.index || !allied(w, me.index, a.index)) continue;
      if (dg2.deadlyIn(a.cell, t0 + 1, t0 + 8)) return false;
    }
    let kills = 0;
    for (const e of w.players) {
      if (!e.alive || e.immune || allied(w, me.index, e.index)) continue;
      if (dg2.deadlyIn(e.cell, t0 + 1, t0 + 4)) kills++;
    }
    if (kills > 0) return true;
    // a mine nobody walks into only freezes the board: set it off after a while
    if (w.tick - born > MINE_STEPS) return true;
    let bricks = 0;
    for (let c = 0; c < NC; c++) if (dg2.brickOpen[c] !== INF && this.dg.brickOpen[c] === INF && w.map[c] === MAP_BRICK) bricks++;
    if (!me.canDrop) return true;
    // keep it as a mine while an enemy is close to its blast, otherwise clear the bricks
    for (const e of w.players) {
      if (!e.alive || allied(w, me.index, e.index)) continue;
      if (dg2.firstBlast[e.cell] !== INF) return false;
      if (this.prof.trigger && manhattan(e.cell, this.per.specs.find((x) => x.slot === oldest)?.cell ?? me.cell) <= 3) return false;
    }
    return bricks > 0;
  }

  // ---------------------------------------------------------------------------------------------------
  // execution

  /** Is the current plan still followable and safe? */
  private planOk(w: World, me: PlayerInfo): boolean {
    const p = this.plan;
    if (!p) return false;
    const k = locate(p, me.cell);
    if (k < 0) return false;
    p.idx = k;
    if (p.relaxed) return w.tick - p.made < 90 && (k < p.path.length - 1 || w.tramp[me.cell] === 1);
    if ((p.action === ACT_PUNCH || p.action === ACT_KICK) && k === p.path.length - 1 && w.tick - p.made < 3) return true;
    if (this.stillTicks > 60 && k < p.path.length - 1) {
      this.failed[p.target] = w.tick + 120;
      return false;
    }
    const m = this.prof.margin * 0.5;
    const t0 = w.tick;
    // a kill spot we only pass through needs to stay safe just until we have dropped and left
    const strike = p.goal === G_ATTACK && p.action === ACT_BOMB && this.strike[p.target] === 1;
    for (let i = k; i < p.path.length; i++) {
      // a warp spin keeps the bot unhurt: the hole matters until the warp fires, the far end from the soonest
      // end of the spin (as the search planned it)
      const a = i === k ? t0 : p.path[i].dir === 4 ? p.path[i].t - WARP_STEPS + WARP_SAFE : p.path[i].t;
      const last = i + 1 >= p.path.length;
      const b = last ? (p.goal === G_SURVIVE ? a + 1 : strike ? a + 4 : t0 + HORIZON) : p.path[i + 1].dir === 4 ? Math.max(a, p.path[i + 1].t - WARP_STEPS) : p.path[i + 1].t;
      if (this.unsafe(p.path[i].cell, a, b, m, i !== k)) return false;
    }
    // goal still worth it?
    if (p.goal === G_POWER && w.power[p.target] < 0) return false;
    if (p.goal === G_SURVIVE) return false;
    return true;
  }

  /** Does cell c have an unsafe interval overlapping the continuous window [a, b] (margin m)? */
  private unsafe(c: number, a: number, b: number, m: number, withBlocked: boolean): boolean {
    const dg = this.dg;
    const bd = c * KD;
    for (let i = 0; i < dg.dN[c]; i++) {
      if (dg.dA[bd + i] - 1 - m <= b && dg.dB[bd + i] - 1 + m >= a) return true;
    }
    if (withBlocked) {
      const bb = c * KB;
      for (let i = 0; i < dg.bN[c]; i++) {
        if (dg.bA[bb + i] - 1 <= b && dg.bB[bb + i] - 1 >= a) return true;
      }
    }
    return false;
  }

  private trackStill(me: PlayerInfo): void {
    if (me.x === this.lastX && me.y === this.lastY) {
      if (this.prev & (IN_UP | IN_RIGHT | IN_DOWN | IN_LEFT)) this.stillTicks++;
    } else {
      this.stillTicks = 0;
      this.movedAt = this.world ? this.world.tick : 0;
    }
    this.lastX = me.x;
    this.lastY = me.y;
  }

  private steer(w: World, me: PlayerInfo): number {
    const p = this.plan;
    if (!p) return 0;
    const path = p.path;
    const k = locate(p, me.cell);
    if (k < 0) {
      this.nextPlan = 0;
      return 0;
    }
    p.idx = k;
    const t0 = w.tick;
    if (k >= path.length - 1) {
      // at the target: act, then hold near the centre
      if (p.action === ACT_BOMB && this.dropCell < 0) this.tryTargetDrop(w, me);
      if (p.action === ACT_PUNCH && p.dir >= 0) {
        const bs = w.bombCell[NB[me.cell * 4 + p.dir]];
        if (bs >= 0 && w.bombBySlot[bs]?.state === BombState.REST && w.tick - p.made < 30) {
          // line up, turn to face the bomb (walking into it only turns us), then punch
          const perp = me.oy * DX[p.dir] - me.ox * DY[p.dir];
          if (Math.abs(perp) > 2) return this.center(me);
          if (me.dir !== p.dir) return DIR_BITS[p.dir];
          this.act2 = true;
        }
        this.nextPlan = 0;
        return 0;
      }
      if (p.action === ACT_KICK && p.dir >= 0) {
        // keep walking into the bomb: the kick happens on the cell centre; re-plan once it slides
        const b = w.bombCell[NB[me.cell * 4 + p.dir]];
        if (b >= 0 && w.bombs.length && w.bombBySlot[b]?.state === BombState.REST && w.tick - p.made < 12) return DIR_BITS[p.dir];
        this.nextPlan = 0;
      }
      // on a trampoline we mean to use (hops are the only relaxed plans ending on one): its centre sets it off
      if (w.tramp[me.cell] && p.relaxed) {
        if (me.ox !== 0) return me.ox > 0 ? IN_LEFT : IN_RIGHT;
        if (me.oy !== 0) return me.oy > 0 ? IN_UP : IN_DOWN;
      }
      return this.center(me);
    }
    const nx = path[k + 1];
    let d = dirBetween(me.cell, nx.cell);
    if (d < 0) {
      // warp jump: walk to the warp hole's centre (it triggers one pixel before it)
      if (Math.abs(me.ox) >= Math.abs(me.oy) && me.ox !== 0) return me.ox > 0 ? IN_LEFT : IN_RIGHT;
      if (me.oy !== 0) return me.oy > 0 ? IN_UP : IN_DOWN;
      this.nextPlan = 0;
      return 0;
    }
    let u = me.speed;
    const cd = w.conv[me.cell];
    if (cd >= 0) {
      if (cd === d) u += w.convSpeed;
      else if (cd === ((d + 2) & 3)) u -= w.convSpeed;
    }
    const along = me.ox * DX[d] + me.oy * DY[d];
    // pushing against a cell that is still closed (a burning brick, a bomb) at the centre makes the simulation
    // slide sideways around the corner, possibly into a neighbouring cell: line up and wait instead
    if ((w.map[nx.cell] !== MAP_BLANK || w.bombCell[nx.cell] >= 0) && along > -2 - Math.ceil(u)) return this.center(me);
    const dist = EXIT[d] - along;
    const tCross = t0 + dist / Math.max(u, 0.05);
    if (tCross < nx.t - 0.75) {
      // early: plans made on a special model (a detonation or a drop just ordered) are followed to the letter,
      // otherwise wait only if the next cell is not safe to enter yet
      // (a warp hole fires on entry: arriving early at its far end could mean landing in flames)
      if (p.strict || w.warpDest[nx.cell] >= 0 || this.unsafe(nx.cell, tCross, nx.t + 1, this.prof.margin * 0.5, true)) return 0;
    } else if (this.burningAt(nx.cell, tCross)) {
      // real moves run a little ahead of the plan: never cross into flames or an explosion that is still on
      return 0;
    }
    return DIR_BITS[d];
  }

  /** The cell is inside a finite deadly interval (flames, an explosion) at continuous time t (half a step slack). */
  private burningAt(c: number, t: number): boolean {
    const dg = this.dg;
    const bd = c * KD;
    for (let i = 0; i < dg.dN[c]; i++) {
      const b = dg.dB[bd + i];
      if (b !== Infinity && dg.dA[bd + i] - 1.5 <= t && b - 0.5 >= t) return true;
    }
    return false;
  }

  /**
   * Boxed in with nothing to do for a while (a pocket of bricks, a bad power-up as the only way on): pace a few
   * pixels inside the cell towards an open neighbour and back, never crossing into it.
   */
  private fidget(w: World, me: PlayerInfo): number {
    // only where nothing but our own trigger bombs (which go off when we say so) could reach us
    if (!this.ownTriggerOnly(w, me.cell)) return 0;
    for (let d = 0; d < 4; d++) {
      const n = NB[me.cell * 4 + d];
      if (n < 0 || w.map[n] !== MAP_BLANK || w.bombCell[n] >= 0 || !this.ownTriggerOnly(w, n)) continue;
      const along = me.ox * DX[d] + me.oy * DY[d];
      if (along >= 6) this.fidgetBack = true;
      if (along <= 0) this.fidgetBack = false;
      return this.fidgetBack ? DIR_BITS[(d + 2) & 3] : DIR_BITS[d];
    }
    return 0;
  }
  private fidgetBack = false;

  /** Cell c is out of every blast, or only in blasts of our own trigger bombs. */
  private ownTriggerOnly(w: World, c: number): boolean {
    if (this.dg.firstBlast[c] === INF) return true;
    if (this.dg.blastOwner[c] !== this.me) return false;
    for (const b of w.bombs) if (b.owner === this.me && b.type !== BombType.TRIGGER) return false;
    for (const b of w.bombs) if (b.owner !== this.me && manhattan(b.cell, c) <= b.flame + 1) return false;
    return true;
  }

  /** Small moves toward the cell's anchor while standing (keeps both lanes open). */
  private center(me: PlayerInfo): number {
    if (Math.abs(me.ox) > 3) return me.ox > 0 ? IN_LEFT : IN_RIGHT;
    if (Math.abs(me.oy) > 3) return me.oy > 0 ? IN_UP : IN_DOWN;
    return 0;
  }

  private tryTargetDrop(w: World, me: PlayerInfo): void {
    const p = this.plan!;
    if (!this.canDropHere(w, me)) return;
    if (this.failed[me.cell] > w.tick) return;
    // still making up our mind (decision lag)
    if (this.pendCell === me.cell && w.tick < this.pendAt) return;
    const enemyNear = this.enemyNear(w, me, me.cell, me.flame + 2);
    const ev = this.evalDrop(w, me, me.cell, enemyNear && this.prof.trap >= 1);
    this.recheck = this.pendCell === me.cell;
    const want = ev.ok && (p.goal === G_BRICK ? ev.bricks - ev.powerLoss > 0 || ev.kills > 0 : this.wantDrop(w, me, ev, enemyNear) || ev.bricks > 0);
    this.recheck = false;
    if (want) {
      this.layBomb(w, me, ev, p.goal, true);
    } else {
      this.pendCell = -1;
      this.failed[me.cell] = w.tick + 40;
      this.nextPlan = 0;
    }
  }
}

/** Progress along a plan: the waypoint the bot is in (paths may revisit cells, so only step forward). */
function locate(p: Plan, cell: number): number {
  const path = p.path;
  let k = p.idx;
  if (path[k].cell === cell) return k;
  for (let j = 1; j <= 2 && k + j < path.length; j++) if (path[k + j].cell === cell) return k + j;
  return -1;
}

function dirOf(bits: number): number {
  if (bits & IN_LEFT) return 3;
  if (bits & IN_DOWN) return 2;
  if (bits & IN_RIGHT) return 1;
  if (bits & IN_UP) return 0;
  return -1;
}
