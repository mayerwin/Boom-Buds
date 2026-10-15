import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { AnimDB } from '../src/game/sim/anims.ts';
import { FrameCtx } from '../src/game/sim/ctx.ts';
import { createGame, roundStart, step, flattenValues, roundWinner, type MatchConfig } from '../src/game/sim/sim.ts';
import type { TextJson } from '../src/engine/assets.ts';
import type { GameState } from '../src/game/sim/types.ts';

const sprites = JSON.parse(readFileSync('public/data/sprites/sprites.json', 'utf8'));
const text: TextJson = JSON.parse(readFileSync('public/data/text.json', 'utf8'));
const anims = new AnimDB(sprites.seqs);

function config(seed: number, players: number, levelno = -1, schemeName = 'BASIC.SCH'): MatchConfig {
  const scheme = text.schemes.find((s) => s.file === schemeName)!;
  return {
    slots: Array.from({ length: 10 }, (_, i) => ({ ctrl: i < players ? 2 : 0, team: -1 })),
    values: flattenValues(text.values),
    scheme,
    extras: text.extras,
    levelno,
    numToWin: 3,
    winByKills: 0,
    teamPlay: 0,
    randomStart: 1,
    enclosementDepth: 2,
    conveyorSpeed: 1,
    stompedBombsDetonate: 1,
    diseasesDestroyable: 1,
    playtime: 150,
    netMode: 0,
    goldWinner: -1,
    goldPrize: -1,
    attract: 0,
    seed,
  };
}

function hashState(s: GameState): number {
  const str = JSON.stringify(s);
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

function runRound(seed: number, players: number, ticks: number, levelno = -1, schemeName = 'BASIC.SCH') {
  const cfg = config(seed, players, levelno, schemeName);
  const s = createGame(cfg);
  roundStart(s, cfg.scheme, cfg.extras);
  const ctx = new FrameCtx(anims);
  let rs = seed * 7919 + 1;
  const rnd = () => { rs = (Math.imul(rs, 1103515245) + 12345) >>> 0; return rs >>> 16; };
  const held = new Uint8Array(10);
  const inputs = new Uint8Array(10);
  let draws = 0;
  for (let t = 0; t < ticks && !s.roundOver; t++) {
    for (let p = 0; p < players; p++) {
      if (rnd() % 12 === 0) held[p] = [1, 2, 4, 8, 0][rnd() % 5];
      inputs[p] = held[p] | (rnd() % 20 === 0 ? 16 : 0) | (rnd() % 40 === 0 ? 32 : 0);
    }
    step(s, ctx, inputs);
    draws += ctx.draws.length;
  }
  return { s, draws };
}

describe('simulation', () => {
  it('runs rounds on every level without errors', () => {
    for (let level = 0; level <= 10; level++) {
      const { s, draws } = runRound(100 + level, 4, 60 * 160, level);
      expect(s.tick).toBeGreaterThan(10);
      expect(draws).toBeGreaterThan(0);
    }
  });

  it('is deterministic', () => {
    const a = runRound(42, 6, 60 * 60);
    const b = runRound(42, 6, 60 * 60);
    expect(hashState(a.s)).toBe(hashState(b.s));
    const c = runRound(43, 6, 60 * 60);
    expect(hashState(c.s)).not.toBe(hashState(a.s));
  });

  it('ends rounds with a winner or a draw', () => {
    let ended = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const { s } = runRound(seed, 2, 60 * 200);
      if (s.roundOver) {
        ended++;
        const w = roundWinner(s);
        expect(w).toBeGreaterThanOrEqual(-1);
      }
    }
    expect(ended).toBeGreaterThan(10);
  });

  it('handles many schemes', () => {
    for (const sch of text.schemes) {
      const { s } = runRound(7, 10, 60 * 30, 3, sch.file);
      expect(s.tick).toBeGreaterThan(0);
    }
  });
});

describe('arena lists', () => {
  it('a random arena is picked among the list, the same way on every machine', () => {
    const pick = (seed: number) => {
      const cfg = { ...config(seed, 2, -1), levels: [4, 10] };
      const s = createGame(cfg);
      const seen: number[] = [];
      for (let r = 0; r < 12; r++) {
        roundStart(s, cfg.scheme, cfg.extras);
        seen.push(s.opts.level);
      }
      return seen;
    };
    const a = pick(5);
    expect(new Set(a)).toEqual(new Set([4, 10]));
    expect(pick(5)).toEqual(a);
  });
});

describe('cloneState', () => {
  it('copies the whole state deeply', async () => {
    const { cloneState } = await import('../src/game/sim/clone.ts');
    const cfg = config(5, 6, 4);
    const s = createGame(cfg);
    roundStart(s, cfg.scheme, cfg.extras);
    const c = cloneState(s);
    expect(JSON.stringify(c)).toBe(JSON.stringify(s));
    c.players[0].x += 5;
    c.map[0] = 9;
    c.pl.inputHistory[0][0] = 77;
    expect(s.players[0].x).not.toBe(c.players[0].x);
    expect(s.map[0]).not.toBe(9);
    expect(s.pl.inputHistory[0][0]).not.toBe(77);
  });
});
