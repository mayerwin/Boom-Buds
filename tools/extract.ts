// Boom Buds asset pipeline: converts the original game's data files into web-friendly assets.
//
//   node tools/extract.ts [--src C:/Games/BOMBERMAN] [--out public/data] [--skip-audio] [--only sprites,screens,...]
//                         [--no-brand]   (pictures as in the original game, for comparisons with its captures)
//
// Sprites are quantized to the game palette exactly like the original does at load time (RGB555 ->
// palette index through the lookup table stored in COLOR.PAL), cropped and packed into 8-bit atlas pages.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { parseAni } from './lib/ani.ts';
import { parsePcx } from './lib/pcx.ts';
import { parseFon } from './lib/fon.ts';
import { readPng } from './lib/png.ts';
import { packRects } from './lib/pack.ts';
import { parseValueList, parseSoundList, parseMessages, parseScheme, parseExtras, parseCampaign } from './lib/textdata.ts';
import { rebrandHelp, rebrandMessages, findOriginalBrand, SCHEME_NAME_OVERRIDES } from './lib/rebrand.ts';

const args = process.argv.slice(2);
function opt(name: string, def: string): string {
  const i = args.indexOf('--' + name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}
const SRC = opt('src', 'C:/Games/BOMBERMAN');
const OUT = opt('out', 'public/data');
const SKIP_AUDIO = args.includes('--skip-audio');
const NO_BRAND = args.includes('--no-brand');
const ONLY = opt('only', '').split(',').filter(Boolean);
const want = (step: string) => ONLY.length === 0 || ONLY.includes(step);

const PAGE = 2048;

function findFile(dir: string, name: string): string {
  const want = name.toLowerCase();
  for (const f of readdirSync(dir)) if (f.toLowerCase() === want) return join(dir, f);
  throw new Error(`missing ${name} in ${dir}`);
}

function listFiles(dir: string, ext: string): string[] {
  return readdirSync(dir).filter((f) => extname(f).toLowerCase() === ext).sort();
}

function ensureDir(d: string): void {
  mkdirSync(d, { recursive: true });
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data));
}

function writeGz(path: string, data: Uint8Array): void {
  writeFileSync(path, gzipSync(data, { level: 9 }));
}

const RES = join(SRC, 'DATA', 'RES');
const ANI = join(SRC, 'DATA', 'ANI');
const SND = join(SRC, 'DATA', 'SOUND');
const SCH = join(SRC, 'DATA', 'SCHEMES');

ensureDir(OUT);

// ---------------------------------------------------------------- palette + lookup table
const colorPal = readFileSync(findFile(SRC, 'COLOR.PAL'));
const gamePal6 = new Uint8Array(colorPal.subarray(0, 768));
const lut = new Uint8Array(colorPal.subarray(768, 768 + 32768));

function step(name: string, fn: () => void): void {
  if (!want(name)) return;
  const t = Date.now();
  fn();
  console.log(`[${name}] done in ${((Date.now() - t) / 1000).toFixed(1)}s`);
}

step('palette', () => {
  writeFileSync(join(OUT, 'palette.bin'), gamePal6);
  writeFileSync(join(OUT, 'lut555.bin'), lut);
  const remaps: number[] = [];
  const rmp = new Uint8Array(10 * 259);
  for (let i = 0; i < 10; i++) {
    const p = join(SRC, `${i}.RMP`);
    if (existsSync(p)) rmp.set(readFileSync(p).subarray(0, 259), i * 259);
    remaps.push(i);
  }
  writeFileSync(join(OUT, 'remap.bin'), rmp);
});

// ---------------------------------------------------------------- sprites
step('sprites', () => {
  const master = readFileSync(join(ANI, 'MASTER.ALI'), 'latin1');
  const aniFiles: string[] = [];
  for (const raw of master.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('-')) aniFiles.push(line.slice(1).trim().toUpperCase());
  }
  interface Frame { file: string; name: string; w: number; h: number; hx: number; hy: number; px: Uint8Array; }
  const frames: Frame[] = [];
  const seqs: Record<string, [number, number, number][][]> = {};
  const files: Record<string, string[]> = {};
  let cropped = 0;
  for (const f of aniFiles) {
    const ani = parseAni(readFileSync(findFile(ANI, f)));
    const base = frames.length;
    for (const fr of ani.frames) {
      const img = fr.image;
      if (!img) { frames.push({ file: f, name: fr.name, w: 0, h: 0, hx: 0, hy: 0, px: new Uint8Array(0) }); continue; }
      const { w, h } = img;
      const idx = new Uint8Array(w * h);
      for (let k = 0; k < w * h; k++) {
        if (img.transparent[k]) { idx[k] = 0; continue; }
        if (img.type === 4) {
          idx[k] = lut[img.pixels[k] & 0x7fff];
        } else {
          // 8-bit frame with its own BGRA palette: convert through RGB555 like the game would
          const c = img.pixels[k];
          const b = img.palette![c * 4], g = img.palette![c * 4 + 1], r = img.palette![c * 4 + 2];
          idx[k] = lut[((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)];
        }
      }
      // crop transparent borders, except exactly 40x36 frames (tiles), like ani_crop_frame in the original
      if (w === 40 && h === 36) {
        frames.push({ file: f, name: fr.name, w, h, hx: img.hotX, hy: img.hotY, px: idx });
        continue;
      }
      let x0 = w, y0 = h, x1 = -1, y1 = -1;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (idx[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
      if (x1 < 0) { frames.push({ file: f, name: fr.name, w: 0, h: 0, hx: img.hotX, hy: img.hotY, px: new Uint8Array(0) }); continue; }
      const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
      const px = new Uint8Array(cw * ch);
      for (let y = 0; y < ch; y++) px.set(idx.subarray((y + y0) * w + x0, (y + y0) * w + x0 + cw), y * cw);
      cropped += w * h - cw * ch;
      // hotspot relative to the cropped rect
      frames.push({ file: f, name: fr.name, w: cw, h: ch, hx: img.hotX - x0, hy: img.hotY - y0, px });
    }
    files[f] = [];
    for (const s of ani.seqs) {
      const states = s.states.map((st) => st.frames.map((r) => [base + r.frame, r.x, r.y] as [number, number, number]));
      if (seqs[s.name]) console.warn(`duplicate sequence name '${s.name}' in ${f}`);
      seqs[s.name] = states;
      files[f].push(s.name);
    }
  }
  const rects = frames.map((fr, id) => ({ id, w: fr.w, h: fr.h })).filter((r) => r.w > 0);
  const { placements, pages } = packRects(rects, PAGE, PAGE, 1);
  const pageData = Array.from({ length: pages }, () => new Uint8Array(PAGE * PAGE));
  const table: number[][] = frames.map((fr) => [0, 0, 0, 0, 0, fr.hx, fr.hy]);
  for (const p of placements) {
    const fr = frames[p.id];
    for (let y = 0; y < fr.h; y++) pageData[p.page].set(fr.px.subarray(y * fr.w, (y + 1) * fr.w), (p.y + y) * PAGE + p.x);
    table[p.id] = [p.page, p.x, p.y, fr.w, fr.h, fr.hx, fr.hy];
  }
  const dir = join(OUT, 'sprites');
  ensureDir(dir);
  pageData.forEach((d, i) => writeGz(join(dir, `atlas${i}.bin.gz`), d));
  writeJson(join(dir, 'sprites.json'), {
    pageSize: PAGE,
    pages,
    frames: table,
    frameNames: frames.map((f) => f.file + ':' + f.name),
    seqs,
    files,
  });
  const used = rects.reduce((a, r) => a + r.w * r.h, 0);
  console.log(`  ${frames.length} frames, ${Object.keys(seqs).length} sequences, ${pages} pages, fill ${(100 * used / (pages * PAGE * PAGE)).toFixed(1)}%, cropped ${cropped} px`);
});

// ---------------------------------------------------------------- screens (PCX)
step('screens', () => {
  const dir = join(OUT, 'screens');
  ensureDir(dir);
  // Only the full-screen "picture screens" keep their own palette (show_picture_wait); every other picture
  // is remapped to the game palette at load time: index 0 -> 0, i -> colorTable[RGB555(palette[i])].
  const OWN = /^(IPLOGO|HSLOGO|TITLE|DRAW|VICTORY\d|TEAM\d)$/;
  const index: Record<string, { w: number; h: number; ownPalette: boolean }> = {};
  const pcxFiles = listFiles(RES, '.pcx').map((f) => join(RES, f));
  for (const p of pcxFiles) {
    if (!existsSync(p)) continue;
    const name = basename(p, extname(p)).toUpperCase();
    const pcx = parsePcx(readFileSync(p));
    const own = OWN.test(name);
    let pixels = pcx.pixels;
    // Boom Buds artwork: tools/brand/<NAME>.png replaces the picture (same size, drawn with the picture's
    // own palette, so it goes through exactly the same palette handling as the original)
    const brand = join('tools', 'brand', `${name}.png`);
    if (existsSync(brand) && !NO_BRAND) {
      pixels = brandIndices(brand, pcx.w, pcx.h, pcx.palette);
      console.log(`  ${name}: Boom Buds artwork`);
    }
    if (!own) {
      const map = new Uint8Array(256);
      for (let i = 1; i < 256; i++) {
        const r = pcx.palette[i * 3], g = pcx.palette[i * 3 + 1], b = pcx.palette[i * 3 + 2];
        map[i] = lut[((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)];
      }
      const src = pixels;
      pixels = new Uint8Array(src.length);
      for (let k = 0; k < pixels.length; k++) pixels[k] = map[src[k]];
    }
    writeGz(join(dir, `${name}.bin.gz`), pixels);
    writeFileSync(join(dir, `${name}.pal`), pcx.palette);
    index[name] = { w: pcx.w, h: pcx.h, ownPalette: own };
  }
  writeJson(join(dir, 'index.json'), index);
  console.log(`  ${Object.keys(index).length} images`);
});

/** Palette indices of a branding PNG drawn with the palette `pal` (exact colour match, first index wins). */
function brandIndices(path: string, w: number, h: number, pal: Uint8Array): Uint8Array {
  const img = readPng(readFileSync(path));
  if (img.w !== w || img.h !== h) throw new Error(`${path}: expected ${w}x${h}, got ${img.w}x${img.h}`);
  const lookup = new Map<number, number>();
  for (let i = 255; i >= 0; i--) lookup.set((pal[i * 3] << 16) | (pal[i * 3 + 1] << 8) | pal[i * 3 + 2], i);
  const out = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) {
    const rgb = (img.rgba[k * 4] << 16) | (img.rgba[k * 4 + 1] << 8) | img.rgba[k * 4 + 2];
    const i = lookup.get(rgb);
    if (i === undefined) throw new Error(`${path}: colour #${rgb.toString(16).padStart(6, '0')} at (${k % w},${Math.floor(k / w)}) is not in the palette`);
    out[k] = i;
  }
  return out;
}

// ---------------------------------------------------------------- fonts
step('fonts', () => {
  const out: Record<string, unknown> = {};
  for (const f of ['FONT0.FON', 'FONT1.FON', 'FONT6.FON']) {
    const p = join(SRC, f);
    if (!existsSync(p)) continue;
    const fon = parseFon(readFileSync(p));
    out[f.replace('.FON', '').toLowerCase()] = {
      height: fon.height,
      spacing: fon.spacing,
      glyphs: fon.glyphs.map((g) => ({ w: g.w, bits: g.bits.join('') })),
    };
  }
  writeJson(join(OUT, 'fonts.json'), out);
});

// ---------------------------------------------------------------- text resources
step('text', () => {
  const values = parseValueList(readFileSync(join(RES, 'VALUELST.RES'), 'latin1'));
  const sounds = parseSoundList(readFileSync(join(RES, 'SOUNDLST.RES'), 'latin1'));
  const messages = rebrandMessages(parseMessages(readFileSync(findFile(SRC, 'MESSAGES.TXT'), 'latin1')));
  const schemes = listFiles(SCH, '.sch').map((f) => parseScheme(f.toUpperCase(), readFileSync(join(SCH, f), 'latin1')));
  for (const sc of schemes) if (SCHEME_NAME_OVERRIDES[sc.file]) sc.name = SCHEME_NAME_OVERRIDES[sc.file];
  const extras: Record<number, ReturnType<typeof parseExtras>> = {};
  for (const f of listFiles(RES, '.res')) {
    const m = /^EXTRA(\d+)\.RES$/i.exec(f);
    if (m) extras[Number(m[1])] = parseExtras(readFileSync(join(RES, f), 'latin1'));
  }
  const campaigns: Record<string, ReturnType<typeof parseCampaign>> = {};
  for (const f of listFiles(RES, '.cam')) campaigns[f.toUpperCase()] = parseCampaign(readFileSync(join(RES, f), 'latin1'));
  // online manual: rebranded, README.BM / NETWORK.BM rewritten for the web version (tools/brand/help)
  const help: Record<string, string> = {};
  for (const f of listFiles(SRC, '.bm')) {
    const name = f.toUpperCase();
    const override = join('tools', 'brand', 'help', name);
    help[name] = existsSync(override)
      ? readFileSync(override, 'latin1').replace(/\r?\n/g, '\r\n')
      : rebrandHelp(name, readFileSync(join(SRC, f), 'latin1'));
    for (const line of findOriginalBrand(help[name])) console.warn(`  note: ${name} still mentions: ${line.trim()}`);
  }
  writeJson(join(OUT, 'text.json'), { values, sounds, messages, schemes, extras, campaigns, help });
  console.log(`  ${Object.keys(values).length} values, ${Object.keys(sounds).length} sounds, ${Object.keys(messages).length} messages, ${schemes.length} schemes`);
});

// ---------------------------------------------------------------- audio
step('audio', () => {
  if (SKIP_AUDIO) { console.log('  skipped'); return; }
  const sounds = parseSoundList(readFileSync(join(RES, 'SOUNDLST.RES'), 'latin1'));
  const names = new Set<string>();
  for (const n of Object.values(sounds)) if (n !== 'xxx' && n !== '0') names.add(n.toUpperCase());
  const dir = join(OUT, 'audio');
  ensureDir(dir);
  const manifest: Record<string, { file: string; samples: number }> = {};
  const isMusic = (n: string) => ['TITLE', 'MENU', 'WIN', 'LOSE', 'NETWORK', 'DRAW', 'GRNACRES', 'GENERIC', 'HOCKEY', 'PYRAMID',
    'MINESHFT', 'BATTLE', 'GIEGER', 'HAUNTED', 'OCEAN', 'SWAMP', 'SEWER'].includes(n);
  let done = 0;
  for (const n of [...names].sort()) {
    let src: string;
    try { src = findFile(SND, n + '.RSS'); } catch { console.warn(`  missing sound ${n}`); continue; }
    const bytes = statSync(src).size;
    const samples = Math.floor(bytes / 4);
    const outFile = `${n.toLowerCase()}.ogg`;
    const dst = join(dir, outFile);
    if (!existsSync(dst) || statSync(dst).mtimeMs < statSync(src).mtimeMs) {
      const bitrate = isMusic(n) ? '96k' : '64k';
      const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 's16le', '-ar', '22050', '-ac', '2', '-i', src,
        '-c:a', 'libopus', '-b:a', bitrate, '-vbr', 'on', '-application', 'audio', dst], { stdio: 'inherit' });
      if (r.status !== 0) throw new Error(`ffmpeg failed for ${n}`);
    }
    manifest[n] = { file: outFile, samples };
    done++;
  }
  writeJson(join(dir, 'audio.json'), manifest);
  console.log(`  ${done} audio files`);
});
