// Match / round lifecycle and the per-frame driver (game_frame @0x42a191), see
// docs/re/engine-loop-input-hud.md §1.6 and docs/re/match-flow.md.
//
// The remake runs this frame function at a fixed 60 Hz with integer dt = 17, 16, 17 ms (50 ms per three
// ticks), which reproduces the original running at 60 fps (cnc-ddraw's recommended rate for this game).
// Counters the original advances once per *rendered* frame and that are purely visual or timing related
// (extras/power-up animations, HURRY blink, sparkles, stun, disease freshness) run on 20 Hz "reference
// frames" instead, i.e. at the game's nominal rate (VALUELST 25/30), see docs/DIFFERENCES.md.

import { W, H, MAX_BOMBS, MAX_PLAYERS, REF, type GameState, type MatchOptions, type Player } from './types.ts';
import { FrameCtx } from './ctx.ts';
import { mapGenerate } from './map.ts';
import { newBomb, bombsUpdate, bombDudScheduleNext } from './bombs.ts';
import { flamesUpdate } from './flames.ts';
import { powersUpdate, powerPlaceLevel } from './powers.ts';
import { extrasLevelLoad, extrasUpdate } from './extras.ts';
import { newPlayer, playersUpdate, playersRoundStart, playersMatchStart, playersAliveCount, CTRL_OFF } from './players.ts';
import { mapUpdate, timeRemainingS } from './enclosure.ts';
import type { Scheme, ExtraDef } from '../../engine/assets.ts';
import type { CampaignStage } from './types.ts';
import { newAlien, MAX_ALIENS, campaignStageSetup, campaignUpdate } from './campaign.ts';

export const TICK_DT = [17, 16, 17];

export interface SlotConfig {
  /** CTRL_* (0 off, 1 AI, 2 human/local, 4 remote) */
  ctrl: number;
  team: number;
}

export interface MatchConfig {
  slots: SlotConfig[];
  values: number[];
  scheme: Scheme;
  extras: Record<string, ExtraDef[]>;
  /** -1 random each round */
  levelno: number;
  /** with levelno -1: the arenas to pick from (empty: the original's choice) */
  levels?: number[];
  numToWin: number;
  winByKills: number;
  teamPlay: number;
  randomStart: number;
  enclosementDepth: number;
  conveyorSpeed: number;
  stompedBombsDetonate: number;
  diseasesDestroyable: number;
  playtime: number;
  netMode: number;
  goldWinner: number;
  goldPrize: number;
  attract: number;
  seed: number;
  /** campaign mode: the stage being played */
  campaign?: CampaignStage;
}

export function flattenValues(values: Record<string, number[]>): number[] {
  const out: number[] = new Array(4000).fill(0);
  for (const [k, arr] of Object.entries(values)) {
    const id = Number(k);
    arr.forEach((v, i) => {
      if (id + i < out.length) out[id + i] = v;
    });
  }
  return out;
}

/** scheme_parse post-processing: -P bornwith/override written into the in-memory VALUELST. */
export function applySchemeToValues(values: number[], scheme: Scheme): { values: number[]; forbidden: number[] } {
  const v = values.slice();
  const forbidden = new Array(15).fill(0);
  scheme.powerups.forEach((p, t) => {
    if (!p || t > 12) return;
    if (p.bornwith > 0) v[50 + t] = p.bornwith;
    if (p.hasOverride) v[400 + t] = p.override;
    forbidden[t] = p.forbidden ? 1 : 0;
  });
  return { values: v, forbidden };
}

export function createGame(cfg: MatchConfig): GameState {
  const { values, forbidden } = applySchemeToValues(cfg.values, cfg.scheme);
  const opts: MatchOptions = {
    level: 0,
    conveyorSpeed: cfg.conveyorSpeed,
    enclosementDepth: cfg.enclosementDepth,
    stompedBombsDetonate: cfg.stompedBombsDetonate,
    diseasesDestroyable: cfg.diseasesDestroyable,
    teamPlay: cfg.teamPlay,
    netMode: cfg.netMode,
    playtime: cfg.playtime >= 1001 ? 0 : cfg.playtime,
    values,
    forbidden,
  };
  const s: GameState = {
    tick: 0,
    frameCounter: 0,
    refFrame: 0,
    refTick: 0,
    nowMs: 0,
    elapsedMs: 0,
    timerRunning: 0,
    rng: { seed: cfg.seed >>> 0 },
    opts,
    map: new Array(W * H).fill(0),
    tiles: new Array(W * H).fill(0),
    flames: Array.from({ length: W * H }, () => ({ state: 0, type: 0, frame: 0, acc: 0, colour: 0, owner: 0, age: 0 })),
    powers: Array.from({ length: W * H }, () => ({ state: 0, type: 0, frame: 0, revealedAt: 0, vis: 0 })),
    bombs: Array.from({ length: MAX_BOMBS }, () => newBomb()),
    explodeList: [],
    bombsLastFrame: -1,
    players: Array.from({ length: MAX_PLAYERS }, (_, i) => newPlayer(i)),
    pl: {
      inputHistory: Array.from({ length: MAX_PLAYERS }, () => new Array(60).fill(0)),
      sparkles: Array.from({ length: 100 }, () => ({ active: 0, x: 0, y: 0, state: 0 })),
      roundFreezeMs: 0,
      trueColoursMs: 0,
      presentAcc: 0,
      presentLatched: 0,
      aliveAcc: 0,
      aliveLatched: 0,
      teamPresent: [0, 0],
      teamAlive: [0, 0],
      teamsAliveLatched: 0,
      kfacePlayer: -1,
      startX: [],
      startY: [],
      goldWinner: cfg.goldWinner,
      goldPrize: cfg.goldPrize,
      campaign: 0,
      attract: cfg.attract,
      winByKills: cfg.winByKills,
      remainingS: 1001,
    },
    extras: [],
    danger: new Array(W * H).fill(0),
    hurry: { needsReset: 1, lastMs: 0, x: 0, y: 0, ring: 0, dir: 1, sound: 0, voicePlayed: 0 },
    regenLastMs: 0,
    nextDudTime: 0,
    roundOver: 0,
    forcedDraw: 0,
    round: 0,
    cfgLevelno: cfg.levelno,
    cfgLevels: cfg.levels ?? [],
    numToWin: cfg.numToWin,
    stats: { bricks: 0, bombsDropped: 0 },
    aliens: Array.from({ length: MAX_ALIENS }, () => newAlien()),
    camp: { stage: cfg.campaign ?? { rovers: 0, roverSpeed: 0, ghosts: 0, ghostSpeed: 0, ais: 0 }, status: 0, retry: 0, clearMs: 0, aliensActive: 0 },
  };
  if (cfg.campaign) s.pl.campaign = 1;
  // slots and teams (the scheme's team field wins, as scheme_parse does at match setup)
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const p = s.players[i];
    const slot = cfg.slots[i];
    p.ctrl = slot ? slot.ctrl : CTRL_OFF;
    const st = cfg.scheme.starts[i];
    p.team = slot && slot.team >= 0 ? slot.team : st ? st[2] : i & 1;
  }
  // start positions: VALUELST defaults, then scheme -S entries
  for (let i = 0; i < MAX_PLAYERS; i++) {
    let x = values[600 + 2 * i];
    let y = values[601 + 2 * i];
    while (x < 0) x += 15;
    while (x >= 15) x -= 15;
    while (y < 0) y += 11;
    while (y >= 11) y -= 11;
    const st = cfg.scheme.starts[i];
    if (st) {
      x = st[0];
      y = st[1];
      while (x < 0) x += 15;
      while (y < 0) y += 11;
      if (x > 15) x = 14;
      if (y > 11) y = 10;
    }
    s.pl.startX[i] = x;
    s.pl.startY[i] = y;
  }
  bombDudScheduleNext(s);
  playersMatchStart(s, !!cfg.randomStart);
  return s;
}

/** round_start @0x410b6e (local / host side). */
export function roundStart(s: GameState, scheme: Scheme, extras: Record<string, ExtraDef[]>): void {
  let level = s.cfgLevelno;
  if (level < 0 && s.cfgLevels.length) {
    // Boom Buds: a random arena among a list (special arenas, or the player's own)
    level = s.cfgLevels[rand15(s, s.cfgLevels.length)];
  } else if (level < 0) {
    const n = Math.max(s.opts.values[35], 1);
    for (let i = 0; i < 200; i++) {
      level = rand15(s, n);
      if (s.opts.values[1150 + level] !== 0) break;
    }
  }
  s.opts.level = level;
  s.round++;
  mapGenerate(s, scheme.rows, scheme.density);
  for (const b of s.bombs) Object.assign(b, newBomb());
  s.explodeList.length = 0;
  for (const f of s.flames) f.state = 0;
  playersRoundStart(s);
  powerPlaceLevel(s);
  extrasLevelLoad(s, extras[String(level)]);
  if (s.pl.campaign) campaignStageSetup(s);
  s.hurry.voicePlayed = 0;
  s.elapsedMs = 0;
  s.timerRunning = 1;
  s.roundOver = 0;
  s.forcedDraw = 0;
  s.pl.remainingS = timeRemainingS(s);
}

function rand15(s: GameState, n: number): number {
  s.rng.seed = (Math.imul(s.rng.seed, 1103515245) + 12345) >>> 0;
  return ((s.rng.seed >>> 16) & 0x7fff) % n;
}

/** One game frame. `inputs[i]` = IN_* bits of player i for this tick. */
export function step(s: GameState, ctx: FrameCtx, inputs: Uint8Array): void {
  const dt = TICK_DT[s.tick % 3];
  ctx.reset(dt);
  s.tick++;
  s.nowMs += dt;
  const rf = Math.floor(s.nowMs / REF);
  s.refTick = rf !== s.refFrame ? rf - s.refFrame : 0;
  s.refFrame = rf;
  s.frameCounter++;
  // round clock (round_timer_update_draw)
  if (s.timerRunning) s.elapsedMs += dt;
  s.pl.remainingS = timeRemainingS(s);
  extrasUpdate(s, ctx);
  bombsUpdate(s, ctx, false);
  powersUpdate(s, ctx);
  flamesUpdate(s, ctx);
  mapUpdate(s, ctx);
  playersUpdate(s, ctx, inputs);
  if (s.pl.campaign) campaignUpdate(s, ctx);
  bombsUpdate(s, ctx, true);
  // HURRY
  const t = timeRemainingS(s);
  const v101 = s.opts.values[101];
  if (t < v101 && t > v101 - 5) {
    if (!s.hurry.voicePlayed) {
      s.hurry.voicePlayed = 1;
      ctx.sound(2700);
    }
    if (s.refFrame & 4) {
      const seq = ctx.anims.find('hurry');
      if (seq >= 0) ctx.draw(ctx.anims.ref(seq, 0).frame, 320, 240, 0);
    }
  }
  // match loop side: stop the clock once at most one player/team is alive, then test the round end
  if (playersAliveCount(s) <= 1) s.timerRunning = 0;
  // (campaign stages end through s.camp.status instead)
  if (!s.pl.campaign && (s.forcedDraw || s.pl.presentLatched <= 1 || roundTimeUp(s))) s.roundOver = 1;
}

export function roundTimeUp(s: GameState): boolean {
  if (s.opts.playtime <= 0) return false;
  return timeRemainingS(s) < 1;
}

/** round_get_winner @0x4219b0: slot (or team) index, -1 for a draw. */
export function roundWinner(s: GameState): number {
  if (roundTimeUp(s)) return -1;
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const p = s.players[i];
    if (p.ctrl !== CTRL_OFF && (p.lives !== 0 || p.alive) && !p.dying) return s.opts.teamPlay ? p.team : i;
  }
  return -1;
}

/** player_award_points(1) @0x421b56 */
export function awardRoundPoint(s: GameState): void {
  if (roundTimeUp(s) || s.forcedDraw) return;
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const p = s.players[i];
    if (p.ctrl !== CTRL_OFF && (p.lives !== 0 || p.alive) && !p.dying) {
      p.score++;
      if (s.opts.teamPlay) {
        for (const q of s.players) if (q !== p && q.ctrl !== CTRL_OFF && q.team === p.team) q.score = p.score;
      }
      return;
    }
  }
}

/** Match winner per match-flow.md §7.3, or -1. */
export function matchWinner(s: GameState): number {
  const N = s.numToWin;
  let maxk = -Infinity;
  let nmax = 0;
  for (const p of s.players) {
    if (p.kills > maxk) { maxk = p.kills; nmax = 1; } else if (p.kills === maxk) nmax++;
  }
  if (!s.opts.teamPlay) {
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const p = s.players[i];
      if (p.ctrl === CTRL_OFF) continue;
      if (s.pl.winByKills ? maxk >= N && nmax === 1 && p.kills === maxk : p.score >= N) return i;
    }
  } else {
    for (let t = 0; t < 2; t++) {
      const p = s.players.find((q) => q.ctrl !== CTRL_OFF && q.team === t);
      if (p && p.score >= N) return t;
    }
  }
  return -1;
}

export function countSides(players: Player[], teamPlay: boolean): number {
  if (!teamPlay) return players.filter((p) => p.ctrl !== CTRL_OFF).length;
  const teams = new Set(players.filter((p) => p.ctrl !== CTRL_OFF).map((p) => p.team));
  return teams.size;
}
