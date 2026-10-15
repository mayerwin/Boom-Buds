// Dev utility: render the GNW .FON fonts to PNG sheets for inspection.
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseFon } from '../lib/fon.ts';
import { writeRgbaPng } from '../lib/png.ts';

const src = process.argv[2] ?? 'C:/Games/BOMBERMAN';
const out = process.argv[3] ?? 'tmp/preview';
mkdirSync(out, { recursive: true });
for (const name of ['FONT0.FON', 'FONT1.FON', 'FONT6.FON']) {
  const fon = parseFon(readFileSync(join(src, name)));
  const cols = 16;
  const cell = 20;
  const rows = Math.ceil(fon.count / cols);
  const W = cols * cell * 2;
  const H = rows * (fon.height + 4) * 2;
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { rgba[i * 4] = 30; rgba[i * 4 + 1] = 30; rgba[i * 4 + 2] = 60; rgba[i * 4 + 3] = 255; }
  fon.glyphs.forEach((g, i) => {
    const gx = (i % cols) * cell;
    const gy = Math.floor(i / cols) * (fon.height + 4);
    for (let y = 0; y < fon.height; y++) for (let x = 0; x < g.w; x++) {
      if (!g.bits[y * g.w + x]) continue;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const p = ((gy + y) * 2 + dy) * W + (gx + x) * 2 + dx;
        rgba[p * 4] = 255; rgba[p * 4 + 1] = 255; rgba[p * 4 + 2] = 255;
      }
    }
  });
  writeRgbaPng(join(out, name + '.png'), W, H, rgba);
  console.log(name, fon.count, fon.height, fon.spacing, fon.glyphs.filter(g => g.w).length, 'non-empty');
}
