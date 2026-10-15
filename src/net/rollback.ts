// Generic GGPO-style rollback session.
//
// Every peer simulates the full game deterministically from the same inputs. Local inputs are applied
// after an optional input delay and broadcast; remote inputs are predicted (last known input repeated)
// until they arrive. When a confirmed input differs from the prediction, the session restores the
// snapshot taken before that tick and re-simulates up to the present.

export interface RollbackGame<S> {
  saveState(): S;
  loadState(s: S): void;
  /** Advance one tick with one input value per player slot. `replay` is true when re-simulating. */
  step(inputs: Uint8Array, tick: number, replay: boolean): void;
  checksum(): number;
}

export interface InputMsg {
  player: number;
  /** tick of inputs[0] */
  tick: number;
  inputs: number[];
  /** highest tick up to which the sender has received all remote inputs */
  ack: number;
  /** sender's current tick (time sync) */
  now: number;
}

export const HISTORY = 512; // input ring buffer size in ticks (8.5 s at 60 Hz)
/** state snapshots kept: a rollback never goes deeper than maxPrediction + 1 ticks */
const SNAPS = 64;

export class RollbackSession<S> {
  readonly players: number;
  readonly local: Set<number>;
  readonly inputDelay: number;
  /** maximum number of unconfirmed ticks we simulate ahead before stalling */
  maxPrediction = 15;
  /** number of ticks simulated so far (the next tick to simulate) */
  tick = 0;
  private inputs: Int16Array[];
  private knownAt: Int32Array[];
  private used: Int16Array[];
  private lastConfirmed: Int32Array;
  private snapshots: (S | undefined)[] = new Array(SNAPS);
  /** local players whose inputs every peer knows anyway (empty slots): never broadcast */
  readonly quiet = new Set<number>();
  private resendFrom = new Map<number, number>();
  private rollbackFrom = Infinity;
  private remoteNow: Int32Array;
  private remoteAck: Int32Array;
  /**
   * One-way network delay to each remote player's machine, in ticks (half the measured round trip): a peer's
   * tick as we last heard it is that much behind its tick now.
   */
  readonly delayTicks: Float64Array;
  private game: RollbackGame<S>;
  /** Called with each locally produced input message, to be broadcast to all peers. */
  send: (msg: InputMsg) => void = () => {};
  // statistics
  rollbacks = 0;
  rolledBackTicks = 0;
  maxRollback = 0;
  stalls = 0;

  /**
   * `inputDelay`: ticks between a local input and the tick it applies to. Each machine may choose its own;
   * `peerDelay` is the smallest one any other machine uses.
   */
  constructor(game: RollbackGame<S>, players: number, local: number[], inputDelay = 1, peerDelay = Math.min(inputDelay, 1)) {
    this.game = game;
    this.players = players;
    this.local = new Set(local);
    this.inputDelay = inputDelay;
    this.inputs = Array.from({ length: players }, () => new Int16Array(HISTORY));
    this.knownAt = Array.from({ length: players }, () => new Int32Array(HISTORY).fill(-1));
    this.used = Array.from({ length: players }, () => new Int16Array(HISTORY));
    this.lastConfirmed = new Int32Array(players).fill(-1);
    this.remoteNow = new Int32Array(players);
    this.remoteAck = new Int32Array(players).fill(-1);
    this.delayTicks = new Float64Array(players);
    this.snapshots[0] = game.saveState();
    // The first ticks of every player are neutral (nobody can have pressed anything yet): this machine's players'
    // first `inputDelay` ticks, the others' first `peerDelay` (a machine with a longer delay sends the rest)
    for (let p = 0; p < players; p++) for (let t = 0; t < (this.local.has(p) ? inputDelay : peerDelay); t++) this.record(p, t, 0);
  }

  private isKnown(p: number, t: number): boolean {
    return t >= 0 && this.knownAt[p][t % HISTORY] === t;
  }

  private record(p: number, t: number, v: number): boolean {
    if (this.isKnown(p, t)) return false;
    const i = t % HISTORY;
    this.knownAt[p][i] = t;
    this.inputs[p][i] = v;
    let c = this.lastConfirmed[p];
    while (this.isKnown(p, c + 1)) c++;
    this.lastConfirmed[p] = c;
    return true;
  }

  /** Highest tick for which all players' inputs are known. */
  confirmedTick(): number {
    let m = Infinity;
    for (let p = 0; p < this.players; p++) m = Math.min(m, this.lastConfirmed[p]);
    return m;
  }

  /** Highest tick for which all *remote* players' inputs are known (what we acknowledge). */
  private remoteConfirmed(): number {
    let m = Infinity;
    for (let p = 0; p < this.players; p++) if (!this.local.has(p)) m = Math.min(m, this.lastConfirmed[p]);
    return m === Infinity ? this.tick + this.inputDelay : m;
  }

  /** Feed an input message received from a peer. */
  receive(msg: InputMsg): void {
    const p = msg.player;
    if (p < 0 || p >= this.players || this.local.has(p)) return;
    if (msg.now > this.remoteNow[p]) this.remoteNow[p] = msg.now;
    if (msg.ack > this.remoteAck[p]) this.remoteAck[p] = msg.ack;
    for (let k = 0; k < msg.inputs.length; k++) {
      const t = msg.tick + k;
      if (t <= this.tick - HISTORY + 2) continue;
      const v = msg.inputs[k];
      if (!this.record(p, t, v)) continue;
      if (t < this.tick && this.used[p][t % HISTORY] !== v) this.rollbackFrom = Math.min(this.rollbackFrom, t);
    }
  }

  private inputFor(p: number, t: number): number {
    if (this.isKnown(p, t)) return this.inputs[p][t % HISTORY];
    const c = this.lastConfirmed[p];
    return c >= 0 ? this.inputs[p][c % HISTORY] : 0;
  }

  private simulate(t: number, replay: boolean): void {
    const ins = new Uint8Array(this.players);
    for (let p = 0; p < this.players; p++) {
      const v = this.inputFor(p, t);
      ins[p] = v;
      this.used[p][t % HISTORY] = v;
    }
    this.game.step(ins, t, replay);
    this.snapshots[(t + 1) % SNAPS] = this.game.saveState();
  }

  /**
   * Ticks we are ahead of the slowest remote peer (positive => we should slow down): its tick as last heard,
   * plus the ticks it played while that message travelled.
   */
  frameAdvantage(): number {
    let adv = 0;
    let any = false;
    for (let p = 0; p < this.players; p++) {
      if (this.local.has(p)) continue;
      const a = this.tick - (this.remoteNow[p] + this.delayTicks[p]);
      adv = any ? Math.max(adv, a) : a;
      any = true;
    }
    return adv;
  }

  /** Re-simulate from the earliest mispredicted tick, if any. */
  private resolveRollback(): void {
    if (this.rollbackFrom >= this.tick) {
      this.rollbackFrom = Infinity;
      return;
    }
    const from = this.rollbackFrom;
    this.rollbackFrom = Infinity;
    const snap = this.snapshots[from % SNAPS];
    if (snap === undefined) throw new Error(`no snapshot for tick ${from}`);
    this.game.loadState(snap);
    const n = this.tick - from;
    this.rollbacks++;
    this.rolledBackTicks += n;
    if (n > this.maxRollback) this.maxRollback = n;
    for (let t = from; t < this.tick; t++) this.simulate(t, true);
  }

  /** True when the next advance() would stall because we are too far ahead of confirmations. */
  wouldStall(): boolean {
    return this.tick - this.confirmedTick() > this.maxPrediction;
  }

  /**
   * Advance one tick using the given local inputs (player -> bits).
   * Returns false when the session stalled instead (too far ahead of remote confirmations).
   */
  advance(localInputs: Map<number, number> | ((player: number) => number)): boolean {
    this.resolveRollback();
    if (this.wouldStall()) {
      this.stalls++;
      this.flush();
      return false;
    }
    const target = this.tick + this.inputDelay;
    for (const p of this.local) {
      const v = typeof localInputs === 'function' ? localInputs(p) : localInputs.get(p) ?? 0;
      this.record(p, target, v);
    }
    this.simulate(this.tick, false);
    this.tick++;
    this.flush();
    return true;
  }

  /** Apply pending corrections without advancing (call before rendering). */
  sync(): void {
    this.resolveRollback();
  }

  /** Broadcast local inputs not yet acknowledged by every peer (bounded window for loss recovery). */
  flush(): void {
    let minAck = Infinity;
    for (let p = 0; p < this.players; p++) if (!this.local.has(p)) minAck = Math.min(minAck, this.remoteAck[p]);
    if (minAck === Infinity) return; // no remote players
    const ack = this.remoteConfirmed();
    for (const p of this.local) {
      if (this.quiet.has(p)) continue;
      const last = this.lastConfirmed[p];
      let from = Math.max(minAck + 1, last - 63, 0);
      const rf = this.resendFrom.get(p);
      if (rf !== undefined) {
        // inputs of a player we took over: peers forgot them from `rf`, resend for a while
        if (this.tick > rf + 120) this.resendFrom.delete(p);
        else from = Math.min(from, Math.max(rf, last - 200));
      }
      if (from > last) {
        // still send a heartbeat so peers learn our tick / ack
        this.send({ player: p, tick: last + 1, inputs: [], ack, now: this.tick });
        continue;
      }
      const inputs: number[] = [];
      for (let t = from; t <= last; t++) inputs.push(this.inputs[p][t % HISTORY]);
      this.send({ player: p, tick: from, inputs, ack, now: this.tick });
    }
  }

  /**
   * A player's machine left: from now on this peer produces its inputs (AI or neutral). Returns the first
   * tick taken over; the other peers must accept this peer's inputs from that tick on (forceFrom).
   */
  takeOver(p: number): number {
    if (this.local.has(p)) return this.tick;
    const from = this.lastConfirmed[p] + 1;
    this.local.add(p);
    this.resendFrom.set(p, from);
    for (let t = from; t < this.tick + this.inputDelay; t++) {
      const v = this.inputFor(p, t);
      this.record(p, t, v);
    }
    return from;
  }

  /**
   * Another peer took over player p from tick `from`: forget what we know of p's inputs from there (we
   * may have received inputs the new owner never got) so that the new owner's inputs are accepted.
   */
  forceFrom(p: number, from: number): void {
    if (this.local.has(p)) return;
    for (let t = from; t < from + HISTORY; t++) {
      const i = t % HISTORY;
      if (this.knownAt[p][i] >= from) this.knownAt[p][i] = -1;
    }
    this.lastConfirmed[p] = Math.min(this.lastConfirmed[p], from - 1);
  }

  /** Stored state after simulating tick t (i.e. at the start of tick t + 1), if still in the ring. */
  snapshotAfter(t: number): S | undefined {
    return t + 1 <= this.tick && t + 1 > this.tick - SNAPS ? this.snapshots[(t + 1) % SNAPS] : undefined;
  }

  /** Inputs actually used to simulate tick t (for replays / debugging). */
  usedInputs(t: number): number[] {
    return Array.from({ length: this.players }, (_, p) => this.used[p][t % HISTORY]);
  }
}
