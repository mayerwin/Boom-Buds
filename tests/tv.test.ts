// The Android TV app's controller adapter (android/tv/tv.js): the native key and stick events it gets from
// MainActivity, as the standard gamepads navigator.getGamepads() returns to the game.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { RemoteButton, REMOTE_HOLD_MS } from '../src/app/controls.ts';
import { IN_ACT1, IN_ACT2, IN_LEFT } from '../src/engine/input.ts';

interface Btn { pressed: boolean; value: number }
interface Snap { id: string; index: number; axes: number[]; buttons: Btn[] }
interface Device { id: number; name?: string; remote?: boolean; bridged?: boolean }
interface PadsApi {
  frame: number;
  input(e: object): number;
  snapshot(): (Snap | null)[];
  on(fn: (type: string, pad: { index: number; id: string }) => void): void;
  /** fetches the events still waiting in the app (install() sets it) */
  pull: (() => void) | null;
  /** the last press, for the diagnostics overlay */
  edge: { seq: number; time: number; recv: number };
}
interface TvApi {
  Pads: new (now: () => number, backButton?: () => number) => PadsApi;
  backButtonFor(doc: object, game: object | null): number;
  install(win: object): PadsApi;
}

// a plain script (UMD), loaded as CommonJS
const tvModule = { exports: {} as TvApi };
new Function('module', readFileSync('android/tv/tv.js', 'utf8'))(tvModule);
const tv = tvModule.exports;

const remote: Device = { id: 7, name: 'Remote', remote: true, bridged: true };
const remote2: Device = { id: 9, name: 'Remote consumer keys', remote: true, bridged: true };
const pad: Device = { id: 12, name: 'Xbox Wireless Controller', remote: false, bridged: true };
const key = (device: Device, code: string, action: 'down' | 'up', repeat = 0) => ({ type: 'key', device, code, action, repeat });
const pressed = (s: Snap | null) => s!.buttons.flatMap((b, i) => (b.pressed ? [i] : []));

function setup(back = () => 1) {
  let now = 1000;
  const pads = new tv.Pads(() => now, back);
  return { pads, advance: (ms: number) => (now += ms) };
}

describe('TV controllers as gamepads', () => {
  it('maps a gamepad\'s buttons, d-pad, hat and sticks to the standard mapping', () => {
    const { pads } = setup();
    pads.input({ type: 'device', action: 'connected', device: pad });
    pads.input(key(pad, 'BUTTON_A', 'down'));
    pads.input(key(pad, 'BUTTON_START', 'down'));
    pads.input({ type: 'motion', device: pad, axes: { x: 0.5, y: -1, rz: 0.25, hatX: 1, hatY: 0, rtrigger: 0.75 } });
    const s = pads.snapshot()[0]!;
    expect(s.id).toBe('Xbox Wireless Controller');
    expect(pressed(s)).toEqual([0, 7, 9, 15]); // A, right trigger, Start, d-pad right from the hat
    expect(s.buttons[7].value).toBe(0.75);
    expect(s.axes).toEqual([0.5, -1, 0, 0.25]);
  });

  it('reads the right stick from Z / RZ, or from RX / RY on a gamepad without them (never a trigger at rest)', () => {
    const { pads } = setup();
    // a gamepad with triggers on RX / RY (at rest: -1) and its right stick on Z / RZ, centred
    pads.input({ type: 'motion', device: pad, axes: { x: 0, y: 0, z: 0, rz: 0, rx: -1, ry: -1 } });
    expect(pads.snapshot()[0]!.axes).toEqual([0, 0, 0, 0]);
    const other: Device = { id: 13, name: 'Old pad', remote: false, bridged: true };
    pads.input({ type: 'motion', device: other, axes: { x: 0, y: 0, rx: 0.5, ry: -0.75 } });
    expect(pads.snapshot()[1]!.axes).toEqual([0, 0, 0.5, -0.75]);
  });

  it('takes the right stick from RX / RY when Z and RZ are triggers resting at -1, and those triggers as LT / RT', () => {
    const { pads } = setup();
    pads.input({ type: 'motion', device: pad, axes: { x: 0, y: 0, z: -1, rz: -1, rx: 0.5, ry: 0 } });
    expect(pads.snapshot()[0]!.axes).toEqual([0, 0, 0.5, 0]);
    pads.input({ type: 'motion', device: pad, axes: { x: 0, y: 0, z: 1, rz: -1, rx: 0, ry: 0 } });
    const s = pads.snapshot()[0]!;
    expect(s.axes).toEqual([0, 0, 0, 0]);
    expect(pressed(s)).toEqual([6]);
  });

  it('keeps a quick tap of a d-pad on the hat axes, as a key tap', () => {
    const { pads, advance } = setup();
    pads.input({ type: 'motion', device: pad, axes: { x: 0, y: 0, hatX: 1, hatY: 0 } });
    pads.input({ type: 'motion', device: pad, axes: { x: 0, y: 0, hatX: 0, hatY: 0 } });
    expect(pressed(pads.snapshot()[0])).toEqual([15]);
    advance(100);
    pads.frame += 2;
    expect(pressed(pads.snapshot()[0])).toEqual([]);
  });

  it('answers with the same snapshot within a display frame until an event comes', () => {
    const { pads } = setup();
    pads.input(key(pad, 'BUTTON_A', 'down'));
    const a = pads.snapshot();
    expect(pads.snapshot()).toBe(a);
    pads.input(key(pad, 'BUTTON_B', 'down'));
    const b = pads.snapshot();
    expect(b).not.toBe(a);
    expect(pressed(b[0])).toEqual([0, 1]);
    pads.frame++;
    expect(pads.snapshot()).not.toBe(b);
  });

  it('makes one "TV remote" gamepad of all the remote\'s devices; OK is A', () => {
    const { pads } = setup();
    const seen: string[] = [];
    pads.on((type, p) => seen.push(`${type}:${p.index}:${p.id}`));
    pads.input({ type: 'device', action: 'connected', device: pad });
    pads.input({ type: 'device', action: 'connected', device: remote });
    pads.input({ type: 'device', action: 'connected', device: remote2 });
    expect(seen).toEqual(['connected:0:Xbox Wireless Controller', 'connected:1:TV remote']);
    pads.input(key(remote2, 'DPAD_CENTER', 'down'));
    pads.input(key(remote, 'DPAD_UP', 'down'));
    expect(pressed(pads.snapshot()[1])).toEqual([0, 12]);
    // a remote device going away does not remove the remote gamepad (the others are still there)
    pads.input({ type: 'device', action: 'disconnected', device: remote2 });
    expect(pads.snapshot()[1]).not.toBeNull();
    pads.input({ type: 'device', action: 'disconnected', device: pad });
    expect(pads.snapshot()[0]).toBeNull();
    expect(seen.at(-1)).toBe('disconnected:0:Xbox Wireless Controller');
  });

  it('keeps a quick tap pressed for a while and through the next display frame', () => {
    const { pads, advance } = setup();
    pads.input(key(pad, 'BUTTON_A', 'down'));
    pads.input(key(pad, 'BUTTON_A', 'up'));
    expect(pressed(pads.snapshot()[0])).toEqual([0]);
    advance(100); // a slow frame: the tap time is over, but no frame has seen the press yet
    expect(pressed(pads.snapshot()[0])).toEqual([0]);
    pads.frame++;
    expect(pressed(pads.snapshot()[0])).toEqual([0]);
    pads.frame++;
    expect(pressed(pads.snapshot()[0])).toEqual([]);
  });

  it('reports a press once (not its key repeats) and lets go of everything when the app is paused', () => {
    const { pads, advance } = setup();
    expect(pads.input(key(remote, 'DPAD_LEFT', 'down'))).toBe(14);
    expect(pads.input(key(remote, 'DPAD_LEFT', 'down', 1))).toBe(-1);
    pads.input({ type: 'lifecycle', action: 'pause' });
    expect(pressed(pads.snapshot()[0])).toEqual([]);
    advance(100);
    pads.frame += 2;
    expect(pressed(pads.snapshot()[0])).toEqual([]);
  });

  it('makes Back the button the screen wants: B in the menus, Start in a round and its pause menu', () => {
    let back = 1;
    const { pads, advance } = setup(() => back);
    expect(pads.input(key(remote, 'BACK', 'down'))).toBe(1);
    pads.input(key(remote, 'BACK', 'up'));
    back = 9;
    pads.frame += 2;
    advance(100);
    expect(pads.input(key(remote, 'BACK', 'down'))).toBe(9);
    // the screen changed while Back was down: its release still lets go
    back = 1;
    pads.input(key(remote, 'BACK', 'up'));
    pads.frame += 2;
    advance(100);
    expect(pressed(pads.snapshot()[0])).toEqual([]);

    const doc = (open: string[]) => ({ getElementById: (id: string) => ({ classList: { contains: () => open.includes(id) } }) });
    expect(tv.backButtonFor(doc(['menu-root']), { runner: {} })).toBe(1);
    expect(tv.backButtonFor(doc(['pause-root']), { runner: {} })).toBe(9);
    expect(tv.backButtonFor(doc([]), { runner: {} })).toBe(9);
    expect(tv.backButtonFor(doc([]), { runner: null })).toBe(1);
  });
});

describe('the events waiting in the app', () => {
  /** enough of a window for tv.js to install itself in (its frame callbacks are never run) */
  function fakeWindow(host: Record<string, unknown>) {
    const doc = {
      readyState: 'complete',
      activeElement: null,
      addEventListener() {},
      getElementById: () => null,
      querySelector: () => null,
    };
    return {
      document: doc,
      navigator: {} as { getGamepads?: () => (Snap | null)[] },
      performance: { now: () => 1000 },
      requestAnimationFrame: () => 1,
      Event: class {
        type: string;
        constructor(type: string) {
          this.type = type;
        }
      },
      dispatchEvent() {},
      AndroidHost: { ready() {}, ...host },
    };
  }

  it('are fetched when the game reads the gamepads, and acted on once each', () => {
    const waiting = [{ type: 'key', device: pad, code: 'BUTTON_A', action: 'down', repeat: 0, time: 4242 }];
    let drained = 0;
    const win = fakeWindow({
      drainInput() {
        drained++;
        return waiting.length ? JSON.stringify(waiting.splice(0)) : '';
      },
    });
    const pads = tv.install(win);
    // the press is in the very first reading: nothing waits for the next display frame
    expect(pressed(win.navigator.getGamepads!()[0])).toEqual([0]);
    expect(drained).toBe(1);
    // and it is noted for the diagnostics overlay, with the time the app saw it
    expect(pads.edge).toMatchObject({ seq: 1, time: 4242 });
    pads.frame++;
    expect(pressed(win.navigator.getGamepads!()[0])).toEqual([0]); // still held, not pressed again
    expect(pads.edge.seq).toBe(1);
  });

  it('are taken as they come when the app pushes them instead', () => {
    const win = fakeWindow({ drainInput: () => '' });
    const pads = tv.install(win);
    (win as unknown as { BoomBudsAndroid: { onInput(e: object): void } }).BoomBudsAndroid.onInput({
      type: 'key', device: pad, code: 'BUTTON_X', action: 'down', repeat: 0, time: 10,
    });
    expect(pressed(pads.snapshot()[0])).toEqual([2]);
    expect(pads.edge.seq).toBe(1);
  });
});

describe('the TV remote in a round', () => {
  /** a fresh remote whose OK was up when the round started */
  const remote = () => {
    const r = new RemoteButton();
    r.bits(0, false, 0);
    return r;
  };

  it('drops the bomb at once while the special button would do nothing', () => {
    const r = remote();
    expect(r.bits(IN_ACT1 | IN_LEFT, false, 10)).toBe(IN_ACT1 | IN_LEFT);
    expect(r.bits(IN_ACT1, false, 10 + REMOTE_HOLD_MS * 2)).toBe(IN_ACT1); // holding is still the bomb button
    expect(r.bits(0, false, 1000)).toBe(0);
  });

  it('with punch or trigger bombs: a short press is the bomb (on release), a long press the special', () => {
    const r = remote();
    expect(r.bits(IN_ACT1, true, 100)).toBe(0);
    expect(r.bits(IN_ACT1, true, 180)).toBe(0);
    expect(r.bits(0, true, 200)).toBe(IN_ACT1); // let go: the bomb
    expect(r.bits(0, true, 230)).toBe(IN_ACT1); // (for a few ticks)
    expect(r.bits(0, true, 260)).toBe(0);
    expect(r.bits(IN_ACT1, true, 1000)).toBe(0);
    expect(r.bits(IN_ACT1, true, 1000 + REMOTE_HOLD_MS)).toBe(IN_ACT2); // held: the special, while held
    expect(r.bits(IN_ACT1, true, 1600)).toBe(IN_ACT2);
    expect(r.bits(0, true, 1700)).toBe(0); // and no bomb when let go
  });

  it('decides what a press is when OK goes down', () => {
    const r = remote();
    // a bomb press stays one (carrying a grabbed bomb) even if the special gets a use meanwhile
    expect(r.bits(IN_ACT1, false, 100)).toBe(IN_ACT1);
    expect(r.bits(IN_ACT1, true, 100 + REMOTE_HOLD_MS * 3)).toBe(IN_ACT1);
    expect(r.bits(0, true, 1500)).toBe(0);
    // and a press that can be the special stays one
    expect(r.bits(IN_ACT1, true, 2000)).toBe(0);
    expect(r.bits(IN_ACT1, false, 2000 + REMOTE_HOLD_MS)).toBe(IN_ACT2);
  });

  it('takes a press the game saw only once for a short one, however far apart the frames are', () => {
    const b = new RemoteButton();
    expect(b.bits(0, true, 0)).toBe(0);
    // one frame sees OK down, the next one (a third of a second later: a machine drawing three frames a second)
    // sees it let go — the game never saw it held, so it was a tap: the bomb
    expect(b.bits(IN_ACT1, true, 100)).toBe(0);
    expect(b.bits(0, true, 430)).toBe(IN_ACT1);
    // held over two frames and longer than the hold: the special
    const c = new RemoteButton();
    expect(c.bits(0, true, 0)).toBe(0);
    expect(c.bits(IN_ACT1, true, 100)).toBe(0);
    expect(c.bits(IN_ACT1, true, 430)).toBe(IN_ACT2);
    expect(c.bits(0, true, 500)).toBe(0);
  });

  it('ignores a press that was already down when the round started or the pause menu closed', () => {
    const r = new RemoteButton();
    expect(r.bits(IN_ACT1, false, 0)).toBe(0);
    expect(r.bits(IN_ACT1, false, 500)).toBe(0);
    expect(r.bits(0, false, 600)).toBe(0);
    expect(r.bits(IN_ACT1, false, 700)).toBe(IN_ACT1);
    r.suspend();
    expect(r.bits(IN_ACT1, true, 800)).toBe(0);
    expect(r.bits(0, true, 900)).toBe(0); // no bomb from the press that closed the menu
    expect(r.bits(IN_ACT1, true, 1000)).toBe(0);
    expect(r.bits(0, true, 1100)).toBe(IN_ACT1);
  });
});
