import { PNG } from 'pngjs';
import { writeFileSync } from 'node:fs';

/** Write an RGBA buffer to a PNG file. */
export function writeRgbaPng(path: string, w: number, h: number, rgba: Uint8Array): void {
  const png = new PNG({ width: w, height: h });
  png.data = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  writeFileSync(path, PNG.sync.write(png));
}

/** Write an indexed image (palette = 256*RGB 8-bit) to an RGBA PNG; index `transparent` (if >= 0) gets alpha 0. */
export function writeIndexedPng(path: string, w: number, h: number, idx: Uint8Array, palette: Uint8Array, transparent = -1): void {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const c = idx[i];
    rgba[i * 4] = palette[c * 3];
    rgba[i * 4 + 1] = palette[c * 3 + 1];
    rgba[i * 4 + 2] = palette[c * 3 + 2];
    rgba[i * 4 + 3] = c === transparent ? 0 : 255;
  }
  writeRgbaPng(path, w, h, rgba);
}

export function readPng(buf: Buffer): { w: number; h: number; rgba: Uint8Array } {
  const png = PNG.sync.read(buf);
  return { w: png.width, h: png.height, rgba: new Uint8Array(png.data) };
}
