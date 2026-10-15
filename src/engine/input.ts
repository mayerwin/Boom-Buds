// Keyboard / gamepad / pointer input. Keys are tracked as DirectInput scan codes (DIK_*), which is
// what the original game stores in options.ini ("keydef=set,action,scancode").

const CODE_TO_DIK: Record<string, number> = {
  Escape: 0x01, Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06, Digit6: 0x07, Digit7: 0x08,
  Digit8: 0x09, Digit9: 0x0a, Digit0: 0x0b, Minus: 0x0c, Equal: 0x0d, Backspace: 0x0e, Tab: 0x0f,
  KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14, KeyY: 0x15, KeyU: 0x16, KeyI: 0x17, KeyO: 0x18, KeyP: 0x19,
  BracketLeft: 0x1a, BracketRight: 0x1b, Enter: 0x1c, ControlLeft: 0x1d,
  KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22, KeyH: 0x23, KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26,
  Semicolon: 0x27, Quote: 0x28, Backquote: 0x29, ShiftLeft: 0x2a, Backslash: 0x2b,
  KeyZ: 0x2c, KeyX: 0x2d, KeyC: 0x2e, KeyV: 0x2f, KeyB: 0x30, KeyN: 0x31, KeyM: 0x32,
  Comma: 0x33, Period: 0x34, Slash: 0x35, ShiftRight: 0x36, NumpadMultiply: 0x37, AltLeft: 0x38, Space: 0x39,
  CapsLock: 0x3a, F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e, F5: 0x3f, F6: 0x40, F7: 0x41, F8: 0x42, F9: 0x43, F10: 0x44,
  NumLock: 0x45, ScrollLock: 0x46, Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49, NumpadSubtract: 0x4a,
  Numpad4: 0x4b, Numpad5: 0x4c, Numpad6: 0x4d, NumpadAdd: 0x4e, Numpad1: 0x4f, Numpad2: 0x50, Numpad3: 0x51,
  Numpad0: 0x52, NumpadDecimal: 0x53, IntlBackslash: 0x56, F11: 0x57, F12: 0x58, NumpadEnter: 0x9c,
  ControlRight: 0x9d, NumpadDivide: 0xb5, AltRight: 0xb8, Home: 0xc7, ArrowUp: 0xc8, PageUp: 0xc9,
  ArrowLeft: 0xcb, ArrowRight: 0xcd, End: 0xcf, ArrowDown: 0xd0, PageDown: 0xd1, Insert: 0xd2, Delete: 0xd3,
  MetaLeft: 0xdb, MetaRight: 0xdc, ContextMenu: 0xdd,
};

export const DIK = {
  ESCAPE: 0x01, RETURN: 0x1c, SPACE: 0x39, TAB: 0x0f, BACK: 0x0e,
  UP: 0xc8, DOWN: 0xd0, LEFT: 0xcb, RIGHT: 0xcd,
  F1: 0x3b, F10: 0x44, LCONTROL: 0x1d, RCONTROL: 0x9d, LMENU: 0x38, RMENU: 0xb8, LSHIFT: 0x2a, RSHIFT: 0x36,
  NUMPADENTER: 0x9c, A: 0x1e, E: 0x12, N: 0x31, D: 0x20, W: 0x11, Q: 0x10, T: 0x14, O: 0x18, Y: 0x15,
  K0: 0x0b,
} as const;

export function dikFromCode(code: string): number {
  return CODE_TO_DIK[code] ?? 0;
}

const DIK_TO_CODE = new Map(Object.entries(CODE_TO_DIK).map(([code, dik]) => [dik, code]));

/** The KeyboardEvent.code of a scan code ('' when there is none). */
export function codeFromDik(dik: number): string {
  return DIK_TO_CODE.get(dik) ?? '';
}

export interface KeyEventRecord {
  dik: number;
  /** printable character (for name entry), '' otherwise */
  char: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** browser auto-repeat */
  repeat: boolean;
}

export interface PointerRecord {
  /** coordinates in the 640x480 game space */
  x: number;
  y: number;
  type: 'down' | 'up' | 'move';
  button: number;
  /** 'mouse', 'touch' or 'pen' */
  kind: string;
}

/** Input bits per player, same order as the original: up, right, down, left, action1, action2. */
export const IN_UP = 1;
export const IN_RIGHT = 2;
export const IN_DOWN = 4;
export const IN_LEFT = 8;
export const IN_ACT1 = 16;
export const IN_ACT2 = 32;

export class Input {
  /** current key state by DIK code */
  readonly down = new Uint8Array(256);
  /** keys pressed since the game last sampled them */
  readonly latched = new Uint8Array(256);
  /** queued key presses since last poll (for menus / text entry) */
  private keyQueue: KeyEventRecord[] = [];
  private pointerQueue: PointerRecord[] = [];
  pointerX = -1;
  pointerY = -1;
  pointerDown = false;
  /** mouse buttons held (PointerEvent.buttons: 1 left, 2 right, 4 middle) */
  mouseButtons = 0;
  /** a physical keyboard has been used (phones and tablets: a Bluetooth keyboard) */
  keyboardSeen = false;
  /** the HTML menus are open: the keyboard belongs to them */
  suspended = false;
  /** Mapping from client coords to game coords, provided by the renderer layout. */
  toGame: (cx: number, cy: number) => [number, number] = (x, y) => [x, y];
  /** Called on first user gesture (to unlock audio). */
  onGesture: (() => void) | null = null;
  private gestured = false;
  /** Virtual (touch) buttons injected per player slot: bits like IN_*. */
  virtualBits = 0;

  constructor(target: HTMLElement) {
    window.addEventListener('keydown', (e) => this.onKey(e, true), { capture: true });
    window.addEventListener('keyup', (e) => this.onKey(e, false), { capture: true });
    window.addEventListener('blur', () => {
      this.down.fill(0);
      this.latched.fill(0);
    });
    target.addEventListener('pointerdown', (e) => this.onPointer(e, 'down'));
    window.addEventListener('pointerup', (e) => this.onPointer(e, 'up'));
    target.addEventListener('pointermove', (e) => this.onPointer(e, 'move'));
    target.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private gesture(): void {
    if (!this.gestured) {
      this.gestured = true;
    }
    this.onGesture?.();
  }

  private onKey(e: KeyboardEvent, isDown: boolean): void {
    if (isDown) this.keyboardSeen = true;
    if (this.suspended) {
      if (!isDown) this.down[dikFromCode(e.code)] = 0;
      return;
    }
    // a native text field (on-screen keyboard for name entry) handles its own keys
    if (document.activeElement instanceof HTMLInputElement) return;
    const dik = dikFromCode(e.code);
    // Let browser shortcuts like F5/F11/F12 and Ctrl+R/Ctrl+Shift+I through.
    const passthrough = e.code === 'F5' || e.code === 'F11' || e.code === 'F12' || (e.ctrlKey && (e.code === 'KeyR' || e.code === 'KeyW' || (e.shiftKey && e.code === 'KeyI')));
    if (!passthrough) e.preventDefault();
    if (!dik) return;
    // Alt+Enter: full screen (the original always ran full screen)
    if (isDown && e.altKey && (dik === 0x1c || dik === 0x9c)) {
      if (!e.repeat) {
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
        else void document.documentElement.requestFullscreen?.().catch(() => {});
      }
      return;
    }
    if (isDown) {
      this.gesture();
      this.keyboardSeen = true;
      // (browser auto-repeat events are queued too; menus implement GNW's own repeat and skip them)
      this.keyQueue.push({
        dik,
        char: e.key.length === 1 ? e.key : '',
        ctrl: e.ctrlKey,
        alt: e.altKey,
        shift: e.shiftKey,
        repeat: e.repeat,
      });
      // like DirectInput, a key only goes down on a real press: after a flush a held key reads as up
      if (!e.repeat) {
        this.down[dik] = 1;
        this.latched[dik] = 1;
      }
    } else {
      this.down[dik] = 0;
    }
  }

  private onPointer(e: PointerEvent, type: PointerRecord['type']): void {
    const [x, y] = this.toGame(e.clientX, e.clientY);
    this.pointerX = x;
    this.pointerY = y;
    if (e.pointerType === 'mouse') this.mouseButtons = e.buttons;
    if (type === 'down') {
      this.pointerDown = true;
      this.gesture();
    } else if (type === 'up') {
      this.pointerDown = false;
    }
    if (this.pointerQueue.length < 256) this.pointerQueue.push({ x, y, type, button: e.button, kind: e.pointerType || 'mouse' });
  }

  /** Down now, or pressed since the last clearLatched() (so a tap between two game frames counts). */
  held(dik: number): boolean {
    return this.down[dik] !== 0 || this.latched[dik] !== 0;
  }

  clearLatched(): void {
    this.latched.fill(0);
  }

  /** Queue a synthetic key press (on-screen buttons). */
  injectKey(dik: number, ctrl = false): void {
    this.gesture();
    this.keyQueue.push({ dik, char: '', ctrl, alt: false, shift: false, repeat: false });
  }

  /** Take all key presses queued since the last call. */
  takeKeys(): KeyEventRecord[] {
    const k = this.keyQueue;
    this.keyQueue = [];
    return k;
  }

  takePointer(): PointerRecord[] {
    const p = this.pointerQueue;
    this.pointerQueue = [];
    return p;
  }

  /** input_flush's kb_clear: forget which keys are held. */
  clearState(): void {
    this.down.fill(0);
    this.latched.fill(0);
  }

  isDown(dik: number): boolean {
    return this.down[dik] !== 0;
  }

  ctrl(): boolean {
    return this.isDown(DIK.LCONTROL) || this.isDown(DIK.RCONTROL);
  }

  alt(): boolean {
    return this.isDown(DIK.LMENU) || this.isDown(DIK.RMENU);
  }

  /** Connected gamepads in the browser's order (the game's JOY 0, JOY 1, ...). */
  gamepads(): Gamepad[] {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const out: Gamepad[] = [];
    for (const p of pads) if (p && p.connected) out.push(p);
    return out;
  }

  /** Read gamepads; returns IN_* bits for JOY `i` (standard mapping). */
  gamepadBits(i: number): number {
    const gp = this.gamepads()[i];
    if (!gp) return 0;
    let bits = 0;
    const ax = gp.axes[0] ?? 0;
    const ay = gp.axes[1] ?? 0;
    const btn = (n: number) => !!gp.buttons[n]?.pressed;
    if (ay < -0.5 || btn(12)) bits |= IN_UP;
    if (ay > 0.5 || btn(13)) bits |= IN_DOWN;
    if (ax < -0.5 || btn(14)) bits |= IN_LEFT;
    if (ax > 0.5 || btn(15)) bits |= IN_RIGHT;
    if (btn(0) || btn(2)) bits |= IN_ACT1;
    if (btn(1) || btn(3)) bits |= IN_ACT2;
    return bits;
  }

  /** Buttons 1..8 of JOY `i` as the original's joystick button mask (bit k = button k + 1). */
  gamepadButtonMask(i: number): number {
    const gp = this.gamepads()[i];
    if (!gp) return 0;
    let m = 0;
    for (let k = 0; k < 8; k++) if (gp.buttons[k]?.pressed) m |= 1 << k;
    return m;
  }

  gamepadCount(): number {
    return this.gamepads().length;
  }
}
