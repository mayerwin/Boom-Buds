// Minimal 8-bit, single plane, RLE PCX decoder (the only kind the original game ships).

export interface Pcx {
  w: number;
  h: number;
  /** Palette indices, w*h. */
  pixels: Uint8Array;
  /** 256 * RGB, 8-bit components exactly as stored in the file. */
  palette: Uint8Array;
}

export function parsePcx(buf: Buffer): Pcx {
  if (buf[0] !== 10) throw new Error('not a PCX file');
  const enc = buf[2];
  const bpp = buf[3];
  const xmin = buf.readUInt16LE(4);
  const ymin = buf.readUInt16LE(6);
  const xmax = buf.readUInt16LE(8);
  const ymax = buf.readUInt16LE(10);
  const planes = buf[65];
  const bpl = buf.readUInt16LE(66);
  if (bpp !== 8 || planes !== 1) throw new Error(`unsupported PCX ${bpp}bpp x${planes}`);
  const w = xmax - xmin + 1;
  const h = ymax - ymin + 1;
  const pixels = new Uint8Array(w * h);
  let pos = 128;
  const line = new Uint8Array(bpl);
  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < bpl) {
      let c = buf[pos++];
      let cnt = 1;
      if (enc === 1 && (c & 0xc0) === 0xc0) {
        cnt = c & 0x3f;
        c = buf[pos++];
      }
      for (let k = 0; k < cnt && x < bpl; k++) line[x++] = c;
    }
    pixels.set(line.subarray(0, w), y * w);
  }
  let palette = new Uint8Array(768);
  if (buf.length >= 769 && buf[buf.length - 769] === 12) {
    palette = new Uint8Array(buf.subarray(buf.length - 768));
  }
  return { w, h, pixels, palette };
}
