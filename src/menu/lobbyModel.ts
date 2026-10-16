// The lobby of a network game (modern menus). The host owns the line-up and the rules; every machine
// tells the host which players it brings (their control sets stay local), the host arranges the ten slots
// by the colours they chose (src/menu/lineup.ts: the host's players, then each machine's in join order, then
// the computer players) and sends the table to everyone. Every player picks their own colour and team; the
// host does it for the computer players. The host keeps the chat; the others' changes to the rules or the
// computer players are requests in the chat, which the host grants with one click. Messages on the control
// channel:
//   client -> host : mine  {players:[{ctl, label, color, team}]}   |   chat-say {text}   |   chat-ask {change}
//   host -> all    : lobby {slots, labels, rules, botOf}   |   start {params, slots}   |   chat {lines, reset?}
//   host -> one    : kick {} (the machine is removed from the room, src/net/netSession.ts)

import type { Game } from '../app/Game.ts';
import type { NetSession } from '../net/netSession.ts';
import { INPUT_AI, INPUT_KEY, INPUT_OFF, AI_DEFAULT, type Slot } from '../app/session.ts';
import { applyRules, describeRules, rulesFromSettings, type Rules } from './rules.tsx';
import { buildParams, type MatchParams } from '../screens/match.ts';
import { schemeFileText, allSchemes } from '../app/schemes.ts';
import { LanBeacon, lanKeys } from '../net/lan.ts';
import { availableIds, NO_LOOK, placeLineup, schemeTeams, teamFor } from './lineup.ts';
import { cleanLevels, type Look } from '../app/settings.ts';
import { SKILL_NAMES } from './ui.tsx';
import { COLOUR_NAMES } from './players.tsx';
import { idsClash } from '../app/controls.ts';

export interface LocalPlayer {
  ctl: string;
  label: string;
  /** chosen colour (slot) and team, -1 when not chosen */
  color: number;
  team: number;
}

export interface LobbyView {
  slots: Slot[];
  /** per slot: how the player plays (control set name), '' for computer players and empty slots */
  labels: string[];
  rules: Rules;
  /** per slot: which computer player of the host it is (-1 for the others) */
  botOf: number[];
}

/** Something only the host may change, asked of it by another machine (a request in the chat). */
export interface LobbyChange {
  rules?: Partial<Rules>;
  /** one more computer player, of this skill */
  addBot?: number;
  /** remove the host's computer player k */
  removeBot?: number;
  /** a new skill for the host's computer player k */
  botSkill?: { k: number; skill: number };
}

/** A line of the lobby chat. */
export interface ChatLine {
  id: number;
  /** say: a message; ask: a change asked of the host; info: who came, who left, who was removed */
  kind: 'say' | 'ask' | 'info';
  /** the machine that said or asked it (0 for info lines), and its name */
  from: number;
  name: string;
  text: string;
  /** ask: what is asked, and whether the host made the change */
  change?: LobbyChange;
  done?: boolean;
  /** Date.now() on the host */
  at: number;
}

/** players one machine may bring (the ten slots are the real limit) */
const MAX_LOCAL = 10;
/** lines the chat keeps, characters per message */
const CHAT_KEEP = 100;
const CHAT_CHARS = 200;
const RULE_KEYS: (keyof Rules)[] = ['level', 'levels', 'listName', 'wins', 'scheme', 'playtime', 'enclosement', 'conveyor', 'randomStart', 'stomped', 'diseases', 'teamPlay', 'winByKills', 'goldman'];

/** One line of text, at most CHAT_CHARS characters (never half an emoji). */
function cleanText(text: string): string {
  return Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, CHAT_CHARS).join('');
}

/** A request as another machine sent it: only what it may ask for, with values of the right kind. */
function cleanChange(c: unknown): LobbyChange | null {
  if (!c || typeof c !== 'object') return null;
  const x = c as Record<string, unknown>;
  const int = (v: unknown) => (Number.isInteger(v) ? (v as number) : undefined);
  const skill = (v: number) => Math.max(0, Math.min(5, v));
  const out: LobbyChange = {};
  if (x.rules && typeof x.rules === 'object') {
    const r: Record<string, unknown> = {};
    for (const k of RULE_KEYS) {
      const v = (x.rules as Record<string, unknown>)[k];
      if (k === 'levels') {
        if (Array.isArray(v)) r[k] = cleanLevels(v);
      } else if (k === 'scheme' || k === 'listName') {
        if (typeof v === 'string' && v.length <= 64) r[k] = v;
      } else if (int(v) !== undefined) r[k] = v;
    }
    if (Object.keys(r).length) out.rules = r as Partial<Rules>;
  }
  const add = int(x.addBot);
  if (add !== undefined) out.addBot = skill(add);
  const rm = int(x.removeBot);
  if (rm !== undefined) out.removeBot = rm;
  const bs = x.botSkill as Record<string, unknown> | undefined;
  const k = int(bs?.k);
  const v = int(bs?.skill);
  if (k !== undefined && v !== undefined) out.botSkill = { k, skill: skill(v) };
  return Object.keys(out).length ? out : null;
}

/** Requests of the same thing in a row become one line (a player stepping through round times). */
function changeKey(c: LobbyChange): string {
  return [
    Object.keys(c.rules ?? {}).sort().join(','),
    c.addBot !== undefined ? 'add' : '',
    c.removeBot !== undefined ? `rm${c.removeBot}` : '',
    c.botSkill ? `skill${c.botSkill.k}` : '',
  ].join('|');
}

function emptySlots(): Slot[] {
  return Array.from({ length: 10 }, (_, i) => ({ type: INPUT_OFF, dev: 0, team: i & 1, owner: 0, ai: AI_DEFAULT }));
}

export class LobbyModel {
  readonly net: NetSession;
  view: LobbyView;
  onChange: () => void = () => {};
  /** clients: the host started the match */
  onStart: (params: MatchParams) => void = () => {};
  private g: Game;
  /** host: players of every machine (the host's own under its id) */
  private wants = new Map<number, LocalPlayer[]>();
  private bots: number[];
  private botLooks: Look[];
  private timer: ReturnType<typeof setInterval>;
  private beacon: LanBeacon | null = null;
  /** this machine's players who play (their device is there) */
  private mine: LocalPlayer[] = [];
  /** this machine's players, also those whose device is not there now (they come back with it) */
  private wanted: LocalPlayer[] = [];
  /** the chat, oldest first (the host keeps it and sends it to newcomers) */
  chat: ChatLine[] = [];
  private chatSeq = 0;
  /** host: the machines in the room at the last look, with their names (for "joined" and "left") */
  private present = new Map<number, string>();
  /** host: machines it removed (their departure is said differently) */
  private removed = new Set<number>();

  constructor(g: Game, net: NetSession, players: LocalPlayer[], bots: number[]) {
    this.g = g;
    this.net = net;
    this.bots = net.role === 'host' ? [...bots] : [];
    this.botLooks = this.bots.map(() => NO_LOOK);
    this.view = { slots: emptySlots(), labels: new Array(10).fill(''), rules: rulesFromSettings(g.settings), botOf: new Array(10).fill(-1) };
    this.setWanted(players);
    // back in the room after a lost connection: the host needs this machine's players again
    net.onRejoined = () => this.net.send(this.net.hostId, { t: 'mine', players: this.mine });
    this.timer = setInterval(() => this.poll(), 80);
    if (net.role === 'host') void this.startBeacon();
  }

  get isHost(): boolean {
    return this.net.role === 'host';
  }

  /** This machine's players who play (control sets). */
  private setMine(players: LocalPlayer[]): void {
    this.mine = players.slice(0, MAX_LOCAL);
    if (this.isHost) {
      this.wants.set(this.net.myId, this.mine);
      this.arrange();
    } else {
      this.net.send(this.net.hostId, { t: 'mine', players: this.mine });
    }
  }

  /** This machine's players, also those whose device is not there now: those whose device is there play. */
  setWanted(players: LocalPlayer[]): void {
    this.wanted = players;
    this.refreshMine(true);
  }

  /** Devices came or went: their players come and go (`force`: tell the host anyway). */
  refreshMine(force = false): void {
    const avail = availableIds(this.g);
    const prefs = this.g.settings.controls;
    const now: LocalPlayer[] = [];
    for (const p of this.wanted) if (avail.has(p.ctl) && !now.some((q) => idsClash(prefs, q.ctl, p.ctl))) now.push(p);
    const same = now.length === this.mine.length && now.every((p, i) => p === this.mine[i]);
    if (force || !same) this.setMine(now);
  }

  get myPlayers(): LocalPlayer[] {
    return this.mine;
  }

  /** This machine's players whose device is not there now. */
  get waiting(): LocalPlayer[] {
    return this.wanted.filter((p) => !this.mine.includes(p));
  }

  /** A new colour or team for one of this machine's players. */
  setMyLook(ctl: string, look: Look): void {
    this.setWanted(this.wanted.map((p) => (p.ctl === ctl ? { ...p, color: look.color, team: look.team } : p)));
  }

  // ------------------------------------------------------------------------------------- host

  addBot(skill: number): void {
    if (!this.isHost || this.count() >= 10) return;
    this.bots.push(skill);
    this.botLooks.push(NO_LOOK);
    this.arrange();
  }

  removeBot(k: number): void {
    this.bots.splice(k, 1);
    this.botLooks.splice(k, 1);
    this.arrange();
  }

  /** Host: a new colour or team for computer player `k`. */
  setBotLook(k: number, look: Look): void {
    if (!this.isHost || k < 0 || k >= this.bots.length) return;
    this.botLooks[k] = look;
    this.arrange();
  }

  botLook(k: number): Look {
    return this.botLooks[k] ?? NO_LOOK;
  }

  setBotSkill(k: number, skill: number): void {
    this.bots[k] = skill;
    this.arrange();
  }

  get botSkills(): number[] {
    return this.bots;
  }

  setRules(r: Rules): void {
    if (!this.isHost) return;
    this.view.rules = r;
    applyRules(this.g.settings, r);
    this.g.app.saveSettings();
    this.arrange();
  }

  private count(): number {
    let n = this.bots.length;
    for (const list of this.wants.values()) n += list.length;
    return n;
  }

  /** Host: rebuild the table (everybody in the slot of their colour) and send it to everyone. */
  private arrange(): void {
    if (!this.isHost) return;
    const slots = emptySlots();
    const labels = new Array(10).fill('');
    const botOf = new Array(10).fill(-1);
    const machines = [this.net.myId, ...this.net.members.filter((m) => m.open).map((m) => m.id)];
    const entries: { owner: number; p?: LocalPlayer; bot?: number; look: Look }[] = [];
    for (const id of machines) {
      for (const p of this.wants.get(id) ?? []) entries.push({ owner: id, p, look: { color: p.color ?? -1, team: p.team ?? -1 } });
    }
    this.bots.forEach((_, k) => entries.push({ owner: this.net.myId, bot: k, look: this.botLooks[k] ?? NO_LOOK }));
    const slotOf = placeLineup(entries.map((e) => e.look));
    const teams = schemeTeams(this.g, this.view.rules.scheme);
    // names in the score lines: the machine's, numbered when it brings several players
    const per = new Map<number, number>();
    for (const e of entries) if (e.p) per.set(e.owner, (per.get(e.owner) ?? 0) + 1);
    const seen = new Map<number, number>();
    let n = 0;
    entries.forEach((e, k) => {
      const i = slotOf[k];
      if (i < 0) return;
      n++;
      const team = teamFor(e.look, i, teams);
      if (e.p) {
        const nth = (seen.get(e.owner) ?? 0) + 1;
        seen.set(e.owner, nth);
        const who = e.owner === this.net.myId ? this.net.name : this.net.memberName(e.owner);
        const name = (per.get(e.owner) ?? 1) > 1 ? `${who} ${nth}` : who;
        slots[i] = { type: INPUT_KEY, dev: 0, team, owner: e.owner, ai: AI_DEFAULT, ctl: e.p.ctl, name };
        labels[i] = e.p.label;
      } else {
        slots[i] = { type: INPUT_AI, dev: 0, team, owner: this.net.myId, ai: this.bots[e.bot!], name: 'CPU' };
        botOf[i] = e.bot!;
      }
    });
    this.view = { slots, labels, rules: this.view.rules, botOf };
    this.net.broadcast({ t: 'lobby', slots, labels, rules: this.view.rules, botOf });
    this.beacon?.update({ players: n, level: this.view.rules.level, host: this.net.name });
    this.onChange();
  }

  /** Host: everything a match needs, or why it cannot start. */
  check(): string | null {
    const active = this.view.slots.filter((s) => s.type !== INPUT_OFF);
    if (active.length < 2) return 'At least two players are needed (add a computer player?)';
    if (this.view.rules.teamPlay && new Set(active.map((s) => s.team)).size < 2) return 'Both teams need at least one player';
    const scheme = allSchemes(this.g.app).find((s) => s.file.toUpperCase() === this.view.rules.scheme.toUpperCase());
    const m = scheme && /\((\d+)( ONLY)?\)\s*$/i.exec(scheme.name);
    if (m && active.length > Number(m[1])) return `This scheme has room for ${m[1]} players`;
    return null;
  }

  /** Host: start the match on every machine; returns the parameters for this one. */
  start(): MatchParams {
    const g = this.g;
    applyRules(g.settings, this.view.rules);
    g.session.slots = this.view.slots.map((s) => ({ ...s }));
    const params = buildParams(g, this.view.rules.level);
    params.schemeText = schemeFileText(g.app, params.scheme) ?? undefined;
    this.net.setOpen(false);
    this.beacon?.stop();
    this.net.aborted = false;
    this.net.broadcast({ t: 'start', params, slots: g.session.slots });
    return params;
  }

  /** Back in the lobby after a match (devices may have come and gone meanwhile: nobody listened). */
  resume(): void {
    this.net.aborted = false;
    if (this.isHost) {
      this.net.setOpen(true);
      this.beacon?.start();
    }
    // (the host arranges the table again; the others tell the host their players)
    this.refreshMine(true);
  }

  private async startBeacon(): Promise<void> {
    if (!this.g.settings.lanVisible) return;
    const keys = await lanKeys(this.net.relay);
    if (!keys.length || !this.isHost || !this.net.code) return;
    this.beacon = new LanBeacon(this.net.relay, keys, { code: this.net.code, host: this.net.name, players: this.count(), max: 10, level: this.view.rules.level });
    this.beacon.start();
  }

  setLanVisible(on: boolean): void {
    this.g.settings.lanVisible = on ? 1 : 0;
    this.g.app.saveSettings();
    if (!this.isHost) return;
    if (on && !this.beacon) void this.startBeacon();
    else if (on) this.beacon?.start();
    else this.beacon?.stop();
  }

  // ------------------------------------------------------------------------------------- chat

  /** Say something to everybody in the room. */
  say(text: string): void {
    const t = cleanText(text);
    if (!t) return;
    if (this.isHost) this.post({ kind: 'say', from: this.net.myId, name: this.net.name, text: t });
    else this.net.send(this.net.hostId, { t: 'chat-say', text: t });
  }

  /** Not the host: ask it for a change, which everybody sees in the chat. Returns how the request reads. */
  ask(change: LobbyChange): string {
    this.net.send(this.net.hostId, { t: 'chat-ask', change });
    return this.describe(change);
  }

  /** Host: make the change that a request of the chat asks for. */
  grant(id: number): void {
    const line = this.chat.find((l) => l.id === id);
    if (!this.isHost || !line || line.kind !== 'ask' || line.done || !line.change) return;
    const c = line.change;
    if (c.rules) this.setRules({ ...this.view.rules, ...c.rules });
    if (c.addBot !== undefined) this.addBot(c.addBot);
    if (c.removeBot !== undefined && c.removeBot < this.bots.length) this.removeBot(c.removeBot);
    if (c.botSkill && c.botSkill.k < this.bots.length) this.setBotSkill(c.botSkill.k, c.botSkill.skill);
    this.update({ ...line, done: true });
  }

  /** Host: remove a machine from the room (and so its players). */
  kick(id: number): void {
    if (!this.isHost || !this.present.has(id)) return;
    this.removed.add(id);
    this.post({ kind: 'info', from: 0, name: '', text: `${this.net.memberName(id)} was removed from the game` });
    this.net.kick(id);
  }

  /** How a change reads ("Round time 3:00", "another computer player (Skilled)"). */
  describe(c: LobbyChange): string {
    const parts: string[] = [];
    if (c.rules) parts.push(describeRules(this.g, { ...this.view.rules, ...c.rules }, c.rules));
    if (c.addBot !== undefined) parts.push(`another computer player (${SKILL_NAMES[c.addBot] ?? c.addBot})`);
    if (c.removeBot !== undefined) parts.push(`remove ${this.botName(c.removeBot)}`);
    if (c.botSkill) parts.push(`${this.botName(c.botSkill.k)} at ${SKILL_NAMES[c.botSkill.skill] ?? c.botSkill.skill}`);
    return parts.join(' · ');
  }

  /** "the red computer player" */
  private botName(k: number): string {
    const slot = this.view.botOf.indexOf(k);
    return slot >= 0 ? `the ${COLOUR_NAMES[slot].toLowerCase()} computer player` : 'a computer player';
  }

  /** Host: a new line, for everybody. */
  private post(l: Omit<ChatLine, 'id' | 'at'>): void {
    const line: ChatLine = { ...l, id: ++this.chatSeq, at: Date.now() };
    this.chat.push(line);
    if (this.chat.length > CHAT_KEEP) this.chat.splice(0, this.chat.length - CHAT_KEEP);
    this.net.broadcast({ t: 'chat', lines: [line] });
    this.onChange();
  }

  /** Host: a line changed (a request updated or granted). */
  private update(line: ChatLine): void {
    const i = this.chat.findIndex((l) => l.id === line.id);
    if (i < 0) return;
    this.chat[i] = line;
    this.net.broadcast({ t: 'chat', lines: [line] });
    this.onChange();
  }

  /** Host: a machine asked for a change. */
  private asked(from: number, raw: unknown): void {
    const c = cleanChange(raw);
    if (!c) return;
    const text = this.describe(c);
    const last = this.chat[this.chat.length - 1];
    if (last?.kind === 'ask' && !last.done && last.from === from && last.change && changeKey(last.change) === changeKey(c) && Date.now() - last.at < 5000) {
      this.update({ ...last, change: c, text, at: Date.now() });
    } else this.post({ kind: 'ask', from, name: this.net.memberName(from), text, change: c });
  }

  /** Host: say who came and who left; a newcomer gets the chat so far. */
  private membersChanged(ids: Set<number>): void {
    const net = this.net;
    for (const id of ids) {
      if (this.present.has(id)) continue;
      const name = net.memberName(id);
      this.present.set(id, name);
      net.send(id, { t: 'chat', lines: this.chat, reset: true });
      this.post({ kind: 'info', from: 0, name: '', text: `${name} joined` });
    }
    for (const [id, name] of [...this.present]) {
      if (ids.has(id)) continue;
      this.present.delete(id);
      if (!this.removed.delete(id)) this.post({ kind: 'info', from: 0, name: '', text: `${name} left` });
    }
  }

  // ------------------------------------------------------------------------------------- messages

  private known = '';

  private poll(): void {
    const net = this.net;
    if (this.isHost) {
      let changed = false;
      for (const { from, msg } of net.take('mine')) {
        const list = (msg.players as LocalPlayer[] | undefined) ?? [];
        this.wants.set(
          from,
          list.slice(0, MAX_LOCAL).map((p) => ({
            ctl: String(p.ctl),
            label: String(p.label).slice(0, 40),
            color: Number.isInteger(p.color) ? Number(p.color) : -1,
            team: p.team === 0 || p.team === 1 ? p.team : -1,
          })),
        );
        changed = true;
      }
      for (const { from, msg } of net.take('chat-say')) {
        const t = cleanText(String(msg.text ?? ''));
        if (t) this.post({ kind: 'say', from, name: net.memberName(from), text: t });
      }
      for (const { from, msg } of net.take('chat-ask')) this.asked(from, msg.change);
      // machines that left lose their players; newcomers get the current table
      const ids = new Set(net.members.filter((m) => m.open).map((m) => m.id));
      for (const id of [...this.wants.keys()]) {
        if (id !== net.myId && !ids.has(id)) {
          this.wants.delete(id);
          changed = true;
        }
      }
      const sig = [...ids].sort().join(',');
      if (sig !== this.known) {
        this.known = sig;
        changed = true;
        this.membersChanged(ids);
      }
      if (changed) this.arrange();
    } else {
      const lobby = net.take('lobby');
      if (lobby.length) {
        const m = lobby[lobby.length - 1].msg;
        this.view = { slots: m.slots as Slot[], labels: m.labels as string[], rules: m.rules as Rules, botOf: (m.botOf as number[]) ?? new Array(10).fill(-1) };
        this.onChange();
      }
      for (const { msg } of net.take('chat')) {
        if (msg.reset) this.chat = [];
        for (const l of (msg.lines as ChatLine[] | undefined) ?? []) {
          const i = this.chat.findIndex((x) => x.id === l.id);
          if (i >= 0) this.chat[i] = l;
          else this.chat.push(l);
        }
        if (this.chat.length > CHAT_KEEP) this.chat.splice(0, this.chat.length - CHAT_KEEP);
        this.onChange();
      }
      const start = net.take('start');
      if (start.length) {
        const m = start[start.length - 1].msg;
        this.g.session.slots = (m.slots as Slot[]).map((s) => ({ ...s }));
        this.onStart(m.params as MatchParams);
      }
      // the member list (pings, names) changes the display too
      const sig = net.members.map((m) => `${m.id}:${m.open}`).join(',');
      if (sig !== this.known) {
        this.known = sig;
        this.onChange();
      }
    }
  }

  dispose(): void {
    clearInterval(this.timer);
    this.net.onRejoined = null;
    this.beacon?.stop();
    this.beacon = null;
  }
}
