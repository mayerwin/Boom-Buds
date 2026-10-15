import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import type { TextJson } from '../src/engine/assets.ts';
import type { App } from '../src/app/App.ts';
import { flattenValues } from '../src/game/sim/sim.ts';
import {
  parseSchemeText, serializeScheme, basicGrid, resetToBasicGrid, allSchemes, saveCustomScheme, loadCustomSchemes,
  schemeFileText, schemeFileName, schemeKey, schemeCell, setSchemeCell, CELL_BLANK, CELL_SOLID, CELL_BRICK,
} from '../src/app/schemes.ts';

const text: TextJson = JSON.parse(readFileSync('public/data/text.json', 'utf8'));
const values = flattenValues(text.values);
const comment = (i: number) => text.messages[800 + i];
const app = { text, values, msg: (id: number) => text.messages[id] ?? '' } as unknown as App;

/** In-memory localStorage for the storage functions. */
class MemStorage {
  private m = new Map<string, string>();
  get length(): number {
    return this.m.size;
  }
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
}

describe('scheme file format', () => {
  it('parse(serialize(x)) round-trips all 67 shipped schemes', () => {
    expect(text.schemes.length).toBe(67);
    for (const s of text.schemes) {
      const warnings: number[][] = [];
      const back = parseSchemeText(s.file, serializeScheme(s, comment), values, (a, b) => warnings.push([a, b]));
      expect(warnings, s.file).toEqual([]);
      expect(back, s.file).toEqual(s);
    }
  });

  it('writes the editor save format (scheme_save 0x403c16)', () => {
    const basic = text.schemes.find((s) => s.file === 'BASIC.SCH')!;
    const out = serializeScheme(basic, comment);
    expect(out.startsWith('\r\n; NOTE! This is a Boom Buds Scheme File.\r\n')).toBe(true);
    expect(out).toContain('\r\n-V,2\r\n');
    expect(out).toContain('\r\n-N,Just the BASIC SET! (10)\r\n');
    expect(out).toContain('\r\n-B,90\r\n');
    expect(out).toContain('\r\n-R, 0,:::::::::::::::\r\n-R, 1,:#:#:#:#:#:#:#:\r\n');
    expect(out).toContain('\r\n-R,10,:::::::::::::::\r\n');
    expect(out).toContain('\r\n-S,1,14,10,1\r\n');
    expect(out).toContain('\r\n-P,10, 0,0, 0, 0,jelly (bouncy) bombs\r\n');
    expect(out.endsWith('-P,12, 0,0, 0, 0,random\r\n')).toBe(true);
    expect(/[^\r]\n/.test(out)).toBe(false);
  });

  const DIR = 'C:/Games/BOMBERMAN/DATA/SCHEMES';
  it.skipIf(!existsSync(DIR))('reproduces the shipped files byte for byte', () => {
    for (const f of readdirSync(DIR)) {
      const raw = readFileSync(`${DIR}/${f}`, 'latin1');
      const s = parseSchemeText(f.toUpperCase(), raw, values);
      // five files end in a DOS EOF character; 31 older ones have no team field in their -S lines
      const expected = raw
        .replace(/\x1a$/, '')
        .replace(/^-S,(\d+),(-?\d+),(-?\d+)\r$/gm, (_m, p: string, x: string, y: string) => `-S,${p},${x},${y},${Number(p) & 1}\r`)
        .replace('an Atomic Bomberman Scheme File', 'a Boom Buds Scheme File');
      expect(serializeScheme(s, comment), f).toBe(expected);
      const shipped = text.schemes.find((x) => x.file === f.toUpperCase())!;
      expect({ ...s, name: shipped.name }, f).toEqual(shipped); // (BMAN93's name is rebranded)
    }
  });

  it('scheme_basic_grid gives the BASIC.SCH layout', () => {
    const b = basicGrid('NEWFILE', values);
    const basic = text.schemes.find((s) => s.file === 'BASIC.SCH')!;
    expect(b.name).toBe('Basic grid pattern');
    expect(b.density).toBe(90);
    expect(b.rows).toEqual(basic.rows);
    expect(b.starts).toEqual(basic.starts);
    expect(b.powerups.every((p) => !p.bornwith && !p.hasOverride && !p.override && !p.forbidden)).toBe(true);
    const s = parseSchemeText('X.SCH', serializeScheme(text.schemes[0], comment), values);
    resetToBasicGrid(s, values);
    expect({ ...s, file: 'NEWFILE' }).toEqual(b);
  });

  it('parses like scheme_parse, quirks included', () => {
    const warnings: number[][] = [];
    const s = parseSchemeText(
      'T.SCH',
      [
        '; comment',
        ' -N,not a definition (leading blank)',
        '-N,Hello, World',
        '-B,150',
        '-R, 3,.....',
        '-R,12,:::::::::::::::',
        '-V,2',
        '-R, 4,...............',
        '-S,2,-1,20',
        '-S,3,15,11,7',
        '-S,1,2',
        '-P, 0,-5,7, 3, 9,comment, with comma',
        '-P,13, 1,1, 1, 1,ignored',
        '-P, 1,2,3',
        '-p, 2, 1,0, 0, 0,lower case',
        '-X,1',
      ].join('\n'),
      values,
      (a, b) => warnings.push([a, b]),
    );
    expect(s.name).toBe('Hello');
    expect(s.density).toBe(150);
    expect(s.rows[3]).toBe(':#:#:#:#:#:#:#:');
    expect(s.rows[4]).toBe('...............');
    expect(s.starts[2]).toEqual([14, 10, 0]);
    expect(s.starts[3]).toEqual([15, 11, 1]);
    expect(s.starts[1]).toEqual([14, 10, 1]);
    expect(s.powerups[0]).toEqual({ bornwith: 0, hasOverride: 1, override: 3, forbidden: 1 });
    expect(s.powerups[2]).toEqual({ bornwith: 0, hasOverride: 0, override: 0, forbidden: 0 });
    expect(s.powerups.length).toBe(13);
    expect(s.version).toBe(2);
    expect(warnings).toEqual([
      [725, 726], [97, 750], // -R before -V: wrong version, then too short
      [725, 726], // -R,12: wrong version, row ignored
      [97, 751], [97, 752], [97, 753], [97, 753],
    ]);
  });

  it('reads and writes cells like scheme_get_cell / scheme_set_cell', () => {
    const s = basicGrid('A.SCH', values);
    expect(schemeCell(s, 0, 0)).toBe(CELL_BRICK);
    expect(schemeCell(s, 1, 1)).toBe(CELL_SOLID);
    expect(schemeCell(s, -1, 0)).toBe(CELL_SOLID);
    setSchemeCell(s, 0, 0, CELL_BLANK);
    setSchemeCell(s, 14, 10, CELL_SOLID);
    setSchemeCell(s, 15, 0, CELL_SOLID);
    setSchemeCell(s, 2, 2, 7);
    expect(s.rows[0]).toBe('.::::::::::::::');
    expect(s.rows[10]).toBe('::::::::::::::#');
    expect(s.rows[2]).toBe('::.::::::::::::');
  });
});

describe('custom schemes (localStorage)', () => {
  beforeEach(() => {
    (globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();
  });

  it('names files like the editor', () => {
    expect(schemeFileName('mylevel')).toBe('mylevel.sch');
    expect(schemeFileName('my.level.txt')).toBe('my.sch');
    expect(schemeKey('Newfile')).toBe('NEWFILE.SCH');
    expect(schemeKey('..\\dir/Basic.sch')).toBe('BASIC.SCH');
  });

  it('stores schemes and lists them with the shipped ones', () => {
    expect(loadCustomSchemes()).toEqual({});
    expect(allSchemes(app).length).toBe(67);
    const mine = basicGrid('mylevel.sch', values);
    mine.name = 'My Level (4)';
    setSchemeCell(mine, 0, 0, CELL_SOLID);
    expect(saveCustomScheme('mylevel.sch', serializeScheme(mine, comment))).toBe(true);
    expect(Object.keys(loadCustomSchemes())).toEqual(['MYLEVEL.SCH']);
    let list = allSchemes(app);
    expect(list.length).toBe(68);
    const files = list.map((s) => s.file);
    expect([...files].sort()).toEqual(files);
    const got = list.find((s) => s.file === 'MYLEVEL.SCH')!;
    expect(got.name).toBe('My Level (4)');
    expect(got.rows[0][0]).toBe('#');
    // a saved scheme replaces the shipped one with the same name
    const basic = parseSchemeText('BASIC.SCH', schemeFileText(app, 'basic.sch')!, values);
    basic.density = 50;
    expect(saveCustomScheme('BASIC.sch', serializeScheme(basic, comment))).toBe(true);
    list = allSchemes(app);
    expect(list.length).toBe(68);
    expect(list.find((s) => s.file === 'BASIC.SCH')!.density).toBe(50);
    expect(schemeFileText(app, 'nothere.sch')).toBe(null);
  });
});
