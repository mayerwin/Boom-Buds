// Text output exactly like the original's helpers on top of the GNW font code (FONT6.FON is the only font
// the game ever selects), see docs/re/screens.md §0.4 and docs/re/graphics.md §6.

import type { Gfx } from '../engine/gfx.ts';

export const FONT = 'font6';

/** GNW text_to_buf width rule: whole glyphs only, stop at the first glyph that does not fit in `maxw`. */
export function clipText(gfx: Gfx, s: string, maxw: number): string {
  const f = gfx.fonts[FONT];
  let w = 0;
  let i = 0;
  for (; i < s.length; i++) {
    const g = f.glyphs[s.charCodeAt(i) & 0xff];
    const cw = g ? g.w + f.spacing : 0;
    if (w + cw > maxw) break;
    w += cw;
  }
  return i === s.length ? s : s.slice(0, i);
}

export function textWidth(gfx: Gfx, s: string): number {
  return gfx.textWidth(FONT, s);
}

/**
 * graf_print (0x41696c): the text is clipped to min(textWidth, w) pixels, drawn in `outline` at the four
 * diagonal offsets (0,0) (2,2) (0,2) (2,0) and in `fg` at (1,1) of a box whose top-left is (x, y).
 */
export function grafPrint(gfx: Gfx, s: string, w: number, x: number, y: number, fg: number, outline: number): void {
  const str = clipText(gfx, s, w);
  if (!str) return;
  gfx.drawText(FONT, str, x, y, outline);
  gfx.drawText(FONT, str, x + 2, y + 2, outline);
  gfx.drawText(FONT, str, x, y + 2, outline);
  gfx.drawText(FONT, str, x + 2, y, outline);
  gfx.drawText(FONT, str, x + 1, y + 1, fg);
}

/** graf_print_centered (0x4172ba): box x = cx - (textWidth + 2) / 2. */
export function grafPrintCentered(gfx: Gfx, s: string, cx: number, y: number, fg: number, outline: number): void {
  const tw = textWidth(gfx, s);
  grafPrint(gfx, s, tw + 2, cx - Math.trunc((tw + 2) / 2), y, fg, outline);
}

/** Plain GNW text (no outline), clipped to `maxw`; `shadow` draws a copy at (+1,+1) first (font flag 0x10000). */
export function gnwText(gfx: Gfx, s: string, maxw: number, x: number, y: number, color: number, shadow = -1): void {
  const str = clipText(gfx, s, maxw);
  if (!str) return;
  if (shadow >= 0) gfx.drawText(FONT, str, x + 1, y + 1, shadow);
  gfx.drawText(FONT, str, x, y, color);
}

/** C printf subset used by MESSAGES.TXT: %s %d %u %c %02u %6.3f etc. */
export function sprintf(fmt: string, ...args: (string | number)[]): string {
  let ai = 0;
  return fmt.replace(/%([-0 ]?)(\d*)(?:\.(\d+))?([sducxf%])/g, (_m, flag: string, width: string, prec: string, conv: string) => {
    if (conv === '%') return '%';
    const a = args[ai++];
    let out: string;
    switch (conv) {
      case 's': out = String(a ?? ''); break;
      case 'c': out = typeof a === 'number' ? String.fromCharCode(a) : String(a ?? '').charAt(0); break;
      case 'f': out = Number(a ?? 0).toFixed(prec ? Number(prec) : 6); break;
      case 'x': out = (Number(a ?? 0) >>> 0).toString(16); break;
      case 'u': out = String(Number(a ?? 0) >>> 0); break;
      default: out = String(Math.trunc(Number(a ?? 0)));
    }
    const wd = width ? Number(width) : 0;
    if (out.length < wd) {
      if (flag === '-') out = out.padEnd(wd, ' ');
      else if (flag === '0' && conv !== 's') out = out.startsWith('-') ? '-' + out.slice(1).padStart(wd - 1, '0') : out.padStart(wd, '0');
      else out = out.padStart(wd, ' ');
    }
    return out;
  });
}
