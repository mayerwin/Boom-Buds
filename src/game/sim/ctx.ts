// Per-frame context handed to every update function: elapsed time, static data and the outputs the
// presentation layer consumes (display list in submission order, sound events).

import type { AnimDB } from './anims.ts';

export const DrawKind = {
  /** atlas frame drawn with its hotspot at (x, y), optional remap (0 = none) */
  SPRITE: 0,
  /** frame silhouette in a single palette colour (shadows, effects) */
  MASK: 1,
} as const;

export interface DrawCmd {
  kind: number;
  frame: number;
  x: number;
  y: number;
  remap: number;
  /** the player whose bomber this is (-1 for everything else): the modern menus' "you" marker */
  who: number;
}

export const SoundKind = {
  /** sound_play_group(base): random least-played member of the group */
  GROUP: 0,
  /** sound_play_id(id): exact id */
  ID: 1,
  /** sound_play_group_ratelimited (jelly bounce) */
  GROUP_THROTTLED: 2,
  /** streamed voice group (not counted against the voice limit) */
  VOICE_GROUP: 3,
} as const;

export interface SoundEvent {
  kind: number;
  id: number;
  /** horizontal position for optional panning (-1 = none) */
  x: number;
}

export class FrameCtx {
  dt = 0;
  readonly anims: AnimDB;
  draws: DrawCmd[] = [];
  sounds: SoundEvent[] = [];
  /** game events for the presentation / scoring layer (deaths, round end, etc.) */
  events: { type: string; a: number; b: number }[] = [];

  constructor(anims: AnimDB) {
    this.anims = anims;
  }

  reset(dt: number): void {
    this.dt = dt;
    this.draws.length = 0;
    this.sounds.length = 0;
    this.events.length = 0;
  }

  draw(frame: number, x: number, y: number, remap = 0, who = -1): void {
    if (this.draws.length >= 400) return; // the original's display list limit (fatal error 10)
    this.draws.push({ kind: DrawKind.SPRITE, frame, x, y, remap, who });
  }

  drawMask(frame: number, x: number, y: number, colour: number): void {
    this.draws.push({ kind: DrawKind.MASK, frame, x, y, remap: colour, who: -1 });
  }

  /** Draw state `state % nstates` of `seq` (frame only, the ANI per-state offsets are ignored). */
  drawSeq(seq: number, state: number, x: number, y: number, remap = 0): void {
    const n = this.anims.states(seq);
    const ref = this.anims.ref(seq, state % n);
    this.draw(ref.frame, x, y, remap);
  }

  sound(id: number, x = -1): void {
    this.sounds.push({ kind: SoundKind.GROUP, id, x });
  }

  soundId(id: number, x = -1): void {
    this.sounds.push({ kind: SoundKind.ID, id, x });
  }

  soundThrottled(id: number, x = -1): void {
    this.sounds.push({ kind: SoundKind.GROUP_THROTTLED, id, x });
  }

  voice(id: number): void {
    this.sounds.push({ kind: SoundKind.VOICE_GROUP, id, x: -1 });
  }

  event(type: string, a = 0, b = 0): void {
    this.events.push({ type, a, b });
  }
}
