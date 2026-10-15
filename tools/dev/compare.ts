// Dev utility: pixel comparison of web screenshots against captures of the original game.
//   node tools/dev/compare.ts <spec.json> [outdir]
// spec: [{ "name", "ref": "path.png", "web": "path.png", "rect": [x,y,w,h]?, "masks": [[x,y,w,h], ...]? }]
// Prints the number of differing pixels per case (inside `rect`, outside `masks`) and writes
// <outdir>/<name>_diff.png (differences in red over a darkened reference).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { PNG } from 'pngjs';

interface Case {
  name: string;
  ref: string;
  web: string;
  rect?: [number, number, number, number];
  masks?: [number, number, number, number][];
}

const [specPath, outDir = 'tmp/compare'] = process.argv.slice(2);
const cases: Case[] = JSON.parse(readFileSync(specPath, 'utf8'));
// paths in the spec are relative to the spec file
const base = dirname(resolve(specPath));
for (const c of cases) {
  c.ref = resolve(base, c.ref);
  c.web = resolve(base, c.web);
}
mkdirSync(outDir, { recursive: true });
let total = 0;
for (const c of cases) {
  const a = PNG.sync.read(readFileSync(c.ref));
  const b = PNG.sync.read(readFileSync(c.web));
  if (a.width !== b.width || a.height !== b.height) {
    console.log(`${c.name}: size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}`);
    continue;
  }
  const [rx, ry, rw, rh] = c.rect ?? [0, 0, a.width, a.height];
  const out = new PNG({ width: a.width, height: a.height });
  let diff = 0;
  let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * 4;
      const inRect = x >= rx && y >= ry && x < rx + rw && y < ry + rh;
      const masked = (c.masks ?? []).some(([mx, my, mw, mh]) => x >= mx && y >= my && x < mx + mw && y < my + mh);
      const same = a.data[i] === b.data[i] && a.data[i + 1] === b.data[i + 1] && a.data[i + 2] === b.data[i + 2];
      if (inRect && !masked && !same) {
        diff++;
        minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        out.data[i] = 255; out.data[i + 1] = 0; out.data[i + 2] = 0;
      } else {
        const k = inRect && !masked ? 0.5 : 0.2;
        out.data[i] = a.data[i] * k; out.data[i + 1] = a.data[i + 1] * k; out.data[i + 2] = a.data[i + 2] * k;
      }
      out.data[i + 3] = 255;
    }
  }
  total += diff;
  writeFileSync(join(outDir, `${c.name}_diff.png`), PNG.sync.write(out));
  console.log(`${c.name}: ${diff} differing px${diff ? ` in [${minX},${minY}]-[${maxX},${maxY}]` : ''}`);
}
console.log(`total: ${total}`);
