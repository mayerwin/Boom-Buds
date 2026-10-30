// Full-mesh WebRTC data channels between all members of a room.
// Two negotiated channels per peer: "ctl" (reliable, ordered) for lobby/control messages and
// "inp" (unordered, no retransmits) for per-tick inputs, which carry their own redundancy.

/** What the mesh needs from the signaling layer (src/net/room.ts). */
export interface Signaler {
  signal(to: number, data: unknown): void;
  on(type: 'signal' | 'peer-left', h: (m: Record<string, unknown>) => void): () => void;
}

export interface PeerConn {
  id: number;
  name: string;
  pc: RTCPeerConnection;
  ctl: RTCDataChannel;
  inp: RTCDataChannel;
  open: boolean;
  rtt: number;
  /** last message received (performance.now) */
  lastSeen: number;
  /** its page went to the background (screen locked, another app): it may be silent for a while */
  away: boolean;
}

/** Public STUN servers: they find each machine's public address, so that connections work across the internet. */
const STUN: RTCIceServer = { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] };
/** how long a relay list from the credentials API is used before it is asked for again */
export const RELAY_TTL_MS = 30 * 60_000;
/** how long a connection waits for the credentials API's answer (time the page runs); then it goes without relays */
export const RELAY_TIMEOUT_MS = 2500;
/** how long the credentials API gets to answer at all: a late answer still serves the next connections */
export const RELAY_GIVE_UP_MS = 10_000;

/** The servers of a credentials API's answer: an array of RTCIceServer, or `{ iceServers: [...] }`. */
export function parseIceServers(data: unknown): RTCIceServer[] {
  const list = Array.isArray(data) ? data : (data as { iceServers?: unknown } | null)?.iceServers;
  if (!Array.isArray(list)) return [];
  const out: RTCIceServer[] = [];
  for (const s of list as Record<string, unknown>[]) {
    const urls = typeof s?.urls === 'string' ? [s.urls] : Array.isArray(s?.urls) ? s.urls.filter((u): u is string => typeof u === 'string') : [];
    if (!urls.length) continue;
    const server: RTCIceServer = { urls };
    if (typeof s.username === 'string') server.username = s.username;
    if (typeof s.credential === 'string') server.credential = s.credential;
    out.push(server);
  }
  return out;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Whether network games have their relay: 'none' (the build has no credentials API), 'checking', 'ok',
 * 'unavailable' (no answer, a refusal, or a relay this network cannot reach) or 'limit' (the relay service's
 * allowance is used up). Without a relay, devices that can connect directly still play.
 */
export type RelayStatus = 'none' | 'checking' | 'ok' | 'unavailable' | 'limit';
type Probe = (servers: RTCIceServer[]) => Promise<RelayStatus>;

/** HTTP and TURN answers that mean the allowance is used up: Payment Required, Too Many Requests, Allocation Quota Reached */
const LIMIT_CODES = new Set([402, 429, 486]);
/** how long a relay check waits for the relay to give this device an address (time the page runs) */
export const RELAY_CHECK_MS = 5000;

/**
 * Call `f` once the page has run for `ms`; returns what cancels it. The time counts in quarter seconds, so that
 * a page stalled meanwhile does not give up too soon: a browser's first peer connection can hold the page for
 * seconds (the Network Game screen opens one to find the games on its network).
 */
function afterRunning(ms: number, f: () => void): () => void {
  let waited = 0;
  const timer = setInterval(() => {
    if ((waited += 250) < ms) return;
    clearInterval(timer);
    f();
  }, 250);
  return () => clearInterval(timer);
}

/**
 * TURN relays from a credentials API (Metered's: a GET returns the STUN and TURN servers with their
 * credentials). The list is kept for 30 minutes. A connection waits 2.5 s at most for it and then goes without;
 * the request goes on for up to 10 s, and a late answer serves the next connections. A request that fails is not
 * kept: the next connection asks again.
 */
export class RelayList {
  /** what the last check found */
  status: RelayStatus = 'checking';
  private servers: RTCIceServer[] | null = null;
  private at = 0;
  private pending: Promise<RTCIceServer[]> | null = null;
  /** the HTTP status of the last request that gave no relays (0: no answer, or no servers in it) */
  private refused = 0;
  private checking: Promise<RelayStatus> | null = null;
  /** the list a check found working (by the time it came) */
  private workedAt = -1;
  private readonly url: string;
  private readonly get: Fetch;
  private readonly clock: () => number;

  constructor(url: string, get: Fetch = (u, init) => fetch(u, init), clock: () => number = () => Date.now()) {
    this.url = url;
    this.get = get;
    this.clock = clock;
  }

  /**
   * The relays for a connection: the kept list while it is fresh, else the answer to the request under way (or a
   * new one), or none after 2.5 s.
   */
  load(): Promise<RTCIceServer[]> {
    const answer = this.answer();
    return new Promise((resolve) => {
      const stop = afterRunning(RELAY_TIMEOUT_MS, () => resolve([]));
      void answer.then((list) => {
        stop();
        resolve(list);
      });
    });
  }

  /** The kept list while it is fresh, else the answer to the request under way (or a new one), however late. */
  private answer(): Promise<RTCIceServer[]> {
    if (this.servers && this.clock() - this.at < RELAY_TTL_MS) return Promise.resolve(this.servers);
    if (!this.pending) this.pending = this.request().finally(() => (this.pending = null));
    return this.pending;
  }

  /**
   * Whether the relays work: the list, then a relayed address from them (`probe`). A list found working is not
   * checked again while it is kept; a failed check is not kept either.
   */
  check(probe: Probe = probeRelays): Promise<RelayStatus> {
    if (this.status === 'ok' && this.workedAt === this.at && this.clock() - this.at < RELAY_TTL_MS) return Promise.resolve('ok');
    if (!this.checking) this.checking = this.recheck(probe).finally(() => (this.checking = null));
    return this.checking;
  }

  private async recheck(probe: Probe): Promise<RelayStatus> {
    const list = await this.answer();
    const status = list.length ? await probe(list).catch((): RelayStatus => 'unavailable') : LIMIT_CODES.has(this.refused) ? 'limit' : 'unavailable';
    if (status === 'ok') this.workedAt = this.at;
    return (this.status = status);
  }

  private async request(): Promise<RTCIceServer[]> {
    const abort = new AbortController();
    const stop = afterRunning(RELAY_GIVE_UP_MS, () => abort.abort());
    this.refused = 0;
    try {
      const r = await this.get(this.url, { cache: 'no-store', signal: abort.signal });
      if (!r.ok) {
        this.refused = r.status;
        return [];
      }
      const list = parseIceServers(await r.json());
      if (list.length) {
        this.servers = list;
        this.at = this.clock();
      }
      return list;
    } catch {
      return [];
    } finally {
      stop();
    }
  }
}

/**
 * Whether TURN relays give this device a relayed address (one allocation, released at once). The credentials
 * API answering is not enough: a relay whose allowance is used up, or that this network cannot reach, still
 * relays nothing.
 */
export async function probeRelays(servers: RTCIceServer[]): Promise<RelayStatus> {
  const turn = servers.filter((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => /^turns?:/.test(u)));
  if (!turn.length || typeof RTCPeerConnection !== 'function') return 'unavailable';
  const pc = new RTCPeerConnection({ iceServers: turn, iceTransportPolicy: 'relay' });
  const codes: number[] = [];
  const verdict = (): RelayStatus => (codes.some((c) => LIMIT_CODES.has(c)) ? 'limit' : 'unavailable');
  try {
    return await new Promise<RelayStatus>((resolve) => {
      const done = (s: RelayStatus) => {
        stop();
        resolve(s);
      };
      const stop = afterRunning(RELAY_CHECK_MS, () => done(verdict()));
      pc.onicecandidateerror = (e) => codes.push((e as RTCPeerConnectionIceErrorEvent).errorCode);
      pc.onicecandidate = (e) => {
        if (!e.candidate) done(verdict());
        else if (e.candidate.type === 'relay' || / typ relay /.test(e.candidate.candidate)) done('ok');
      };
      pc.createDataChannel('probe');
      pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => done('unavailable'));
    });
  } finally {
    pc.close();
  }
}

const env = import.meta.env ?? {};
const relayApi = String(env.VITE_TURN_API ?? '').trim();
const RELAYS = relayApi && typeof fetch === 'function' ? new RelayList(relayApi) : null;

/**
 * Ask the credentials API for the relays and check that they work: when the network screens open, so that the
 * first connection finds the relays ready (local games ask nothing).
 */
export function checkRelays(): Promise<RelayStatus> {
  return RELAYS ? RELAYS.check() : Promise.resolve('none');
}

/** What the last relay check found (see checkRelays). */
export function relayStatus(): RelayStatus {
  return RELAYS ? RELAYS.status : 'none';
}

/**
 * The servers a connection tries: public STUN servers (on a LAN the machines connect directly), then TURN relays
 * for networks where no direct path exists (mobile carriers sharing one address between many phones, guest
 * Wi-Fi, company and school networks). The relays are set at build time: a credentials API (VITE_TURN_API,
 * recommended), or fixed ones (VITE_TURN_URLS, comma separated, with VITE_TURN_USERNAME and VITE_TURN_CREDENTIAL).
 */
export async function iceServers(relays: RelayList | null = RELAYS): Promise<RTCIceServer[]> {
  const list: RTCIceServer[] = [STUN];
  const turn = String(env.VITE_TURN_URLS ?? '').split(',').map((u) => u.trim()).filter(Boolean);
  if (turn.length) list.push({ urls: turn, username: env.VITE_TURN_USERNAME, credential: env.VITE_TURN_CREDENTIAL });
  if (relays) list.push(...(await relays.load()));
  return list;
}

/**
 * Relayed paths only (`?nodirect` in the address, or `window.boombudsNoDirect = true` before connecting): to
 * check that the TURN relay works. Without a relay, no connection can be made this way.
 */
function relayOnly(): boolean {
  if (typeof window === 'undefined') return false;
  return (window as { boombudsNoDirect?: boolean }).boombudsNoDirect === true || new URLSearchParams(location.search).has('nodirect');
}

/**
 * Simulated network conditions, for testing (`?netsim=100,20,2`): every message this machine sends waits 100 ms
 * plus up to 20 ms of jitter, and 2 % of its inputs are lost (the control channel stays reliable and ordered).
 * Give both machines the parameter for symmetric conditions (a round trip then takes twice the delay).
 */
export interface NetSim {
  latency: number;
  jitter: number;
  loss: number;
}

export function netSimFrom(search: string): NetSim | null {
  const p = new URLSearchParams(search).get('netsim');
  if (!p) return null;
  const [latency, jitter, loss] = p.split(',').map((x) => Math.max(0, Number(x) || 0));
  return { latency: latency ?? 0, jitter: jitter ?? 0, loss: Math.min(100, loss ?? 0) / 100 };
}

const SIM = typeof location === 'undefined' ? null : netSimFrom(location.search);

export class Mesh {
  readonly peers = new Map<number, PeerConn>();
  onControl: (from: number, msg: Record<string, unknown>) => void = () => {};
  onInput: (from: number, data: ArrayBuffer) => void = () => {};
  onPeerOpen: (p: PeerConn) => void = () => {};
  /** a connection ended; `bye`: the other machine left on purpose */
  onPeerClosed: (id: number, bye: boolean) => void = () => {};
  private sig: Signaler;
  private unsub: (() => void)[] = [];

  constructor(sig: Signaler) {
    this.sig = sig;
    this.unsub.push(sig.on('signal', (m) => void this.onSignal(Number(m.from), m.data as SignalData)));
    this.unsub.push(sig.on('peer-left', (m) => this.drop(Number(m.peer))));
  }

  /** Open a connection to `id`; the caller is the offerer. */
  async connect(id: number, name: string): Promise<void> {
    const servers = await this.serversFor(id);
    if (!servers) return;
    const p = this.create(id, name, servers);
    const offer = await p.pc.createOffer();
    await p.pc.setLocalDescription(offer);
    this.sig.signal(id, { sdp: p.pc.localDescription });
  }

  /** connections waiting for the relay list (normally there already), by peer: dropping the peer cancels its own */
  private attempts = new Map<number, number>();
  private attemptSeq = 0;

  /** The servers for a new connection to `id`; null when the peer was dropped meanwhile. */
  private async serversFor(id: number): Promise<RTCIceServer[] | null> {
    const n = ++this.attemptSeq;
    this.attempts.set(id, n);
    const servers = await iceServers();
    if (this.attempts.get(id) !== n) return null;
    this.attempts.delete(id);
    return servers;
  }

  private create(id: number, name: string, iceServers: RTCIceServer[]): PeerConn {
    const existing = this.peers.get(id);
    if (existing) return existing;
    const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: relayOnly() ? 'relay' : 'all' });
    const ctl = pc.createDataChannel('ctl', { negotiated: true, id: 0, ordered: true });
    const inp = pc.createDataChannel('inp', { negotiated: true, id: 1, ordered: false, maxRetransmits: 0 });
    inp.binaryType = 'arraybuffer';
    const p: PeerConn = { id, name, pc, ctl, inp, open: false, rtt: 0, lastSeen: performance.now(), away: false };
    this.peers.set(id, p);
    pc.onicecandidate = (e) => {
      if (e.candidate) this.sig.signal(id, { ice: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.drop(id);
    };
    let opened = 0;
    const onOpen = () => {
      opened++;
      if (opened === 2) {
        p.open = true;
        this.onPeerOpen(p);
      }
    };
    ctl.onopen = onOpen;
    inp.onopen = onOpen;
    ctl.onmessage = (e) => {
      p.lastSeen = performance.now();
      try {
        const msg = JSON.parse(String(e.data));
        if (msg.type === '_bye') { this.drop(id, false, true); return; }
        if (msg.type === '_ping') { this.sendControl(id, { type: '_pong', t: msg.t }); return; }
        if (msg.type === '_pong') { p.rtt = performance.now() - Number(msg.t); return; }
        if (msg.type === '_away' || msg.type === '_back') { p.away = msg.type === '_away'; return; }
        this.onControl(id, msg);
      } catch { /* ignore malformed */ }
    };
    inp.onmessage = (e) => {
      p.lastSeen = performance.now();
      this.onInput(id, e.data as ArrayBuffer);
    };
    ctl.onclose = () => this.drop(id);
    return p;
  }

  private async onSignal(from: number, data: SignalData): Promise<void> {
    let p = this.peers.get(from);
    if (data.sdp) {
      if (!p) {
        const servers = await this.serversFor(from);
        if (!servers) return;
        p = this.create(from, 'peer', servers);
      }
      await p.pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') {
        const answer = await p.pc.createAnswer();
        await p.pc.setLocalDescription(answer);
        this.sig.signal(from, { sdp: p.pc.localDescription });
      }
      for (const c of this.pendingIce.get(from) ?? []) await p.pc.addIceCandidate(c).catch(() => {});
      this.pendingIce.delete(from);
    } else if (data.ice) {
      if (!p || !p.pc.remoteDescription) {
        const list = this.pendingIce.get(from) ?? [];
        list.push(data.ice);
        this.pendingIce.set(from, list);
      } else {
        await p.pc.addIceCandidate(data.ice).catch(() => {});
      }
    }
  }

  private pendingIce = new Map<number, RTCIceCandidateInit[]>();

  sendControl(to: number, msg: Record<string, unknown>): void {
    const p = this.peers.get(to);
    if (!p || p.ctl.readyState !== 'open') return;
    const text = JSON.stringify(msg);
    if (!SIM) {
      p.ctl.send(text);
      return;
    }
    // simulated delay, keeping the reliable channel's order
    const now = performance.now();
    const at = Math.max(this.simCtlAt.get(to) ?? 0, now + SIM.latency + Math.random() * SIM.jitter);
    this.simCtlAt.set(to, at);
    setTimeout(() => {
      if (p.ctl.readyState === 'open') p.ctl.send(text);
    }, at - now);
  }

  private simCtlAt = new Map<number, number>();

  broadcastControl(msg: Record<string, unknown>): void {
    for (const id of this.peers.keys()) this.sendControl(id, msg);
  }

  broadcastInput(data: ArrayBuffer): void {
    for (const p of this.peers.values()) {
      if (p.inp.readyState !== 'open') continue;
      if (SIM) {
        if (Math.random() < SIM.loss) continue;
        setTimeout(() => {
          if (p.inp.readyState === 'open') try { p.inp.send(data); } catch { /* buffer full */ }
        }, SIM.latency + Math.random() * SIM.jitter);
        continue;
      }
      try { p.inp.send(data); } catch { /* buffer full: drop, inputs are redundant */ }
    }
  }

  /** Tell every peer that this machine is going away (page closed). */
  sayBye(): void {
    this.broadcastControl({ type: '_bye' });
  }

  /** Tell every peer whether this page is in the background (it may then be silent for a while). */
  sayAway(away: boolean): void {
    this.broadcastControl({ type: away ? '_away' : '_back' });
  }

  ping(): void {
    const t = performance.now();
    this.broadcastControl({ type: '_ping', t });
  }

  /** Close the connection to `id` (`silent`: without the onPeerClosed notification; `bye`: it said goodbye). */
  drop(id: number, silent = false, bye = false): void {
    const p = this.peers.get(id);
    this.pendingIce.delete(id);
    this.attempts.delete(id);
    if (!p) return;
    this.peers.delete(id);
    try { p.pc.close(); } catch { /* ignore */ }
    if (!silent) this.onPeerClosed(id, bye);
  }

  /** Close every connection, and forget those still being prepared, without the onPeerClosed notifications. */
  dropAll(): void {
    this.attempts.clear();
    this.pendingIce.clear();
    for (const id of [...this.peers.keys()]) this.drop(id, true);
  }

  close(): void {
    this.attempts.clear();
    for (const id of [...this.peers.keys()]) this.drop(id);
    for (const u of this.unsub) u();
  }
}

interface SignalData {
  sdp?: RTCSessionDescriptionInit;
  ice?: RTCIceCandidateInit;
}

/** Binary encoding of rollback input messages for the unreliable channel. */
export function encodeInputMsg(m: { player: number; tick: number; inputs: number[]; ack: number; now: number; round: number }): ArrayBuffer {
  const n = Math.min(255, m.inputs.length);
  const buf = new ArrayBuffer(16 + n);
  const v = new DataView(buf);
  v.setUint8(0, 2);
  v.setUint8(1, m.round & 0xff);
  v.setUint8(2, m.player);
  v.setInt32(3, m.tick, true);
  v.setInt32(7, m.ack, true);
  v.setInt32(11, m.now, true);
  v.setUint8(15, n);
  for (let i = 0; i < n; i++) v.setUint8(16 + i, m.inputs[i]);
  return buf;
}

export function decodeInputMsg(buf: ArrayBuffer): { player: number; tick: number; inputs: number[]; ack: number; now: number; round: number } | null {
  if (buf.byteLength < 16) return null;
  const v = new DataView(buf);
  if (v.getUint8(0) !== 2) return null;
  const n = v.getUint8(15);
  if (buf.byteLength < 16 + n) return null;
  const inputs: number[] = [];
  for (let i = 0; i < n; i++) inputs.push(v.getUint8(16 + i));
  return { round: v.getUint8(1), player: v.getUint8(2), tick: v.getInt32(3, true), ack: v.getInt32(7, true), now: v.getInt32(11, true), inputs };
}
