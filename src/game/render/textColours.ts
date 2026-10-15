// Text colours as the original computes them: palette indices looked up in COLOR.PAL's RGB555 table.
// player_text_color (0x41672f): colorTable[min(R/3,31)<<10 | min(G/3,31)<<5 | min(B/3,31)] from the
// percentages stored at the end of N.RMP; team play: team 0 white (0x7fff), team 1 light red (0x7d4a).
// player_text_outline_color (0x416867): black, except white for player 1 (the black bomber) outside team play.

import type { Gfx } from '../../engine/gfx.ts';

export interface TextColours {
  /** [fg, outline] palette indices for player i (team = -1 outside team play) */
  player(i: number, team: number): [number, number];
  /** the modern score lines: player i's colour on a black outline (dark grey for the black bomber) */
  hud(i: number): number;
  rgb(r5: number, g5: number, b5: number): number;
  white: number;
  black: number;
  yellow: number;
  darkRed: number;
  cyan: number;
  lightRed: number;
  grey: number;
}

export function textColours(gfx: Gfx): TextColours {
  const lut = gfx.lut555;
  const rgb = (r: number, g: number, b: number) => lut[(r << 10) | (g << 5) | b];
  const playerFg: number[] = [];
  for (let i = 0; i < 10; i++) {
    const base = i * 259 + 256;
    const R = gfx.rmp[base], G = gfx.rmp[base + 1], B = gfx.rmp[base + 2];
    playerFg.push(rgb(Math.min(Math.trunc(R / 3), 31), Math.min(Math.trunc(G / 3), 31), Math.min(Math.trunc(B / 3), 31)));
  }
  const white = rgb(31, 31, 31);
  const black = lut[0];
  return {
    player(i, team) {
      if (team >= 0) return [team === 0 ? white : rgb(31, 10, 10), black];
      return [playerFg[i], i === 1 ? white : black];
    },
    hud(i) {
      return i === 1 ? rgb(13, 13, 13) : playerFg[i];
    },
    rgb,
    white,
    black,
    yellow: rgb(31, 31, 10),
    darkRed: rgb(20, 0, 0),
    cyan: rgb(10, 31, 31),
    lightRed: rgb(31, 10, 10),
    grey: rgb(20, 20, 20),
  };
}
