// Computer players. A bot plays through the same input bits as a human (src/engine/input.ts); think() is
// called once per simulation step before step() and never mutates the state.
//
// Architecture (see the individual modules):
//   world.ts      per-step snapshot of the visible state, shared by all bots (map, bombs, players, extras,
//                 predicted enclosement)
//   motion.ts     predicted paths of kicked / conveyed / flying bombs (pixel emulation of bombs.ts)
//   perception.ts what a bot believes: reaction delay, blind spots of the weaker levels
//   danger.ts     per-cell burn and block intervals with chain reactions, burning bricks, triggers, enclosement
//   reach.ts      time-expanded safe-interval path search with the bot's real speed
//   bot.ts        planning (flee, power-ups, bricks, attacks and traps), drop checks, path execution
//   profile.ts    the five difficulty levels
//   original.ts   level 0: the original game's computer player (docs/re/ai-original.md), self-contained

import type { GameState } from '../sim/types.ts';
import { Bot } from './bot.ts';
import { OriginalAi } from './original.ts';

export interface AiOptions {
  /** 0 = the original game's AI (original.ts), 1..5 = the difficulty levels of bot.ts */
  level: 0 | 1 | 2 | 3 | 4 | 5;
  seed: number;
}

export interface AiPlayer {
  /** Called once per simulation tick (60 Hz) *before* step(); returns input bits for player `index`. */
  think(s: GameState, index: number): number;
  /** Called at round start (new map). */
  reset(): void;
}

export function createAi(opts: AiOptions): AiPlayer {
  if (opts.level === 0) return new OriginalAi(opts.seed >>> 0);
  const level = Math.max(1, Math.min(5, Math.round(opts.level || 3)));
  return new Bot(level, opts.seed >>> 0);
}
