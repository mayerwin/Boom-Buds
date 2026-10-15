// Dev utility: render every PCX screen into a contact sheet.
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parsePcx } from '../lib/pcx.ts';
import { writeRgbaPng } from '../lib/png.ts';
const src = process.argv[2] ?? 'C:/Games/BOMBERMAN/DATA/RES';
const out = process.argv[3] ?? 'tmp/preview';
mkdirSync(out, { recursive: true });
const files = readdirSync(src).filter((f) => f.toLowerCase().endsWith('.pcx')).filter((f) => { const p = parsePcx(readFileSync(join(src, f))); return p.w === 640; });
const cols = 6, tw = 320, th = 240;
const rows = Math.ceil(files.length / cols);
const W = cols * tw, H = rows * (th + 12);
const rgba = new Uint8Array(W * H * 4);
files.forEach((f, i) => {
  const p = parsePcx(readFileSync(join(src, f)));
  const ox = (i % cols) * tw, oy = Math.floor(i / cols) * (th + 12);
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    const c = p.pixels[(y * 2) * p.w + x * 2];
    const o = ((oy + y) * W + ox + x) * 4;
    rgba[o] = p.palette[c * 3]; rgba[o + 1] = p.palette[c * 3 + 1]; rgba[o + 2] = p.palette[c * 3 + 2]; rgba[o + 3] = 255;
  }
  console.log(i, f);
});
writeRgbaPng(join(out, 'screens.png'), W, H, rgba);
