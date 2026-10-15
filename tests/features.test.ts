// Scenario tests for the level features and bomb actions: arrows, conveyors, warps, trampolines, kicking,
// punching across the field edge and trigger bombs.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { AnimDB } from '../src/game/sim/anims.ts';
import { FrameCtx } from '../src/game/sim/ctx.ts';
import { createGame, roundStart, step, flattenValues, type MatchConfig } from '../src/game/sim/sim.ts';
import { bombCreate, bombKick } from '../src/game/sim/bombs.ts';
import { cellCenterX, cellFeetY, pxToCx, pyToCy, MAP_BLANK, MAP_BRICK } from '../src/game/sim/map.ts';
import { A_TRAMPOLINE } from '../src/game/sim/players.ts';
import { BombState, BombType, type GameState } from '../src/game/sim/types.ts';
import { IN_RIGHT, IN_UP, IN_ACT1, IN_ACT2 } from '../src/engine/input.ts';
import type { TextJson } from '../src/engine/assets.ts';

const sprites = JSON.parse(readFileSync('public/data/sprites/sprites.json', 'utf8'));
const text: TextJson = JSON.parse(readFileSync('public/data/text.json', 'utf8'));
const anims = new AnimDB(sprites.seqs);

/** A two-player round on `level` with every brick and power-up removed and both players parked out of the way. */
function field(level: number): { s: GameState; ctx: FrameCtx } {
  const scheme = text.schemes.find((x) => x.file === 'BASIC.SCH')!;
  const cfg: MatchConfig = {
    slots: Array.from({ length: 10 }, (_, i) => ({ ctrl: i < 2 ? 2 : 0, team: -1 })),
    values: flattenValues(text.values),
    scheme,
    extras: text.extras,
    levelno: level,
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
  place(s, 0, 0, 10);
  place(s, 1, 14, 10);
  for (const p of s.players) p.startCleared = 1;
  return { s, ctx: new FrameCtx(anims) };
}

function place(s: GameState, pi: number, cx: number, cy: number): void {
  const p = s.players[pi];
  p.x = p.homeX = cellCenterX(cx);
  p.y = p.homeY = cellFeetY(cy);
}

const cellOf = (x: number, y: number) => `${pxToCx(x)},${pyToCy(y)}`;

function run(s: GameState, ctx: FrameCtx, ticks: number, input: (t: number) => number[] = () => []): void {
  const inputs = new Uint8Array(10);
  for (let t = 0; t < ticks; t++) {
    inputs.fill(0);
    input(t).forEach((v, i) => (inputs[i] = v));
    step(s, ctx, inputs);
  }
}

describe('level features', () => {
  it('arrows turn kicked bombs (level 2: a loop around the field)', () => {
    const { s, ctx } = field(2);
    const b = bombCreate(s, 4, 2, BombType.REGULAR, 0, 0, 2, 600, 0);
    bombKick(s, ctx, b, 3);
    const visited: string[] = [];
    const inputs = new Uint8Array(10);
    for (let t = 0; t < 900; t++) {
      step(s, ctx, inputs);
      const c = cellOf(s.bombs[b].x, s.bombs[b].y);
      if (visited[visited.length - 1] !== c) visited.push(c);
    }
    // west to the arrow at (2,2), south to (2,8), east to (12,8), north to (12,2), west again
    const order = ['3,2', '2,2', '2,5', '2,8', '7,8', '12,8', '12,5', '12,2', '7,2', '2,2'];
    let k = 0;
    for (const c of visited) if (c === order[k]) k++;
    expect(k).toBe(order.length);
    expect(s.bombs[b].state).toBe(BombState.SLIDING);
  });

  it('conveyors carry idle players and resting bombs (level 10)', () => {
    const { s, ctx } = field(10);
    place(s, 0, 5, 2); // eastbound belt
    const b = bombCreate(s, 12, 3, BombType.REGULAR, 0, 1, 2, 600, 0); // southbound belt
    const x0 = s.players[0].x;
    const y0 = s.bombs[b].y;
    run(s, ctx, 60);
    expect(s.players[0].x).toBeGreaterThan(x0 + 20);
    expect(s.players[0].y).toBe(cellFeetY(2));
    expect(s.bombs[b].y).toBeGreaterThan(y0 + 20);
    expect(s.bombs[b].x).toBe(cellCenterX(12));
  });

  it('a player walking against a conveyor is slowed down', () => {
    const a = field(10);
    place(a.s, 0, 9, 2); // walking east on an eastbound belt
    const c = field(10);
    place(c.s, 0, 9, 8); // walking east on a westbound belt
    run(a.s, a.ctx, 20, () => [IN_RIGHT]);
    run(c.s, c.ctx, 20, () => [IN_RIGHT]);
    const withBelt = a.s.players[0].x - cellCenterX(9);
    const against = c.s.players[0].x - cellCenterX(9);
    expect(withBelt).toBeGreaterThan(against + 10);
  });

  it('warps send players to the linked warp (level 4)', () => {
    const { s, ctx } = field(4);
    place(s, 0, 2, 3);
    const seen = new Set<string>();
    run(s, ctx, 240, (t) => {
      seen.add(cellOf(s.players[0].x, s.players[0].y));
      return [t < 30 ? IN_UP : 0];
    });
    // warp 0 at (2,2) links to warp 3 at (2,8)
    expect(seen.has('2,2')).toBe(true);
    expect(cellOf(s.players[0].x, s.players[0].y)).toBe('2,8');
  });

  it('trampolines bounce players, who cannot be hurt in the air (level 9)', () => {
    const { s, ctx } = field(9);
    place(s, 0, 2, 3);
    let jumped = false;
    run(s, ctx, 60, (t) => {
      if (s.players[0].anim === A_TRAMPOLINE) jumped = true;
      return [t < 20 ? IN_UP : 0];
    });
    expect(jumped).toBe(true);
  });
});

describe('bomb actions', () => {
  it('kicked bombs slide until something blocks them', () => {
    const { s, ctx } = field(0);
    place(s, 0, 0, 0);
    s.players[0].counts[3] = 1; // kicker
    const b = bombCreate(s, 1, 0, BombType.REGULAR, 0, 1, 2, 600, 0);
    run(s, ctx, 240, (t) => [t < 15 ? IN_RIGHT : 0]);
    expect(cellOf(s.bombs[b].x, s.bombs[b].y)).toBe('14,0');
    expect(s.bombs[b].state).toBe(BombState.REST);
  });

  it('jelly bombs bounce back from walls', () => {
    const { s, ctx } = field(0);
    const b = bombCreate(s, 12, 0, BombType.JELLY, 0, 1, 2, 600, 0);
    bombKick(s, ctx, b, 1);
    let turned = false;
    run(s, ctx, 120, () => {
      if (s.bombs[b].dir === 3) turned = true;
      return [];
    });
    expect(turned).toBe(true);
    expect(pxToCx(s.bombs[b].x)).toBeLessThan(12);
  });

  it('punched bombs fly three cells and wrap around the field edge', () => {
    const { s, ctx } = field(0);
    place(s, 0, 0, 0);
    s.players[0].counts[5] = 1; // punch
    s.players[0].dir = 1;
    const b1 = bombCreate(s, 1, 0, BombType.REGULAR, 0, 1, 2, 600, 0);
    run(s, ctx, 90, (t) => [t === 1 ? IN_ACT2 : 0]);
    expect(cellOf(s.bombs[b1].x, s.bombs[b1].y)).toBe('4,0');
    place(s, 0, 12, 2);
    s.players[0].dir = 1;
    const b2 = bombCreate(s, 13, 2, BombType.REGULAR, 0, 1, 2, 600, 0);
    run(s, ctx, 180, (t) => [t === 1 ? IN_ACT2 : 0]);
    expect(s.bombs[b2].state).toBe(BombState.REST);
    expect(pxToCx(s.bombs[b2].x)).toBeLessThan(3); // came back in on the west side
  });

  it('trigger bombs wait for the second button', () => {
    const { s, ctx } = field(0);
    place(s, 0, 4, 4);
    s.players[0].counts[9] = 1; // trigger
    run(s, ctx, 10, (t) => [t === 1 ? IN_ACT1 : 0]);
    const b = s.bombs.findIndex((x) => x.active);
    expect(b).toBeGreaterThanOrEqual(0);
    expect(s.bombs[b].type).toBe(BombType.TRIGGER);
    place(s, 0, 8, 4);
    run(s, ctx, 300);
    expect(s.bombs[b].active).toBeTruthy(); // long past the normal 2 s fuse
    run(s, ctx, 10, (t) => [t === 1 ? IN_ACT2 : 0]);
    expect(s.bombs[b].active).toBe(0);
    expect(s.flames.some((f) => f.state)).toBe(true);
  });
});
