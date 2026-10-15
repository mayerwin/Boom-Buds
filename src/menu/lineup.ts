// Where the players of a line-up go. A slot is a colour: slot i plays the bomber of colour i. Players who
// chose a colour get it unless somebody before them in the line-up took it (people come before computer
// players); everybody else takes the first free colours. A player's team is the one chosen, or else the
// scheme's team for the slot, like the original.

import type { Game } from '../app/Game.ts';
import type { Look } from '../app/settings.ts';
import { allSchemes } from '../app/schemes.ts';

export const NO_LOOK: Look = { color: -1, team: -1 };

/** The slot of every entry, in order (-1 when the ten slots are full). */
export function placeLineup(looks: Look[]): number[] {
  const out = looks.map(() => -1);
  const taken = new Set<number>();
  looks.forEach((l, k) => {
    if (l.color >= 0 && l.color < 10 && !taken.has(l.color)) {
      out[k] = l.color;
      taken.add(l.color);
    }
  });
  let next = 0;
  looks.forEach((_, k) => {
    if (out[k] >= 0) return;
    while (next < 10 && taken.has(next)) next++;
    if (next < 10) {
      out[k] = next;
      taken.add(next);
    }
  });
  return out;
}

/** Teams of the slots by default: the scheme's start entries, like the original. */
export function schemeTeams(g: Game, scheme: string): number[] {
  const s = allSchemes(g.app).find((x) => x.file.toUpperCase() === scheme.toUpperCase());
  return Array.from({ length: 10 }, (_, i) => (s?.starts[i] ? s.starts[i][2] : i & 1));
}

/** The team of a player in `slot`. */
export function teamFor(look: Look, slot: number, defaults: number[]): number {
  return look.team === 0 || look.team === 1 ? look.team : (defaults[slot] ?? slot & 1);
}

/** A copy of `look` with another team or colour. */
export function withTeam(look: Look, team: number): Look {
  return { ...look, team };
}

export function withColor(look: Look, color: number): Look {
  return { ...look, color };
}
