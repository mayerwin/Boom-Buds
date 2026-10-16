// Where the players of a line-up go. A slot is a colour: slot i plays the bomber of colour i. Players who
// chose a colour get it unless somebody before them in the line-up took it (people come before computer
// players); everybody else takes the first free colours. A player's team is the one chosen, or else the
// scheme's team for the slot, like the original.
//
// The Local Game's line-up is kept in the settings (every player with their control set, also those whose
// device is not there now: they come back with it). The modern menus and the original menus' player setup
// share it: one changes it, the other shows it.

import type { Game } from '../app/Game.ts';
import type { Look } from '../app/settings.ts';
import { allSchemes } from '../app/schemes.ts';
import { availableSets, classicInput, findSet, idsClash, migrateSetId, slotSetId } from '../app/controls.ts';
import { AI_DEFAULT, INPUT_AI, INPUT_JOY, INPUT_KEY, INPUT_OFF, type Slot } from '../app/session.ts';

export const NO_LOOK: Look = { color: -1, team: -1 };

/** A person of a line-up: their control set, colour and team. */
export interface Human {
  ctl: string;
  look: Look;
}

/** A computer player of a line-up. */
export interface Bot {
  skill: number;
  look: Look;
}

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

/** Ids of the control sets that can be played on this device now. */
export function availableIds(g: Game): Set<string> {
  return new Set(availableSets(g.settings.controls, g.app.input, g.app.isTouch).map((s) => s.id));
}

/** The players in order, without those whose set clashes with a player before them (two on one device). */
function withoutClashes(g: Game, players: Human[]): Human[] {
  const out: Human[] = [];
  for (const p of players) if (!out.some((q) => idsClash(g.settings.controls, q.ctl, p.ctl))) out.push(p);
  return out;
}

/**
 * The players of a line-up who play now: those whose device is there, as many as the ten slots leave room for
 * beside `bots` computer players.
 */
export function playingNow(g: Game, players: Human[], bots: number, avail = availableIds(g)): Human[] {
  return withoutClashes(g, players.filter((p) => avail.has(p.ctl))).slice(0, Math.max(0, 10 - bots));
}

/** The kept line-up: every player (also those whose device is not there now) and the computer players. */
export function savedLineup(g: Game): { players: Human[]; bots: Bot[] } {
  const st = g.settings;
  const players: Human[] = [];
  st.localPlayers.forEach((id, i) => {
    // (an id of an earlier version whose gamepad the browser does not list yet waits as it is; a keyboard set
    // deleted since then is gone)
    const ctl = migrateSetId(id) ?? id;
    if (findSet(st.controls, ctl) || /^pad-\d+$/.test(ctl)) players.push({ ctl, look: st.localLooks.players[i] ?? NO_LOOK });
  });
  const bots = st.localBots.slice(0, 10).map((skill, k) => ({ skill, look: st.localLooks.bots[k] ?? NO_LOOK }));
  return { players: withoutClashes(g, players), bots };
}

/** Keep a line-up in the settings (the caller saves them). */
export function storeLineup(g: Game, players: Human[], bots: Bot[]): void {
  const st = g.settings;
  const kept = withoutClashes(g, players);
  st.localPlayers = kept.map((p) => p.ctl);
  st.localBots = bots.map((b) => b.skill);
  st.localLooks = { players: kept.map((p) => p.look), bots: bots.map((b) => b.look) };
}

/**
 * The ten slots of a line-up (`players`: those who play now): everybody in the slot of their colour, with their
 * team; people as the original menus show them too (KEY n, JOY n), with their control set.
 */
export function lineupSlots(g: Game, players: Human[], bots: Bot[], scheme: string): Slot[] {
  const looks = [...players.map((p) => p.look), ...bots.map((b) => b.look)];
  const slotOf = placeLineup(looks);
  const teams = schemeTeams(g, scheme);
  const slots: Slot[] = Array.from({ length: 10 }, (_, i) => ({ type: INPUT_OFF, dev: 0, team: teams[i], owner: 0, ai: AI_DEFAULT }));
  looks.forEach((look, k) => {
    const i = slotOf[k];
    if (i < 0) return;
    const team = teamFor(look, i, teams);
    const teamChosen = look.team === 0 || look.team === 1;
    if (k < players.length) {
      const c = classicInput(g.settings.controls, players[k].ctl);
      slots[i] = { ...slots[i], type: c.type, dev: Math.max(0, c.dev), ctl: players[k].ctl, team, teamChosen, name: `P${k + 1}` };
    } else slots[i] = { ...slots[i], type: INPUT_AI, ai: bots[k - players.length].skill, team, teamChosen, name: 'CPU' };
  });
  return slots;
}

/** The slots of the kept line-up, with the players whose device is there. */
export function savedLineupSlots(g: Game): Slot[] {
  const { players, bots } = savedLineup(g);
  return lineupSlots(g, playingNow(g, players, bots.length), bots, g.settings.schemefilename);
}

/**
 * The line-up of the original menus' player setup (local games), to keep: everybody in the colour of their slot,
 * with their team when they chose it (or it is not the scheme's); the kept players whose device is not there now
 * stay in it.
 */
export function lineupFromSlots(g: Game, slots: Slot[], scheme: string): { players: Human[]; bots: Bot[] } {
  const teams = schemeTeams(g, scheme);
  const players: Human[] = [];
  const bots: Bot[] = [];
  slots.forEach((sl, i) => {
    const look = { color: i, team: sl.teamChosen || sl.team !== teams[i] ? sl.team : -1 };
    if (sl.type === INPUT_AI) bots.push({ skill: sl.ai, look });
    else if (sl.type === INPUT_KEY || sl.type === INPUT_JOY) {
      const ctl = slotSetId(g.settings.controls, sl);
      if (ctl && !ctl.startsWith('joy-')) players.push({ ctl, look });
    }
  });
  const avail = availableIds(g);
  for (const p of savedLineup(g).players) if (!avail.has(p.ctl) && !players.some((q) => q.ctl === p.ctl)) players.push(p);
  return { players, bots };
}
