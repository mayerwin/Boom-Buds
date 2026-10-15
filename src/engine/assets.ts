// Loading of the generated asset bundle (public/data, produced by tools/extract.ts).

import dataHashes from 'virtual:boombuds-data';

const BASE = import.meta.env.BASE_URL + 'data/';

/**
 * URL of a data file. Production builds add the file's content hash (tools/build/versioning.ts), so the
 * browser's cache never serves an outdated file and keeps the unchanged ones.
 */
export function assetUrl(path: string): string {
  const v = dataHashes[path];
  return v ? `${BASE}${path}?v=${v}` : BASE + path;
}

async function fetchOk(path: string): Promise<Response> {
  const r = await fetch(assetUrl(path));
  if (!r.ok) throw new Error(`failed to load ${path}: ${r.status}`);
  return r;
}

export async function loadJson<T>(path: string): Promise<T> {
  return (await fetchOk(path)).json() as Promise<T>;
}

export async function loadBinary(path: string): Promise<Uint8Array> {
  return new Uint8Array(await (await fetchOk(path)).arrayBuffer());
}

/** Load a gzip-compressed binary using the native DecompressionStream; `progress(bytes, total)`. */
export async function loadGz(path: string, progress?: (got: number, total: number) => void): Promise<Uint8Array> {
  const r = await fetchOk(path);
  let buf: Uint8Array;
  const total = Number(r.headers.get('content-length') ?? 0);
  if (progress && r.body && total > 0) {
    const reader = r.body.getReader();
    const chunks: Uint8Array[] = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      progress(Math.min(got, total), total);
    }
    buf = new Uint8Array(got);
    let o = 0;
    for (const c of chunks) {
      buf.set(c, o);
      o += c.length;
    }
  } else {
    buf = new Uint8Array(await r.arrayBuffer());
    progress?.(1, 1);
  }
  // Some servers transparently serve .gz files with Content-Encoding: gzip; detect by magic bytes.
  if (buf.length < 2 || buf[0] !== 0x1f || buf[1] !== 0x8b) return buf;
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([buf as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface SpriteManifest {
  pageSize: number;
  pages: number;
  /** [page, x, y, w, h, hotX, hotY] */
  frames: number[][];
  frameNames: string[];
  /** seq name -> states -> [frame, dx, dy][] */
  seqs: Record<string, [number, number, number][][]>;
  files: Record<string, string[]>;
}

export interface FontJson {
  height: number;
  spacing: number;
  glyphs: { w: number; bits: string }[];
}

export interface Scheme {
  file: string;
  version: number;
  name: string;
  density: number;
  rows: string[];
  starts: [number, number, number][];
  powerups: { bornwith: number; hasOverride: number; override: number; forbidden: number }[];
}

export interface ExtraDef {
  kind: 'A' | 'W' | 'C' | 'T';
  args: string[];
}

export interface TextJson {
  values: Record<string, number[]>;
  sounds: Record<string, string>;
  messages: Record<string, string>;
  schemes: Scheme[];
  extras: Record<string, ExtraDef[]>;
  campaigns: Record<string, unknown[]>;
  help: Record<string, string>;
}

export interface ScreenIndex {
  [name: string]: { w: number; h: number; ownPalette: boolean };
}
