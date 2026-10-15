// Simulation state. Mirrors the original game's data structures (docs/re/*.md). Everything here is plain
// data (no classes, no functions) so a snapshot is a structuredClone and the state is deterministic.

import type { RngState } from './rng.ts';

export const W = 15;
export const H = 11;
export const CELL_W = 40;
export const CELL_H = 36;
export const GRID_X = 20;
export const GRID_Y = 68;
/** milliseconds per reference frame (1000 / VALUELST 30) */
export const REF = 50;
export const MAX_BOMBS = 100;
export const MAX_PLAYERS = 10;
export const DX = [0, 1, 0, -1];
export const DY = [-1, 0, 1, 0];

export const BombState = { REST: 0, SLIDING: 1, FLYING: 2, HELD: 3 } as const;
export const BombType = { REGULAR: 0, TRIGGER: 1, JELLY: 2 } as const;

export interface Bomb {
  /** 0 free, 1 live, 2 dud */
  active: number;
  type: number;
  x: number;
  y: number;
  startX: number;
  startY: number;
  dir: number;
  state: number;
  anim: number;
  animAcc: number;
  /** 0 none, 1..4 = direction+1 that does not get flames, 0xff none */
  skipDir: number;
  stop: number;
  colour: number;
  owner: number;
  born: number;
  fuseElapsed: number;
  step: number;
  bounce: number;
  fuseLen: number;
  flameLen: number;
  speed: number;
  accum: number;
  /** holding player index, -1 none */
  holder: number;
}

export interface FlameCell {
  /** 0 none, 1 burning, -1 last draw of a brick flame (transient inside the update) */
  state: number;
  /** 0-3 tip, 4-7 mid, 8 centre, 9 burning brick */
  type: number;
  frame: number;
  acc: number;
  colour: number;
  owner: number;
  age: number;
}

export interface PowerCell {
  /** 0 none, 1 hidden under brick, 2 revealed */
  state: number;
  type: number;
  frame: number;
  revealedAt: number;
  vis: number;
}

export interface Extra {
  /** 0 arrow, 1 warp, 2 conveyor, 3 trampoline */
  type: number;
  active: number;
  cx: number;
  cy: number;
  x: number;
  y: number;
  dir: number;
  /** warp id and link-to id */
  id: number;
  link: number;
  anim: number;
  /** warp graphic number ("extra warp %u"), 0 = invisible */
  gfx: number;
  /** warp knock-out done */
  firstUpdate: number;
}

export interface Player {
  index: number;
  /** 1 = in play (alive or dying) */
  alive: number;
  deathAnim: number;
  dying: number;
  bombSeq: number;
  /** 0 off, 1 AI, 2 keyboard, 3 joystick, 4 network-remote (the remake uses 2 for every human) */
  ctrl: number;
  ctrlSub: number;
  homeX: number;
  homeY: number;
  x: number;
  y: number;
  stepDx: number;
  stepDy: number;
  dir: number;
  wantDir: number;
  walk: number;
  deathMs: number;
  btn1Prev: number;
  btn2Prev: number;
  btn1: number;
  btn2: number;
  stun: number;
  colour: number;
  id: number;
  fuse: number;
  anim: number;
  animFrame: number;
  animMs: number;
  team: number;
  triggerUsed: number;
  counts: number[];
  awesome: number;
  invulnMs: number;
  lives: number;
  score: number;
  kills: number;
  speed: number;
  accum: number;
  diseaseMs: number;
  diseaseLen: number;
  diseaseFresh: number;
  disease: number[];
  startCleared: number;
  /** held bomb slot, -1 none */
  held: number;
  /** remake bookkeeping */
  tauntRolled: number;
  /** disease flicker colour for the current reference frame (-1 = none) */
  flicker: number;
}

export interface Sparkle {
  active: number;
  x: number;
  y: number;
  state: number;
}

/** you.c globals */
export interface PlayersGlobal {
  /** 10 players x 30 entries x {age, dir} */
  inputHistory: number[][];
  sparkles: Sparkle[];
  roundFreezeMs: number;
  trueColoursMs: number;
  presentAcc: number;
  presentLatched: number;
  aliveAcc: number;
  aliveLatched: number;
  teamPresent: number[];
  teamAlive: number[];
  teamsAliveLatched: number;
  kfacePlayer: number;
  startX: number[];
  startY: number[];
  goldWinner: number;
  goldPrize: number;
  campaign: number;
  attract: number;
  winByKills: number;
  remainingS: number;
}

export interface HurryState {
  /** 1 once the enclosement started this round (also requests a reset at the next round start) */
  needsReset: number;
  lastMs: number;
  x: number;
  y: number;
  ring: number;
  dir: number;
  sound: number;
  voicePlayed: number;
}

export interface MatchOptions {
  level: number;
  conveyorSpeed: number;
  enclosementDepth: number;
  stompedBombsDetonate: number;
  diseasesDestroyable: number;
  teamPlay: number;
  netMode: number;
  /** total play time in seconds (0 = infinite) */
  playtime: number;
  /** VALUELST values in effect (scheme overrides applied), flat: multi-value lines fill consecutive ids */
  values: number[];
  /** scheme 'forbidden from random' flags by powerup type */
  forbidden: number[];
}

/** Campaign alien (aliens.c record, 0x98 bytes in the original). */
export interface Alien {
  active: number;
  /** 1 rover, 2 ghost */
  type: number;
  dying: number;
  homeX: number;
  homeY: number;
  x: number;
  y: number;
  /** 0 N, 1 E, 2 S, 3 W */
  dir: number;
  /** step counter (short), animation state */
  anim: number;
  /** 1/100 px per reference frame */
  speed: number;
  acc: number;
  startCleared: number;
}

/** One stage of a campaign (.CAM "-C" line). */
export interface CampaignStage {
  rovers: number;
  roverSpeed: number;
  ghosts: number;
  ghostSpeed: number;
  ais: number;
}

export interface CampaignState {
  stage: CampaignStage;
  /** 0 running, 1 cleared, 2 failed */
  status: number;
  /** failed because no human was left: play the same stage again */
  retry: number;
  clearMs: number;
  aliensActive: number;
}

export interface GameState {
  tick: number;
  frameCounter: number;
  /** 20 Hz reference frame number (floor(nowMs / 50)) and how many started during this tick */
  refFrame: number;
  refTick: number;
  timerRunning: number;
  forcedDraw: number;
  round: number;
  cfgLevelno: number;
  /** a random arena (cfgLevelno -1) is picked among these when there are any (Boom Buds' arena lists) */
  cfgLevels: number[];
  numToWin: number;
  /** emulated timeGetTime(): sum of all frame dts */
  nowMs: number;
  /** elapsed game time in ms */
  elapsedMs: number;
  rng: RngState;
  opts: MatchOptions;
  map: number[];
  /** what each cell's tile picture in the background buffer currently shows (0 blank, 1 solid, 2 brick) */
  tiles: number[];
  flames: FlameCell[];
  powers: PowerCell[];
  bombs: Bomb[];
  explodeList: { bomb: number; dir: number }[];
  bombsLastFrame: number;
  players: Player[];
  pl: PlayersGlobal;
  extras: Extra[];
  danger: number[];
  hurry: HurryState;
  regenLastMs: number;
  /** wall-clock-like dud schedule in game seconds */
  nextDudTime: number;
  roundOver: number;
  stats: { bricks: number; bombsDropped: number };
  /** campaign mode (s.pl.campaign) */
  aliens: Alien[];
  camp: CampaignState;
}
