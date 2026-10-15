// Generates the PWA / favicon icons from the game's own sprites (a bomb next to a bud's head).
import { readFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { writeRgbaPng } from './lib/png.ts';

const DATA = 'public/data';
const sprites = JSON.parse(readFileSync(`${DATA}/sprites/sprites.json`, 'utf8'));
const pal6 = readFileSync(`${DATA}/palette.bin`);
const pages = Array.from({ length: sprites.pages }, (_, i) => gunzipSync(readFileSync(`${DATA}/sprites/atlas${i}.bin.gz`)));
const rmp = readFileSync(`${DATA}/remap.bin`);
const S = sprites.pageSize;

function frameOf(seq: string, state = 0): number {
  return sprites.seqs[seq][state][0][0];
}

function render(size: number, out: string): void {
  const rgba = new Uint8Array(size * size * 4);
  // background: dark radial-ish fill using palette black and a deep blue
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (x - size / 2) / size, dy = (y - size / 2) / size;
    const d = Math.min(1, Math.sqrt(dx * dx + dy * dy) * 1.6);
    const o = (y * size + x) * 4;
    rgba[o] = Math.round(30 * (1 - d) + 8);
    rgba[o + 1] = Math.round(24 * (1 - d) + 6);
    rgba[o + 2] = Math.round(90 * (1 - d) + 20);
    rgba[o + 3] = 255;
  }
  const blit = (frame: number, cx: number, cy: number, scale: number, remap: number) => {
    const [page, fx, fy, w, h, hx, hy] = sprites.frames[frame];
    for (let y = 0; y < h * scale; y++) for (let x = 0; x < w * scale; x++) {
      let c = pages[page][(fy + Math.floor(y / scale)) * S + fx + Math.floor(x / scale)];
      if (!c) continue;
      if (remap >= 0) c = rmp[remap * 259 + c] || c;
      const px = Math.round(cx - hx * scale + x), py = Math.round(cy - hy * scale + y);
      if (px < 0 || py < 0 || px >= size || py >= size) continue;
      const o = (py * size + px) * 4;
      rgba[o] = (pal6[c * 3] & 63) << 2; rgba[o + 1] = (pal6[c * 3 + 1] & 63) << 2; rgba[o + 2] = (pal6[c * 3 + 2] & 63) << 2;
    }
  };
  const scale = size / 64;
  blit(frameOf('stand south'), size * 0.5, size * 0.92, scale * 0.95, 0);
  writeRgbaPng(out, size, size, rgba);
}

mkdirSync('public/icons', { recursive: true });
render(192, 'public/icons/icon-192.png');
render(512, 'public/icons/icon-512.png');
render(64, 'public/favicon.png');
console.log('icons written');
