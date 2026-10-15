// AI level 0, the original game's computer player (src/game/ai/original.ts, docs/re/ai-original.md): scenario
// tests on an open BASIC field (bricks removed) plus determinism, state immutability and whole rounds.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { AnimDB } from '../src/game/sim/anims.ts';
import { FrameCtx } from '../src/game/sim/ctx.ts';
import { createGame, roundStart, step, flattenValues, type MatchConfig } from '../src/game/sim/sim.ts';
import { bombCreate } from '../src/game/sim/bombs.ts';
import { cellCenterX, cellFeetY, pxToCx, pyToCy, MAP_BLANK, MAP_SOLID, MAP_BRICK } from '../src/game/sim/map.ts';
import { BombState, BombType, W, type GameState } from '../src/game/sim/types.ts';
import { IN_ACT1 } from '../src/engine/input.ts';
import type { TextJson } from '../src/engine/assets.ts';
import { createAi, type AiPlayer } from '../src/game/ai/index.ts';
import { OriginalAi, IN_FRESH } from '../src/game/ai/original.ts';
import { makeConfig, playRound, LEVEL0 } from '../tools/ai-arena.ts';

const sprites = JSON.parse(readFileSync('public/data/sprites/sprites.json', 'utf8'));
const text: TextJson = JSON.parse(readFileSync('public/data/text.json', 'utf8'));
const anims = new AnimDB(sprites.seqs);

function hashState(s: GameState): number {
  const str = JSON.stringify(s);
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Slot 0 a computer player, slot 1 a human who stands still; no bricks, power-ups, duds or start freeze. */
function field(): { s: GameState; ctx: FrameCtx } {
  const scheme = text.schemes.find((x) => x.file === 'BASIC.SCH')!;
  const cfg: MatchConfig = {
    slots: Array.from({ length: 10 }, (_, i) => ({ ctrl: i === 0 ? 1 : i === 1 ? 2 : 0, team: -1 })),
    values: flattenValues(text.values),
    scheme,
    extras: text.extras,
    levelno: 0,
    numToWin: 3,
    winByKills: 0,
    teamPlay: 0,
    randomStart: 0,
    enclosementDepth: 2,
    conveyorSpeed: 1,
    stompedBombsDetonate: 1,
    diseasesDestroyable: 1,
    playtime: 150,
    netMode: 0,
    goldWinner: -1,
    goldPrize: -1,
    attract: 0,
    seed: 1,
  };
  const s = createGame(cfg);
  roundStart(s, cfg.scheme, cfg.extras);
  for (let i = 0; i < s.map.length; i++) if (s.map[i] === MAP_BRICK) s.map[i] = MAP_BLANK;
  for (const p of s.powers) p.state = 0;
  s.pl.roundFreezeMs = 0;
  s.nextDudTime = 1e9;
  for (const p of s.players) p.startCleared = 1;
  // spawned already (the first update would put them on their start points)
  for (const i of [0, 1]) {
    s.players[i].alive = 1;
    s.players[i].lives = 0;
  }
  place(s, 0, 0, 0);
  place(s, 1, 14, 10);
  return { s, ctx: new FrameCtx(anims) };
}

/** Put player pi on cell (cx, cy); its start point (home) too unless given. */
function place(s: GameState, pi: number, cx: number, cy: number, home: [number, number] = [cx, cy]): void {
  const p = s.players[pi];
  p.x = cellCenterX(cx);
  p.y = cellFeetY(cy);
  p.homeX = cellCenterX(home[0]);
  p.homeY = cellFeetY(home[1]);
}

const cellOf = (s: GameState, pi: number) => [pxToCx(s.players[pi].x), pyToCy(s.players[pi].y)];
const alive = (s: GameState, pi: number) => s.players[pi].alive === 1 && !s.players[pi].dying;

/** Step with the AI on slot 0 (the human on slot 1 stands still); stops early when `until` holds. */
function run(s: GameState, ctx: FrameCtx, ai: AiPlayer, ticks: number, until: () => boolean = () => false): { deaths: { a: number; b: number }[]; bits: number[] } {
  const inputs = new Uint8Array(10);
  const deaths: { a: number; b: number }[] = [];
  const bits: number[] = [];
  for (let t = 0; t < ticks && !until(); t++) {
    inputs[0] = ai.think(s, 0);
    bits.push(inputs[0]);
    step(s, ctx, inputs);
    for (const e of ctx.events) if (e.type === 'death') deaths.push({ a: e.a, b: e.b });
  }
  return { deaths, bits };
}

describe('original AI (level 0)', () => {
  it('createAi({ level: 0 }) is the original AI; levels 1..5 are not', () => {
    expect(createAi({ level: 0, seed: 1 })).toBeInstanceOf(OriginalAi);
    for (const level of [1, 2, 3, 4, 5] as const) expect(createAi({ level, seed: 1 })).not.toBeInstanceOf(OriginalAi);
  });

  it('runs from a bomb under it and survives the blast', () => {
    for (const [seed, cx, cy] of [[1, 6, 4], [2, 8, 6], [3, 4, 2]]) {
      const { s, ctx } = field();
      place(s, 0, cx, cy);
      const b = bombCreate(s, cx, cy, BombType.REGULAR, 1, 1, 2, s.players[1].fuse, 0);
      const ai = new OriginalAi(seed);
      ai.reset();
      // the bomb goes off after 2 s; look half a second later
      const { deaths } = run(s, ctx, ai, 150);
      expect(s.bombs[b].active).toBe(0);
      expect(deaths.filter((d) => d.a === 0)).toEqual([]);
      expect(alive(s, 0)).toBe(true);
      const [x, y] = cellOf(s, 0);
      // out of the cross of flame length 2
      expect((x === cx && Math.abs(y - cy) <= 2) || (y === cy && Math.abs(x - cx) <= 2)).toBe(false);
    }
  });

  it('bombs a brick next to it, gets away and the brick is gone', () => {
    const { s, ctx } = field();
    place(s, 0, 4, 4);
    s.map[3 * W + 4] = MAP_BRICK;
    const ai = new OriginalAi(5);
    ai.reset();
    run(s, ctx, ai, 30, () => s.bombs.some((b) => b.active && b.owner === 0));
    const b = s.bombs.findIndex((x) => x.active && x.owner === 0);
    expect(b).toBeGreaterThanOrEqual(0);
    expect([pxToCx(s.bombs[b].x), pyToCy(s.bombs[b].y)]).toEqual([4, 4]);
    const { deaths } = run(s, ctx, ai, 60 * 4);
    expect(s.map[3 * W + 4]).toBe(MAP_BLANK);
    expect(deaths.filter((d) => d.a === 0)).toEqual([]);
    expect(alive(s, 0)).toBe(true);
  });

  it('bombs a player next to it (away from its start point) and kills a player who stays', () => {
    const { s, ctx } = field();
    place(s, 0, 8, 4, [0, 0]);
    place(s, 1, 9, 4);
    const ai = new OriginalAi(7);
    ai.reset();
    run(s, ctx, ai, 30, () => s.bombs.some((b) => b.active && b.owner === 0));
    const b = s.bombs.findIndex((x) => x.active && x.owner === 0);
    expect(b).toBeGreaterThanOrEqual(0);
    expect([pxToCx(s.bombs[b].x), pyToCy(s.bombs[b].y)]).toEqual([8, 4]);
    const { deaths } = run(s, ctx, ai, 60 * 3);
    expect(deaths).toContainEqual({ a: 1, b: 0 });
    expect(alive(s, 0)).toBe(true);
  });

  it('does not bomb a player next to its own start point', () => {
    const { s, ctx } = field();
    place(s, 0, 8, 4);
    place(s, 1, 9, 4);
    const ai = new OriginalAi(7);
    ai.reset();
    // it may still walk off and come back: only the first second counts, while it is within 2 cells of home
    for (let t = 0; t < 60; t++) {
      const [x, y] = cellOf(s, 0);
      if (Math.abs(x - 8) + Math.abs(y - 4) >= 3) break;
      run(s, ctx, ai, 1);
    }
    expect(s.bombs.some((b) => b.active && b.owner === 0)).toBe(false);
  });

  it('chases a human across the open field and bombs them', () => {
    let kills = 0;
    for (const seed of [11, 12, 13]) {
      const { s, ctx } = field();
      place(s, 0, 0, 0);
      place(s, 1, 10, 6);
      const ai = new OriginalAi(seed);
      ai.reset();
      let closest = 99;
      const { deaths } = run(s, ctx, ai, 60 * 60, () => {
        const [x, y] = cellOf(s, 0);
        closest = Math.min(closest, Math.abs(x - 10) + Math.abs(y - 6));
        return !alive(s, 1) || !alive(s, 0);
      });
      expect(closest).toBeLessThanOrEqual(1);
      if (deaths.some((d) => d.a === 1 && d.b === 0)) kills++;
    }
    expect(kills).toBeGreaterThanOrEqual(2);
  });

  it('punches bombs next to it, sets off its trigger bombs from a safe cell and throws its own bombs with the grab glove', () => {
    // walled in (solid blocks) so that it cannot run off before its 1-in-4 (punch) or 1-in-2 (grab) roll succeeds
    const wall = (s: GameState, cells: [number, number][]) => {
      for (const [x, y] of cells) s.map[y * W + x] = MAP_SOLID;
    };
    {
      const { s, ctx } = field();
      place(s, 0, 6, 4);
      wall(s, [[6, 3], [5, 4], [6, 5]]);
      s.players[0].counts[5] = 1; // punch
      const b = bombCreate(s, 7, 4, BombType.REGULAR, 1, 1, 2, 200, 0);
      run(s, ctx, new OriginalAi(3), 60, () => s.bombs[b].state === BombState.FLYING);
      expect(s.bombs[b].state).toBe(BombState.FLYING);
      expect(s.bombs[b].dir).toBe(1);
    }
    {
      const { s, ctx } = field();
      place(s, 0, 2, 8);
      s.players[0].counts[9] = 1; // trigger
      const b = bombCreate(s, 8, 2, BombType.TRIGGER, 0, 0, 2, 40, 0);
      run(s, ctx, new OriginalAi(4), 60 * 3, () => !s.bombs[b].active);
      expect(s.bombs[b].active).toBe(0);
      expect(s.flames.some((f) => f.state)).toBe(true);
    }
    {
      const { s, ctx } = field();
      place(s, 0, 6, 4);
      wall(s, [[6, 3], [7, 4], [6, 5], [5, 4]]);
      s.players[0].counts[6] = 1; // grab
      s.players[0].dir = 1;
      const b = bombCreate(s, 6, 4, BombType.REGULAR, 0, 0, 2, 200, 0);
      let held = false;
      run(s, ctx, new OriginalAi(6), 60 * 2, () => {
        if (s.players[0].held === b) held = true;
        return held && s.bombs[b].state === BombState.FLYING;
      });
      expect(held).toBe(true);
      expect(s.bombs[b].state).toBe(BombState.FLYING);
    }
  });

  it('forces a fresh press when its button still counts as held (IN_FRESH)', () => {
    const { s, ctx } = field();
    place(s, 0, 4, 4);
    s.map[3 * W + 4] = MAP_BRICK;
    const ai = new OriginalAi(5);
    ai.reset();
    const inputs = new Uint8Array(10);
    let pressed = 0;
    for (let t = 0; t < 60 && !s.bombs.some((b) => b.active); t++) {
      // as if button 1 had been down in the previous step (pickup pause, a held press)
      s.players[0].btn1 = 1;
      inputs[0] = ai.think(s, 0);
      if (inputs[0] & IN_ACT1 && !pressed) pressed = inputs[0];
      step(s, ctx, inputs);
    }
    expect(pressed & IN_FRESH).toBe(IN_FRESH);
    expect(s.bombs.some((b) => b.active && b.owner === 0)).toBe(true);
  });

  it('thinks at 20 Hz by default (the input only changes at the start of a 50 ms frame), every step with hz 60', () => {
    for (const hz of [20, 60]) {
      const { s, ctx } = field();
      place(s, 0, 6, 4);
      place(s, 1, 8, 6);
      const { bits } = run(s, ctx, new OriginalAi(9, hz), 60 * 10);
      let changes = 0;
      let offFrame = 0;
      for (let t = 1; t < bits.length; t++) {
        if ((bits[t] & ~IN_FRESH) === (bits[t - 1] & ~IN_FRESH)) continue;
        changes++;
        if (t % 3 !== 0) offFrame++;
        // the fresh-press bit only on the first step of a frame
        if (hz === 20 && t % 3 !== 0) expect(bits[t] & IN_FRESH).toBe(0);
      }
      expect(changes).toBeGreaterThan(10);
      if (hz === 20) expect(offFrame).toBe(0);
      else expect(offFrame).toBeGreaterThan(0);
    }
  });

  it('never mutates the state and only returns direction, button and fresh-press bits', () => {
    const cfg = makeConfig({ id: 0, levels: [LEVEL0, LEVEL0, LEVEL0, LEVEL0, 0, 0, 0, 0, 0, 0], seed: 7, levelno: 0, scheme: 'BASIC.SCH', playtime: 150, depth: 2 });
    const s = createGame(cfg);
    roundStart(s, cfg.scheme, text.extras);
    const ctx = new FrameCtx(anims);
    const ais = [0, 1, 2, 3].map((i) => new OriginalAi(100 + i, i & 1 ? 60 : 20));
    const inputs = new Uint8Array(10);
    for (let t = 0; t < 900; t++) {
      const before = t % 30 === 0 ? hashState(s) : 0;
      for (let i = 0; i < 4; i++) inputs[i] = ais[i].think(s, i);
      if (before) expect(hashState(s)).toBe(before);
      for (let i = 0; i < 4; i++) expect(inputs[i] & ~(63 | IN_FRESH)).toBe(0);
      step(s, ctx, inputs);
    }
  });

  it('is deterministic for a given seed, and each bot depends on its own seed only', () => {
    const digest = (seeds: number[], ticks: number) => {
      const cfg = makeConfig({ id: 0, levels: [LEVEL0, LEVEL0, LEVEL0, 0, 0, 0, 0, 0, 0, 0], seed: 21, levelno: 4, scheme: 'BASIC.SCH', playtime: 150, depth: 2 });
      const s = createGame(cfg);
      roundStart(s, cfg.scheme, text.extras);
      const ctx = new FrameCtx(anims);
      const ais = seeds.map((seed) => createAi({ level: 0, seed }));
      for (const a of ais) a.reset();
      const inputs = new Uint8Array(10);
      let h = 0;
      for (let t = 0; t < ticks && !s.roundOver; t++) {
        for (let i = 0; i < 3; i++) {
          inputs[i] = ais[i].think(s, i);
          h = (Math.imul(h, 31) + inputs[i] + i) | 0;
        }
        step(s, ctx, inputs);
      }
      return { h, state: hashState(s) };
    };
    const a = digest([1, 2, 3], 60 * 30);
    const b = digest([1, 2, 3], 60 * 30);
    expect(b).toEqual(a);
    expect(digest([1, 2, 4], 60 * 30).h).not.toBe(a.h);
    // whole rounds through the arena driver
    const job = { id: 0, levels: [LEVEL0, 2, 0, 0, 0, 0, 0, 0, 0, 0], seed: 5, levelno: 3, scheme: 'BASIC.SCH', playtime: 150, depth: 2 };
    const r1 = playRound(job, 60 * 160);
    const r2 = playRound(job, 60 * 160);
    expect(r1.error).toBeUndefined();
    expect([r2.winner, r2.ticks, r2.deaths, r2.drops]).toEqual([r1.winner, r1.ticks, r1.deaths, r1.drops]);
  });

  it('plays every arena level (0..10) without errors and keeps moving', () => {
    for (let level = 0; level <= 10; level++) {
      const res = playRound({ id: level, levels: [LEVEL0, LEVEL0, LEVEL0, LEVEL0, 0, 0, 0, 0, 0, 0], seed: 400 + level, levelno: level, scheme: 'BASIC.SCH', playtime: 150, depth: 2 }, 60 * 25);
      expect(res.error).toBeUndefined();
      expect(res.drops.slice(0, 4).reduce((x, y) => x + y, 0)).toBeGreaterThan(0);
      // the original stands still at times (boxed in, waiting for a blast to pass), never for long
      expect(Math.max(...res.idle.slice(0, 4))).toBeLessThan(60 * 8);
    }
  });
});
