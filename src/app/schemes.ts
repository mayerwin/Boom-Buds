// Scheme files (DATA\SCHEMES\*.SCH): the original's text format, read like scheme_parse (0x403eee) and
// written like the level editor's scheme_save (0x403c16), plus the browser's stand-in for the scheme
// directory: schemes made or changed with the level editor live in localStorage and override the shipped
// ones with the same file name. docs/re/match-flow.md §4.1, docs/re/screens.md §19.

import type { App } from './App.ts';
import type { Scheme } from '../engine/assets.ts';
import { sprintf } from '../ui/text.ts';

export const SCHEME_W = 15;
export const SCHEME_H = 11;
export const SCHEME_PLAYERS = 10;
/** power-up types stored in a scheme (-P 0..12) */
export const SCHEME_POWERS = 13;

export const CELL_BLANK = 0;
export const CELL_SOLID = 1;
export const CELL_BRICK = 2;

const STORE_KEY = 'boombuds.schemes.v1';

/** scheme_basic_grid's rows (0x458406 even rows, 0x4583f6 odd rows) and name (0x4583e3) */
const ROW_EVEN = ':::::::::::::::';
const ROW_ODD = ':#:#:#:#:#:#:#:';
const BASIC_NAME = 'Basic grid pattern';

/** Flat VALUELST (App.values): lines with several values fill consecutive ids. */
type Values = ArrayLike<number>;

/** (line1, line2) message ids of a msgbox_ok warning raised while parsing */
export type SchemeWarn = (line1: number, line2: number) => void;

/** C atoi: optional blanks, sign and digits; 0 when there are none. */
export function atoi(s: string | undefined): number {
  const m = /^[ \t\n\v\f\r]*([+-]?\d+)/.exec(s ?? '');
  return m ? Number(m[1]) | 0 : 0;
}

/** Default start of player i: V(600+2i), V(601+2i) wrapped into the field. */
function defaultStart(values: Values, i: number): [number, number] {
  let x = values[600 + 2 * i] ?? 0;
  let y = values[601 + 2 * i] ?? 0;
  while (x < 0) x += SCHEME_W;
  while (x >= SCHEME_W) x -= SCHEME_W;
  while (y < 0) y += SCHEME_H;
  while (y >= SCHEME_H) y -= SCHEME_H;
  return [x, y];
}

function emptyPowerups(): Scheme['powerups'] {
  return Array.from({ length: SCHEME_POWERS }, () => ({ bornwith: 0, hasOverride: 0, override: 0, forbidden: 0 }));
}

/**
 * scheme_basic_grid (0x4049c0): name "Basic grid pattern", density 90, bricks everywhere with solid
 * blocks on odd rows and columns, the VALUELST start positions with teams alternating 0/1, empty
 * power-up table.
 */
export function basicGrid(file: string, values: Values): Scheme {
  return {
    file,
    version: 2,
    name: BASIC_NAME,
    density: 90,
    rows: Array.from({ length: SCHEME_H }, (_, y) => (y & 1 ? ROW_ODD : ROW_EVEN)),
    starts: Array.from({ length: SCHEME_PLAYERS }, (_, i) => [...defaultStart(values, i), i & 1] as [number, number, number]),
    powerups: emptyPowerups(),
  };
}

/** Replace the contents of `s` with the basic grid (Ctrl-B in the editor), keeping the file name. */
export function resetToBasicGrid(s: Scheme, values: Values): void {
  const b = basicGrid(s.file, values);
  s.name = b.name;
  s.density = b.density;
  s.rows = b.rows;
  s.starts = b.starts;
  s.powerups = b.powerups;
}

/** scheme_get_cell (0x404852): ':' brick, '#' solid, anything else blank; outside the field = solid. */
export function schemeCell(s: Scheme, x: number, y: number): number {
  if (x < 0 || x >= SCHEME_W || y < 0 || y >= SCHEME_H) return CELL_SOLID;
  const ch = (s.rows[y] ?? '')[x];
  return ch === ':' ? CELL_BRICK : ch === '#' ? CELL_SOLID : CELL_BLANK;
}

/** scheme_set_cell (0x4048eb): cells outside the field are ignored. */
export function setSchemeCell(s: Scheme, x: number, y: number, type: number): void {
  if (x < 0 || x >= SCHEME_W || y < 0 || y >= SCHEME_H) return;
  const ch = type === CELL_SOLID ? '#' : type === CELL_BRICK ? ':' : '.';
  const row = (s.rows[y] ?? '').padEnd(SCHEME_W, '.');
  s.rows[y] = row.slice(0, x) + ch + row.slice(x + 1);
}

/** The lines fgets(buf, 99, f) returns from a file opened in text mode, without their '\n'. */
function fgetsLines(text: string): string[] {
  const out: string[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    if (!line.length) continue;
    for (let i = 0; i < line.length; i += 98) out.push(line.slice(i, i + 98));
  }
  return out;
}

/**
 * scheme_parse (0x403eee) applied to the text of a scheme file. Starts from the basic grid, then:
 * `-V,n` (warning 725/726 unless 2), `-N,name` (up to the next comma), `-B,density` (not clamped),
 * `-R,row,15 cells` (warning 725/726 per row when the version is not 2; 750 when malformed),
 * `-S,player,x,y[,team]` (negative coordinates wrapped, x > 15 -> 14, y > 11 -> 10; team kept from the
 * grid when absent; 751 when malformed), `-P,type,bornwith,has_override,override,forbidden[,comment]`
 * (bornwith >= 0, flags 0/1; 752 when malformed); other `-` lines: 753. Lines not starting with '-' are
 * comments. The line type letter is case-sensitive.
 */
export function parseSchemeText(file: string, text: string, values: Values, warn?: SchemeWarn): Scheme {
  const s = basicGrid(file, values);
  let version = 0;
  for (const line of fgetsLines(text)) {
    // up to 10 fields: each one ends at the next comma, the 10th takes the rest of the line
    const parts = line.split(',');
    let f = parts.slice(1);
    if (f.length > 10) f = [...f.slice(0, 9), f.slice(9).join(',')];
    const n = f.length;
    if (line[0] !== '-') continue;
    switch (line[1]) {
      case 'V':
        version = atoi(f[0]);
        if (version !== 2) warn?.(725, 726);
        break;
      case 'N':
        if (n) s.name = f[0];
        break;
      case 'B':
        if (n) s.density = atoi(f[0]);
        break;
      case 'R': {
        if (version !== 2) warn?.(725, 726);
        if (n !== 2) {
          warn?.(97, 750);
          break;
        }
        const r = atoi(f[0]);
        if (r < 0 || r >= SCHEME_H) break;
        if (f[1].length !== SCHEME_W) warn?.(97, 750); // debug_clue("wrong width of line...")
        else s.rows[r] = f[1];
        break;
      }
      case 'S': {
        if (n !== 3 && n !== 4) {
          warn?.(97, 751);
          break;
        }
        const p = atoi(f[0]);
        let x = atoi(f[1]);
        let y = atoi(f[2]);
        while (x < 0) x += SCHEME_W;
        while (y < 0) y += SCHEME_H;
        if (x > SCHEME_W) x = SCHEME_W - 1;
        if (y > SCHEME_H) y = SCHEME_H - 1;
        if (p < 0 || p >= SCHEME_PLAYERS) break;
        const st = s.starts[p];
        st[0] = x;
        st[1] = y;
        if (n === 4) st[2] = atoi(f[3]) !== 0 ? 1 : 0;
        break;
      }
      case 'P': {
        if (n < 5) {
          warn?.(97, 752);
          break;
        }
        const t = atoi(f[0]);
        if (t < 0 || t >= SCHEME_POWERS) break;
        s.powerups[t] = {
          bornwith: Math.max(atoi(f[1]), 0),
          hasOverride: atoi(f[2]) !== 0 ? 1 : 0,
          override: atoi(f[3]),
          forbidden: atoi(f[4]) !== 0 ? 1 : 0,
        };
        break;
      }
      default:
        warn?.(97, 753);
    }
  }
  s.version = version;
  return s;
}

/** First line of a saved scheme file (the original wrote "...an Atomic Bomberman Scheme File."). */
const HEADER = '; NOTE! This is a Boom Buds Scheme File.';

/**
 * scheme_save (0x403c16): the file the editor writes ("wt": every line ends in CR LF). `powerComment(i)`
 * is the text after the last field of the -P lines (msgs 800..812); it is ignored when reading.
 */
export function serializeScheme(s: Scheme, powerComment: (type: number) => string): string {
  const out: string[] = [];
  const w = (fmt: string, ...args: (string | number)[]) => out.push(sprintf(fmt, ...args));
  w(`\n${HEADER}\n`);
  w('; Modify at your own risk.  It is machine-generated and updated.\n\n');
  w('\n; this is an internal version control number\n');
  w('-V,%u\n', 2);
  w('\n; this is the textual name of the scheme\n');
  w('-N,%s\n', s.name);
  w('\n; scheme brick density (0-100 percent)\n');
  w('-B,%u\n', s.density);
  w('\n; actual array data (# is solid, : is brick, . is blank)\n');
  w(';               11111\n');
  w(';     012345678901234\n');
  for (let y = 0; y < SCHEME_H; y++) w('-R,%2u,%s\n', y, s.rows[y] ?? '');
  w('\n; player starting locations (playerno,X,Y)\n');
  for (let i = 0; i < SCHEME_PLAYERS; i++) {
    const st = s.starts[i] ?? [0, 0, 0];
    w('-S,%u,%d,%d,%d\n', i, st[0], st[1], st[2]);
  }
  w('\n; powerup information; the fields are:\n');
  w(';   powerup #, bornwith, has_override, override_value, forbidden\n');
  w(';   (note the last text field has no effect; it is only a comment)\n');
  for (let i = 0; i < SCHEME_POWERS; i++) {
    const p = s.powerups[i] ?? { bornwith: 0, hasOverride: 0, override: 0, forbidden: 0 };
    w('-P,%2u,%2d,%d,%2d,%2d,%s\n', i, p.bornwith, p.hasOverride, p.override, p.forbidden, powerComment(i));
  }
  return out.join('').replace(/\n/g, '\r\n');
}

/** The -P comments the original writes: MESSAGES.TXT 800 + type. */
export function powerComments(app: App): (type: number) => string {
  return (i) => app.msg(800 + i);
}

/** 0x40497c: the editor turns a typed file name into "<name up to the first '.'>.sch". */
export function schemeFileName(name: string): string {
  const dot = name.indexOf('.');
  return (dot >= 0 ? name.slice(0, dot) : name) + '.sch';
}

/**
 * Where a scheme name is looked up and stored: like datafile_path (directories dropped) after
 * scheme_parse's extension swap, upper-cased (the original's file system is case-insensitive and its
 * scheme list upper-cases the names).
 */
export function schemeKey(name: string): string {
  const base = name.slice(Math.max(name.lastIndexOf('\\'), name.lastIndexOf('/')) + 1);
  return schemeFileName(base).toUpperCase();
}

/** datafile_path's "data/schemes/<name>.sch", for the error messages 710 / 711. */
export function schemePath(name: string): string {
  const key = schemeKey(name);
  return `data/schemes/${key.slice(0, -4)}.sch`;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Schemes written by the level editor: file name (upper case, e.g. "MYLEVEL.SCH") -> .SCH text. */
export function loadCustomSchemes(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const raw = storage()?.getItem(STORE_KEY);
    if (!raw) return out;
    const obj = JSON.parse(raw) as unknown;
    if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) if (typeof v === 'string') out[schemeKey(k)] = v;
    }
  } catch {
    /* storage unavailable or corrupt */
  }
  return out;
}

/** Store a scheme file written by the editor; false when it could not be written (msg 710). */
export function saveCustomScheme(file: string, text: string): boolean {
  const st = storage();
  if (!st) return false;
  try {
    const all = loadCustomSchemes();
    all[schemeKey(file)] = text;
    st.setItem(STORE_KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}

/** Forget a scheme written by the editor (a shipped scheme of that name comes back). */
export function deleteCustomScheme(file: string): void {
  const st = storage();
  if (!st) return;
  try {
    const all = loadCustomSchemes();
    delete all[schemeKey(file)];
    st.setItem(STORE_KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable */
  }
}

/** Forget every scheme written by the editor. */
export function clearCustomSchemes(): void {
  try {
    storage()?.removeItem(STORE_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** Is `name` a scheme written by the editor (or imported)? */
export function isCustomScheme(name: string): boolean {
  return loadCustomSchemes()[schemeKey(name)] !== undefined;
}

/** The text of scheme file `name` as scheme_parse would open it, or null when there is no such file. */
export function schemeFileText(app: App, name: string): string | null {
  const key = schemeKey(name);
  const custom = loadCustomSchemes()[key];
  if (custom !== undefined) return custom;
  const builtin = app.text.schemes.find((s) => s.file.toUpperCase() === key);
  return builtin ? serializeScheme(builtin, powerComments(app)) : null;
}

let cache: { raw: string; values: Values; list: Scheme[] } | null = null;

/**
 * Every scheme file: the shipped ones plus the editor's, a saved scheme replacing a shipped one with the
 * same file name; sorted by file name like the original's directory listing.
 */
export function allSchemes(app: App): Scheme[] {
  const custom = loadCustomSchemes();
  const raw = JSON.stringify(custom);
  if (cache && cache.raw === raw && cache.values === app.values) return cache.list.slice();
  const byFile = new Map<string, Scheme>();
  for (const s of app.text.schemes) byFile.set(s.file.toUpperCase(), s);
  for (const [file, text] of Object.entries(custom)) byFile.set(file, parseSchemeText(file, text, app.values));
  const list = [...byFile.values()].sort((a, b) => {
    const fa = a.file.toUpperCase(), fb = b.file.toUpperCase();
    return fa < fb ? -1 : fa > fb ? 1 : 0;
  });
  cache = { raw, values: app.values, list };
  return list.slice();
}
