import { describe, it, expect } from 'vitest';
import { RollbackSession, type RollbackGame, type InputMsg } from '../src/net/rollback.ts';

class ToyGame implements RollbackGame<Int32Array> {
  s = new Int32Array(8);
  saveState(): Int32Array { return this.s.slice(); }
  loadState(v: Int32Array): void { this.s.set(v); }
  step(inputs: Uint8Array, tick: number): void {
    for (let p = 0; p < inputs.length; p++) {
      this.s[p] = (Math.imul(this.s[p], 31) + inputs[p] * 7 + tick) | 0;
    }
    this.s[7] = (this.s[7] ^ Math.imul(this.s[0] + this.s[1], 0x9e3779b1)) | 0;
  }
  checksum(): number { let h = 0; for (const v of this.s) h = (Math.imul(h, 16777619) ^ v) | 0; return h; }
}

function lcg(seed: number) {
  let x = seed >>> 0;
  return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
}

function run(peers: number, latency: number, jitter: number, loss: number, ticks: number, delay: number, delays?: number[]) {
  const dOf = (i: number) => delays?.[i] ?? delay;
  const rnd = lcg(1234);
  const games = Array.from({ length: peers }, () => new ToyGame());
  const sessions = games.map((g, i) => new RollbackSession(g, peers, [i], dOf(i), delays ? Math.min(...delays) : Math.min(dOf(i), 1)));
  // true inputs per player per tick, generated deterministically (change every few ticks like humans)
  const truth: number[][] = Array.from({ length: peers }, () => []);
  for (let p = 0; p < peers; p++) {
    let v = 0;
    for (let t = 0; t < ticks + 100; t++) {
      if (rnd() < 0.08) v = Math.floor(rnd() * 64);
      truth[p].push(v);
    }
  }
  type Pkt = { at: number; to: number; msg: InputMsg };
  let queue: Pkt[] = [];
  let now = 0;
  sessions.forEach((s, i) => {
    s.send = (msg) => {
      for (let j = 0; j < peers; j++) {
        if (j === i) continue;
        if (rnd() < loss) continue;
        queue.push({ at: now + latency + Math.floor(rnd() * (jitter + 1)), to: j, msg: JSON.parse(JSON.stringify(msg)) });
      }
    };
  });
  const localTick = new Array(peers).fill(0);
  // run until everyone reached `ticks` and all inputs are confirmed
  for (now = 0; now < ticks * 4; now++) {
    const ready = queue.filter((q) => q.at <= now);
    queue = queue.filter((q) => q.at > now);
    for (const q of ready) sessions[q.to].receive(q.msg);
    for (let i = 0; i < peers; i++) {
      const s = sessions[i];
      if (s.tick >= ticks) { s.flush(); continue; }
      const target = s.tick + dOf(i);
      if (s.advance(new Map([[i, truth[i][target]]]))) localTick[i]++;
    }
    if (sessions.every((s) => s.tick >= ticks && s.confirmedTick() >= ticks - 1)) break;
  }
  for (const s of sessions) s.sync();
  // reference simulation with true inputs, accounting for the input delay
  const ref = new ToyGame();
  for (let t = 0; t < ticks; t++) {
    const ins = new Uint8Array(peers);
    for (let p = 0; p < peers; p++) ins[p] = t < dOf(p) ? 0 : truth[p][t];
    ref.step(ins, t);
  }
  return { sessions, games, ref };
}

describe('RollbackSession', () => {
  it('converges with latency, jitter and packet loss', () => {
    const { sessions, games, ref } = run(4, 3, 4, 0.15, 1500, 1);
    for (const g of games) expect(g.checksum()).toBe(ref.checksum());
    expect(sessions.some((s) => s.rollbacks > 0)).toBe(true);
  });

  it('works with zero input delay on a fast network', () => {
    const { games, ref } = run(2, 1, 0, 0, 800, 0);
    for (const g of games) expect(g.checksum()).toBe(ref.checksum());
  });

  it('works with large delay and heavy loss', () => {
    const { games, ref } = run(5, 6, 6, 0.35, 1200, 3);
    for (const g of games) expect(g.checksum()).toBe(ref.checksum());
  });

  it('stays in sync when the machines use different input delays', () => {
    const { games, ref } = run(3, 4, 3, 0.1, 1200, 1, [1, 2, 3]);
    for (const g of games) expect(g.checksum()).toBe(ref.checksum());
  });

  it('counts the ticks a peer played while its message travelled when comparing clocks', () => {
    const s = new RollbackSession(new ToyGame(), 2, [0], 1);
    for (let t = 0; t < 14; t++) s.advance(new Map([[0, 0]]));
    s.receive({ player: 1, tick: 1, inputs: [], ack: -1, now: 10 });
    expect(s.frameAdvantage()).toBe(4);
    // a 133 ms round trip: the peer is 4 ticks further on than its message says, as far as we are
    s.delayTicks[1] = 4;
    expect(s.frameAdvantage()).toBe(0);
  });
});
