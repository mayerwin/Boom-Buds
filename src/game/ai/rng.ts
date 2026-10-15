// Seeded random numbers for the computer players (mulberry32). Never touches the simulation's RNG, so bots
// do not change the game's random sequence and every bot is reproducible from its seed.

export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = (seed >>> 0) ^ 0x9e3779b9;
  }

  /** Uniform in [0, 1). */
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  chance(p: number): boolean {
    return p > 0 && this.next() < p;
  }
}
