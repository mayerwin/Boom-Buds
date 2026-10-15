// Parser for the GNW bitmap fonts (FONT0.FON, FONT1.FON, FONT6.FON).
// Header: u32 glyph count, u32 height, u32 spacing(?), 8 bytes unused,
// then glyph count * {u32 width, u32 offset}, then 1bpp glyph rows (MSB first, ceil(w/8) bytes per row).

export interface FonGlyph {
  w: number;
  /** One byte per pixel (0/1), h rows of w pixels. */
  bits: number[];
}

export interface Fon {
  count: number;
  height: number;
  spacing: number;
  glyphs: FonGlyph[];
}

export function parseFon(buf: Buffer): Fon {
  const count = buf.readUInt32LE(0);
  const height = buf.readUInt32LE(4);
  const spacing = buf.readUInt32LE(8);
  const tableStart = 20;
  const dataStart = tableStart + count * 8;
  const glyphs: FonGlyph[] = [];
  for (let i = 0; i < count; i++) {
    const w = buf.readUInt32LE(tableStart + i * 8);
    const off = buf.readUInt32LE(tableStart + i * 8 + 4);
    const bpr = (w + 7) >> 3;
    const bits: number[] = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < w; x++) {
        const byte = buf[dataStart + off + y * bpr + (x >> 3)];
        bits.push(byte & (0x80 >> (x & 7)) ? 1 : 0);
      }
    }
    glyphs.push({ w, bits });
  }
  return { count, height, spacing, glyphs };
}
