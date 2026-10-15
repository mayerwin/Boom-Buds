// Message relays for the room signaling (src/net/room.ts). Players meet through free public MQTT brokers,
// several at once so that one being down does not matter; a development server can stand in for them
// (tests, LAN parties without internet). Only the connection handshake goes through a relay: the game
// itself runs over direct WebRTC connections.

import { MqttClient } from './mqtt.ts';

export interface Relay {
  /** Connect; resolves as soon as one connection works, rejects if none does. */
  start(): Promise<void>;
  /** Messages published on `topic` by anyone (this client included). */
  subscribe(topic: string, cb: (data: Uint8Array) => void): () => void;
  publish(topic: string, data: Uint8Array): void;
  /** working connections */
  readonly up: number;
  /**
   * Only reachable from one local network (the LAN server): its clients are all on the same network, and the
   * room handshake needs no encryption (pages served over plain http on a LAN have no Web Crypto anyway).
   */
  readonly local?: boolean;
  close(): void;
}

/** Free public MQTT brokers with WebSocket access (checked 2026-10). */
export const PUBLIC_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081',
];

type Listener = (data: Uint8Array) => void;

/** Publishes to every connected broker and listens on all of them (the room layer drops duplicates). */
export class MqttRelay implements Relay {
  private clients: MqttClient[];
  private subs = new Map<string, Set<Listener>>();
  private closed = false;

  constructor(urls: string[] = PUBLIC_BROKERS) {
    this.clients = urls.map((u) => {
      const c = new MqttClient(u);
      c.onMessage = (topic, payload) => {
        for (const cb of this.subs.get(topic) ?? []) cb(payload);
      };
      c.onClose = () => this.retry(c, 1000);
      return c;
    });
  }

  get up(): number {
    return this.clients.filter((c) => c.connected).length;
  }

  private async open(c: MqttClient): Promise<void> {
    await c.connect(`bb${Math.random().toString(36).slice(2, 12)}`);
    for (const t of this.subs.keys()) c.subscribe(t);
  }

  private retry(c: MqttClient, delay: number): void {
    setTimeout(() => {
      if (this.closed) return;
      this.open(c).catch(() => this.retry(c, Math.min(delay * 2, 30_000)));
    }, delay);
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      let failed = 0;
      for (const c of this.clients) {
        this.open(c).then(resolve, () => {
          if (++failed === this.clients.length) reject(new Error('no relay reachable'));
          if (!this.closed) this.retry(c, 5000);
        });
      }
    });
  }

  subscribe(topic: string, cb: Listener): () => void {
    let set = this.subs.get(topic);
    if (!set) {
      set = new Set();
      this.subs.set(topic, set);
      for (const c of this.clients) if (c.connected) c.subscribe(topic);
    }
    set.add(cb);
    return () => {
      set.delete(cb);
      if (set.size || this.subs.get(topic) !== set) return;
      this.subs.delete(topic);
      for (const c of this.clients) if (c.connected) c.unsubscribe(topic);
    };
  }

  publish(topic: string, data: Uint8Array): void {
    for (const c of this.clients) if (c.connected) c.publish(topic, data);
  }

  close(): void {
    this.closed = true;
    for (const c of this.clients) c.close();
  }
}

function toBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The relay of the development / LAN server (server/signaling.ts, WebSocket on /signal). */
export class LocalRelay implements Relay {
  readonly url: string;
  readonly local = true;
  private ws: WebSocket | null = null;
  private subs = new Map<string, Set<Listener>>();

  constructor(url?: string) {
    this.url = url ?? `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/signal`;
  }

  get up(): number {
    return this.ws && this.ws.readyState === WebSocket.OPEN ? 1 : 0;
  }

  start(timeoutMs = 4000): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('local relay not reachable'));
      }, timeoutMs);
      ws.onopen = () => {
        clearTimeout(timer);
        for (const t of this.subs.keys()) this.send({ type: 'sub', topic: t });
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('local relay not reachable'));
      };
      ws.onmessage = (ev) => {
        let m: { type?: string; topic?: string; data?: string };
        try {
          m = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (m.type !== 'msg' || !m.topic || typeof m.data !== 'string') return;
        const data = fromBase64(m.data);
        for (const cb of this.subs.get(m.topic) ?? []) cb(data);
      };
    });
  }

  private send(m: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  subscribe(topic: string, cb: Listener): () => void {
    let set = this.subs.get(topic);
    if (!set) {
      set = new Set();
      this.subs.set(topic, set);
      this.send({ type: 'sub', topic });
    }
    set.add(cb);
    return () => {
      set.delete(cb);
      if (set.size || this.subs.get(topic) !== set) return;
      this.subs.delete(topic);
      this.send({ type: 'unsub', topic });
    };
  }

  publish(topic: string, data: Uint8Array): void {
    this.send({ type: 'pub', topic, data: toBase64(data) });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}

/** In-memory relay shared by several room clients in one process (unit tests). */
export class MemoryRelay implements Relay {
  static readonly hub = new Map<string, Set<Listener>>();
  private mine: { topic: string; cb: Listener }[] = [];
  up = 1;

  start(): Promise<void> {
    return Promise.resolve();
  }

  subscribe(topic: string, cb: Listener): () => void {
    let set = MemoryRelay.hub.get(topic);
    if (!set) {
      set = new Set();
      MemoryRelay.hub.set(topic, set);
    }
    set.add(cb);
    const entry = { topic, cb };
    this.mine.push(entry);
    return () => {
      set.delete(cb);
      this.mine = this.mine.filter((e) => e !== entry);
    };
  }

  publish(topic: string, data: Uint8Array): void {
    for (const cb of [...(MemoryRelay.hub.get(topic) ?? [])]) queueMicrotask(() => cb(data.slice()));
  }

  close(): void {
    for (const e of this.mine) MemoryRelay.hub.get(e.topic)?.delete(e.cb);
    this.mine = [];
    this.up = 0;
  }
}
