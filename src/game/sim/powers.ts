// power.c: power-ups hidden under bricks, revealed on destruction, picked up, dropped on death
// (docs/re/flames-map-powerups.md §3).

import { W, H, type GameState, type Player } from './types.ts';
import type { FrameCtx } from './ctx.ts';
import { rand } from './rng.ts';
import { inBounds, mapGet, cellCenterX, cellFeetY, MAP_BRICK, MAP_BLANK } from './map.ts';
import { bombAtCell, bombsUntrigger } from './bombs.ts';
import { playerAtCell } from './players.ts';
import { playerGiveDisease, playerCureDiseases } from './diseases.ts';

export const P_BOMB = 0, P_FLAME = 1, P_DISEASE = 2, P_KICKER = 3, P_SKATE = 4, P_PUNCH = 5, P_GRAB = 6,
  P_SPOOGE = 7, P_GOLDFLAME = 8, P_TRIGGER = 9, P_JELLY = 10, P_DISEASE3 = 11, P_RANDOM = 12, P_CLOG = 13;

export const POWER_NAMES = ['bomb', 'flame', 'disease', 'kicker', 'skate', 'punch', 'grab', 'spooge', 'goldflame', 'trigger', 'jelly', 'disease3', 'random', 'clog'];

export function powerIsExclusive(t: number): boolean {
  return t === P_PUNCH || t === P_GRAB || t === P_SPOOGE || t === P_TRIGGER || t === P_JELLY;
}

function val(s: GameState, id: number): number {
  return s.opts.values[id] ?? 0;
}

/** power_at: index of the power cell when state != 0 (hidden ones included), else -1. */
export function powerAt(s: GameState, cx: number, cy: number): number {
  if (!inBounds(cx, cy)) return -1;
  const i = cy * W + cx;
  return s.powers[i].state !== 0 ? i : -1;
}

export function powerDestroy(s: GameState, i: number): void {
  s.powers[i].state = 0;
}

/** Destroy a visible power-up hit by a flame or a sliding bomb (disease relocation rule). */
export function powerDestroyByHit(s: GameState, i: number): void {
  const t = s.powers[i].type;
  powerDestroy(s, i);
  if (t === P_DISEASE && !s.opts.diseasesDestroyable) powerSpawnRandomBlank(s, P_DISEASE);
}

/** power_place_level @0x4258e5 */
export function powerPlaceLevel(s: GameState): void {
  for (const p of s.powers) {
    p.state = 0;
    p.type = 0;
    p.frame = 0;
    p.revealedAt = 0;
    p.vis = 0;
  }
  for (let t = 0; t <= 12; t++) {
    let n = val(s, 400 + t);
    if (s.opts.netMode && t === P_RANDOM) n = 0;
    const isChance = n < 0;
    n = Math.abs(n);
    for (let k = 0; k < n; k++) {
      if (isChance && rand(s.rng) % 10 !== 0) continue;
      for (let tries = 0; tries < 200; tries++) {
        const x = rand(s.rng) % 15;
        const y = rand(s.rng) % 11;
        if (mapGet(s, x, y) === MAP_BRICK && powerAt(s, x, y) < 0) {
          const p = s.powers[y * W + x];
          p.state = 1;
          p.type = t;
          p.frame = 0;
          p.revealedAt = 0;
          p.vis = 0;
          break;
        }
      }
    }
  }
}

function copyPower(s: GameState, from: number, to: number): void {
  Object.assign(s.powers[to], s.powers[from]);
}

function swapPower(s: GameState, a: number, b: number): void {
  const tmp = { ...s.powers[a] };
  Object.assign(s.powers[a], s.powers[b]);
  Object.assign(s.powers[b], tmp);
}

function clearPower(s: GameState, i: number): void {
  const p = s.powers[i];
  p.state = 0;
  p.type = 0;
  p.frame = 0;
  p.revealedAt = 0;
  p.vis = 0;
}

/** power_reveal_at @0x425107 */
export function powerRevealAt(s: GameState, cx: number, cy: number): void {
  if (rand(s.rng) % 30 === 0) { /* nop_hook: the rand() is consumed */ }
  if (!inBounds(cx, cy)) return;
  let i = cy * W + cx;
  const p = s.powers[i];
  if (!s.opts.netMode && elapsedSeconds(s) < val(s, 102)) {
    const t = p.type;
    if (t === P_PUNCH || t === P_GRAB || t === P_DISEASE3) {
      let done = false;
      for (let tries = 0; tries < 200 && !done; tries++) {
        const rx = rand(s.rng) % 15;
        const ry = rand(s.rng) % 11;
        const j = ry * W + rx;
        if (mapGet(s, rx, ry) === MAP_BRICK && powerAt(s, rx, ry) >= 0) {
          const ot = s.powers[j].type;
          if (ot !== P_PUNCH && ot !== P_GRAB && ot !== P_DISEASE3) {
            swapPower(s, i, j);
            done = true;
          }
        }
      }
      if (!done) {
        for (let tries = 0; tries < 200; tries++) {
          const rx = rand(s.rng) % 15;
          const ry = rand(s.rng) % 11;
          if (mapGet(s, rx, ry) === MAP_BRICK && powerAt(s, rx, ry) < 0) {
            copyPower(s, i, ry * W + rx);
            s.powers[i].state = 0;
            return;
          }
        }
      }
    }
  }
  if (s.powers[i].state === 1) {
    s.powers[i].revealedAt = s.frameCounter;
    s.powers[i].state = 2;
  }
  void i;
}

/** time_elapsed_s(): total seconds minus remaining seconds as computed by the HUD clock. */
export function elapsedSeconds(s: GameState): number {
  return Math.ceil(s.elapsedMs / 1000);
}

/** power_spawn_visible_at */
export function powerSpawnVisibleAt(s: GameState, cx: number, cy: number, type: number): void {
  const p = s.powers[cy * W + cx];
  p.state = 2;
  p.type = type;
  p.frame = 0;
  p.vis = 0;
  p.revealedAt = s.frameCounter;
}

/** power_spawn_random_blank @0x4255b2 */
export function powerSpawnRandomBlank(s: GameState, type: number): void {
  if (type === P_CLOG) return;
  for (let outer = 0; outer < 100; outer++) {
    let tries = 100;
    let x = 0;
    let y = 0;
    do {
      x = rand(s.rng) % 15;
      y = rand(s.rng) % 11;
      tries--;
      if (tries <= 0) return;
    } while (mapGet(s, x, y) !== MAP_BLANK);
    if (bombAtCell(s, x, y) >= 0 || powerAt(s, x, y) >= 0 || playerAtCell(s, x, y) >= 0) continue;
    powerSpawnVisibleAt(s, x, y, type);
    return;
  }
}

/** power_update_draw @0x424f89 */
export function powersUpdate(s: GameState, ctx: FrameCtx): void {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = s.powers[y * W + x];
      if (p.state === 1 && mapGet(s, x, y) !== MAP_BRICK) p.state = 0;
      if (p.state === 2 && mapGet(s, x, y) === MAP_BLANK) {
        const seq = ctx.anims.find(`power ${POWER_NAMES[p.type]}`);
        p.vis++;
        if (seq >= 0) {
          const n = ctx.anims.states(seq);
          const ref = ctx.anims.ref(seq, p.frame % n);
          ctx.draw(ref.frame, cellCenterX(x), cellFeetY(y), 0);
        }
        p.frame = (p.frame + s.refTick) & 0xffff;
      }
    }
  }
}

/** Clear a start-area cell, relocating a hidden power-up under another brick (map_clear_cell_keep_power). */
export function mapClearCellKeepPower(s: GameState, cx: number, cy: number, v: number, setCell: (x: number, y: number, v: number) => void): void {
  if (!inBounds(cx, cy)) return;
  const i = cy * W + cx;
  if (s.powers[i].state !== 0) {
    for (let tries = 0; tries < 200; tries++) {
      const rx = rand(s.rng) % 15;
      const ry = rand(s.rng) % 11;
      if (mapGet(s, rx, ry) === MAP_BRICK && powerAt(s, rx, ry) < 0) {
        copyPower(s, i, ry * W + rx);
        clearPower(s, i);
        break;
      }
    }
  }
  setCell(cx, cy, v);
}

/** player_pickup_power @0x41e21e (followed by power_destroy by the caller). */
export function playerPickupPower(s: GameState, ctx: FrameCtx, p: Player, pwIdx: number): void {
  const pw = s.powers[pwIdx];
  let snd = -1;
  const curable = val(s, 124);
  const cure = Math.max(val(s, 125), 1);
  if (curable && rand(s.rng) % cure === 0) playerCureDiseases(s, p);
  let type = pw.type;
  let applied = true;
  for (;;) {
    let again = false;
    switch (type) {
      case P_BOMB: snd = 400; p.counts[0]++; break;
      case P_FLAME: snd = 400; p.counts[1]++; break;
      case P_DISEASE: playerGiveDisease(s, ctx, p, 1); break;
      case P_KICKER: snd = 400; p.counts[3]++; break;
      case P_SKATE: snd = 400; p.counts[4]++; break;
      case P_PUNCH: snd = 400; p.counts[5]++; playerDropExcess(s, p, P_TRIGGER); break;
      case P_GRAB: snd = 400; p.counts[6]++; playerDropExcess(s, p, P_SPOOGE); break;
      case P_SPOOGE: snd = 400; p.counts[7]++; playerDropExcess(s, p, P_GRAB); break;
      case P_GOLDFLAME: snd = 400; p.counts[8]++; break;
      case P_TRIGGER:
        p.triggerUsed = 0; snd = 400; p.counts[9]++;
        playerDropExcess(s, p, P_PUNCH);
        playerDropExcess(s, p, P_JELLY);
        break;
      case P_JELLY: snd = 135; p.counts[10]++; playerDropExcess(s, p, P_TRIGGER); break;
      case P_DISEASE3:
        playerGiveDisease(s, ctx, p, 1);
        playerGiveDisease(s, ctx, p, 0);
        playerGiveDisease(s, ctx, p, 0);
        break;
      case P_RANDOM: {
        let found = false;
        for (let tries = 0; tries < 200; tries++) {
          type = rand(s.rng) % 12;
          if (!s.opts.forbidden[type]) { found = true; break; }
        }
        if (found) again = true;
        else applied = false;
        break;
      }
    }
    if (!again) break;
  }
  void applied;
  pw.type = type;
  const lim = val(s, 550 + type);
  if (lim !== 0 && p.counts[type] > lim) p.counts[type] = lim;
  if (type !== P_DISEASE && type !== P_DISEASE3) {
    p.awesome++;
    if (p.awesome >= 7 && (p.awesome - 7) % 5 === 0) snd = 1400;
    if (p.awesome > 50) p.awesome = 7;
  }
  if (snd !== -1) ctx.sound(snd, p.x);
}

/** player_drop_excess @0x41e16a: give up power-ups above the starting count (they respawn elsewhere). */
export function playerDropExcess(s: GameState, p: Player, t: number): void {
  const start = val(s, 50 + t);
  if (powerIsExclusive(t)) {
    if (p.counts[t] > start) {
      powerSpawnRandomBlank(s, t);
      p.counts[t] = start;
    }
  } else {
    while (p.counts[t] > start) {
      powerSpawnRandomBlank(s, t);
      p.counts[t]--;
    }
  }
  if (t === P_TRIGGER && p.counts[P_TRIGGER] === 0) bombsUntrigger(s, p.index);
}

/** player_drop_all_powers @0x41dbfe (end of the death animation). */
export function playerDropAllPowers(s: GameState, p: Player): void {
  for (let t = 0; t <= 14; t++) {
    const start = val(s, 50 + t);
    if (powerIsExclusive(t)) {
      if (p.counts[t] > start) {
        powerSpawnRandomBlank(s, t);
        p.counts[t] = start;
      }
    } else {
      while (p.counts[t] > start) {
        powerSpawnRandomBlank(s, t);
        p.counts[t]--;
      }
    }
  }
}

/** Lose 1..3 power-ups when hit on the head (player_head_hit, local games). */
export function playerLosePowersOnHeadHit(s: GameState, p: Player): void {
  const n = (rand(s.rng) % Math.max(val(s, 671), 1)) + val(s, 670);
  for (let k = 0; k < n; k++) {
    for (let tries = 0; tries < 200; tries++) {
      const t = rand(s.rng) % 15;
      if (p.counts[t] > val(s, 50 + t)) {
        powerSpawnRandomBlank(s, t);
        p.counts[t]--;
        break;
      }
    }
  }
}
