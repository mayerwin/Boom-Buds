// Turns the sound events produced by a simulation frame into audio, in the order the frame produced them
// (the 6-voice limit is evaluated per request in that order, as in the original game_frame).
//
// Deviation (docs/DIFFERENCES.md): the original draws the sound selection from the game's rand(), which
// shifts the gameplay random sequence; here selection uses the audio engine's own generator so that the
// simulation stays deterministic for netplay and replays.

import type { AudioEngine } from '../engine/audio.ts';
import type { FrameCtx } from './sim/ctx.ts';
import { SoundKind } from './sim/ctx.ts';

export class AudioPresenter {
  private audio: AudioEngine;
  /** sound_play_group_ratelimited bookkeeping (jelly bounce): last reference frame per id */
  private lastFrame = new Map<number, number>();
  /** set while a rollback re-simulates frames whose sounds were already played */
  muted = false;

  constructor(audio: AudioEngine) {
    this.audio = audio;
  }

  reset(): void {
    this.lastFrame.clear();
  }

  frame(ctx: FrameCtx, frameCounter: number, refFrame: number): void {
    if (this.muted) return;
    for (const e of ctx.sounds) {
      switch (e.kind) {
        case SoundKind.GROUP:
          this.audio.playGroup(e.id);
          break;
        case SoundKind.ID:
          this.audio.playId(e.id, frameCounter);
          break;
        case SoundKind.GROUP_THROTTLED: {
          // at most once per 3 (reference) frames, shared by all jelly bombs
          const last = this.lastFrame.get(e.id) ?? -1000;
          if (refFrame < last || refFrame >= last + 3) {
            this.audio.playGroup(e.id);
            this.lastFrame.set(e.id, refFrame);
          }
          break;
        }
        case SoundKind.VOICE_GROUP:
          this.audio.playVoiceGroup(e.id);
          break;
      }
    }
  }
}
