// Program-wide state that the original keeps in globals across screens: the 10 player slots (input type,
// device, team), the gold player, attract-mode bookkeeping and the match end state.

import type { NetSession } from '../net/netSession.ts';

export const INPUT_OFF = 0;
export const INPUT_AI = 1;
export const INPUT_KEY = 2;
export const INPUT_JOY = 3;
export const INPUT_NET = 4;

export interface Slot {
  /** INPUT_* */
  type: number;
  /** keyboard layout (0/1) or joystick number */
  dev: number;
  /** 0/1 */
  team: number;
  /** network games: id of the machine whose player this is (0 in local games) */
  owner: number;
  /** computer player: 0 the original's (reverse engineered), 1..5 Boom Buds' skill levels */
  ai: number;
  /** modern menus: the control set playing this slot on its owner machine (src/app/controls.ts) */
  ctl?: string;
  /** modern menus: the player's name in the score lines ("P1", a machine's name, "CPU") */
  name?: string;
}

/** Default computer player: the original game's. */
export const AI_DEFAULT = 0;

export class Session {
  slots: Slot[] = Array.from({ length: 10 }, (_, i) => ({ type: INPUT_OFF, dev: 0, team: i & 1, owner: 0, ai: AI_DEFAULT }));
  /** g_gold_player: winning slot of the previous match (team play: 0 or 2), -1 none */
  goldPlayer = -1;
  /** result of the last roulette (power-up type), -1 none */
  rouletteResult = -1;
  /** g_match_end: 0 running, 1 won, 2 aborted, 10 campaign finished */
  matchEnd = 0;
  /** Alt-W: results screens auto-continue */
  autoContinue = 0;
  attract = 0;
  private saved: { slots: Slot[]; level: number; teamPlay: number } | null = null;
  /** 0 local, 1 server, 2 client */
  netMode = 0;
  campaign = 0;
  /** stages of the campaign file chosen for this match */
  campaignStages: { name: string; level: number; scheme: string; rovers: number; roverSpeed: number; ghosts: number; ghostSpeed: number; ais: number }[] = [];
  /** first match after a network session resets the inputs */
  afterNet = false;
  /** benchmark / demo override of attract mode: number of computer players, level (-1 random), skill (0 = as set) */
  bench: { players: number; level: number; ai: number } | null = null;
  /** the network session (null in local games) */
  net: NetSession | null = null;
  /** local slots saved while a network session is running */
  private localSlots: Slot[] | null = null;

  /** id of this machine in the network session (0 in local games) */
  get myId(): number {
    return this.net ? this.net.myId : 0;
  }

  /** A human player of another machine (shown as "NET"). */
  isRemote(i: number): boolean {
    const s = this.slots[i];
    return !!this.net && (s.type === INPUT_KEY || s.type === INPUT_JOY) && s.owner !== this.net.myId;
  }

  /** A human player of this machine. */
  isLocalHuman(i: number): boolean {
    const s = this.slots[i];
    return (s.type === INPUT_KEY || s.type === INPUT_JOY) && (!this.net || s.owner === this.net.myId);
  }

  /** Input type as this machine displays it (remote humans are NET). */
  displayType(i: number): number {
    return this.isRemote(i) ? INPUT_NET : this.slots[i].type;
  }

  /** Enter a network session: remember the local setup, start from a fresh table. */
  beginNet(net: NetSession): void {
    this.localSlots = this.slots.map((x) => ({ ...x }));
    this.net = net;
    this.netMode = net.role === 'host' ? 1 : 2;
    this.goldPlayer = -1;
    this.afterNet = true;
  }

  endNet(): void {
    this.net = null;
    this.netMode = 0;
    if (this.localSlots) this.slots = this.localSlots;
    this.localSlots = null;
    for (const s of this.slots) s.owner = 0;
  }

  /** players_assign_default_inputs (0x42123f) */
  assignDefaults(joysticks: number, assignKeyboard: boolean): void {
    let j = 0;
    let keyAssigned = false;
    for (let p = 0; p < 10; p++) {
      const s = this.slots[p];
      if (s.type !== INPUT_OFF) continue;
      if (j < joysticks) {
        s.type = INPUT_JOY;
        s.dev = j;
      } else if (!keyAssigned && assignKeyboard) {
        s.type = INPUT_KEY;
        s.dev = 0;
        keyAssigned = true;
      } else if (p === 1) {
        s.type = INPUT_AI;
        s.dev = 0;
      }
      j++;
    }
  }

  saveInputs(level: number, teamPlay: number): void {
    this.saved = { slots: this.slots.map((s) => ({ ...s })), level, teamPlay };
  }

  restoreInputs(): { level: number; teamPlay: number } | null {
    if (!this.saved) return null;
    const s = this.saved;
    this.slots = s.slots.map((x) => ({ ...x }));
    this.saved = null;
    return { level: s.level, teamPlay: s.teamPlay };
  }

  hasHumans(): boolean {
    return this.slots.some((s) => s.type === INPUT_KEY || s.type === INPUT_JOY);
  }

  /** players_count_input_conflicts: two players of one machine on the same keyboard layout or joystick */
  inputConflicts(): number {
    let n = 0;
    for (let a = 0; a < 10; a++) {
      for (let b = a + 1; b < 10; b++) {
        const x = this.slots[a], y = this.slots[b];
        if ((x.type === INPUT_KEY || x.type === INPUT_JOY) && x.type === y.type && x.dev === y.dev && x.owner === y.owner) n++;
      }
    }
    return n;
  }

  /** players_count_sides: active players, or distinct teams with team play */
  countSides(teamPlay: boolean): number {
    const active = this.slots.filter((s) => s.type !== INPUT_OFF);
    if (!teamPlay) return active.length;
    return new Set(active.map((s) => s.team)).size;
  }
}
