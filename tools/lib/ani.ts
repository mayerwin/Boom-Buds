// Parser for the FREDIT ".ANI" animation container used by the original game.
//
// Layout: "CHFILEANI " signature, u32 length, u16 id, then a list of chunks:
//   sig[4] u32 length u16 id body[length]
// Top level chunks: HEAD, PAL, TPAL, CBOX, FRAM*, SEQ*.
//   FRAM -> HEAD, FNAM (frame file name), CIMG (image)
//   SEQ  -> HEAD (32 byte name + fields, u16 state count at +78), STAT*
//   STAT -> HEAD (i16 duration, -1 = same as previous), FRAM (u16 count, count * {u16 frame, i16 x, i16 y, i16, i16})
// CIMG: u16 type, u16 flags (bit 2 = use key color), u32 header size, u32 ?, u16 w, u16 h,
//       u16 hotspot x, u16 hotspot y, u16 key color, u16 ?, [palette block when header >= 32],
//       u16, u16, u32 compressed size (+12), u32 uncompressed size, RLE data.
// Type 4 images are 15-bit RGB (x1r5g5b5) with TGA style RLE, type 11 images are 8-bit with a BGRA palette.

export interface AniImage {
  type: number;
  flags: number;
  w: number;
  h: number;
  hotX: number;
  hotY: number;
  key: number;
  /** For type 4: RGB555 pixels. For type 11: palette indices. */
  pixels: Uint16Array;
  /** BGRA palette for type 11 images. */
  palette?: Uint8Array;
  /** Pixel is transparent mask (1 = transparent). */
  transparent: Uint8Array;
}

export interface AniFrame {
  name: string;
  image: AniImage | null;
}

export interface AniSeqFrameRef {
  frame: number;
  x: number;
  y: number;
}

export interface AniSeqState {
  duration: number;
  frames: AniSeqFrameRef[];
}

export interface AniSeq {
  name: string;
  states: AniSeqState[];
}

export interface AniFile {
  frames: AniFrame[];
  seqs: AniSeq[];
  cbox: [number, number] | null;
}

interface Chunk {
  sig: string;
  len: number;
  id: number;
  body: number;
}

function readChunks(buf: Buffer, start: number, end: number): Chunk[] {
  const out: Chunk[] = [];
  let pos = start;
  while (pos + 10 <= end) {
    const sig = buf.toString('latin1', pos, pos + 4);
    const len = buf.readUInt32LE(pos + 4);
    const id = buf.readUInt16LE(pos + 8);
    const body = pos + 10;
    out.push({ sig, len, id, body });
    pos = body + len;
  }
  return out;
}

function cstr(buf: Buffer, start: number, end: number): string {
  let e = start;
  while (e < end && buf[e] !== 0) e++;
  return buf.toString('latin1', start, e);
}

function decodeCimg(buf: Buffer, b: number): AniImage {
  const type = buf.readUInt16LE(b);
  const flags = buf.readUInt16LE(b + 2);
  const extra = buf.readUInt32LE(b + 4);
  const w = buf.readUInt16LE(b + 12);
  const h = buf.readUInt16LE(b + 14);
  const hotX = buf.readUInt16LE(b + 16);
  const hotY = buf.readUInt16LE(b + 18);
  const key = buf.readUInt16LE(b + 20);
  let pos = b + 24;
  let palette: Uint8Array | undefined;
  if (extra >= 32) {
    const palSize = extra - 32;
    pos += 8;
    palette = new Uint8Array(buf.subarray(pos, pos + palSize));
    pos += palSize;
  }
  const csize = buf.readUInt32LE(pos + 4) - 12;
  const usize = buf.readUInt32LE(pos + 8);
  pos += 12;
  const n = w * h;
  const pixels = new Uint16Array(n);
  const comp = buf.subarray(pos, pos + csize);
  let o = 0;
  let i = 0;
  if (type === 4) {
    while (o < n && i < comp.length) {
      const c = comp[i++];
      if (c & 0x80) {
        const cnt = (c & 0x7f) + 1;
        const v = comp[i] | (comp[i + 1] << 8);
        i += 2;
        for (let k = 0; k < cnt && o < n; k++) pixels[o++] = v;
      } else {
        const cnt = c + 1;
        for (let k = 0; k < cnt && o < n; k++) {
          pixels[o++] = comp[i] | (comp[i + 1] << 8);
          i += 2;
        }
      }
    }
  } else if (type === 11) {
    if (usize === csize) {
      for (let k = 0; k < n; k++) pixels[k] = comp[k];
    } else {
      while (o < n && i < comp.length) {
        const c = comp[i++];
        if (c & 0x80) {
          const cnt = (c & 0x7f) + 1;
          const v = comp[i++];
          for (let k = 0; k < cnt && o < n; k++) pixels[o++] = v;
        } else {
          const cnt = c + 1;
          for (let k = 0; k < cnt && o < n; k++) pixels[o++] = comp[i++];
        }
      }
    }
  } else {
    throw new Error(`unsupported CIMG type ${type}`);
  }
  const transparent = new Uint8Array(n);
  if (flags & 4) {
    for (let k = 0; k < n; k++) if (pixels[k] === key) transparent[k] = 1;
  }
  return { type, flags, w, h, hotX, hotY, key, pixels, palette, transparent };
}

export function parseAni(buf: Buffer): AniFile {
  if (buf.toString('latin1', 0, 10) !== 'CHFILEANI ') throw new Error('not an ANI file');
  const flen = buf.readUInt32LE(10);
  const top = readChunks(buf, 16, Math.min(buf.length, 16 + flen));
  const frames: AniFrame[] = [];
  const seqs: AniSeq[] = [];
  let cbox: [number, number] | null = null;
  for (const c of top) {
    if (c.sig === 'CBOX') {
      cbox = [buf.readUInt16LE(c.body), buf.readUInt16LE(c.body + 2)];
    } else if (c.sig === 'FRAM') {
      let name = '';
      let image: AniImage | null = null;
      for (const s of readChunks(buf, c.body, c.body + c.len)) {
        if (s.sig === 'FNAM') name = cstr(buf, s.body, s.body + s.len);
        else if (s.sig === 'CIMG') image = decodeCimg(buf, s.body);
      }
      frames.push({ name, image });
    } else if (c.sig === 'SEQ ') {
      let name = '';
      const states: AniSeqState[] = [];
      for (const s of readChunks(buf, c.body, c.body + c.len)) {
        if (s.sig === 'HEAD') {
          name = cstr(buf, s.body, s.body + Math.min(32, s.len));
        } else if (s.sig === 'STAT') {
          let duration = 0;
          const refs: AniSeqFrameRef[] = [];
          for (const t of readChunks(buf, s.body, s.body + s.len)) {
            if (t.sig === 'HEAD') {
              duration = buf.readInt16LE(t.body);
            } else if (t.sig === 'FRAM') {
              const cnt = buf.readUInt16LE(t.body);
              for (let k = 0; k < cnt; k++) {
                const off = t.body + 2 + k * 10;
                if (off + 6 > t.body + t.len) break;
                refs.push({ frame: buf.readUInt16LE(off), x: buf.readInt16LE(off + 2), y: buf.readInt16LE(off + 4) });
              }
            }
          }
          states.push({ duration, frames: refs });
        }
      }
      seqs.push({ name, states });
    }
  }
  return { frames, seqs, cbox };
}
