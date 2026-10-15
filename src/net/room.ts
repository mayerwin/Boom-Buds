// Rooms: the machines of a network game meet under a 6-character room code on a relay
// (src/net/relay.ts), then connect directly to each other with WebRTC (src/net/mesh.ts). The relay only
// carries the handshake, encrypted with a key derived from the room code.
//
// Messages on the room's topic (JSON envelope {v, mid, from, t, ...}):
//   join    {name, build}               a machine asks to enter (repeated until answered)
//   welcome {to, peers:[{id,name}]}     host -> newcomer: the machines to connect to
//   deny    {to, reason}                host -> newcomer: full / started / version / kicked
//   sig     {to, name, data}            WebRTC offer / answer / ICE candidate for one machine
//   bye     {}                          a machine leaves (the host leaving closes the room)

import type { Relay } from './relay.ts';
import { buildId } from '../engine/build.ts';

export const ROOM_PROTOCOL = 1;
/** Room code symbols: letters and digits without the ones that look alike (0 O, 1 I L). */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;

export function newRoomCode(): string {
  const r = new Uint32Array(CODE_LENGTH);
  crypto.getRandomValues(r);
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[r[i] % CODE_ALPHABET.length];
  return s;
}

/** Canonical form of a typed room code (case, spaces and dashes do not matter), or null. */
export function normalizeRoomCode(text: string): string | null {
  const c = text.toUpperCase().replace(/[\s-]/g, '');
  if (c.length !== CODE_LENGTH) return null;
  for (const ch of c) if (!CODE_ALPHABET.includes(ch)) return null;
  return c;
}

/** Topic name of a room: a hash of the code (FNV-1a, 64 bits as two 32-bit lanes). */
export function roomTopic(code: string): string {
  let a = 0x811c9dc5;
  let b = 0x050c5d1f;
  for (const ch of `boombuds:${code}`) {
    const c = ch.charCodeAt(0);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193) ^ (a >>> 7);
    b >>>= 0;
  }
  return `boombuds/${ROOM_PROTOCOL}/${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** AES-GCM key from the room code (null without Web Crypto, e.g. plain-http pages other than localhost). */
async function roomKey(code: string): Promise<CryptoKey | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const base = await subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('boombuds-room-v1'), iterations: 5000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 128 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export type JoinResult =
  | { ok: true; hostId: number; peers: { id: number; name: string }[] }
  | { ok: false; reason: 'not-found' | 'full' | 'started' | 'version' | 'kicked' };

type Handler = (m: Record<string, unknown>) => void;

export class RoomSignaling {
  /** this machine (random, positive 31-bit) */
  readonly id: number;
  name: string;
  /** names of the machines seen in the room */
  readonly names = new Map<number, string>();
  code = '';
  role: 'none' | 'host' | 'client' = 'none';
  hostId = 0;
  /** host: new machines may enter */
  open = true;
  /** host: machines in the room, the host included */
  memberCount: () => number = () => 1;
  maxMembers = 10;
  private relay: Relay;
  private topic = '';
  private key: CryptoKey | null = null;
  private unsub: (() => void) | null = null;
  private seen = new Set<string>();
  private seenOrder: string[] = [];
  private handlers = new Map<string, Set<Handler>>();
  /** machines welcomed by this host */
  private welcomed = new Set<number>();
  /** host: machines it removed from this room (they may not come back with the same session) */
  private banned = new Set<number>();

  constructor(relay: Relay, name: string) {
    this.relay = relay;
    this.name = name;
    const r = new Uint32Array(1);
    crypto.getRandomValues(r);
    this.id = (r[0] % 0x7ffffffe) + 1;
    this.names.set(this.id, name);
  }

  on(type: string, h: Handler): () => void {
    let s = this.handlers.get(type);
    if (!s) {
      s = new Set();
      this.handlers.set(type, s);
    }
    s.add(h);
    return () => s.delete(h);
  }

  private emit(type: string, m: Record<string, unknown>): void {
    for (const h of [...(this.handlers.get(type) ?? [])]) h(m);
  }

  private async enter(code: string): Promise<void> {
    this.leave();
    this.code = code;
    this.topic = roomTopic(code);
    this.key = this.relay.local ? null : await roomKey(code);
    this.unsub = this.relay.subscribe(this.topic, (d) => void this.receive(d));
  }

  /** Open a new room with a fresh code; this machine is its host. */
  async create(): Promise<string> {
    await this.enter(newRoomCode());
    this.role = 'host';
    this.hostId = this.id;
    this.open = true;
    this.welcomed.clear();
    this.banned.clear();
    return this.code;
  }

  /** Enter the room `code`: resolves with the machines to connect to, or why that is not possible. */
  async join(code: string, timeoutMs = 10_000): Promise<JoinResult> {
    await this.enter(code);
    this.role = 'client';
    return new Promise((resolve) => {
      let done = false;
      const finish = (r: JoinResult) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(again);
        off();
        if (!r.ok) this.leave();
        resolve(r);
      };
      const timer = setTimeout(() => finish({ ok: false, reason: 'not-found' }), timeoutMs);
      const ask = () => this.post({ t: 'join', name: this.name, build: buildId() });
      const again = setInterval(ask, 1500);
      const off = this.on('reply', (m) => {
        if (m.t === 'welcome') {
          this.hostId = Number(m.from);
          const peers = (m.peers as { id: number; name: string }[]).filter((p) => p.id !== this.id);
          for (const p of peers) this.names.set(p.id, p.name);
          finish({ ok: true, hostId: this.hostId, peers });
        } else if (m.t === 'deny') {
          const reason = String(m.reason);
          finish({ ok: false, reason: reason === 'full' || reason === 'started' || reason === 'version' || reason === 'kicked' ? reason : 'not-found' });
        }
      });
      ask();
    });
  }

  /** WebRTC signaling data for machine `to` (used by the mesh). */
  signal(to: number, data: unknown): void {
    this.post({ t: 'sig', to, name: this.name, data });
  }

  /** Leave the room (the others are told); the relay connection stays open. */
  leave(): void {
    if (this.unsub) {
      this.post({ t: 'bye' });
      this.unsub();
    }
    this.unsub = null;
    this.role = 'none';
    this.hostId = 0;
    this.code = '';
    this.welcomed.clear();
  }

  // ------------------------------------------------------------------------------------- transport

  private post(m: Record<string, unknown>): void {
    const mid = Math.random().toString(36).slice(2, 12);
    this.remember(mid);
    const topic = this.topic;
    const key = this.key;
    const body = enc.encode(JSON.stringify({ v: ROOM_PROTOCOL, mid, from: this.id, ...m }));
    void (async () => {
      let out: Uint8Array;
      if (key) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, body));
        out = new Uint8Array(1 + 12 + ct.length);
        out[0] = 1;
        out.set(iv, 1);
        out.set(ct, 13);
      } else {
        out = new Uint8Array(1 + body.length);
        out[0] = 0;
        out.set(body, 1);
      }
      if (topic) this.relay.publish(topic, out);
    })();
  }

  /** Remember a message id (the same message arrives once per broker); false if already seen. */
  private remember(mid: string): boolean {
    if (this.seen.has(mid)) return false;
    this.seen.add(mid);
    this.seenOrder.push(mid);
    if (this.seenOrder.length > 2000) this.seen.delete(this.seenOrder.shift()!);
    return true;
  }

  private async receive(d: Uint8Array): Promise<void> {
    let text: string;
    try {
      if (d[0] === 1) {
        if (!this.key) return;
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: d.slice(1, 13) }, this.key, d.slice(13));
        text = dec.decode(plain);
      } else if (d[0] === 0) {
        text = dec.decode(d.subarray(1));
      } else {
        return;
      }
    } catch {
      return; // another room's message on a colliding topic, or garbage
    }
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    const from = Number(m.from);
    if (!from || from === this.id || typeof m.mid !== 'string' || !this.remember(m.mid)) return;
    if (typeof m.name === 'string') this.names.set(from, m.name.slice(0, 32));
    const toMe = Number(m.to) === this.id;
    switch (m.t) {
      case 'join':
        if (this.role === 'host') this.admit(from, m);
        break;
      case 'welcome':
      case 'deny':
        if (toMe) this.emit('reply', m);
        break;
      case 'sig':
        if (toMe) this.emit('signal', { from, data: m.data });
        break;
      case 'bye':
        this.welcomed.delete(from);
        this.emit('peer-left', { peer: from });
        if (from === this.hostId && this.role === 'client') this.emit('room-closed', {});
        break;
    }
  }

  private admit(from: number, m: Record<string, unknown>): void {
    const deny = (reason: string) => this.post({ t: 'deny', to: from, reason });
    // the same release on every machine (two builds could simulate differently); development builds have no id
    const mine = buildId();
    if (m.v !== ROOM_PROTOCOL || (mine && m.build && m.build !== mine)) return deny('version');
    if (this.banned.has(from)) return deny('kicked');
    const again = this.welcomed.has(from);
    if (!again) {
      if (!this.open) return deny('started');
      if (this.memberCount() >= this.maxMembers) return deny('full');
    }
    this.welcomed.add(from);
    const peers = [{ id: this.id, name: this.name }];
    for (const id of this.welcomed) if (id !== from) peers.push({ id, name: this.names.get(id) ?? '?' });
    this.post({ t: 'welcome', to: from, peers });
    if (!again) this.emit('peer-joined', { peer: { id: from, name: this.names.get(from) ?? '?' } });
  }

  /** Host: forget a machine that left (its slot in the room is free again). */
  forget(id: number): void {
    this.welcomed.delete(id);
  }

  /** Host: a machine removed from the room is refused if it asks to come back. */
  ban(id: number): void {
    this.banned.add(id);
    this.welcomed.delete(id);
  }

  close(): void {
    this.leave();
    this.handlers.clear();
  }
}
