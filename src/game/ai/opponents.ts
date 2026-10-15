// Opponent model: which slots are played by bots of which level. Every bot registers itself on each step, so
// the others can judge how fast it reacts to a new bomb (its true perception delay); players that never
// register (humans, network players) get a human-like default.

import type { GameState } from '../sim/types.ts';
import { profileFor } from './profile.ts';
import { msToSteps } from './timing.ts';

const levels = new WeakMap<GameState, Int8Array>();

/** steps a human needs to notice a new bomb and start moving (about 250 ms) */
export const HUMAN_REACT = msToSteps(250);

/** reaction steps per bot level: perception delay (or the late warning of level 1) plus a step to re-plan */
const BOT_REACT = [HUMAN_REACT, 0, 0, 0, 0, 0].map((v, lv) => {
  if (lv === 0) return v;
  const p = profileFor(lv);
  const ms = Math.max(p.reactMs, p.warnMs === Infinity ? 0 : 2000 - p.warnMs);
  return msToSteps(ms) + 1;
});

/** which bot levels kick bombs out of their way (humans may) */
const BOT_KICK = [true, 0, 0, 0, 0, 0].map((v, lv) => (lv === 0 ? true : profileFor(lv).kick));

export function registerBot(s: GameState, index: number, level: number): void {
  let a = levels.get(s);
  if (!a) {
    a = new Int8Array(16);
    levels.set(s, a);
  }
  a[index] = level;
}

/** Bot level of a player, 0 if unknown (human or not registered yet). */
export function botLevel(s: GameState, index: number): number {
  return levels.get(s)?.[index] ?? 0;
}

/** Does the player in `index` kick bombs away when it has the power-up? */
export function kicksBombs(s: GameState, index: number): boolean {
  return BOT_KICK[botLevel(s, index)] ?? true;
}

/** Steps the player in `index` needs to react to a bomb that appears next to it. */
export function reactSteps(s: GameState, index: number): number {
  return BOT_REACT[botLevel(s, index)] ?? HUMAN_REACT;
}
