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

/**
 * Public STUN servers find each machine's public address so that connections work across the internet;
 * on a LAN the machines connect directly. A TURN relay (for networks where no direct path exists, e.g. some
 * mobile carriers) can be configured at build time: VITE_TURN_URLS (comma separated), VITE_TURN_USERNAME,
 * VITE_TURN_CREDENTIAL.
 */
function iceServers(): RTCIceServer[] {
  const list: RTCIceServer[] = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
  const env = import.meta.env ?? {};
  const turn = String(env.VITE_TURN_URLS ?? '').split(',').map((u) => u.trim()).filter(Boolean);
  if (turn.length) list.push({ urls: turn, username: env.VITE_TURN_USERNAME, credential: env.VITE_TURN_CREDENTIAL });
  return list;
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
    const p = this.create(id, name);
    const offer = await p.pc.createOffer();
    await p.pc.setLocalDescription(offer);
    this.sig.signal(id, { sdp: p.pc.localDescription });
  }

  private create(id: number, name: string): PeerConn {
    const existing = this.peers.get(id);
    if (existing) return existing;
    const pc = new RTCPeerConnection({ iceServers: iceServers() });
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
      if (!p) p = this.create(from, 'peer');
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
    if (!p) return;
    this.peers.delete(id);
    try { p.pc.close(); } catch { /* ignore */ }
    if (!silent) this.onPeerClosed(id, bye);
  }

  close(): void {
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
