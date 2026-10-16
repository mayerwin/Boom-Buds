// Menu input in GNW key codes (what the original's get_input()/input_get_menu_key() return):
// ASCII for printable keys, Enter 0x0D, Esc 0x1B, Space 0x20, Tab 0x09, Backspace 0x08, Ctrl+letter 1..26,
// extended keys 0x100 + scancode (F1 0x13B, Up 0x148, Left 0x14B, Right 0x14D, Down 0x150, PgUp 0x149,
// PgDn 0x151, Home 0x147, End 0x14F, F10 0x144, Ctrl-Left 0x173, Ctrl-Right 0x174), Alt+letter 0x100 + scancode.
// Keys auto-repeat like GNW: first repeat after 500 ms, then every 80 ms.

import type { KeyEventRecord, PointerRecord } from '../engine/input.ts';
import { IN_UP, IN_DOWN, IN_LEFT, IN_RIGHT, IN_ACT1, IN_ACT2, connectedPads, padMenuBits } from '../engine/input.ts';
import type { App } from '../app/App.ts';

export const K = {
  ENTER: 0x0d, ESC: 0x1b, SPACE: 0x20, TAB: 0x09, BACKSPACE: 0x08,
  UP: 0x148, DOWN: 0x150, LEFT: 0x14b, RIGHT: 0x14d, PGUP: 0x149, PGDN: 0x151, HOME: 0x147, END: 0x14f,
  F1: 0x13b, F10: 0x144, CTRL_LEFT: 0x173, CTRL_RIGHT: 0x174, DEL: 0x153,
  CTRL_A: 0x01, CTRL_B: 0x02, CTRL_D: 0x04, CTRL_E: 0x05, CTRL_F: 0x06, CTRL_Q: 0x11, CTRL_R: 0x12,
  ALT_W: 0x111, ALT_O: 0x118, ALT_A: 0x11e, ALT_D: 0x120, ALT_C: 0x12e, ALT_N: 0x131, ALT_P: 0x119,
  /** pseudo code for a pointer/touch press (the original returns -2 for mouse buttons) */
  MOUSE: -2,
} as const;

const EXTENDED = new Set([0xc8, 0xd0, 0xcb, 0xcd, 0xc9, 0xd1, 0xc7, 0xcf, 0xd2, 0xd3, 0x9c, 0x9d, 0xb8, 0xb5]);
const SCAN_TO_EXT: Record<number, number> = { 0xc8: 0x48, 0xd0: 0x50, 0xcb: 0x4b, 0xcd: 0x4d, 0xc9: 0x49, 0xd1: 0x51, 0xc7: 0x47, 0xcf: 0x4f, 0xd2: 0x52, 0xd3: 0x53 };
const LETTER_SCANS: Record<number, string> = {};
'QWERTYUIOP'.split('').forEach((c, i) => (LETTER_SCANS[0x10 + i] = c));
'ASDFGHJKL'.split('').forEach((c, i) => (LETTER_SCANS[0x1e + i] = c));
'ZXCVBNM'.split('').forEach((c, i) => (LETTER_SCANS[0x2c + i] = c));

/** Convert one key press to a GNW key code, or -1 when it has no code. */
export function gnwCode(k: KeyEventRecord): number {
  const d = k.dik;
  if (d === 0x1c || d === 0x9c) return K.ENTER;
  if (d === 0x01) return K.ESC;
  if (d === 0x0f) return K.TAB;
  if (d === 0x0e) return K.BACKSPACE;
  if (d >= 0x3b && d <= 0x44) return 0x100 + d; // F1..F10
  if (d === 0x57 || d === 0x58) return 0x100 + d;
  if (EXTENDED.has(d)) {
    const base = SCAN_TO_EXT[d];
    if (base === undefined) return -1;
    if (k.ctrl && base === 0x4b) return K.CTRL_LEFT;
    if (k.ctrl && base === 0x4d) return K.CTRL_RIGHT;
    return 0x100 + base;
  }
  const letter = LETTER_SCANS[d];
  if (letter) {
    if (k.ctrl) return letter.charCodeAt(0) - 64; // Ctrl-A = 1
    if (k.alt) return 0x100 + d;
  }
  if (k.char && k.char.length === 1) {
    const c = k.char.charCodeAt(0);
    if (c >= 32 && c < 127) return c;
  }
  if (d === 0x39) return K.SPACE;
  return -1;
}

interface HeldKey {
  code: number;
  next: number;
}

const DIRS: [number, number][] = [[IN_UP, K.UP], [IN_DOWN, K.DOWN], [IN_LEFT, K.LEFT], [IN_RIGHT, K.RIGHT]];

interface PadState {
  bits: number;
  /** the direction repeating while held (a key code, -1 none) and when it repeats next */
  code: number;
  bit: number;
  at: number;
  /** the last reading that saw the pad */
  seen: number;
}

/**
 * Menu keys from the gamepads, each read on its own: the directions (either stick or the d-pad, repeating while
 * held: after 500 ms, then every 80 ms, like GNW's keys), A = Enter, B = Esc. A gamepad's first reading only
 * notes what is held, so that a button already down then (the one that opened a menu) does not count.
 */
export class PadKeys {
  private pads = new Map<number, PadState>();
  private reading = 0;

  poll(now: number, repeat = true): number[] {
    const out: number[] = [];
    const n = ++this.reading;
    for (const gp of connectedPads()) {
      const bits = padMenuBits(gp);
      const st = this.pads.get(gp.index);
      if (!st) {
        this.pads.set(gp.index, { bits, code: -1, bit: 0, at: 0, seen: n });
        continue;
      }
      st.seen = n;
      const pressed = bits & ~st.bits;
      st.bits = bits;
      for (const [b, code] of DIRS) {
        if (pressed & b) {
          out.push(code);
          st.code = code;
          st.bit = b;
          st.at = now + 500;
        }
      }
      if (st.code !== -1) {
        if (!(bits & st.bit)) st.code = -1;
        else if (repeat && now >= st.at) {
          out.push(st.code);
          st.at = now + 80;
        }
      }
      if (pressed & IN_ACT1) out.push(K.ENTER);
      if (pressed & IN_ACT2) out.push(K.ESC);
    }
    for (const [i, st] of this.pads) if (st.seen !== n) this.pads.delete(i);
    return out;
  }

  /** Forget the gamepads: the next reading only notes what is held. */
  reset(): void {
    this.pads.clear();
  }
}

/**
 * Per-frame menu key source: keyboard (with GNW repeat), gamepads and the on-screen touch controls
 * (d-pad = arrows, A = Enter, B = Esc), plus pointer taps.
 */
export class MenuInput {
  private held = new Map<number, HeldKey>(); // dik -> repeat state
  private prevPad = 0;
  private padRepeatAt = 0;
  private padRepeatCode = -1;
  private app: App;
  /** pointer presses received this frame (game coordinates) */
  taps: PointerRecord[] = [];
  /** every pointer record received this frame */
  pointer: PointerRecord[] = [];

  constructor(app: App) {
    this.app = app;
  }

  /** The gamepad and touch buttons held now are not presses (input_flush: a button that ended a demo or a screen). */
  resetPads(): void {
    let bits = this.app.touch.visible ? this.app.touch.bits() : 0;
    for (const gp of connectedPads()) bits |= padMenuBits(gp);
    this.prevPad = bits;
    this.padRepeatCode = -1;
  }

  /** Collect this frame's key codes (in order). */
  poll(keys: KeyEventRecord[], pointer: PointerRecord[], now: number): number[] {
    const out: number[] = [];
    for (const k of keys) {
      if (k.repeat) continue; // browser repeat: ignored, GNW repeat below
      const code = gnwCode(k);
      if (code !== -1) {
        out.push(code);
        if (!(k.ctrl && code < 32) && code !== K.ESC && code !== K.ENTER) this.held.set(k.dik, { code, next: now + 500 });
        else this.held.set(k.dik, { code: -1, next: Infinity });
      }
    }
    for (const [dik, h] of this.held) {
      if (!this.app.input.isDown(dik)) {
        this.held.delete(dik);
        continue;
      }
      if (h.code !== -1 && now >= h.next) {
        out.push(h.code);
        h.next = now + 80;
      }
    }
    // gamepads + touch controls
    let bits = this.app.touch.visible ? this.app.touch.bits() : 0;
    for (const gp of connectedPads()) bits |= padMenuBits(gp);
    const pressed = bits & ~this.prevPad;
    for (const [b, code] of DIRS) {
      if (pressed & b) {
        out.push(code);
        this.padRepeatCode = code;
        this.padRepeatAt = now + 500;
      }
    }
    if (this.padRepeatCode !== -1) {
      const bit = DIRS.find(([, c]) => c === this.padRepeatCode)![0];
      if (!(bits & bit)) this.padRepeatCode = -1;
      else if (now >= this.padRepeatAt) {
        out.push(this.padRepeatCode);
        this.padRepeatAt = now + 80;
      }
    }
    if (pressed & IN_ACT1) out.push(K.ENTER);
    if (pressed & IN_ACT2) out.push(K.ESC);
    this.prevPad = bits;
    this.pointer = pointer;
    this.taps = pointer.filter((p) => p.type === 'down');
    return out;
  }
}
