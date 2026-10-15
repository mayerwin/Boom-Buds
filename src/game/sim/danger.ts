// The original AI danger map (bombs.c danger_get/danger_set_max): cleared every frame, raised by bombs
// (fuse_elapsed + 100), flames (1000) and the enclosement look-ahead.

import { W, type GameState } from './types.ts';
import { inBounds } from './map.ts';

export function dangerRaise(s: GameState, cx: number, cy: number, v: number): void {
  if (!inBounds(cx, cy)) return;
  const i = cy * W + cx;
  if (s.danger[i] < v) s.danger[i] = v;
}

export function dangerGet(s: GameState, cx: number, cy: number): number {
  if (!inBounds(cx, cy)) return 0;
  return s.danger[cy * W + cx];
}
