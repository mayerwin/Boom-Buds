// Diseases (player.md §10): 0 molasses, 1 crack, 2 constipation, 3 poops, 4 short flame, 5 crack poops,
// 6 short fuze, 7 swap (instant), 8 reversed controls.

import { REF, type GameState, type Player } from './types.ts';
import type { FrameCtx } from './ctx.ts';
import { rand } from './rng.ts';

export const D_MOLASSES = 0, D_CRACK = 1, D_CONSTIPATION = 2, D_POOPS = 3, D_SHORT_FLAME = 4, D_CRACK_POOPS = 5,
  D_SHORT_FUZE = 6, D_SWAP = 7, D_REVERSED = 8;

function val(s: GameState, id: number): number {
  return s.opts.values[id] ?? 0;
}

/** player_cure_diseases @0x41df4c */
export function playerCureDiseases(_s: GameState, p: Player): void {
  p.diseaseMs = 0;
  p.diseaseLen = 0;
  for (let i = 0; i < 14; i++) p.disease[i] = 0;
}

/** player_give_disease @0x41dfb6 */
export function playerGiveDisease(s: GameState, ctx: FrameCtx, p: Player, sound: number): void {
  if (p.ctrl === 4) return;
  let d = 0;
  for (let t = 0; t < 200; t++) {
    d = rand(s.rng) % 9;
    if (!s.opts.netMode || d !== D_SWAP) break;
  }
  if (sound) {
    if (rand(s.rng) % 3 === 0) ctx.sound(3000 + 50 * d, p.x);
    else ctx.sound(2300, p.x);
  }
  if (d === D_SWAP) {
    for (let t = 0; t < 200; t++) {
      const q = s.players[rand(s.rng) % 10];
      if (q !== p && q.ctrl !== 0 && (q.lives > 0 || q.alive) && !q.dying) {
        const tx = p.x, ty = p.y;
        p.x = q.x;
        p.y = q.y;
        q.x = tx;
        q.y = ty;
        break;
      }
    }
    return;
  }
  p.disease[d] = 1;
  p.diseaseMs = 1;
  p.diseaseLen = val(s, 130 + d) * REF;
  p.diseaseFresh = val(s, 129);
}

/** Disease timer and contact transmission, every frame before input (player.md §10.3/10.4). */
export function playerDiseaseTick(s: GameState, ctx: FrameCtx, p: Player): void {
  if (p.diseaseMs) {
    p.diseaseMs += ctx.dt;
    if (p.diseaseMs > p.diseaseLen) playerCureDiseases(s, p);
  }
  if (p.diseaseMs !== 0 && p.diseaseFresh === 0) {
    const multiply = val(s, 123);
    for (const q of s.players) {
      if (q === p || !q.alive || q.dying || q.diseaseMs !== 0) continue;
      if (Math.abs(q.x - p.x) > 40 - 10 || Math.abs(q.y - p.y) > 36 - 10) continue;
      q.diseaseFresh = val(s, 129);
      q.diseaseMs = p.diseaseMs;
      q.diseaseLen = p.diseaseLen;
      for (let i = 0; i < 14; i++) {
        q.disease[i] = p.disease[i];
        if (!multiply) p.disease[i] = 0;
      }
      if (!multiply) {
        p.diseaseMs = 0;
        p.diseaseLen = 0;
        break;
      }
    }
  }
}
