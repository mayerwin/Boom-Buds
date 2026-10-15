// Headless AI tournaments: round-robin 1v1 matches between difficulty levels plus free-for-alls, on every
// arena level (0..10) and several schemes. Reports win rates per level pair, suicide rates, death causes
// (self-kill / trapped / killed by an enemy / enclosement, see DeathTracker), round lengths, the AI cost per
// tick and an idle check (exit code 1 if a bot stood still for more than IDLE_LIMIT_S while able to move).
// Pressure metrics catch passive bots: the longest time a bot could have dropped a bomb (one ready, an enemy
// within 5 cells, a safe escape after dropping) without doing so, its drop rate once few bricks are left,
// and time-out draws with opponents still close. --dummies N adds rounds of every level against scripted
// non-bot opponents (tools/ai-dummies.ts: standing still, wandering, fleeing); --trio N adds three-bot
// free-for-alls and two-against-one team rounds at level --trio-level (default 3).
//
//   node tools/ai-arena.ts                      default tournament (100 rounds per adjacent level pair)
//   node tools/ai-arena.ts --rounds 200 --pairs 1-2,2-3,3-4,4-5 --ffa 40 --workers 16
//   node tools/ai-arena.ts --quick              small smoke run
//   node tools/ai-arena.ts --pairs 0-1,0-2,0-3 --ffa 0 --ffa9 0   AI level 0 (the original game's AI)
//
// Options: --rounds N (per pair), --pairs a-b,..., --ffa N (4-player FFA rounds), --ffa-levels a,b,c,d (their
// levels, default 2,3,4,5), --ffa9 N (9 bots, CPU stress), --levels 0,1,..10 (arenas), --schemes A.SCH,B.SCH,
// --seed S, --workers N, --time S (round time, default 150), --depth D (enclosement depth, default 2),
// --dummy-levels a,b,.. (levels of the --dummies rounds, default 1..5), --ai0-hz 20|60 (think rate of AI level
// 0, default its own), --verbose. AI levels are 0..5: level 0 is the original game's AI
// (src/game/ai/original.ts); RoundJob.levels stores it as LEVEL0, as 0 marks an empty slot.

import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { AnimDB } from '../src/game/sim/anims.ts';
import { FrameCtx } from '../src/game/sim/ctx.ts';
import { createGame, roundStart, step, flattenValues, roundWinner, roundTimeUp, type MatchConfig } from '../src/game/sim/sim.ts';
import type { TextJson } from '../src/engine/assets.ts';
import type { GameState } from '../src/game/sim/types.ts';
import { DX, DY, BombState, BombType } from '../src/game/sim/types.ts';
import { pxToCx, pyToCy } from '../src/game/sim/map.ts';
import { createAi, type AiPlayer } from '../src/game/ai/index.ts';
import { OriginalAi } from '../src/game/ai/original.ts';
import { World } from '../src/game/ai/world.ts';
import { Danger, makeSpec, type BombSpec } from '../src/game/ai/danger.ts';
import { Reach, type ReachOpts } from '../src/game/ai/reach.ts';
import { TRIGGER_GRACE } from '../src/game/ai/perception.ts';
import { stepsUntil } from '../src/game/ai/timing.ts';
import { Dummy, DUMMY_KINDS, type DummyKind } from './ai-dummies.ts';

/** RoundJob.levels code of AI level 0, the original game's AI (0 itself marks an empty slot). */
export const LEVEL0 = 10;
/** AI level codes in report order. */
const LEVEL_CODES = [LEVEL0, 1, 2, 3, 4, 5];

/** The createAi level of a RoundJob.levels code. */
export function aiLevel(code: number): number {
  return code === LEVEL0 ? 0 : code;
}

/** The RoundJob.levels code of an AI level (0..5). */
export function levelCode(level: number): number {
  return level === 0 ? LEVEL0 : level;
}

function label(code: number): string {
  return `L${aiLevel(code)}`;
}

export interface RoundJob {
  id: number;
  /** AI level code per slot (0 = empty slot, LEVEL0 = AI level 0, 1..5) */
  levels: number[];
  /** think rate of AI level 0 (default: its own, see original.ts) */
  ai0Hz?: number;
  /** team per slot (-1 = default) */
  teams?: number[];
  seed: number;
  levelno: number;
  scheme: string;
  playtime: number;
  depth: number;
  teamPlay?: number;
  /** scripted non-bot opponent per slot ('' none; see DummyKind) */
  dummies?: string[];
}

export interface DeathRecord {
  slot: number;
  killer: number;
  tick: number;
}

export interface RoundResult {
  id: number;
  levels: number[];
  levelno: number;
  scheme: string;
  /** winning slot (or team in team play), -1 draw */
  winner: number;
  ticks: number;
  deaths: DeathRecord[];
  /** total milliseconds spent in think() and number of think() calls */
  aiMs: number;
  aiCalls: number;
  /** worst single-tick AI time (all bots) in ms */
  aiMaxTick: number;
  /** slots that did not move for IDLE_LIMIT_S+ s while alive and able to (not boxed in, stunned, warping) */
  stuck: number[];
  /** longest idle stretch (ticks) per slot */
  idle: number[];
  /** classified deaths */
  kinds: DeathInfo[];
  /** per slot: most time (steps) a bot could have dropped a bomb (one ready, an enemy within 5 cells, a safe
   * escape after dropping) without dropping one */
  passive: number[];
  /** per slot: bombs dropped, and bombs dropped / steps alive while few bricks were left */
  drops: number[];
  lateDrops: number[];
  lateSteps: number[];
  /** ended by the clock with opponents alive and within 5 cells of each other */
  closeTimeout: boolean;
  /** ended by the round clock */
  timeUp: boolean;
  teamPlay: number;
  dummies: string[];
  /** bombs dropped per slot */
  error?: string;
}

const ROOT = fileURLToPath(new URL('..', import.meta.url));

let data: { text: TextJson; anims: AnimDB } | null = null;
function load(): { text: TextJson; anims: AnimDB } {
  if (!data) {
    const sprites = JSON.parse(readFileSync(ROOT + 'public/data/sprites/sprites.json', 'utf8'));
    const text: TextJson = JSON.parse(readFileSync(ROOT + 'public/data/text.json', 'utf8'));
    data = { text, anims: new AnimDB(sprites.seqs) };
  }
  return data;
}

export function makeConfig(job: RoundJob): MatchConfig {
  const { text } = load();
  const scheme = text.schemes.find((s) => s.file === job.scheme) ?? text.schemes.find((s) => s.file === 'BASIC.SCH')!;
  return {
    // bots are AI-controlled (1); scripted dummies come in as human players (2)
    slots: Array.from({ length: 10 }, (_, i) => ({ ctrl: (job.levels[i] ?? 0) > 0 ? 1 : job.dummies?.[i] ? 2 : 0, team: job.teams?.[i] ?? -1 })),
    values: flattenValues(text.values),
    scheme,
    extras: text.extras,
    levelno: job.levelno,
    numToWin: 3,
    winByKills: 0,
    teamPlay: job.teamPlay ?? 0,
    randomStart: 1,
    enclosementDepth: job.depth,
    conveyorSpeed: 1,
    stompedBombsDetonate: 1,
    diseasesDestroyable: 1,
    playtime: job.playtime,
    netMode: 0,
    goldWinner: -1,
    goldPrize: -1,
    attract: 0,
    seed: job.seed,
  };
}

/** Play one round with AI players on every non-empty slot. */
export function playRound(job: RoundJob, maxTicks = 60 * 200): RoundResult {
  const { text, anims } = load();
  const cfg = makeConfig(job);
  const s = createGame(cfg);
  roundStart(s, cfg.scheme, text.extras);
  const ctx = new FrameCtx(anims);
  const ais: (AiPlayer | null)[] = job.levels.map((lv, i) => {
    if (!(lv > 0)) return null;
    const seed = (job.seed * 31 + i * 7919) >>> 0;
    if (lv === LEVEL0 && job.ai0Hz) return new OriginalAi(seed, job.ai0Hz);
    return createAi({ level: aiLevel(lv) as 0 | 1 | 2 | 3 | 4 | 5, seed });
  });
  for (const a of ais) a?.reset();
  const dummies = Array.from({ length: 10 }, (_, i) => {
    const k = job.dummies?.[i];
    return k && !((job.levels[i] ?? 0) > 0) ? new Dummy(k as DummyKind, (job.seed * 17 + i * 101) >>> 0) : null;
  });
  const inputs = new Uint8Array(10);
  const res: RoundResult = {
    id: job.id, levels: job.levels, levelno: s.opts.level, scheme: job.scheme, winner: -1, ticks: 0, deaths: [],
    aiMs: 0, aiCalls: 0, aiMaxTick: 0, stuck: [], idle: new Array(10).fill(0), kinds: [],
    passive: new Array(10).fill(0), drops: new Array(10).fill(0), lateDrops: new Array(10).fill(0), lateSteps: new Array(10).fill(0), closeTimeout: false, timeUp: false,
    teamPlay: job.teamPlay ?? 0, dummies: job.dummies ?? [],
  };
  const pressure = new PressureTracker(ais.map((a) => a !== null));
  const lastMove = new Array(10).fill(0);
  const lastPos = new Array(10).fill(-1);
  const stuck = new Set<number>();
  const tracker = new DeathTracker();
  try {
    let t = 0;
    for (; t < maxTicks && !s.roundOver; t++) {
      for (let i = 0; i < 10; i++) inputs[i] = dummies[i] ? dummies[i]!.think(s, i) : 0;
      const a0 = performance.now();
      for (let i = 0; i < 10; i++) {
        const ai = ais[i];
        if (ai) inputs[i] = ai.think(s, i);
      }
      const a1 = performance.now();
      const dt = a1 - a0;
      res.aiMs += dt;
      res.aiCalls++;
      if (dt > res.aiMaxTick && t > 70) res.aiMaxTick = dt;
      tracker.before(s);
      step(s, ctx, inputs);
      tracker.after(s, ctx);
      pressure.after(s, res);
      for (const e of ctx.events) if (e.type === 'death') res.deaths.push({ slot: e.a, killer: e.b, tick: s.tick });
      for (let i = 0; i < 10; i++) {
        const p = s.players[i];
        if (!ais[i] || !p.alive || p.dying) continue;
        const pos = p.x * 1000 + p.y;
        // boxed in (cornerhead), stunned, warping or bouncing: nothing to do
        const unable = (p.anim >= 3 && p.anim <= 7) || (p.anim >= 20 && p.anim < 40) || s.pl.roundFreezeMs > 0;
        if (pos !== lastPos[i] || unable) {
          lastPos[i] = pos;
          lastMove[i] = t;
        } else {
          res.idle[i] = Math.max(res.idle[i], t - lastMove[i]);
          if (t - lastMove[i] > 60 * IDLE_LIMIT_S) stuck.add(i);
        }
      }
    }
    res.ticks = t;
    res.winner = s.roundOver ? roundWinner(s) : -1;
    if (res.winner < 0) res.closeTimeout = closeOpponents(s, 5);
    res.timeUp = s.roundOver === 1 && roundTimeUp(s);
  } catch (e) {
    res.error = e instanceof Error ? e.stack ?? e.message : String(e);
  }
  res.stuck = [...stuck];
  res.kinds = tracker.kinds;
  return res;
}

/** a bot idle for longer than this (seconds) counts as stuck and fails the arena check */
export const IDLE_LIMIT_S = 8;

// -------------------------------------------------------------------------------------------------------
// death classification

/** How a death came about, judged from the bombs that actually burned the victim. */
export type DeathKind = 'self' | 'trapped' | 'enemy' | 'env';

export interface DeathInfo {
  slot: number;
  kind: DeathKind;
  tick: number;
  /** own-bomb death although the escape oracle saw a way out until the end (a misstep) */
  missed?: boolean;
  /** steps between the moment the victim was doomed and its death */
  doomed?: number;
  /** what happened at the moment the victim became doomed (own-drop, enemy-drop, kick, walk) */
  why?: string;
}

interface BombLife {
  /** original dropper (chain reactions transfer the sim's owner field) */
  orig: number;
  cell: number;
  from: number;
  to: number;
  /** kicked / punched / thrown while an enemy of the dropper stood next to it */
  enemyMoved: boolean;
}

/**
 * Perfect-information escape check on the current field: can the player still reach a spot that stays safe
 * from every bomb on the field (chains, kicked / flying bombs, conveyors, flames, enclosement)? Uses the bots'
 * own danger model and safe-interval search, with margin 0 and no reaction delay. Enemy trigger bombs count as
 * going off right away; the player's own triggers as never (it decides when they go off).
 */
class EscapeOracle {
  readonly w = new World();
  private dg = new Danger();
  private r = new Reach();
  private pool: BombSpec[] = [];
  private specs: BombSpec[] = [];
  private o: ReachOpts = { cell: 0, ox: 0, oy: 0, speed: 1, margin: 0, horizon: 0, useWarps: true, avoid: null, maxSteps: 420, any: true };
  private sharedTick = -1;
  private hasTrigger = false;

  load(s: GameState): void {
    this.w.build(s);
    this.sharedTick = -1;
    this.hasTrigger = this.w.bombs.some((b) => b.type === BombType.TRIGGER && !b.queued);
  }

  /** `keep(slot)`: only the bombs passing the filter exist (null: all bombs) */
  escapes(v: number, keep: ((slot: number) => boolean) | null): boolean {
    const w = this.w;
    const p = w.players[v];
    if (!p || p.cell < 0) return true;
    if (keep || this.hasTrigger || this.sharedTick !== w.tick) {
      this.build(v, keep);
      this.sharedTick = keep || this.hasTrigger ? -1 : w.tick;
    }
    const o = this.o;
    o.cell = p.cell;
    o.ox = p.ox;
    o.oy = p.oy;
    o.speed = p.speed;
    o.horizon = w.tick + 240;
    return this.r.run(w, this.dg, o) && this.r.havens > 0;
  }

  /** Could player v drop a bomb now (one ready) and still reach a spot that stays safe (margin 1)? */
  dropSafe(v: number): boolean {
    const w = this.w;
    const p = w.players[v];
    if (!p || p.cell < 0 || !p.canDrop || w.warpDest[p.cell] >= 0) return false;
    this.fill(v, null);
    const h = this.hyp;
    h.slot = -1;
    h.owner = v;
    h.type = BombType.REGULAR;
    h.flame = p.flame;
    h.cell = p.cell;
    h.track = null;
    h.alt = null;
    h.from = w.tick + 1;
    h.tOwn = w.tick + 1 + stepsUntil(w.tick + 1, p.fuseMs);
    h.forever = false;
    h.blind = false;
    h.noChain = false;
    this.specs.push(h);
    this.dg.build(w, this.specs);
    this.sharedTick = -1;
    const o = this.o;
    o.cell = p.cell;
    o.ox = p.ox;
    o.oy = p.oy;
    o.speed = p.speed;
    o.horizon = w.tick + 240;
    o.margin = 1;
    const ok = this.r.run(w, this.dg, o) && this.r.havens > 0;
    o.margin = 0;
    return ok;
  }
  private hyp: BombSpec = makeSpec();

  private build(v: number, keep: ((slot: number) => boolean) | null): void {
    this.fill(v, keep);
    this.dg.build(this.w, this.specs);
  }

  private fill(v: number, keep: ((slot: number) => boolean) | null): void {
    const w = this.w;
    const specs = this.specs;
    specs.length = 0;
    let used = 0;
    for (const b of w.bombs) {
      if (b.state === BombState.HELD) continue;
      if (keep && !keep(b.slot)) continue;
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
        const o = b.owner >= 0 && b.owner < w.players.length ? w.players[b.owner] : null;
        if (b.owner === v || !o || !o.alive) {
          sp.tOwn = Infinity;
        } else {
          sp.tOwn = w.tick + 1 + TRIGGER_GRACE;
          sp.forever = true;
        }
      }
      if (sp.cell < 0 && !sp.track) continue;
      specs.push(sp);
    }
  }
}

/** bricks left on the field below which the late-game drop rate is measured */
export const FEW_BRICKS = 10;
/** an enemy this close (Manhattan) makes a bot's bomb count as pressure */
const PRESSURE_DIST = 5;

function opponents(s: GameState, a: number, b: number): boolean {
  if (a === b) return false;
  return !s.opts.teamPlay || s.players[a].team !== s.players[b].team;
}

function cellOfPlayer(s: GameState, i: number): number {
  const p = s.players[i];
  return pyToCy(p.y) * 15 + pxToCx(p.x);
}

function closeOpponents(s: GameState, dist: number): boolean {
  for (let a = 0; a < 10; a++) {
    const pa = s.players[a];
    if (!pa.alive || pa.dying) continue;
    for (let b = a + 1; b < 10; b++) {
      const pb = s.players[b];
      if (!pb.alive || pb.dying || !opponents(s, a, b)) continue;
      const ca = cellOfPlayer(s, a);
      const cb = cellOfPlayer(s, b);
      if (Math.abs((ca % 15) - (cb % 15)) + Math.abs(Math.floor(ca / 15) - Math.floor(cb / 15)) <= dist) return true;
    }
  }
  return false;
}

/**
 * Passivity of the bots: counts their drops (overall and while few bricks are left) and, every third step,
 * whether each bot could drop a bomb right now with a safe escape while an enemy is close; that time adds up
 * until the bot's next drop (RoundResult.passive keeps the longest such stretch).
 */
class PressureTracker {
  private oracle = new EscapeOracle();
  private born = new Int32Array(100).fill(-1);
  private since = new Float64Array(10);
  private late = false;
  private bots: boolean[];

  constructor(bots: boolean[]) {
    this.bots = bots;
  }

  after(s: GameState, res: RoundResult): void {
    for (let i = 0; i < 100; i++) {
      const b = s.bombs[i];
      if (!b.active || this.born[i] === b.born) continue;
      this.born[i] = b.born;
      const o = b.owner;
      if (o < 0 || o >= 10 || !this.bots[o]) continue;
      res.drops[o]++;
      if (this.late) res.lateDrops[o]++;
      this.since[o] = 0;
    }
    if (s.tick % 3 !== 0) return;
    let bricks = 0;
    for (let c = 0; c < 165; c++) if (s.map[c] === 2) bricks++;
    this.late = bricks <= FEW_BRICKS;
    let loaded = false;
    for (let v = 0; v < 10; v++) {
      if (!this.bots[v]) continue;
      const p = s.players[v];
      if (!p.alive || p.dying) continue;
      if (this.late) res.lateSteps[v] += 3;
      const cv = cellOfPlayer(s, v);
      let near = false;
      for (let e = 0; e < 10 && !near; e++) {
        const q = s.players[e];
        if (!q.alive || q.dying || !opponents(s, v, e)) continue;
        const ce = cellOfPlayer(s, e);
        if (Math.abs((cv % 15) - (ce % 15)) + Math.abs(Math.floor(cv / 15) - Math.floor(ce / 15)) <= PRESSURE_DIST) near = true;
      }
      if (!near) continue;
      if (!loaded) {
        this.oracle.load(s);
        loaded = true;
      }
      if (!this.oracle.dropSafe(v)) continue;
      this.since[v] += 3;
      if (this.since[v] > res.passive[v]) res.passive[v] = this.since[v];
    }
  }
}

/**
 * Reconstructs, step by step, which bombs (by original dropper) produced the flames that killed a player:
 * every explosion's blast is recomputed on the pre-step map, chain links are followed (an arm that stops on a
 * bomb sets it off), and the newest blast per cell is remembered. Deaths are then classified:
 *  - enemy:   an enemy-dropped bomb is part of the killing chain
 *  - env:     enclosement block (no flame owner)
 *  - otherwise only the victim's own (or allied) bombs burned it, and a perfect-information escape oracle,
 *    run every step, decides: at the first step from which the victim could no longer escape (with all bombs
 *    on the field), would it still have escaped if the enemies' bombs were not there?
 *      trapped: yes (enemy bombs cut the escape), or an enemy kicked / punched one of the killing bombs
 *      self:    no (its own bombs alone doomed it), or the oracle saw a way out until the end (a misstep)
 * Players never block each other in this game, so only bombs (and their flames) can cut an escape.
 */
export class DeathTracker {
  private born = new Int32Array(100).fill(-1);
  private life: (BombLife | null)[] = new Array(100).fill(null);
  private prevActive = new Uint8Array(100);
  private prevCell = new Int16Array(100);
  private prevFlame = new Int16Array(100);
  private prevState = new Int8Array(100);
  private prevMap = new Uint8Array(165);
  private prevPower = new Uint8Array(165);
  private chainedBy = new Int32Array(100).fill(-1);
  private parent: number[] = [];
  private exLife: BombLife[] = [];
  private exTick: number[] = [];
  private lastBlast = new Int32Array(165).fill(-1);
  private lastBlastTick = new Int32Array(165).fill(-1000);
  private oracle = new EscapeOracle();
  private doomTick = new Int32Array(10).fill(-1);
  private doomOwn = new Uint8Array(10);
  private doomWhy: string[] = new Array(10).fill('');
  readonly kinds: DeathInfo[] = [];

  private find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }

  private enemies(s: GameState, a: number, b: number): boolean {
    if (a === b || a < 0 || b < 0) return false;
    return !s.opts.teamPlay || s.players[a].team !== s.players[b].team;
  }

  /** bomb in `slot` was dropped by v or an ally */
  private ownBomb(s: GameState, v: number, slot: number): boolean {
    const b = s.bombs[slot];
    const l = this.life[slot];
    const orig = l && this.born[slot] === b.born ? l.orig : b.owner;
    return orig === v || (orig >= 0 && !this.enemies(s, v, orig));
  }

  /** Call before step(): remember the field and register new bombs. */
  before(s: GameState): void {
    for (let i = 0; i < 165; i++) {
      this.prevMap[i] = s.map[i];
      this.prevPower[i] = s.powers[i].state === 2 && s.map[i] === 0 ? 1 : 0;
    }
    for (let i = 0; i < 100; i++) {
      const b = s.bombs[i];
      const cx = pxToCx(b.x);
      const cy = pyToCy(b.y);
      const cell = cx >= 0 && cy >= 0 && cx < 15 && cy < 11 ? cy * 15 + cx : -1;
      if (b.active && this.born[i] !== b.born) {
        this.born[i] = b.born;
        this.life[i] = { orig: b.owner, cell, from: s.tick, to: s.tick, enemyMoved: false };
        this.chainedBy[i] = -1;
      }
      this.prevActive[i] = b.active ? 1 : 0;
      this.prevCell[i] = cell;
      this.prevFlame[i] = b.flameLen;
      this.prevState[i] = b.state;
    }
  }

  /** Call after step(). */
  after(s: GameState, ctx: FrameCtx): void {
    const tick = s.tick;
    let kicked = false;
    // moved bombs: who stood next to them when they started moving?
    for (let i = 0; i < 100; i++) {
      const b = s.bombs[i];
      if (b.active && this.born[i] !== b.born && (b.state === 1 || b.state === 2)) {
        // dropped and kicked within the same step (a kicker walking into the cell as the bomb appears)
        this.born[i] = b.born;
        const cx0 = pxToCx(b.x);
        const cy0 = pyToCy(b.y);
        this.life[i] = { orig: b.owner, cell: cy0 * 15 + cx0, from: tick - 1, to: tick, enemyMoved: false };
        this.chainedBy[i] = -1;
        this.prevState[i] = 0;
      }
      const l = this.life[i];
      if (!b.active || !l || this.born[i] !== b.born) continue;
      l.to = tick;
      const cx = pxToCx(b.x);
      const cy = pyToCy(b.y);
      if (cx >= 0 && cy >= 0 && cx < 15 && cy < 11) l.cell = cy * 15 + cx;
      if ((b.state === 1 || b.state === 2) && this.prevState[i] === 0) {
        kicked = true;
        for (const p of s.players) {
          if (!p.alive || p.dying || !this.enemies(s, l.orig, p.index)) continue;
          if (Math.abs(pxToCx(p.x) - pxToCx(b.x)) + Math.abs(pyToCy(p.y) - pyToCy(b.y)) <= 1) l.enemyMoved = true;
        }
      }
    }
    // explosions of this step, blasts on the pre-step field
    for (let i = 0; i < 100; i++) {
      if (!this.prevActive[i]) continue;
      const b = s.bombs[i];
      if (b.active && this.born[i] === b.born) continue;
      const l = this.life[i];
      const p = this.prevCell[i];
      if (!l || p < 0) continue;
      const id = this.parent.length;
      this.parent.push(id);
      this.exLife.push(l);
      this.exTick.push(tick);
      if (this.chainedBy[i] >= 0) this.parent[id] = this.find(this.chainedBy[i]);
      this.mark(p, id, tick);
      for (let d = 0; d < 4; d++) {
        let x = p % 15;
        let y = Math.floor(p / 15);
        for (let k = 0; k < this.prevFlame[i]; k++) {
          x += DX[d];
          y += DY[d];
          if (x < 0 || y < 0 || x >= 15 || y >= 11) break;
          const c = y * 15 + x;
          let hit = -1;
          for (let j = 0; j < 100; j++) {
            if (j !== i && this.prevActive[j] && this.prevCell[j] === c && this.prevState[j] !== 2 && this.prevState[j] !== 3) { hit = j; break; }
          }
          if (hit >= 0) {
            // chain: that bomb goes off now or in the next step as part of this chain
            this.chainedBy[hit] = this.find(id);
            break;
          }
          if (this.prevPower[c]) break;
          const m = this.prevMap[c];
          if (m === 1 || m === 2) break;
          this.mark(c, id, tick);
        }
      }
    }
    for (const e of ctx.events) {
      if (e.type !== 'death') continue;
      const v = e.a;
      const pl = s.players[v];
      const cell = pyToCy(pl.y) * 15 + pxToCx(pl.x);
      this.kinds.push(this.classify(s, v, e.b, cell, tick));
    }
    // escape oracle: from which step on was each player doomed, and would it have been without enemy bombs?
    let any = false;
    for (let i = 0; i < 100 && !any; i++) if (s.bombs[i].active) any = true;
    let loaded = false;
    for (let v = 0; v < 10; v++) {
      const p = s.players[v];
      if (!any || !p.alive || p.dying) {
        this.doomTick[v] = -1;
        continue;
      }
      if (!loaded) {
        this.oracle.load(s);
        loaded = true;
      }
      if (this.oracle.escapes(v, null)) {
        this.doomTick[v] = -1;
        continue;
      }
      if (this.doomTick[v] >= 0) continue;
      this.doomTick[v] = tick;
      this.doomOwn[v] = this.oracle.escapes(v, (slot) => this.ownBomb(s, v, slot)) ? 1 : 0;
      // what changed in this step?
      let why = 'walk';
      for (let i = 0; i < 100; i++) {
        const b = s.bombs[i];
        if (!b.active || this.born[i] === b.born) continue;
        if (b.owner === v) why = 'own-drop';
        else if (why === 'walk' && this.enemies(s, v, b.owner)) why = 'enemy-drop';
      }
      if (why === 'walk' && kicked) why = 'kick';
      this.doomWhy[v] = why;
    }
  }

  private mark(c: number, id: number, tick: number): void {
    this.lastBlast[c] = id;
    this.lastBlastTick[c] = tick;
  }

  private classify(s: GameState, v: number, killer: number, cell: number, tick: number): DeathInfo {
    const info: DeathInfo = { slot: v, kind: 'self', tick };
    if (killer < 0) {
      info.kind = 'env';
      return info;
    }
    const e = cell >= 0 && cell < 165 && tick - this.lastBlastTick[cell] <= 32 ? this.lastBlast[cell] : -1;
    let moved = false;
    if (e >= 0) {
      const root = this.find(e);
      let own = 0;
      for (let x = this.parent.length - 1; x >= 0 && tick - this.exTick[x] < 240; x--) {
        if (this.find(x) !== root) continue;
        const l = this.exLife[x];
        if (this.enemies(s, v, l.orig)) {
          info.kind = 'enemy';
          return info;
        }
        own++;
        if (l.enemyMoved) moved = true;
      }
      if (!own && this.enemies(s, v, killer)) {
        info.kind = 'enemy';
        return info;
      }
    } else if (this.enemies(s, v, killer)) {
      // flames not reconstructed: trust the simulation's attribution
      info.kind = 'enemy';
      return info;
    }
    // only own (or allied) bombs: the escape oracle decides
    if (this.doomTick[v] >= 0) {
      info.doomed = tick - this.doomTick[v];
      info.why = this.doomWhy[v];
      info.kind = this.doomOwn[v] || moved ? 'trapped' : 'self';
    } else {
      info.missed = true;
      info.kind = moved ? 'trapped' : 'self';
    }
    return info;
  }
}


// -------------------------------------------------------------------------------------------------------
// tournament driver

interface Args {
  rounds: number;
  /** level codes (LEVEL0 for AI level 0) */
  pairs: [number, number][];
  ffa: number;
  ffaLevels: number[];
  ffa9: number;
  levels: number[];
  schemes: string[];
  seed: number;
  workers: number;
  time: number;
  depth: number;
  verbose: boolean;
  dummies: number;
  dummyLevels: number[];
  trio: number;
  trioLevel: number;
  ai0Hz: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    rounds: 100,
    pairs: [[1, 2], [2, 3], [3, 4], [4, 5]],
    ffa: 40,
    ffaLevels: [2, 3, 4, 5],
    ffa9: 4,
    levels: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    schemes: ['BASIC.SCH', 'BASIC.SCH', 'BASIC.SCH', 'BMAN93.SCH', 'X.SCH', 'CHASE.SCH', 'NEIGHBOR.SCH', 'SPREAD.SCH'],
    seed: 1,
    workers: Math.max(1, Math.min(cpus().length - 2, 16)),
    time: 150,
    depth: 2,
    verbose: false,
    dummies: 0,
    dummyLevels: [1, 2, 3, 4, 5],
    trio: 0,
    trioLevel: 3,
    ai0Hz: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case '--rounds': a.rounds = Number(v); i++; break;
      case '--pairs': a.pairs = v.split(',').map((p) => p.split('-').map((x) => levelCode(Number(x))) as [number, number]); i++; break;
      case '--ffa': a.ffa = Number(v); i++; break;
      case '--ffa-levels': a.ffaLevels = v.split(',').map((x) => levelCode(Number(x))); i++; break;
      case '--ai0-hz': a.ai0Hz = Number(v); i++; break;
      case '--ffa9': a.ffa9 = Number(v); i++; break;
      case '--levels': a.levels = v.split(',').map(Number); i++; break;
      case '--schemes': a.schemes = v.split(','); i++; break;
      case '--seed': a.seed = Number(v); i++; break;
      case '--workers': a.workers = Number(v); i++; break;
      case '--time': a.time = Number(v); i++; break;
      case '--depth': a.depth = Number(v); i++; break;
      case '--verbose': a.verbose = true; break;
      case '--dummies': a.dummies = Number(v); i++; break;
      case '--dummy-levels': a.dummyLevels = v.split(',').map((x) => levelCode(Number(x))); i++; break;
      case '--trio': a.trio = Number(v); i++; break;
      case '--trio-level': a.trioLevel = levelCode(Number(v)); i++; break;
      case '--quick': a.rounds = 10; a.ffa = 4; a.ffa9 = 1; break;
    }
  }
  return a;
}

function makeJobs(a: Args): RoundJob[] {
  const jobs: RoundJob[] = [];
  let id = 0;
  let k = 0;
  const pick = <T>(arr: T[], n: number) => arr[n % arr.length];
  for (const [x, y] of a.pairs) {
    for (let r = 0; r < a.rounds; r++) {
      const levels = new Array(10).fill(0);
      // alternate the slots so start positions are fair (random start shuffles them anyway)
      if (r % 2 === 0) { levels[0] = x; levels[1] = y; } else { levels[0] = y; levels[1] = x; }
      jobs.push({ id: id++, levels, seed: a.seed * 100003 + k * 7 + 1, levelno: pick(a.levels, r), scheme: pick(a.schemes, Math.floor(r / a.levels.length) + r), playtime: a.time, depth: a.depth });
      k++;
    }
  }
  for (let r = 0; r < a.ffa; r++) {
    const levels = new Array(10).fill(0);
    const order = a.ffaLevels;
    for (let i = 0; i < order.length; i++) levels[i] = order[(i + r) % order.length];
    jobs.push({ id: id++, levels, seed: a.seed * 100003 + k * 7 + 3, levelno: pick(a.levels, r), scheme: pick(a.schemes, r * 3), playtime: a.time, depth: a.depth });
    k++;
  }
  for (let r = 0; r < a.ffa9; r++) {
    const levels = [1, 2, 3, 4, 5, 5, 4, 3, 2, 0];
    jobs.push({ id: id++, levels, seed: a.seed * 100003 + k * 7 + 5, levelno: pick(a.levels, r * 5), scheme: 'BASIC.SCH', playtime: a.time, depth: a.depth });
    k++;
  }
  // three bots: free-for-all, and two against one in team play
  for (let r = 0; r < a.trio; r++) {
    const L = a.trioLevel;
    const levels = [L, L, L, 0, 0, 0, 0, 0, 0, 0];
    jobs.push({ id: id++, levels, seed: a.seed * 100003 + k * 7 + 2, levelno: pick(a.levels, r), scheme: pick(a.schemes, r), playtime: a.time, depth: a.depth });
    k++;
    const teams = [0, 0, 1, -1, -1, -1, -1, -1, -1, -1];
    jobs.push({ id: id++, levels: [...levels], teams, teamPlay: 1, seed: a.seed * 100003 + k * 7 + 4, levelno: pick(a.levels, r + 3), scheme: pick(a.schemes, r + 1), playtime: a.time, depth: a.depth });
    k++;
  }
  // every level against each scripted non-bot opponent
  for (let r = 0; r < a.dummies; r++) {
    for (const lv of a.dummyLevels) {
      for (const kind of DUMMY_KINDS) {
        const levels = new Array(10).fill(0);
        const dummies = new Array(10).fill('');
        const swap = r % 2 === 1;
        levels[swap ? 1 : 0] = lv;
        dummies[swap ? 0 : 1] = kind;
        // the same field for every level and slot order: only the bot differs
        jobs.push({ id: id++, levels, dummies, seed: a.seed * 100003 + 900001 + r * 31 + DUMMY_KINDS.indexOf(kind), levelno: pick(a.levels, r), scheme: pick(a.schemes, r * 3), playtime: a.time, depth: a.depth });
        k++;
      }
    }
  }
  if (a.ai0Hz) for (const j of jobs) j.ai0Hz = a.ai0Hz;
  return jobs;
}

function pct(n: number, d: number): string {
  return d > 0 ? `${((100 * n) / d).toFixed(1)}%` : '-';
}

function report(a: Args, results: RoundResult[], wallS: number): void {
  const byId = results.sort((p, q) => p.id - q.id);
  const errors = byId.filter((r) => r.error);
  console.log(`\n${byId.length} rounds in ${wallS.toFixed(1)} s wall time`);
  if (errors.length) {
    console.log(`ERRORS: ${errors.length}`);
    for (const e of errors.slice(0, 3)) console.log(e.error);
  }
  // 1v1 pairs
  console.log('\n1v1 head-to-head (win rate of the higher level; draws listed separately)');
  console.log('pair   rounds  hiWins loWins draws  hiRate(decisive)  hiRate(all)  avgLen  timeUp');
  for (const [x, y] of a.pairs) {
    const [lo, hi] = aiLevel(x) <= aiLevel(y) ? [x, y] : [y, x];
    const rs = byId.filter((r) => {
      const ls = r.levels.filter((l) => l > 0);
      return ls.length === 2 && ((ls[0] === lo && ls[1] === hi) || (ls[0] === hi && ls[1] === lo));
    });
    let hw = 0;
    let lw = 0;
    let dr = 0;
    let len = 0;
    let up = 0;
    for (const r of rs) {
      len += r.ticks;
      if (r.timeUp) up++;
      if (r.winner < 0) dr++;
      else if (r.levels[r.winner] === hi) hw++;
      else lw++;
    }
    console.log(`${label(lo)}-${label(hi)}  ${String(rs.length).padStart(6)}  ${String(hw).padStart(6)} ${String(lw).padStart(6)} ${String(dr).padStart(5)}  ${pct(hw, hw + lw).padStart(16)}  ${pct(hw, rs.length).padStart(11)}  ${(len / Math.max(rs.length, 1) / 60).toFixed(1).padStart(5)}s  ${String(up).padStart(6)}`);
  }
  // deaths per level
  console.log('\nDeaths per level (all rounds)');
  console.log('level  deaths  suicides  byEnemy  byWalls  suicideRate  rounds  wins');
  const present = LEVEL_CODES.filter((lv) => lv !== LEVEL0 || byId.some((r) => r.levels.includes(lv)));
  for (const lv of present) {
    let deaths = 0;
    let sui = 0;
    let enemy = 0;
    let walls = 0;
    let rounds = 0;
    let wins = 0;
    for (const r of byId) {
      const slots = r.levels.map((l, i) => (l === lv ? i : -1)).filter((i) => i >= 0);
      if (!slots.length) continue;
      rounds += slots.length;
      if (r.winner >= 0 && r.levels[r.winner] === lv) wins++;
      for (const d of r.deaths) {
        if (!slots.includes(d.slot)) continue;
        deaths++;
        if (d.killer === d.slot) sui++;
        else if (d.killer < 0) walls++;
        else enemy++;
      }
    }
    console.log(`${label(lv)}     ${String(deaths).padStart(6)}  ${String(sui).padStart(8)}  ${String(enemy).padStart(7)}  ${String(walls).padStart(7)}  ${pct(sui, deaths).padStart(11)}  ${String(rounds).padStart(6)}  ${String(wins).padStart(4)}`);
  }
  // death classification (original droppers along the killing chain)
  console.log('\nDeath causes per level (share of deaths). enemy = an enemy-dropped bomb in the killing chain; env =');
  console.log('enclosement; otherwise only own bombs burned the bot and a perfect-information escape check decides at the');
  console.log('step it became doomed: trapped = it would have escaped without the enemy bombs (or an enemy kicked one of');
  console.log('its bombs); self = its own bombs alone doomed it, or it missed an escape that existed until the end (missed)');
  console.log('level  deaths      self     trapped       enemy         env   missed');
  for (const lv of present) {
    const c = { self: 0, trapped: 0, enemy: 0, env: 0 };
    let n = 0;
    let missed = 0;
    for (const r of byId) {
      for (const k of r.kinds) {
        if (r.levels[k.slot] !== lv) continue;
        c[k.kind]++;
        n++;
        if (k.missed && k.kind === 'self') missed++;
      }
    }
    const f = (x: number) => `${String(x).padStart(4)} ${pct(x, n).padStart(6)}`;
    console.log(`${label(lv)}     ${String(n).padStart(6)}  ${f(c.self)}  ${f(c.trapped)}  ${f(c.enemy)}  ${f(c.env)}  ${String(missed).padStart(6)}`);
  }
  // pressure: passivity and the late-game drop rate per level
  console.log('\nPressure per level. passive = time a bomb was ready, an enemy within 5 cells and a safe escape after');
  console.log(`dropping existed, summed until the bot's next drop (longest per bot and round); late = drops per minute alive`);
  console.log(`with at most ${FEW_BRICKS} bricks left`);
  console.log('level   bots  passive p50    p90    max   >10s   late drops/min');
  for (const lv of present) {
    const vals: number[] = [];
    let lateD = 0;
    let lateS = 0;
    for (const r of byId) {
      for (let i = 0; i < 10; i++) {
        if (r.levels[i] !== lv) continue;
        vals.push(r.passive[i] / 60);
        lateD += r.lateDrops[i];
        lateS += r.lateSteps[i];
      }
    }
    if (!vals.length) continue;
    vals.sort((x, y) => x - y);
    const q = (f: number) => vals[Math.min(vals.length - 1, Math.floor(f * vals.length))];
    const over = vals.filter((x) => x > 10).length;
    console.log(`${label(lv)}    ${String(vals.length).padStart(6)}  ${q(0.5).toFixed(1).padStart(10)}  ${q(0.9).toFixed(1).padStart(5)}  ${vals[vals.length - 1].toFixed(1).padStart(5)}  ${pct(over, vals.length).padStart(5)}  ${lateS ? (lateD / (lateS / 3600)).toFixed(1).padStart(8) : '       -'}`);
  }
  const groups: [string, RoundResult[]][] = [
    ['1v1', byId.filter((r) => r.levels.filter((l) => l > 0).length === 2 && !r.dummies.some((d) => d))],
    ['3 bots FFA', byId.filter((r) => r.levels.filter((l) => l > 0).length === 3 && !r.teamPlay)],
    ['2 vs 1 teams', byId.filter((r) => r.levels.filter((l) => l > 0).length === 3 && r.teamPlay)],
    ['4 bots FFA', byId.filter((r) => r.levels.filter((l) => l > 0).length === 4)],
    ['vs scripted', byId.filter((r) => r.dummies.some((d) => d))],
  ];
  console.log('\nTime-out draws with opponents alive within 5 cells of each other:');
  console.log(groups.filter(([, rs]) => rs.length).map(([n, rs]) => `${n} ${rs.filter((r) => r.closeTimeout).length}/${rs.length} (draws ${rs.filter((r) => r.winner < 0).length})`).join(', '));
  const trio = byId.filter((r) => r.levels.filter((l) => l > 0).length === 3);
  if (trio.length) {
    const lv = trio[0].levels[0];
    const ffa3 = trio.filter((r) => !r.teamPlay);
    const team = trio.filter((r) => r.teamPlay);
    const avg = (rs: RoundResult[]) => (rs.reduce((t, r) => t + r.ticks, 0) / Math.max(1, rs.length) / 60).toFixed(1);
    console.log(`\nThree ${label(lv)} bots: FFA ${ffa3.length} rounds, draws ${ffa3.filter((r) => r.winner < 0).length}, avg ${avg(ffa3)} s; 2 vs 1 ${team.length} rounds, pair won ${team.filter((r) => r.winner === 0).length}, single won ${team.filter((r) => r.winner === 1).length}, draws ${team.filter((r) => r.winner < 0).length}, avg ${avg(team)} s`);
  }
  const dum = byId.filter((r) => r.dummies.some((d) => d));
  if (dum.length) {
    console.log('\nAgainst scripted non-bot opponents: killed by the bot / rounds, average time to the kill; crushed by the');
    console.log('closing walls instead (wall); rounds the bot died');
    console.log('level   ' + DUMMY_KINDS.map((k) => k.padEnd(30)).join(''));
    for (const lv of present) {
      const cols = DUMMY_KINDS.map((kind) => {
        const rs = dum.filter((r) => r.levels.includes(lv) && r.dummies.includes(kind));
        if (!rs.length) return '-';
        let killed = 0;
        let t = 0;
        let died = 0;
        let wall = 0;
        for (const r of rs) {
          const ds = r.dummies.indexOf(kind);
          const d = r.deaths.find((x) => x.slot === ds);
          if (d && d.killer >= 0) {
            killed++;
            t += d.tick;
          } else if (d) {
            wall++;
          }
          if (r.deaths.some((x) => x.slot !== ds)) died++;
        }
        return `${killed}/${rs.length} ${killed ? (t / killed / 60).toFixed(1) + 's' : '-'} wall ${wall} died ${died}`;
      });
      console.log(`${label(lv)}      ` + cols.map((c) => c.padEnd(30)).join(''));
    }
  }
  // FFA
  const ffa = byId.filter((r) => r.levels.filter((l) => l > 0).length === 4);
  if (ffa.length) {
    const wins = new Map<number, number>(a.ffaLevels.map((lv) => [lv, 0]));
    let draws = 0;
    for (const r of ffa) {
      if (r.winner < 0) draws++;
      else wins.set(r.levels[r.winner], (wins.get(r.levels[r.winner]) ?? 0) + 1);
    }
    const names = a.ffaLevels.map(label);
    console.log(`\nFFA (4 bots ${names.join('/')}, ${ffa.length} rounds): wins ${[...wins].map(([lv, n]) => `${label(lv)} ${n}`).join(', ')}, draws ${draws}`);
  }
  // per arena level
  console.log('\nRounds per arena level: avg length / draws / stuck');
  for (const lv of a.levels.filter((v, i, arr) => arr.indexOf(v) === i)) {
    const rs = byId.filter((r) => r.levelno === lv);
    if (!rs.length) continue;
    const len = rs.reduce((t, r) => t + r.ticks, 0) / rs.length / 60;
    const draws = rs.filter((r) => r.winner < 0).length;
    const stuck = rs.reduce((t, r) => t + r.stuck.length, 0);
    console.log(`  level ${String(lv).padStart(2)}: ${String(rs.length).padStart(4)} rounds, avg ${len.toFixed(1)} s, draws ${draws}, stuck ${stuck}`);
  }
  // CPU
  const per = (rs: RoundResult[]) => {
    let ms = 0;
    let calls = 0;
    let max = 0;
    let bots = 0;
    for (const r of rs) {
      ms += r.aiMs;
      calls += r.aiCalls;
      max = Math.max(max, r.aiMaxTick);
      bots += r.levels.filter((l) => l > 0).length * r.aiCalls;
    }
    return { tick: ms / Math.max(calls, 1), bot: ms / Math.max(bots, 1), max };
  };
  const one = per(byId.filter((r) => r.levels.filter((l) => l > 0).length === 2));
  const four = per(ffa);
  const nine = per(byId.filter((r) => r.levels.filter((l) => l > 0).length === 9));
  console.log('\nAI cost (ms per tick, all bots; note: worker threads share the CPU)');
  console.log(`  1v1:    avg ${one.tick.toFixed(3)} ms/tick (${one.bot.toFixed(3)} per bot), worst tick ${one.max.toFixed(2)} ms`);
  if (ffa.length) console.log(`  4 bots: avg ${four.tick.toFixed(3)} ms/tick (${four.bot.toFixed(3)} per bot), worst tick ${four.max.toFixed(2)} ms`);
  if (nine.tick > 0) console.log(`  9 bots: avg ${nine.tick.toFixed(3)} ms/tick (${nine.bot.toFixed(3)} per bot), worst tick ${nine.max.toFixed(2)} ms`);
  const stuckRounds = byId.filter((r) => r.stuck.length > 0);
  const maxIdle = byId.reduce((m, r) => Math.max(m, ...r.idle), 0) / 60;
  console.log(`\nIdle check (no bot idle > ${IDLE_LIMIT_S} s while able to move): ${stuckRounds.length ? 'FAIL' : 'OK'}, longest idle ${maxIdle.toFixed(1)} s${stuckRounds.length ? ', rounds ' + stuckRounds.slice(0, 12).map((r) => `${r.id}(lvl ${r.levelno} ${r.scheme})`).join(' ') : ''}`);
  if (stuckRounds.length || errors.length) process.exitCode = 1;
  if (a.verbose) {
    for (const r of byId) {
      console.log(`#${r.id} L${r.levelno} ${r.scheme} levels=${r.levels.filter((l) => l).map(aiLevel).join('/')} winner=${r.winner >= 0 ? label(r.levels[r.winner]) : 'draw'} len=${(r.ticks / 60).toFixed(1)}s maxTick=${r.aiMaxTick.toFixed(1)}ms passive=${r.passive.filter((_, i) => r.levels[i] > 0).map((v) => (v / 60).toFixed(0)).join("/")}${r.dummies.some((d) => d) ? " vs=" + r.dummies.filter((d) => d).join("/") : ""} deaths=${r.kinds.map((k) => `${k.slot}(${label(r.levels[k.slot])}) ${k.kind}${k.missed ? '/missed' : ''}${k.doomed !== undefined ? ` doomed ${k.doomed} ${k.why}` : ''} @${(k.tick / 60).toFixed(1)}`).join(', ')}`);
    }
  }
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const jobs = makeJobs(a);
  const t0 = performance.now();
  const results: RoundResult[] = [];
  const nw = Math.max(1, Math.min(a.workers, jobs.length));
  console.log(`running ${jobs.length} rounds on ${nw} worker(s)...`);
  let next = 0;
  await new Promise<void>((resolve, reject) => {
    let live = 0;
    for (let i = 0; i < nw; i++) {
      const wk = new Worker(new URL(import.meta.url), { workerData: { worker: true } });
      live++;
      const feed = () => {
        if (next < jobs.length) wk.postMessage(jobs[next++]);
        else wk.postMessage(null);
      };
      wk.on('message', (r: RoundResult) => {
        results.push(r);
        if (results.length % 50 === 0) process.stdout.write(`  ${results.length}/${jobs.length}\n`);
        feed();
      });
      wk.on('error', reject);
      wk.on('exit', () => {
        live--;
        if (live === 0) resolve();
      });
      feed();
    }
  });
  report(a, results, (performance.now() - t0) / 1000);
}

if (!isMainThread && workerData?.worker) {
  // profile overrides for experiments: AI_TUNE='{"5":{"trapBudget":20}}' node tools/ai-arena.ts ...
  if (process.env.AI_TUNE) (globalThis as { __AI_TUNE?: unknown }).__AI_TUNE = JSON.parse(process.env.AI_TUNE);
  parentPort!.on('message', (job: RoundJob | null) => {
    if (!job) {
      process.exit(0);
    }
    parentPort!.postMessage(playRound(job));
  });
} else if (isMainThread && process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
