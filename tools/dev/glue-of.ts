// Dev utility: which GLUE picture is the background of a screenshot (for comparisons with captures).
//   node tools/dev/glue-of.ts <png>...
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { PNG } from 'pngjs';

const pal = readFileSync('public/data/palette.bin');
const glues = Array.from({ length: 7 }, (_, k) => gunzipSync(readFileSync(`public/data/screens/GLUE${k}.bin.gz`)));
for (const file of process.argv.slice(2)) {
  const img = PNG.sync.read(readFileSync(file));
  const scores = glues.map((g) => {
    let n = 0;
    for (let i = 0; i < 640 * 480; i += 7) {
      const c = g[i];
      const r = (pal[c * 3] & 63) << 2, gg = (pal[c * 3 + 1] & 63) << 2, b = (pal[c * 3 + 2] & 63) << 2;
      if (c === 0 ? img.data[i * 4] === 0 && img.data[i * 4 + 1] === 0 && img.data[i * 4 + 2] === 0 : img.data[i * 4] === r && img.data[i * 4 + 1] === gg && img.data[i * 4 + 2] === b) n++;
    }
    return n;
  });
  const best = scores.indexOf(Math.max(...scores));
  console.log(`${file}\t${best}\t${(scores[best] / (640 * 480 / 7) * 100).toFixed(1)}%`);
}
