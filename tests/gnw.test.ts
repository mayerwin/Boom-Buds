// GNW colour tables and widget metrics against the values measured from the original (docs/re/gnw-data.json).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { GnwColors, CpuFont, WinBuf } from '../src/ui/gnw.ts';
import type { Gfx } from '../src/engine/gfx.ts';
import { helpLines } from '../src/ui/helpViewer.ts';

const data = JSON.parse(readFileSync('docs/re/gnw-data.json', 'utf8'));
const fakeGfx = {
  lut555: new Uint8Array(readFileSync('public/data/lut555.bin')),
  gamePalette6: new Uint8Array(readFileSync('public/data/palette.bin')),
} as unknown as Gfx;
const fonts = JSON.parse(readFileSync('public/data/fonts.json', 'utf8'));

describe('GNW', () => {
  it('lighten table and window colours match the original', () => {
    const c = new GnwColors(fakeGfx);
    expect(Array.from(c.lightenMap)).toEqual(data.lighten);
    expect(c.wcolor).toEqual(data.wcolor);
    expect(c.black).toBe(data.black);
  });

  it('FONT6 metrics: widths and text_max', () => {
    const f = new CpuFont(fonts.font6);
    expect(f.widths.slice(0, data.font6.widths.length)).toEqual(data.font6.widths);
    expect(f.maxWidth()).toBe(data.font6.text_max);
  });

  it('lines: horizontal excludes the right end, vertical includes both ends', () => {
    const b = new WinBuf(10, 10);
    b.line(2, 5, 6, 5, 9);
    expect(Array.from(b.px.slice(50, 60))).toEqual([0, 0, 9, 9, 9, 9, 0, 0, 0, 0]);
    const v = new WinBuf(3, 10);
    v.line(1, 2, 1, 6, 7);
    const col = Array.from({ length: 10 }, (_, y) => v.px[y * 3 + 1]);
    expect(col).toEqual([0, 0, 7, 7, 7, 7, 7, 0, 0, 0]);
  });

  it('help files: tab expansion quirk and Ctrl-Z end of file', () => {
    expect(helpLines('a\tb\r\nend\x1aIGNORED')).toEqual(['a   b', 'end']);
    // after a TAB the column counter is one ahead of the output
    expect(helpLines('\t\tx')[0]).toBe('       x');
  });
});
