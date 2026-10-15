// Dev utility: convert a PCX to PNG (optionally crop/zoom). node tools/dev/pcx2png.ts in.pcx out.png [zoom] [x y w h]
import { readFileSync } from 'node:fs';
import { parsePcx } from '../lib/pcx.ts';
import { writeRgbaPng } from '../lib/png.ts';
const [inp, out, zs, xs, ys, ws, hs] = process.argv.slice(2);
const p = parsePcx(readFileSync(inp));
const z = Number(zs ?? 1);
const x0 = Number(xs ?? 0), y0 = Number(ys ?? 0), w = Number(ws ?? p.w), h = Number(hs ?? p.h);
const rgba = new Uint8Array(w * z * h * z * 4);
for (let y = 0; y < h * z; y++) for (let x = 0; x < w * z; x++) {
  const c = p.pixels[(y0 + Math.floor(y / z)) * p.w + x0 + Math.floor(x / z)];
  const o = (y * w * z + x) * 4;
  rgba[o] = p.palette[c * 3]; rgba[o + 1] = p.palette[c * 3 + 1]; rgba[o + 2] = p.palette[c * 3 + 2]; rgba[o + 3] = 255;
}
writeRgbaPng(out, w * z, h * z, rgba);
