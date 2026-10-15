// A network game session: a room on a relay (6-character code, src/net/room.ts), the WebRTC mesh between
// all machines of the room and the control messages the menus exchange. The host is authoritative for
// everything outside the simulation (players, settings, when screens advance); during rounds every
// machine runs the same deterministic simulation from everybody's inputs (rollback, src/net/rollback.ts).

import { Mesh, decodeInputMsg } from './mesh.ts';
import { RoomSignaling } from './room.ts';
import { LocalRelay, MqttRelay, type Relay } from './relay.ts';
import type { InputMsg } from './rollback.ts';

export interface CtlMsg {
  t: string;
  [k: string]: unknown;
}

export interface Member {
  id: number;
  name: string;
  /** data channels open */
  open: boolean;
  /** when the host welcomed it (performance.now) */
  since: number;
  /** nothing heard from it for a few seconds (shown as "connection lost") */
  stale?: boolean;
}

/**
 * How long another machine may stay silent before it counts as gone (ms). Pings flow every second, inputs
 * every frame during rounds. In the lobby nothing waits for anybody, so a phone may lock its screen or
 * switch apps for a while (much longer when its page said it went to the background); during a match
 * everybody's game waits for every machine's inputs, so a silent one is given up on sooner (its players are
 * then played by the host), except while the match is paused: nobody is in a hurry then.
 */
const LOBBY_TIMEOUT = 20_000;
const AWAY_TIMEOUT = 120_000;
const MATCH_TIMEOUT = 8_000;
const STALE_AFTER = 3_000;

export type JoinOutcome = 'ok' | 'not-found' | 'full' | 'started' | 'version' | 'kicked' | 'failed';

/**
 * The relay to meet on: public MQTT brokers, or the dev / LAN server's (`?relay=local`, and the default on
 * the pages the LAN server serves), or `?relay=wss://...`; `?relay=public` forces the public brokers.
 */
export function defaultRelay(): Relay {
  const p = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('relay') : null;
  const served = typeof document !== 'undefined' ? document.querySelector<HTMLMetaElement>('meta[name="boombuds-relay"]')?.content : null;
  if (p === 'local' || (!p && served === 'local')) return new LocalRelay();
  if (p && /^wss?:\/\//.test(p)) return new MqttRelay([p]);
  return new MqttRelay();
}

export class NetSession {
  readonly relay: Relay;
  readonly room: RoomSignaling;
  readonly mesh: Mesh;
  role: 'host' | 'client' = 'client';
  readonly myId: number;
  hostId = 0;
  name: string;
  /** other machines of the room (join order) */
  readonly members: Member[] = [];
  private ctl: { from: number; msg: CtlMsg }[] = [];
  /** the host left / closed the room (clients) */
  hostLost = false;
  /** the host aborted the running match (clients; reset when a match starts) */
  aborted = false;
  /** the host removed this machine from the room (clients; this machine left it at once) */
  kicked = false;
  /** inputs received for the running round */
  onInput: ((msg: InputMsg & { round: number }) => void) | null = null;
  /** a member left (or its connection failed) */
  onLeave: ((id: number) => void) | null = null;
  /** something about the members changed (lobby display) */
  onMembers: (() => void) | null = null;
  /** clients: back in the room after a lost connection to the host (the lobby re-sends its players) */
  onRejoined: (() => void) | null = null;
  /** a match is being played (src/screens/match.ts): machines are given up on sooner */
  inMatch = false;
  /** the running round is paused (src/screens/round.ts): as patient as in the lobby */
  paused = false;
  /** clients: getting back into the room after losing the connection to the host in the lobby */
  reconnecting = false;
  private lastTick = performance.now();
  private onVisibility: () => void;
  /** machines that said goodbye (they left on purpose) */
  private byeFrom = new Set<number>();
  private unsub: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval>;

  private constructor(relay: Relay, name: string) {
    this.relay = relay;
    this.name = name;
    this.room = new RoomSignaling(relay, name);
    this.myId = this.room.id;
    this.room.memberCount = () => 1 + this.members.length;
    this.mesh = new Mesh(this.room);
    this.mesh.onControl = (from, msg) => {
      if (msg.t === 'abort' && from === this.hostId) this.aborted = true;
      else if (msg.t === 'kick' && from === this.hostId && this.role === 'client') {
        this.leaveRoom();
        this.kicked = true;
      } else this.ctl.push({ from, msg: msg as CtlMsg });
    };
    this.mesh.onInput = (_from, data) => {
      const m = decodeInputMsg(data);
      if (m && this.onInput) this.onInput(m);
    };
    this.mesh.onPeerOpen = (p) => {
      const name = this.room.names.get(p.id) ?? p.name;
      const m = this.members.find((x) => x.id === p.id);
      if (m) {
        m.open = true;
        m.name = name;
      } else {
        this.members.push({ id: p.id, name, open: true, since: performance.now() });
      }
      this.onMembers?.();
    };
    this.mesh.onPeerClosed = (id, bye) => {
      if (bye) this.byeFrom.add(id);
      this.memberGone(id, bye);
    };
    this.unsub.push(this.room.on('room-closed', () => (this.hostLost = true)));
    this.unsub.push(this.room.on('peer-left', (m) => {
      this.byeFrom.add(Number(m.peer));
      this.memberGone(Number(m.peer), true);
    }));
    this.unsub.push(this.room.on('peer-joined', (m) => {
      const p = m.peer as { id: number; name: string };
      if (!this.members.find((x) => x.id === p.id)) this.members.push({ id: p.id, name: p.name, open: false, since: performance.now() });
      this.onMembers?.();
    }));
    this.timer = setInterval(() => this.tick(), 1000);
    // a closed tab says goodbye at once (otherwise its peers notice after the silence timeout)
    this.onPageHide = () => {
      this.mesh.sayBye();
      this.room.leave();
    };
    window.addEventListener('pagehide', this.onPageHide);
    // a page going to the background warns the others that it may fall silent; coming back, a client that
    // lost the host meanwhile gets back into the room
    this.onVisibility = () => {
      this.mesh.sayAway(document.hidden);
      if (!document.hidden) this.tick();
    };
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  private onPageHide: () => void;

  /** Connect to the relay; rejects when it cannot be reached (offline). */
  static async connect(name: string, relay: Relay = defaultRelay()): Promise<NetSession> {
    await relay.start();
    return new NetSession(relay, name);
  }

  /**
   * Once a second: pings, silent machines (see LOBBY_TIMEOUT), and the host drops newcomers whose connection
   * never opened.
   */
  private tick(): void {
    this.mesh.ping();
    const now = performance.now();
    const gap = now - this.lastTick;
    this.lastTick = now;
    if (gap > 2500) {
      // this page itself was stalled or suspended (busy phone, locked screen): what the others sent meanwhile
      // is still queued, so their silence counts from now on
      for (const p of this.mesh.peers.values()) p.lastSeen = Math.max(p.lastSeen, now - 1000);
      return;
    }
    let changed = false;
    for (const p of [...this.mesh.peers.values()]) {
      if (!p.open) continue;
      const silent = now - p.lastSeen;
      if (silent > (this.inMatch && !this.paused ? MATCH_TIMEOUT : p.away ? AWAY_TIMEOUT : LOBBY_TIMEOUT)) {
        this.memberGone(p.id);
        continue;
      }
      const m = this.members.find((x) => x.id === p.id);
      const stale = silent > STALE_AFTER || p.away;
      if (m && !!m.stale !== stale) {
        m.stale = stale;
        changed = true;
      }
    }
    if (changed) this.onMembers?.();
    if (this.role !== 'host') return;
    for (const m of [...this.members]) if (!m.open && now - m.since > 20_000) this.memberGone(m.id);
  }

  /** Machine `id` is gone; `bye`: it left on purpose (otherwise its connection was lost). */
  private memberGone(id: number, bye = false): void {
    this.room.forget(id);
    this.mesh.drop(id, true);
    const i = this.members.findIndex((m) => m.id === id);
    if (i < 0) return;
    this.members.splice(i, 1);
    if (id === this.hostId && this.role === 'client') {
      // a lost connection in the lobby: try to get back into the room first (the host may only have lost us)
      if (!bye && !this.inMatch && this.room.code) void this.rejoin(this.room.code, id);
      else this.hostLost = true;
    }
    this.onLeave?.(id);
    this.onMembers?.();
  }

  /** Clients: back into the room after losing the host in the lobby; the host is lost if that fails. */
  private async rejoin(code: string, host: number): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.onMembers?.();
    // a host leaving on purpose also says goodbye on the relay, which may come a moment after the
    // connection closed: give it that moment
    await new Promise((res) => setTimeout(res, 1500));
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok && !this.byeFrom.has(host); attempt++) {
      const r = await this.join(code);
      ok = r === 'ok';
      if (r === 'not-found' || r === 'version') break;
      if (!ok) await new Promise((res) => setTimeout(res, 2000));
    }
    this.reconnecting = false;
    if (ok) this.onRejoined?.();
    else this.hostLost = true;
    this.onMembers?.();
  }

  // --------------------------------------------------------------------------------- rooms

  get code(): string {
    return this.room.code;
  }

  /** Change this machine's name (before creating or joining a room). */
  setName(name: string): void {
    this.name = name;
    this.room.name = name;
    this.room.names.set(this.myId, name);
  }

  /** Open a new room on the relay; this machine hosts it. Resolves with the room code. */
  async create(): Promise<string> {
    this.leaveRoom();
    this.kicked = false;
    this.role = 'host';
    const code = await this.room.create();
    this.hostId = this.myId;
    return code;
  }

  /** Host: whether new machines may enter (closed while a match runs). */
  setOpen(open: boolean): void {
    this.room.open = open;
  }

  /** Join the room `code`; resolves once the data channels to every machine of the room are open. */
  async join(code: string): Promise<JoinOutcome> {
    this.leaveRoom();
    this.kicked = false;
    this.role = 'client';
    const r = await this.room.join(code);
    if (!r.ok) return r.reason;
    this.hostId = r.hostId;
    for (const p of r.peers) {
      if (!this.members.find((x) => x.id === p.id)) this.members.push({ id: p.id, name: p.name, open: false, since: performance.now() });
      void this.mesh.connect(p.id, p.name);
    }
    const t0 = performance.now();
    let retried = false;
    for (;;) {
      await new Promise((res) => setTimeout(res, 50));
      if (this.hostLost) break;
      const missing = this.members.filter((m) => !m.open);
      if (!missing.length && this.members.some((m) => m.id === this.hostId)) return 'ok';
      const t = performance.now() - t0;
      if (!retried && t > 7000) {
        // a lost offer or answer on the relay: try those connections once more
        retried = true;
        for (const m of missing) {
          this.mesh.drop(m.id, true);
          void this.mesh.connect(m.id, m.name);
        }
      }
      if (t > 16_000) break;
    }
    this.leaveRoom();
    return 'failed';
  }

  /**
   * Host, in the lobby: remove machine `id` from the room. It is told (and leaves at once), the others see it
   * leave, and it is refused if it asks to come back with the same session.
   */
  kick(id: number): void {
    if (this.role !== 'host' || id === this.myId) return;
    this.room.ban(id);
    this.send(id, { t: 'kick' });
    // (a moment for the message to go out before the connection closes)
    setTimeout(() => this.memberGone(id, true), 300);
  }

  // --------------------------------------------------------------------------------- messages

  send(to: number, msg: CtlMsg): void {
    this.mesh.sendControl(to, msg);
  }

  broadcast(msg: CtlMsg): void {
    this.mesh.broadcastControl(msg);
  }

  /** Take the control messages received so far (optionally only those of type `t`). */
  take(t?: string): { from: number; msg: CtlMsg }[] {
    if (!t) {
      const all = this.ctl;
      this.ctl = [];
      return all;
    }
    const out = this.ctl.filter((m) => m.msg.t === t);
    if (out.length) this.ctl = this.ctl.filter((m) => m.msg.t !== t);
    return out;
  }

  /** Is there a pending message of type `t`? (not consumed) */
  peek(t: string): boolean {
    return this.ctl.some((m) => m.msg.t === t);
  }

  memberName(id: number): string {
    if (id === this.myId) return this.name;
    return this.members.find((m) => m.id === id)?.name ?? this.room.names.get(id) ?? '?';
  }

  /** Round trip time to the slowest member (ms). */
  maxRtt(): number {
    let r = 0;
    for (const p of this.mesh.peers.values()) r = Math.max(r, p.rtt);
    return r;
  }

  /** Round trip time to one member (ms, 0 when unknown). */
  rtt(id: number): number {
    return this.mesh.peers.get(id)?.rtt ?? 0;
  }

  /** Leave the current room; the relay connection stays open. */
  leaveRoom(): void {
    // the others learn at once that this machine left on purpose
    this.mesh.sayBye();
    this.room.leave();
    for (const id of [...this.mesh.peers.keys()]) this.mesh.drop(id, true);
    this.members.length = 0;
    this.ctl = [];
    this.hostLost = false;
    this.aborted = false;
    this.hostId = 0;
    this.role = 'client';
  }

  close(): void {
    clearInterval(this.timer);
    window.removeEventListener('pagehide', this.onPageHide);
    document.removeEventListener('visibilitychange', this.onVisibility);
    for (const u of this.unsub) u();
    this.unsub = [];
    this.room.close();
    this.mesh.close();
    this.relay.close();
  }
}
