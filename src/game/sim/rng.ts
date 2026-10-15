// The original game's random generator (Watcom C rand(): LCG x*1103515245+12345, bits 16..30).
// The seed lives in the simulation state so that every peer draws the same sequence.

export interface RngState {
  seed: number;
}

export function rand(s: RngState): number {
  s.seed = (Math.imul(s.seed, 1103515245) + 12345) >>> 0;
  return (s.seed >>> 16) & 0x7fff;
}

/** rand() % n, as written in the original code (n > 0). */
export function randMod(s: RngState, n: number): number {
  return n > 0 ? rand(s) % n : 0;
}

/** 1-in-n chance, the original's convention for VALUELST "chances" (n <= 0 is treated as never). */
export function chance(s: RngState, n: number): boolean {
  return n > 0 && rand(s) % n === 0;
}
