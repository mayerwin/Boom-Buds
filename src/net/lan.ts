// Games on the local network, found without a room code. Browsers cannot broadcast on a LAN, but machines
// behind the same router share one public IP address: each browser learns it from a public STUN server and
// listens on a relay topic derived from it, where hosts announce their open games every two seconds.
// (IPv6 devices have their own addresses; they meet by their /64 network prefix instead.)

import type { Relay } from './relay.ts';
import { ROOM_PROTOCOL } from './room.ts';

export interface LanGame {
  code: string;
  host: string;
  players: number;
  max: number;
  /** arena (-1 random) */
  level: number;
  /** last announcement (performance.now) */
  seen: number;
}

function expandV6(a: string): string[] {
  const [head, tail] = a.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const fill = tail !== undefined ? new Array(Math.max(0, 8 - h.length - t.length)).fill('0') : [];
  return [...h, ...fill, ...t].map((x) => x.toLowerCase().replace(/^0+(?=.)/, ''));
}

/** Keys of this machine's network(s): its public IPv4 address, and/or its IPv6 /64 prefix. */
export async function networkKeys(timeoutMs = 3000): Promise<string[]> {
  if (typeof RTCPeerConnection === 'undefined') return [];
  const pc = new RTCPeerConnection({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }] });
  pc.createDataChannel('probe');
  const keys = new Set<string>();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      pc.close();
      resolve([...keys]);
    };
    const timer = setTimeout(finish, timeoutMs);
    pc.onicecandidate = (e) => {
      if (!e.candidate) return finish();
      const c = e.candidate;
      if (c.type !== 'srflx' || !c.address) return;
      if (c.address.includes(':')) keys.add(`v6:${expandV6(c.address).slice(0, 4).join(':')}`);
      else keys.add(`v4:${c.address}`);
    };
    pc.createOffer()
      .then((o) => pc.setLocalDescription(o))
      .catch(finish);
  });
}

/** Keys to meet on: every client of a local relay is on the same network; otherwise the public address. */
export async function lanKeys(relay: Relay): Promise<string[]> {
  return relay.local ? ['local'] : networkKeys();
}

function lanTopic(key: string): string {
  let h = 0x811c9dc5;
  let h2 = 0x9747b28c;
  for (const ch of `boombuds-lan:${key}`) {
    h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ch.charCodeAt(0), 0x5bd1e995) >>> 0;
  }
  return `boombuds/lan/${ROOM_PROTOCOL}/${h.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A host announcing its open game on the local network. */
export class LanBeacon {
  private relay: Relay;
  private topics: string[];
  private timer: ReturnType<typeof setInterval> | null = null;
  private info: Omit<LanGame, 'seen'>;

  constructor(relay: Relay, keys: string[], info: Omit<LanGame, 'seen'>) {
    this.relay = relay;
    this.topics = keys.map(lanTopic);
    this.info = info;
  }

  update(info: Partial<Omit<LanGame, 'seen'>>): void {
    this.info = { ...this.info, ...info };
  }

  start(): void {
    if (this.timer || !this.topics.length) return;
    this.send();
    this.timer = setInterval(() => this.send(), 2000);
  }

  private send(gone = false): void {
    const msg = enc.encode(JSON.stringify({ v: ROOM_PROTOCOL, ...this.info, gone, n: Math.random() }));
    for (const t of this.topics) this.relay.publish(t, msg);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.send(true);
  }
}

/** The open games announced on this machine's network(s). */
export class LanScanner {
  readonly games = new Map<string, LanGame>();
  onChange: (() => void) | null = null;
  /** a game to leave out (this machine's own) */
  ignore = '';
  private unsub: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval>;

  constructor(relay: Relay, keys: string[]) {
    for (const k of keys) this.unsub.push(relay.subscribe(lanTopic(k), (d) => this.receive(d)));
    this.timer = setInterval(() => this.expire(), 1000);
  }

  private receive(d: Uint8Array): void {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(dec.decode(d));
    } catch {
      return;
    }
    const code = String(m.code ?? '');
    if (m.v !== ROOM_PROTOCOL || !/^[A-Z0-9]{6}$/.test(code) || code === this.ignore) return;
    if (m.gone) {
      if (this.games.delete(code)) this.onChange?.();
      return;
    }
    const old = this.games.get(code);
    const g: LanGame = {
      code,
      host: String(m.host ?? '?').slice(0, 32),
      players: Number(m.players) || 0,
      max: Number(m.max) || 10,
      level: Number.isFinite(Number(m.level)) ? Number(m.level) : -1,
      seen: performance.now(),
    };
    this.games.set(code, g);
    if (!old || old.host !== g.host || old.players !== g.players || old.level !== g.level) this.onChange?.();
  }

  private expire(): void {
    const now = performance.now();
    let changed = false;
    for (const [code, g] of this.games) {
      if (now - g.seen > 7000) {
        this.games.delete(code);
        changed = true;
      }
    }
    if (changed) this.onChange?.();
  }

  list(): LanGame[] {
    return [...this.games.values()].sort((a, b) => a.host.localeCompare(b.host));
  }

  stop(): void {
    clearInterval(this.timer);
    for (const u of this.unsub) u();
    this.unsub = [];
  }
}
