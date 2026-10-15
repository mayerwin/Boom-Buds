# Boom Buds — computer player (AI) brief

Boom Buds is a pixel/gameplay-perfect web remake of Atomic Bomberman (1997). The deterministic game
simulation is implemented in `src/game/sim/*` from reverse-engineered specs in `docs/re/*.md`
(player.md, bombs.md, flames-map-powerups.md, extras-levels.md, engine-loop-input-hud.md, match-flow.md;
ai-original.md describes the weak original AI). Read the sim code first — it is the ground truth.

## Goal
State-of-the-art bots with **5 difficulty levels** so the game is genuinely fun for everyone, from kids
(level 1) to very skilled players (level 5 = super skilled, not impossible/cheating). Bots play through
the same input interface as humans.

## Interface (create `src/game/ai/index.ts`)
```ts
import type { GameState } from '../sim/types.ts';
export interface AiOptions { level: 1|2|3|4|5; seed: number; }
export interface AiPlayer {
  /** Called once per simulation tick (60 Hz) *before* step(); returns input bits for player `index`. */
  think(s: GameState, index: number): number;
  /** Called at round start (new map). */
  reset(): void;
}
export function createAi(opts: AiOptions): AiPlayer;
```
Input bits (`src/engine/input.ts`): IN_UP=1, IN_RIGHT=2, IN_DOWN=4, IN_LEFT=8, IN_ACT1=16 (drop bomb /
grab+hold / spooge on own bomb), IN_ACT2=32 (stop own kicked bombs, punch bomb in front, detonate
oldest trigger bomb). Buttons are edge-triggered by the player code (press = bit set this tick and not
last tick); holding IN_ACT1 while carrying keeps the bomb, releasing throws it. Bit 0x80 (AI only) makes
the player code treat the buttons as freshly pressed even if they were held last tick.
`think` must NOT mutate `s`. You may `structuredClone(s)` and call `step()` on the clone to look ahead
(perfect forward model), but mind the CPU budget. Use your own seeded RNG (never Math.random).

Notes from the original rules that matter: AI players (`ctrl === 1`) are exempt from the reversed-controls
disease and the hockey-rink ice delay; inputs are ignored for the first 1000 ms of a round and while
stunned/warping/trampolining/in the pickup pause; a dying player counts as alive for 1 s; flames kill if the
player's anchor cell has any flame; movement is pixel based with lane alignment and corner sliding
(player.md §6.2); kicks happen automatically when walking centred into a bomb with a kicker.

## What strong play needs (suggested architecture; improve on it)
1. **Danger/time model**: for every cell, time intervals during which it will burn — from bomb fuses
   (fuseLen - fuseElapsed, ms; trigger bombs = owner-controlled, treat as imminent when an enemy owns
   them), chain reactions (a bomb hit by another's flame explodes the next frame), flame lengths, blocking
   bricks/solids/powerups, moving bombs (kicked/flying trajectories), existing flames (remaining ~500 ms),
   burning bricks, and the hurry enclosement spiral (state `s.hurry`, a block every 250 ms, see
   `src/game/sim/enclosure.ts`).
2. **Time-expanded reachability** (BFS/Dijkstra over cell × time using the bot's real speed incl. skates,
   molasses/crack, conveyors) to find safe cells and safe paths; a cell is safe to stand in only outside its
   danger intervals; prefer cells that stay safe for long.
3. **Bomb placement** only if an escape exists after adding the bomb (simulate its blast & chains).
4. **Offense**: trap detection — evaluate opponents' escape options after a candidate bomb (or bomb +
   kick/punch), multi-bomb combos for higher levels, trigger-bomb timing, kicking bombs into corridors
   toward enemies, punching bombs over walls, spooge lines. Team play: never harm teammates.
5. **Economy**: break bricks efficiently early, value powerups (bombs, flames, kick, skate early; avoid
   disease/super-bad disease unless desperate; jelly/trigger/punch/grab usage), avoid the edges during the
   enclosement.
6. **Execution**: convert a cell path into direction bits (handle lane alignment: steer toward lane centre
   before turning; use the corner assist), drop bombs at the right pixel moment, avoid jitter.

## Difficulty levels (tune so each feels distinct and fun)
Retuned in 2026-10 to play like people, on a ladder measured against the original game's computer player
(AI 0, the default; the user's targets: L1 clearly below it, L2 slightly below, L3 ~70 %, L4 ~85 %, L5 ~97 %,
each level clearly above the one below). Before laying a bomb every level hesitates like a person (`dropLag`,
jittered), and the weaker levels misjudge blasts (`rangeBlind`, `mistake`) and notice bombs late
(`warnMs`). Every level uses the arenas' extras (warp holes, conveyors; a trampoline as a last resort).
- L1 Rookie: slow reactions (~900 ms), notices bombs late and thinks it has more time (`timeBlind`), misjudges
  others' blasts, wanders, rarely attacks; seldom kills itself: loses to AI 0 most of the time.
- L2 Casual: ~650 ms, bombs whoever is in line but late, runs into dead ends, misjudges blasts and chains: about
  even with AI 0.
- L3 Skilled: ~300 ms, full model incl. moving bombs (some chains missed), single-bomb traps, kicks, good
  pickups.
- L4 Expert: ~240 ms, opponent escape modelling, 2-bomb traps, punch/grab/trigger usage, dead-end avoidance.
- L5 Master: ~150 ms reactions, deep multi-bomb trap search, near-perfect safety, exploits the enclosement;
  plays like a top human, no cheating (it only reads state a human can see on screen).
- AI 0 (the default): the original game's computer player, src/game/ai/original.ts (docs/re/ai-original.md).

## Performance budget
60 Hz sim with up to 9 bots: average total AI cost per tick ≤ 1.5 ms on a desktop (≤ 4 ms worst case),
proportionally lower on phones. Stagger heavy planning across ticks (each bot replans every few ticks or on
events) and keep a cheap per-tick safety check. Measure it (add a benchmark script).

## Validation (required)
- `tools/ai-arena.ts`: headless round-robin tournaments (Node, `node tools/ai-arena.ts`) on several levels
  and schemes (load `public/data/text.json` and `public/data/sprites/sprites.json` like `tests/sim.test.ts`).
  Report win rates per level pair, suicide rates, average round length, AI ms/tick.
- Win-rate ordering must be clear: L5 > L4 > L3 > L2 > L1 (each step ≥ 65% head-to-head in 1v1 over ≥ 100
  rounds), L1 should still sometimes win against L2. L3+ suicide rate < 10% of deaths, L5 < 3%.
- Bots must not get stuck (e.g. oscillating forever), must finish rounds in reasonable time, and must handle
  every level (0..10) including conveyors (10), arrows (2, 3), warps (4), trampolines (9), regenerating
  bricks (7), ice (2, AI exempt) and the enclosement.
- Add vitest tests in `tests/ai.test.ts` (fast: a few short matches, no exceptions, ordering sanity).

Keep code clean, typed (TypeScript, `erasableSyntaxOnly`: no enums/namespaces/parameter properties),
commented where non-obvious, matching the style of `src/game/sim`. Do not modify the simulation files
except for clear bugs (report them); do not touch other parts of the app.
