// The 11 arenas ("levels"/waves) of the original game. Per-level data comes from VALUELST.RES
// (ice delay 450+n, regenerating tiles 340+n, random eligibility 1150+n), MESSAGES.TXT (150+n names),
// SOUNDLST.RES (music 1100+n) and EXTRA<n>.RES (arrows, warps, conveyors, trampolines).

export const LEVEL_COUNT = 11;

/**
 * The arenas with something special about them: ice (sliding), bricks that grow back, or extras (arrows, warp
 * holes, conveyor belts, trampolines). "Random special arena" picks among them.
 */
export function specialLevels(values: Record<string, number[]>, extras: Record<string, unknown[]>): number[] {
  const out: number[] = [];
  for (let n = 0; n < LEVEL_COUNT; n++) {
    const v = (id: number) => values[id]?.[0] ?? 0;
    if (v(450 + n) > 0 || v(340 + n) > 0 || (extras[String(n)]?.length ?? 0) > 0) out.push(n);
  }
  return out;
}

export interface LevelInfo {
  index: number;
  name: string;
  field: string; // FIELDn.PCX
  tileSeq: (kind: 'blank' | 'solid' | 'brick') => string;
  brickSeq: string; // "flame brick n"
  musicId: number; // SOUNDLST id
  iceDelayMs: number;
  regenSeconds: number;
  randomEligible: boolean;
}

export function levelInfo(n: number, values: Record<string, number[]>, messages: Record<string, string>): LevelInfo {
  const v = (id: number) => values[id]?.[0] ?? 0;
  return {
    index: n,
    name: messages[150 + n] ?? `Level ${n}`,
    field: `FIELD${n}`,
    tileSeq: (kind) => `tile ${n} ${kind}`,
    brickSeq: `flame brick ${n}`,
    musicId: 1100 + n,
    iceDelayMs: v(450 + n),
    regenSeconds: v(340 + n),
    randomEligible: v(1150 + n) !== 0,
  };
}
