// How much a bot wants each power-up, given what it already has (player.md §13, flames-map-powerups.md §3).
// Units: roughly "one brick destroyed" = 1.

import { P_BOMB, P_FLAME, P_DISEASE, P_KICKER, P_SKATE, P_PUNCH, P_GRAB, P_SPOOGE, P_GOLDFLAME, P_TRIGGER, P_JELLY, P_DISEASE3, P_RANDOM } from '../sim/powers.ts';
import type { PlayerInfo } from './world.ts';
import type { Profile } from './profile.ts';

export function powerValue(type: number, me: PlayerInfo, prof: Profile): number {
  const c = me.counts;
  let v = 0;
  switch (type) {
    case P_BOMB:
      v = c[0] < 3 ? 7 : c[0] < 5 ? 5 : c[0] < 8 ? 2.5 : 0;
      break;
    case P_FLAME:
      v = c[8] ? 0.5 : c[1] < 3 ? 6 : c[1] < 5 ? 4 : c[1] < 8 ? 1.5 : 0;
      break;
    case P_SKATE:
      v = c[4] === 0 ? 6 : c[4] === 1 ? 4 : c[4] < 4 ? 1.5 : 0;
      break;
    case P_KICKER:
      v = c[3] ? 0 : prof.kick ? 5 : 1;
      break;
    case P_PUNCH:
      v = c[5] ? 0 : prof.punch ? (c[9] ? 1 : 3.5) : 0.5;
      break;
    case P_GRAB:
      v = c[6] ? 0 : 0.5;
      break;
    case P_SPOOGE:
      v = c[7] ? 0 : prof.spooge ? 3 : 0.5;
      break;
    case P_GOLDFLAME:
      v = c[8] ? 0 : c[1] < 6 ? 6 : 2;
      break;
    case P_TRIGGER:
      v = c[9] ? 0 : prof.trigger ? (prof.level >= 4 ? 5 : 2.5) : 0.5;
      break;
    case P_JELLY:
      v = c[10] ? 0 : c[9] ? -1 : 0.5;
      break;
    case P_RANDOM:
      v = 1.5;
      break;
    case P_DISEASE:
      v = prof.greed >= 0.8 ? -8 : 1;
      break;
    case P_DISEASE3:
      v = prof.greed >= 0.8 ? -15 : 1;
      break;
  }
  return v > 0 ? v * prof.greed : v;
}

/** Power-ups a bot should never walk over by accident (its level recognises them as bad). */
export function isBadPower(type: number, prof: Profile): boolean {
  return prof.greed >= 0.8 && (type === P_DISEASE || type === P_DISEASE3);
}
