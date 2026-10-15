import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { AnimDB } from '../src/game/sim/anims.ts';
import { FrameCtx } from '../src/game/sim/ctx.ts';
import { createGame, roundStart, step, flattenValues } from '../src/game/sim/sim.ts';
import type { TextJson } from '../src/engine/assets.ts';
import { BombType, type GameState } from '../src/game/sim/types.ts';
import { bombCreate } from '../src/game/sim/bombs.ts';
import { A_TRAMPOLINE, A_WARP_IN, A_WARP_OUT } from '../src/game/sim/players.ts';
import { createAi, type AiPlayer } from '../src/game/ai/index.ts';
import { botLevel, reactSteps } from '../src/game/ai/opponents.ts';
import { makeConfig, playRound, IDLE_LIMIT_S } from '../tools/ai-arena.ts';
import { Dummy, type DummyKind } from '../tools/ai-dummies.ts';
import { pxToCx, pyToCy, cellCenterX, cellFeetY } from '../src/game/sim/map.ts';

const sprites = JSON.parse(readFileSync('public/data/sprites/sprites.json', 'utf8'));
const text: TextJson = JSON.parse(readFileSync('public/data/text.json', 'utf8'));
const anims = new AnimDB(sprites.seqs);

function hashState(s: GameState): number {
  const str = JSON.stringify(s);
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Run `ticks` steps with AI players on the slots given by `levels`; returns the state and an input digest. */
function run(levels: number[], seed: number, levelno: number, ticks: number, scheme = 'BASIC.SCH') {
  const lv = [...levels, ...new Array(10 - levels.length).fill(0)];
  const cfg = makeConfig({ id: 0, levels: lv, seed, levelno, scheme, playtime: 150, depth: 2 });
  const s = createGame(cfg);
  roundStart(s, cfg.scheme, text.extras);
  const ctx = new FrameCtx(anims);
  const ais: (AiPlayer | null)[] = lv.map((l, i) => (l > 0 ? createAi({ level: l as 1 | 2 | 3 | 4 | 5, seed: seed * 13 + i }) : null));
  const inputs = new Uint8Array(10);
  const moved = new Array(10).fill(false);
  const start = s.players.map((p) => p.x * 1000 + p.y);
  let digest = 0;
  let bad = 0;
  for (let t = 0; t < ticks && !s.roundOver; t++) {
    for (let i = 0; i < 10; i++) {
      const b = ais[i] ? ais[i]!.think(s, i) : 0;
      if (!Number.isInteger(b) || b < 0 || b > 63) bad++;
      inputs[i] = b;
      digest = (Math.imul(digest, 31) + b + i) | 0;
    }
    step(s, ctx, inputs);
    for (let i = 0; i < 10; i++) if (s.players[i].x * 1000 + s.players[i].y !== start[i] && t > 0) moved[i] = true;
  }
  return { s, digest, bad, moved };
}

/**
 * A bot against a scripted non-bot player (tools/ai-dummies.ts) on an open field: every brick is cleared, so
 * nothing but the opponent gives the bot a reason to drop. Returns the longest time (s) the bot spent within
 * 5 cells of the opponent with a bomb ready but without dropping one (summed until its next drop), its drops,
 * and when the opponent died (s, -1 if it survived).
 */
function openFieldDuel(level: number, kind: DummyKind, seed: number, levelno: number, ticks: number) {
  const levels = [level, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const dummies = ['', kind, '', '', '', '', '', '', '', ''];
  const cfg = makeConfig({ id: 0, levels, dummies, seed, levelno, scheme: 'BASIC.SCH', playtime: 150, depth: 1 });
  const s = createGame(cfg);
  roundStart(s, cfg.scheme, text.extras);
  for (let c = 0; c < s.map.length; c++) if (s.map[c] === 2) s.map[c] = 0;
  const ctx = new FrameCtx(anims);
  const bot = createAi({ level: level as 1 | 2 | 3 | 4 | 5, seed: seed * 13 + 1 });
  const dummy = new Dummy(kind, seed * 7 + 3);
  const inputs = new Uint8Array(10);
  const born = new Int32Array(100).fill(-1);
  let since = 0;
  let longest = 0;
  let drops = 0;
  let died = -1;
  for (let t = 0; t < ticks && !s.roundOver; t++) {
    inputs[1] = dummy.think(s, 1);
    inputs[0] = bot.think(s, 0);
    step(s, ctx, inputs);
    for (const e of ctx.events) if (e.type === 'death' && e.a === 1 && died < 0) died = s.tick / 60;
    let own = 0;
    for (let i = 0; i < 100; i++) {
      const b = s.bombs[i];
      if (!b.active) continue;
      if (b.owner === 0) own++;
      if (born[i] === b.born) continue;
      born[i] = b.born;
      if (b.owner === 0) {
        drops++;
        since = 0;
      }
    }
    const p = s.players[0];
    const q = s.players[1];
    if (!p.alive || p.dying || !q.alive || q.dying || s.pl.roundFreezeMs > 0) continue;
    const dist = Math.abs(pxToCx(p.x) - pxToCx(q.x)) + Math.abs(pyToCy(p.y) - pyToCy(q.y));
    if (dist <= 5 && p.counts[0] > own) longest = Math.max(longest, ++since);
  }
  return { longest: longest / 60, drops, died };
}

describe('computer players', () => {
  it('think() returns input bits and never mutates the state', () => {
    const cfg = makeConfig({ id: 0, levels: [1, 2, 3, 4, 5, 0, 0, 0, 0, 0], seed: 7, levelno: 0, scheme: 'BASIC.SCH', playtime: 150, depth: 2 });
    const s = createGame(cfg);
    roundStart(s, cfg.scheme, text.extras);
    const ctx = new FrameCtx(anims);
    const ais = [1, 2, 3, 4, 5].map((l) => createAi({ level: l as 1 | 2 | 3 | 4 | 5, seed: l }));
    const inputs = new Uint8Array(10);
    for (let t = 0; t < 400; t++) {
      const before = t % 50 === 0 ? hashState(s) : 0;
      for (let i = 0; i < 5; i++) inputs[i] = ais[i].think(s, i);
      if (before) expect(hashState(s)).toBe(before);
      for (let i = 0; i < 5; i++) expect(inputs[i] & ~63).toBe(0);
      step(s, ctx, inputs);
    }
  });

  it('plays every arena level (0..10) without errors and keeps moving', () => {
    for (let level = 0; level <= 10; level++) {
      const { s, bad, moved } = run([2, 3, 4, 5], 100 + level, level, 60 * 25);
      expect(bad).toBe(0);
      expect(s.tick).toBeGreaterThan(60);
      // every bot that is still around (or was until it died) walked somewhere
      expect(moved.slice(0, 4).filter(Boolean).length).toBeGreaterThanOrEqual(3);
    }
  });

  it('handles crowded games and other schemes', () => {
    for (const scheme of ['CHASE.SCH', 'X.SCH', 'NEIGHBOR.SCH']) {
      const { bad } = run([1, 2, 3, 4, 5, 5, 4, 3, 2], 9, 3, 60 * 20, scheme);
      expect(bad).toBe(0);
    }
  });

  it('is deterministic for a given seed', () => {
    const a = run([3, 5], 42, 4, 60 * 30);
    const b = run([3, 5], 42, 4, 60 * 30);
    expect(a.digest).toBe(b.digest);
    expect(hashState(a.s)).toBe(hashState(b.s));
  });

  it('a master beats a rookie', () => {
    let master = 0;
    let rookie = 0;
    for (let r = 0; r < 6; r++) {
      const levels = r % 2 === 0 ? [5, 1] : [1, 5];
      const res = playRound({ id: r, levels: [...levels, 0, 0, 0, 0, 0, 0, 0, 0], seed: 2000 + r, levelno: r % 11, scheme: 'BASIC.SCH', playtime: 150, depth: 2 }, 60 * 160);
      expect(res.error).toBeUndefined();
      if (res.winner >= 0) {
        if (res.levels[res.winner] === 5) master++;
        else rookie++;
      }
    }
    expect(master).toBeGreaterThan(rookie);
    expect(master).toBeGreaterThanOrEqual(4);
  });

  it('never idles for long and classifies every death', () => {
    const jobs = [
      { levels: [4, 5], levelno: 9, scheme: 'CHASE.SCH' },
      { levels: [2, 3], levelno: 2, scheme: 'BASIC.SCH' },
      { levels: [3, 4, 5, 2], levelno: 6, scheme: 'NEIGHBOR.SCH' },
    ];
    jobs.forEach((j, n) => {
      const levels = [...j.levels, ...new Array(10 - j.levels.length).fill(0)];
      const res = playRound({ id: n, levels, seed: 300 + n, levelno: j.levelno, scheme: j.scheme, playtime: 150, depth: 2 }, 60 * 160);
      expect(res.error).toBeUndefined();
      expect(Math.max(...res.idle)).toBeLessThanOrEqual(60 * IDLE_LIMIT_S);
      expect(res.kinds.length).toBe(res.deaths.length);
    });
  });

  it('models opponents: bots register their level, slow bots react later than fast ones, humans get a default', () => {
    const cfg = makeConfig({ id: 0, levels: [1, 5, 0, 0, 0, 0, 0, 0, 0, 0], seed: 3, levelno: 0, scheme: 'BASIC.SCH', playtime: 150, depth: 2 });
    const s = createGame(cfg);
    roundStart(s, cfg.scheme, text.extras);
    const a = createAi({ level: 1, seed: 1 });
    const b = createAi({ level: 5, seed: 2 });
    a.think(s, 0);
    b.think(s, 1);
    expect(botLevel(s, 0)).toBe(1);
    expect(botLevel(s, 1)).toBe(5);
    expect(botLevel(s, 2)).toBe(0);
    expect(reactSteps(s, 0)).toBeGreaterThan(reactSteps(s, 2));
    expect(reactSteps(s, 2)).toBeGreaterThan(reactSteps(s, 1));
  });

  it('keeps laying bombs at players who never attack, at every level (no passive bots)', () => {
    // bots used to stop dropping once no brick was left and no sure kill was in sight (levels 1, 3, 4, 5 sat
    // 11-29 s next to these opponents without a bomb); now each level presses on its own clock
    for (let level = 1; level <= 5; level++) {
      const still = openFieldDuel(level, 'still', 31 + level * 10, 0, 60 * 30);
      expect(still.drops).toBeGreaterThan(0);
      expect(still.longest).toBeLessThanOrEqual(15);
      // someone who just stands there gets bombed
      expect(still.died).toBeGreaterThanOrEqual(0);
      const wander = openFieldDuel(level, 'wander', 32 + level * 10, 1, 60 * 30);
      expect(wander.drops).toBeGreaterThan(0);
      expect(wander.longest).toBeLessThanOrEqual(15);
    }
    // a level 5 that used to hop between attack spots next to a still player without ever dropping (27 s)
    const hopper = openFieldDuel(5, 'still', 82, 1, 60 * 30);
    expect(hopper.longest).toBeLessThanOrEqual(15);
    expect(hopper.died).toBeGreaterThanOrEqual(0);
  });

  it('a round between two bots ends (winner or time-out draw)', () => {
    const res = playRound({ id: 0, levels: [4, 4, 0, 0, 0, 0, 0, 0, 0, 0], seed: 77, levelno: 1, scheme: 'BASIC.SCH', playtime: 150, depth: 2 }, 60 * 160);
    expect(res.error).toBeUndefined();
    expect(res.ticks).toBeLessThanOrEqual(60 * 152);
    expect(res.winner).toBeGreaterThanOrEqual(-1);
  });

  it('takes warp holes at every level and comes out of them unhurt (level 4)', () => {
    // levels 1-4 used to keep out of warp holes; and every level sometimes came out of the spin into flames, since
    // the search thought the spin lasted longer than it does
    // (three bots of each level, so that the weak ones, who die early, get the time to)
    const warps = [0, 0, 0, 0, 0, 0];
    let burnt = 0;
    for (let lv = 1; lv <= 5; lv++) {
      const levels = [lv, lv, lv, 0, 0, 0, 0, 0, 0, 0];
      const cfg = makeConfig({ id: lv, levels, seed: 400 + lv, levelno: 4, scheme: 'BASIC.SCH', playtime: 150, depth: 2 });
      const s = createGame(cfg);
      roundStart(s, cfg.scheme, text.extras);
      const ctx = new FrameCtx(anims);
      const ais = [0, 1, 2].map((i) => createAi({ level: lv as 1 | 2 | 3 | 4 | 5, seed: lv * 13 + i }));
      const inputs = new Uint8Array(10);
      const prev = [0, 0, 0];
      const landed = [-1e9, -1e9, -1e9];
      for (let t = 0; t < 60 * 50 && !s.roundOver; t++) {
        for (let i = 0; i < 3; i++) inputs[i] = ais[i].think(s, i);
        step(s, ctx, inputs);
        for (let i = 0; i < 3; i++) {
          const a = s.players[i].anim;
          if (a === A_WARP_OUT && prev[i] !== A_WARP_OUT) warps[lv]++;
          if (prev[i] === A_WARP_IN && a !== A_WARP_IN) landed[i] = s.tick;
          prev[i] = a;
        }
        for (const e of ctx.events) if (e.type === 'death' && s.tick - landed[e.a] === 1) burnt++;
      }
    }
    for (let lv = 1; lv <= 5; lv++) expect(warps[lv]).toBeGreaterThan(0);
    expect(burnt).toBe(0);
  });

  it('with no safe cell in walking reach, makes for the trampoline next to it instead of waiting to die (level 9)', () => {
    // a corridor cell between the trampoline at (2,2) and an enemy bomb at (2,4) that goes off in 1.5 s: bots used
    // to stay there and die. Now they head for the trampoline; once on it, some find a way out on foot (turning
    // inside the trampoline's cell does not set it off), the others bounce. (Levels 1-2 notice a bomb this fast
    // too late to make it anywhere: they are slow on purpose.)
    for (const level of [3, 4, 5]) {
      const scheme = text.schemes.find((x) => x.file === 'BASIC.SCH')!;
      const s = createGame({
        slots: Array.from({ length: 10 }, (_, i) => ({ ctrl: i === 0 ? 1 : i === 1 ? 2 : 0, team: -1 })), values: flattenValues(text.values), scheme,
        extras: text.extras, levelno: 9, numToWin: 3, winByKills: 0, teamPlay: 0, randomStart: 0, enclosementDepth: 2, conveyorSpeed: 1,
        stompedBombsDetonate: 1, diseasesDestroyable: 1, playtime: 150, netMode: 0, goldWinner: -1, goldPrize: -1, attract: 0, seed: level,
      });
      roundStart(s, scheme, text.extras);
      for (let c = 0; c < s.map.length; c++) if (s.map[c] === 2) s.map[c] = 0;
      for (const p of s.powers) p.state = 0;
      s.pl.roundFreezeMs = 0;
      s.nextDudTime = 1e9;
      const place = (i: number, cx: number, cy: number) => {
        s.players[i].x = s.players[i].homeX = cellCenterX(cx);
        s.players[i].y = s.players[i].homeY = cellFeetY(cy);
        s.players[i].startCleared = 1;
      };
      place(0, 2, 3);
      place(1, 14, 10);
      bombCreate(s, 2, 4, BombType.REGULAR, 1, 1, 3, 30, 0);
      const ctx = new FrameCtx(anims);
      const bot = createAi({ level: level as 3 | 4 | 5, seed: 5 });
      const inputs = new Uint8Array(10);
      let used = false;
      for (let t = 0; t < 240; t++) {
        inputs[0] = bot.think(s, 0);
        step(s, ctx, inputs);
        const p = s.players[0];
        if (p.anim === A_TRAMPOLINE || (pxToCx(p.x) === 2 && pyToCy(p.y) === 2)) used = true;
      }
      expect(used).toBe(true);
      expect(s.players[0].alive && !s.players[0].dying).toBeTruthy();
    }
  });
});
