// Time helpers for the computer players. The simulation runs at 60 Hz with step durations TICK_DT =
// 17, 16, 17 ms (50 ms per three steps). The AI measures time in absolute step numbers: the state as passed
// to think() is at the end of step `s.tick`; the next step() call executes step `s.tick + 1`.

import { TICK_DT } from '../sim/sim.ts';

/**
 * Number of steps n >= 1, counted from the step after `tick`, until the summed step durations reach `ms`
 * (sum >= ms, or sum > ms when `strict`). Used for bomb fuses (>=) and flame lifetimes (>).
 */
export function stepsUntil(tick: number, ms: number, strict = false): number {
  let n = 0;
  let sum = 0;
  if (ms > 100) {
    // any three consecutive steps last exactly 50 ms
    const cycles = Math.floor((ms - 50) / 50);
    n = cycles * 3;
    sum = cycles * 50;
  }
  while (strict ? sum <= ms : sum < ms) {
    sum += TICK_DT[(tick + n) % 3];
    n++;
  }
  return n < 1 ? 1 : n;
}

/** Average accumulator units (1/100 px) per step for a speed given in 1/100 px per 50 ms. */
export function unitsPerStep(spd: number): number {
  if (spd <= 0) return 0;
  return (Math.floor((spd * 17) / 50) + Math.floor((spd * 16) / 50) + Math.floor((spd * 17) / 50)) / 3;
}

/** Milliseconds to steps (rounded up, at least 1). */
export function msToSteps(ms: number): number {
  return Math.max(1, Math.ceil((ms * 3) / 50));
}
