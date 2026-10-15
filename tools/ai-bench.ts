// AI CPU benchmark: single-threaded rounds with many bots, measuring the total think() time per simulation
// tick (all bots together), which is what the 60 Hz loop pays.
//
//   node tools/ai-bench.ts                 9 bots (levels 1..5 mixed), 4 rounds
//   node tools/ai-bench.ts --level 5       9 bots of level 5
//   node tools/ai-bench.ts --level 0       9 bots of level 0, the original game's AI (--ai0-hz 60: every step)
//   node tools/ai-bench.ts --bots 4 --rounds 8 --scheme BASIC.SCH
//   node tools/ai-bench.ts --level 5 --repeat 3   the same rounds three times; per tick the fastest of the
//                                                 three counts, which removes the pauses of a busy machine
//                                                 (the AI's work is deterministic, the OS's scheduling is not)
//
// Budget (docs/AI_BRIEF.md): average <= 1.5 ms per tick for 9 bots, worst case <= 4 ms.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AnimDB } from '../src/game/sim/anims.ts';
import { FrameCtx } from '../src/game/sim/ctx.ts';
import { createGame, roundStart, step } from '../src/game/sim/sim.ts';
import type { TextJson } from '../src/engine/assets.ts';
import { createAi, type AiPlayer } from '../src/game/ai/index.ts';
import { OriginalAi } from '../src/game/ai/original.ts';
import { makeConfig, levelCode, aiLevel, LEVEL0 } from './ai-arena.ts';

interface Args {
  bots: number;
  /** AI level 0..5, -1 = levels 1..5 mixed */
  level: number;
  rounds: number;
  scheme: string;
  seed: number;
  repeat: number;
  ai0Hz: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { bots: 9, level: -1, rounds: 4, scheme: 'BASIC.SCH', seed: 1, repeat: 1, ai0Hz: 0 };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    switch (argv[i]) {
      case '--bots': a.bots = Number(v); i++; break;
      case '--level': a.level = Number(v); i++; break;
      case '--ai0-hz': a.ai0Hz = Number(v); i++; break;
      case '--rounds': a.rounds = Number(v); i++; break;
      case '--scheme': a.scheme = v; i++; break;
      case '--seed': a.seed = Number(v); i++; break;
      case '--repeat': a.repeat = Math.max(1, Number(v)); i++; break;
    }
  }
  return a;
}

function main(): void {
  const a = parseArgs(process.argv.slice(2));
  const root = fileURLToPath(new URL('..', import.meta.url));
  const sprites = JSON.parse(readFileSync(root + 'public/data/sprites/sprites.json', 'utf8'));
  const text: TextJson = JSON.parse(readFileSync(root + 'public/data/text.json', 'utf8'));
  const anims = new AnimDB(sprites.seqs);
  let perTick: number[] = [];
  let simMs = 0;
  for (let pass = 0; pass < a.repeat; pass++) {
    const times: number[] = [];
    simMs = 0;
    for (let r = 0; r < a.rounds; r++) {
      // level codes as in the arena (0 empty slot, LEVEL0 for AI level 0)
      const levels = Array.from({ length: 10 }, (_, i) => (i < a.bots ? levelCode(a.level >= 0 ? a.level : (i % 5) + 1) : 0));
      const cfg = makeConfig({ id: r, levels, seed: a.seed * 1000 + r, levelno: (r * 3) % 11, scheme: a.scheme, playtime: 150, depth: 2 });
      const s = createGame(cfg);
      roundStart(s, cfg.scheme, text.extras);
      const ctx = new FrameCtx(anims);
      const ais: (AiPlayer | null)[] = levels.map((lv, i) => {
        if (!(lv > 0)) return null;
        if (lv === LEVEL0 && a.ai0Hz) return new OriginalAi(r * 97 + i, a.ai0Hz);
        return createAi({ level: aiLevel(lv) as 0 | 1 | 2 | 3 | 4 | 5, seed: r * 97 + i });
      });
      const inputs = new Uint8Array(10);
      for (let t = 0; t < 60 * 155 && !s.roundOver; t++) {
        const t0 = performance.now();
        for (let i = 0; i < 10; i++) inputs[i] = ais[i] ? ais[i]!.think(s, i) : 0;
        const t1 = performance.now();
        step(s, ctx, inputs);
        simMs += performance.now() - t1;
        // the first second is the round-start freeze (no input), skip it
        if (t > 60) times.push(t1 - t0);
      }
    }
    perTick = pass === 0 ? times : perTick.map((x, k) => Math.min(x, times[k]));
  }
  perTick.sort((x, y) => x - y);
  const n = perTick.length;
  const avg = perTick.reduce((x, y) => x + y, 0) / n;
  const pct = (p: number) => perTick[Math.min(n - 1, Math.floor((p / 100) * n))];
  console.log(`${a.bots} bots (${a.level >= 0 ? 'level ' + a.level + (a.level === 0 && a.ai0Hz ? ` at ${a.ai0Hz} Hz` : '') : 'levels 1..5'}), ${a.rounds} rounds, ${n} ticks, scheme ${a.scheme}${a.repeat > 1 ? `, fastest of ${a.repeat} runs per tick` : ''}`);
  console.log(`AI per tick: avg ${avg.toFixed(3)} ms, p50 ${pct(50).toFixed(3)}, p99 ${pct(99).toFixed(3)}, p99.9 ${pct(99.9).toFixed(3)}, max ${perTick[n - 1].toFixed(3)} ms`);
  console.log(`simulation step: avg ${(simMs / n).toFixed(3)} ms`);
}

main();
