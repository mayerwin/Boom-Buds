// Control sets (src/app/controls.ts): gamepads known by name (whole, or one half each for two players), four
// keyboard sets, the original menus' view of them (KEY n, JOY n, JOY n L / R), and the gamepad readings of the
// game and the menus (src/engine/input.ts, src/ui/menuInput.ts).
import { describe, it, expect, beforeEach } from 'vitest';
import {
  addMissingBuiltins,
  availableSets,
  classicChoices,
  classicInput,
  classicKeySets,
  defaultControlPrefs,
  findSet,
  idsClash,
  mergeHalves,
  migrateSetId,
  padOf,
  padSetId,
  slotSetId,
  type ControlPrefs,
} from '../src/app/controls.ts';
import { IN_ACT1, IN_ACT2, IN_DOWN, IN_LEFT, IN_RIGHT, IN_UP, connectedPads, forgetPads, padBits, padMenuBits, type Input } from '../src/engine/input.ts';
import { INPUT_JOY, INPUT_KEY, type Slot } from '../src/app/session.ts';
import { K, PadKeys } from '../src/ui/menuInput.ts';

interface FakePad {
  id: string;
  index: number;
  connected: boolean;
  mapping: string;
  axes: number[];
  buttons: { pressed: boolean; value: number }[];
}

const fake = (id: string, index: number, mapping = 'standard'): FakePad => ({
  id,
  index,
  connected: true,
  mapping,
  axes: [0, 0, 0, 0],
  buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
});

let pads: (FakePad | null)[] = [];
const nav = globalThis.navigator as unknown as Record<string, unknown>;
Object.defineProperty(nav, 'getGamepads', { configurable: true, value: () => pads });
/** a reading of the gamepads after this one sees changes (connectedPads() keeps one for 2 ms) */
const later = async () => new Promise((r) => setTimeout(r, 5));
const input = { keyboardSeen: false } as Input;
const press = (p: FakePad, ...b: number[]) => b.forEach((n) => (p.buttons[n] = { pressed: true, value: 1 }));
const gp = (p: FakePad) => p as unknown as Gamepad;

const XBOX = 'Xbox Wireless Controller';

beforeEach(async () => {
  pads = [];
  forgetPads();
  await later();
});

describe('gamepad sets', () => {
  it('know a gamepad by name and rank among those of the same name, wherever the browser lists it', async () => {
    const a = fake(XBOX, 0), b = fake(XBOX, 1), r = fake('TV remote', 2);
    pads = [a, b, r];
    const list = connectedPads();
    expect(padSetId(list, 0)).toBe(`pad:0:${XBOX}`);
    expect(padSetId(list, 1, 'right')).toBe(`padR:1:${XBOX}`);
    expect(padOf(`pad:1:${XBOX}`)).toBe(b);
    expect(padOf('pad:0:TV remote')).toBe(r);
    const prefs = defaultControlPrefs();
    expect(findSet(prefs, `pad:0:${XBOX}`)?.name).toBe(XBOX);
    expect(findSet(prefs, `padL:1:${XBOX}`)?.name).toBe(`${XBOX} 2 (left)`);
    expect(findSet(prefs, 'pad:0:TV remote')?.name).toBe('TV remote');
    // the first of the two identical gamepads drops out: the second keeps its rank (and its player), the first's
    // player waits for it; back at its place, it is the same set again
    pads = [null, b, r];
    await later();
    expect(padOf('pad:0:TV remote')).toBe(r);
    expect(padOf(`pad:1:${XBOX}`)).toBe(b);
    expect(padOf(`pad:0:${XBOX}`)).toBeNull();
    pads = [a, b, r];
    await later();
    expect(padOf(`pad:0:${XBOX}`)).toBe(a);
  });

  it('read the next gamepad of a visit afresh (forgetPads)', async () => {
    pads = [fake(XBOX, 1)];
    await later();
    forgetPads();
    expect(padSetId(connectedPads(), 0)).toBe(`pad:0:${XBOX}`);
  });

  it('let two players share a gamepad, one half each, but not the whole of it', () => {
    const prefs = defaultControlPrefs();
    expect(idsClash(prefs, `padL:0:${XBOX}`, `padR:0:${XBOX}`)).toBe(false);
    expect(idsClash(prefs, `pad:0:${XBOX}`, `padR:0:${XBOX}`)).toBe(true);
    expect(idsClash(prefs, `padL:0:${XBOX}`, `padL:0:${XBOX}`)).toBe(true);
    expect(idsClash(prefs, `padL:0:${XBOX}`, `padL:1:${XBOX}`)).toBe(false);
    expect(idsClash(prefs, 'kb-esdf', 'kb-ijkl')).toBe(false);
    // the remaining player of a shared gamepad gets all of it
    expect(mergeHalves([`padR:0:${XBOX}`, 'kb-esdf'], `padL:0:${XBOX}`)).toEqual([`pad:0:${XBOX}`, 'kb-esdf']);
    expect(mergeHalves(['kb-esdf'], 'kb-arrows')).toEqual(['kb-esdf']);
  });

  it('offer each half of a gamepad whose layout is known, never of the TV remote', async () => {
    pads = [fake(XBOX, 0), fake('TV remote', 1), fake('Old joystick', 2, '')];
    await later();
    const ids = availableSets(defaultControlPrefs(), input, false).map((s) => s.id);
    expect(ids).toEqual([
      'kb-esdf', 'kb-arrows', 'kb-ijkl', 'kb-numpad',
      `pad:0:${XBOX}`, `padL:0:${XBOX}`, `padR:0:${XBOX}`, 'pad:0:TV remote', 'pad:0:Old joystick',
    ]);
  });

  it('take ids of the earlier versions ("pad-1": a place in the list) while that gamepad is there', async () => {
    pads = [fake(XBOX, 0), fake('TV remote', 1)];
    await later();
    expect(migrateSetId('pad-1')).toBe('pad:0:TV remote');
    expect(migrateSetId('pad-4')).toBeNull();
    expect(migrateSetId('kb-esdf')).toBe('kb-esdf');
  });
});

describe('the original menus', () => {
  it('number the keyboard sets KEY 0 (right), KEY 1 (left), then the others; a replay of the original has only two', () => {
    const prefs = defaultControlPrefs();
    expect(classicKeySets(prefs).map((s) => s.id)).toEqual(['kb-arrows', 'kb-esdf', 'kb-ijkl', 'kb-numpad']);
    expect(classicInput(prefs, 'kb-ijkl')).toMatchObject({ type: INPUT_KEY, dev: 2 });
    const replay: ControlPrefs = { sets: prefs.sets.filter((s) => s.id === 'kb-arrows' || s.id === 'kb-esdf') };
    expect(classicChoices(replay, true, false)).toEqual(['kb-arrows', 'kb-esdf']);
  });

  it('go through every set: keyboards, each gamepad and its halves, touch controls', async () => {
    pads = [fake(XBOX, 0), fake('TV remote', 1)];
    await later();
    const prefs = defaultControlPrefs();
    expect(classicChoices(prefs, true, true)).toEqual([
      'kb-arrows', 'kb-esdf', 'kb-ijkl', 'kb-numpad',
      `pad:0:${XBOX}`, `padL:0:${XBOX}`, `padR:0:${XBOX}`, 'pad:0:TV remote',
      'touch', 'touch-left', 'touch-right',
    ]);
    expect(classicInput(prefs, `padR:0:${XBOX}`)).toMatchObject({ type: INPUT_JOY, dev: 0, extra: ' R' });
    expect(classicInput(prefs, 'pad:0:TV remote')).toMatchObject({ type: INPUT_JOY, dev: 1, extra: '' });
    expect(classicInput(prefs, 'touch-left').word).toBe('TOUCH L');
    // a slot of the original's (no set of its own): KEY n is a keyboard set, JOY n a gamepad
    const slot = (type: number, dev: number): Slot => ({ type, dev, team: 0, owner: 0, ai: 0 });
    expect(slotSetId(prefs, slot(INPUT_KEY, 1))).toBe('kb-esdf');
    expect(slotSetId(prefs, slot(INPUT_JOY, 1))).toBe('pad:0:TV remote');
    expect(slotSetId(prefs, slot(INPUT_JOY, 5))).toBe('joy-5');
    expect(slotSetId(prefs, { ...slot(INPUT_KEY, 0), ctl: `padL:0:${XBOX}` })).toBe(`padL:0:${XBOX}`);
  });

  it('bring back built-in sets a stored list lacks, before the player\'s own', () => {
    const prefs: ControlPrefs = { sets: [defaultControlPrefs().sets[0], defaultControlPrefs().sets[1], { id: 'kb-mine', name: 'Mine', kind: 'keys', keys: ['KeyT', 'KeyH', 'KeyG', 'KeyF', 'KeyR', 'KeyY'] }] };
    addMissingBuiltins(prefs);
    expect(prefs.sets.map((s) => s.id)).toEqual(['kb-esdf', 'kb-arrows', 'kb-ijkl', 'kb-numpad', 'kb-mine']);
  });
});

describe('gamepad readings', () => {
  it('play a whole gamepad with the left stick or the d-pad, A bomb, B special', () => {
    const p = fake(XBOX, 0);
    p.axes = [0.9, 0, -1, 0];
    press(p, 12, 0);
    expect(padBits(gp(p))).toBe(IN_RIGHT | IN_UP | IN_ACT1);
  });

  it('play half a gamepad: left stick or d-pad, LB, LT on the left; right stick, A / RB, X / RT on the right', () => {
    const p = fake(XBOX, 0);
    p.axes = [-0.8, 0, 0, 0.7];
    press(p, 4, 7, 13);
    expect(padBits(gp(p), 'left')).toBe(IN_LEFT | IN_DOWN | IN_ACT1);
    expect(padBits(gp(p), 'right')).toBe(IN_DOWN | IN_ACT2);
    // the right half plays with the two buttons a thumb reaches beside its stick: A bombs, X is the special
    const r = fake(XBOX, 0);
    press(r, 0);
    expect(padBits(gp(r), 'right')).toBe(IN_ACT1);
    const s = fake(XBOX, 0);
    press(s, 2);
    expect(padBits(gp(s), 'right')).toBe(IN_ACT2);
    // B and Y are the whole gamepad's special, and nothing on its right half (B is "back" in the menus)
    const t = fake(XBOX, 0);
    press(t, 1, 3);
    expect(padBits(gp(t))).toBe(IN_ACT2);
    expect(padBits(gp(t), 'right')).toBe(0);
    // a gamepad of unknown layout has no right stick to play with
    const q = { ...fake('Old joystick', 1, ''), axes: [0, 0, -1, -1] };
    expect(padBits(gp(q), 'right')).toBe(0);
  });

  it('move in the menus with either stick (the right one with a known layout only) or the d-pad', () => {
    const p = fake(XBOX, 0);
    p.axes = [0, 0, 0, -0.9];
    expect(padMenuBits(gp(p))).toBe(IN_UP);
    expect(padMenuBits(gp({ ...p, mapping: '' }))).toBe(0);
    press(p, 1);
    expect(padMenuBits(gp(p)) & IN_ACT2).toBe(IN_ACT2);
  });

  it('give menu keys per gamepad, repeating a held direction, never for what was held at the first reading', async () => {
    const p = fake(XBOX, 0);
    press(p, 0);
    pads = [p];
    await later();
    const keys = new PadKeys();
    expect(keys.poll(0)).toEqual([]); // A already down: not a press
    await later();
    p.buttons[0] = { pressed: false, value: 0 };
    press(p, 15);
    expect(keys.poll(10)).toEqual([K.RIGHT]);
    await later();
    expect(keys.poll(400)).toEqual([]);
    await later();
    expect(keys.poll(520)).toEqual([K.RIGHT]);
    await later();
    expect(keys.poll(610)).toEqual([K.RIGHT]);
    await later();
    press(p, 0);
    expect(keys.poll(620)).toEqual([K.ENTER]);
  });
});
