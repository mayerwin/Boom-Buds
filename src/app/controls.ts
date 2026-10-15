// Control sets: named ways to play one bomber (a keyboard layout, a gamepad, the mouse, on-screen touch
// controls). Players pick a set in the Local / Network Game menus; keyboard sets can be edited or created
// in the Controls menu or right from the player setup. Keys are physical positions (KeyboardEvent.code), so
// a set works the same on QWERTY, AZERTY or QWERTZ keyboards; labels come from the keyboard's layout.

import { codeFromDik, dikFromCode, IN_ACT1, IN_ACT2, IN_DOWN, IN_LEFT, IN_RIGHT, IN_UP, type Input } from '../engine/input.ts';

export type ControlKind = 'keys' | 'pad' | 'mouse' | 'touch';

/** Actions in input-bit order: up, right, down, left, bomb, special. */
export const ACTIONS = ['up', 'right', 'down', 'left', 'bomb', 'special'] as const;
export const ACTION_LABELS = ['Up', 'Right', 'Down', 'Left', 'Bomb', 'Special'];

export interface ControlSet {
  id: string;
  name: string;
  kind: ControlKind;
  /** keyboard sets: KeyboardEvent.code per action (ACTIONS order) */
  keys?: string[];
  /** gamepad sets: index in navigator.getGamepads() order */
  pad?: number;
  /** touch sets: the whole screen (one player) or one side (two players on one device) */
  side?: 'both' | 'left' | 'right';
  /** shipped with the game (cannot be deleted; can be reset) */
  builtin?: boolean;
}

/** Keyboard sets that work out of the box: two players can share one keyboard. */
export const BUILTIN_KEY_SETS: ControlSet[] = [
  { id: 'kb-esdf', name: 'Keyboard left', kind: 'keys', keys: ['KeyE', 'KeyF', 'KeyD', 'KeyS', 'KeyA', 'KeyQ'], builtin: true },
  { id: 'kb-arrows', name: 'Keyboard right', kind: 'keys', keys: ['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'Period', 'Comma'], builtin: true },
];

/** Persisted part: edited built-in sets and the player's own sets. */
export interface ControlPrefs {
  sets: ControlSet[];
}

export function defaultControlPrefs(): ControlPrefs {
  return { sets: BUILTIN_KEY_SETS.map((s) => ({ ...s, keys: [...s.keys!] })) };
}

// ------------------------------------------------------------------------------------- key labels

/** Layout map of the keyboard (Chromium: navigator.keyboard), filled asynchronously. */
let layout: Map<string, string> | null = null;
export async function loadKeyboardLayout(): Promise<void> {
  try {
    const kb = (navigator as unknown as { keyboard?: { getLayoutMap(): Promise<Map<string, string>> } }).keyboard;
    if (kb?.getLayoutMap) layout = new Map(await kb.getLayoutMap());
  } catch {
    layout = null;
  }
}

const NAMED: Record<string, string> = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'Space', Enter: 'Enter', NumpadEnter: 'Num Enter',
  ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift', ControlLeft: 'L-Ctrl', ControlRight: 'R-Ctrl', AltLeft: 'L-Alt', AltRight: 'R-Alt',
  Tab: 'Tab', Backspace: '⌫', CapsLock: 'Caps', Escape: 'Esc', Insert: 'Ins', Delete: 'Del', Home: 'Home', End: 'End',
  PageUp: 'PgUp', PageDown: 'PgDn', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[',
  BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`', IntlBackslash: '<',
};

/** What is printed on the key at physical position `code` on this keyboard. */
export function keyLabel(code: string): string {
  const fromLayout = layout?.get(code);
  if (fromLayout && fromLayout.trim()) return fromLayout.length === 1 ? fromLayout.toUpperCase() : fromLayout;
  if (NAMED[code]) return NAMED[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return code;
}

/** Short summary of a keyboard set: the movement keys, then bomb and special ("E S D F · A Q", "Arrows · . ,"). */
export function keysSummary(keys: string[]): string {
  const k = keys.map(keyLabel);
  const arrows = keys[0] === 'ArrowUp' && keys[1] === 'ArrowRight' && keys[2] === 'ArrowDown' && keys[3] === 'ArrowLeft';
  return `${arrows ? 'Arrows' : `${k[0]} ${k[3]} ${k[2]} ${k[1]}`} · ${k[4]} ${k[5]}`;
}

// ------------------------------------------------------------------------------------- devices

/** Name of a gamepad without the vendor/product noise browsers add. */
export function padName(gp: Gamepad): string {
  let n = gp.id.replace(/\(.*?(Vendor|STANDARD GAMEPAD).*?\)/gi, '').replace(/\s+/g, ' ').trim();
  if (!n) n = 'Gamepad';
  return n.length > 28 ? `${n.slice(0, 27)}…` : n;
}

/** Whether a mouse (fine pointer) is present: then the mouse can play a bomber. */
export function hasMouse(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(any-pointer: fine)').matches;
}

/** The Android TV app (android/): its remote and gamepads arrive as gamepads (android/tv/tv.js). */
export function isTvApp(): boolean {
  return typeof window !== 'undefined' && !!(window as unknown as { AndroidHost?: unknown }).AndroidHost;
}

/** The TV app's remote, as a gamepad (its id in android/tv/tv.js) */
export const TV_REMOTE = 'TV remote';

/** a press of the remote's OK at least this long is the special button (ms) */
export const REMOTE_HOLD_MS = 300;

/**
 * The TV remote's single action button in a round. OK is the bomb button, as on any other controller: a bomb
 * at once, held as long as OK is (to carry a grabbed bomb). When the special button has a use for the bomber at
 * that moment (the boxing glove's punch, trigger bombs, a kicked bomb still sliding to stop), a long press is
 * the special instead, and a short press is the bomb button when OK is let go. The kind of press is decided
 * when OK goes down. A press already down when the round starts or resumes is ignored until it is let go.
 * Only the remote's player is concerned: every other controller keeps its own two buttons.
 */
export class RemoteButton {
  private downAt = -1;
  /** this press can be the special (decided when OK went down) */
  private dual = false;
  private tapUntil = 0;
  private waitRelease = true;

  /** Input bits from the remote's gamepad bits (OK = IN_ACT1); `special`: the special button has a use now. */
  bits(raw: number, special: boolean, now: number): number {
    const ok = !!(raw & IN_ACT1);
    let out = raw & ~(IN_ACT1 | IN_ACT2);
    if (this.waitRelease) {
      if (!ok) this.waitRelease = false;
      return out;
    }
    if (now < this.tapUntil) out |= IN_ACT1; // a short press, let go: the bomb button
    if (!ok) {
      if (this.downAt >= 0 && this.dual && now - this.downAt < REMOTE_HOLD_MS) {
        this.tapUntil = now + 50; // (a few simulation ticks see it)
        out |= IN_ACT1;
      }
      this.downAt = -1;
      return out;
    }
    if (this.downAt < 0) {
      this.downAt = now;
      this.dual = special;
    }
    if (!this.dual) return out | IN_ACT1;
    return now - this.downAt >= REMOTE_HOLD_MS ? out | IN_ACT2 : out;
  }

  /** The pause menu is open: forget the press, wait for OK to be let go. */
  suspend(): void {
    this.downAt = -1;
    this.tapUntil = 0;
    this.waitRelease = true;
  }
}

export function isTouchOnly(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches && !hasMouse();
}

/**
 * Every set that can be picked on this device right now: keyboard sets, one per connected gamepad, the
 * mouse, and touch controls on touch screens.
 */
export function availableSets(prefs: ControlPrefs, input: Input, touch: boolean): ControlSet[] {
  const out: ControlSet[] = [];
  // phones and tablets offer keyboard sets once a (Bluetooth) keyboard has been used
  if (!isTouchOnly() || input.keyboardSeen) for (const s of prefs.sets) if (s.kind === 'keys') out.push(s);
  input.gamepads().forEach((gp, i) => out.push({ id: `pad-${i}`, name: padName(gp), kind: 'pad', pad: i }));
  if (hasMouse()) out.push({ id: 'mouse', name: 'Mouse', kind: 'mouse' });
  if (touch) {
    out.push({ id: 'touch', name: 'Touch controls', kind: 'touch', side: 'both' });
    out.push({ id: 'touch-left', name: 'Touch, left side', kind: 'touch', side: 'left' });
    out.push({ id: 'touch-right', name: 'Touch, right side', kind: 'touch', side: 'right' });
  }
  return out;
}

// ------------------------------------------------------------------- the original menus' layouts

/**
 * The original menus' keyboard layouts KEY 0 and KEY 1 are the sets "Keyboard right" and "Keyboard left":
 * one set of keys whatever the menus, changed from either.
 */
export const CLASSIC_SET_IDS = ['kb-arrows', 'kb-esdf'] as const;

function classicSet(prefs: ControlPrefs, layout: number): ControlSet {
  const id = CLASSIC_SET_IDS[layout];
  let set = prefs.sets.find((s) => s.id === id);
  if (!set) {
    set = { ...BUILTIN_KEY_SETS.find((s) => s.id === id)!, keys: [...BUILTIN_KEY_SETS.find((s) => s.id === id)!.keys!] };
    prefs.sets.unshift(set);
  }
  return set;
}

/** KEY 0 and KEY 1 as the original stores them: scan codes of up, right, down, left, action 1, action 2. */
export function classicLayouts(prefs: ControlPrefs): number[][] {
  return [0, 1].map((L) => {
    const keys = classicSet(prefs, L).keys ?? [];
    return Array.from({ length: 10 }, (_, a) => (a < 6 && keys[a] ? dikFromCode(keys[a]) : 0));
  });
}

/** The keydefs screen of the original menus changes key `action` of layout `layout` (a scan code). */
export function setClassicKey(prefs: ControlPrefs, layout: number, action: number, dik: number): void {
  const code = codeFromDik(dik);
  if (!code || action < 0 || action > 5) return;
  const set = classicSet(prefs, layout);
  const keys = [...(set.keys ?? [])];
  keys[action] = code;
  set.keys = keys;
}

/** "Return to default keys" of the original menus: both layouts as they came. */
export function resetClassicLayouts(prefs: ControlPrefs): void {
  for (let L = 0; L < 2; L++) classicSet(prefs, L).keys = [...BUILTIN_KEY_SETS.find((s) => s.id === CLASSIC_SET_IDS[L])!.keys!];
}

export function findSet(prefs: ControlPrefs, id: string): ControlSet | null {
  const k = prefs.sets.find((s) => s.id === id);
  if (k) return k;
  const pad = /^pad-(\d+)$/.exec(id);
  if (pad) {
    const n = Number(pad[1]);
    // the TV app's remote goes by its name: it is not much of a gamepad
    const gp = isTvApp() ? [...navigator.getGamepads()].filter((p) => p && p.connected)[n] : null;
    return { id, name: gp?.id === TV_REMOTE ? TV_REMOTE : `Gamepad ${n + 1}`, kind: 'pad', pad: n };
  }
  if (id === 'mouse') return { id, name: 'Mouse', kind: 'mouse' };
  if (id === 'touch' || id === 'touch-left' || id === 'touch-right') {
    const side = id === 'touch' ? 'both' : id === 'touch-left' ? 'left' : 'right';
    return { id, name: side === 'both' ? 'Touch controls' : `Touch, ${side} side`, kind: 'touch', side };
  }
  return null;
}

/** Two sets that cannot be used by two players at the same time. */
export function setsClash(a: ControlSet, b: ControlSet): boolean {
  if (a.id === b.id) return true;
  if (a.kind === 'touch' && b.kind === 'touch') return a.side === 'both' || b.side === 'both' || a.side === b.side;
  if (a.kind === 'keys' && b.kind === 'keys') return a.keys!.some((k) => b.keys!.includes(k));
  return false;
}

/** The set a key press or gamepad button belongs to (for "press a key to join"). */
export function setForKey(prefs: ControlPrefs, code: string): ControlSet | null {
  return prefs.sets.find((s) => s.kind === 'keys' && s.keys!.includes(code)) ?? null;
}

// ------------------------------------------------------------------------------------- sampling

/** Input bits of a keyboard set (keys held now or pressed since the last game frame). */
export function keyBits(input: Input, keys: string[]): number {
  const bits = [IN_UP, IN_RIGHT, IN_DOWN, IN_LEFT, IN_ACT1, IN_ACT2];
  let out = 0;
  for (let i = 0; i < 6; i++) {
    const dik = dikFromCode(keys[i]);
    if (dik && input.held(dik)) out |= bits[i];
  }
  return out;
}

/**
 * Mouse play: the bomber walks toward the pointer (along the axis where it is farther away), left button
 * drops a bomb, right button is the special action.
 */
export function mouseBits(input: Input, px: number, py: number): number {
  let out = 0;
  if (input.mouseButtons & 1) out |= IN_ACT1;
  if (input.mouseButtons & 2) out |= IN_ACT2;
  if (input.pointerX < 0) return out;
  const dx = input.pointerX - px;
  const dy = input.pointerY - (py - 18);
  const DEAD = 10;
  if (Math.abs(dx) < DEAD && Math.abs(dy) < DEAD) return out;
  if (Math.abs(dx) >= Math.abs(dy)) out |= dx > 0 ? IN_RIGHT : IN_LEFT;
  else out |= dy > 0 ? IN_DOWN : IN_UP;
  return out;
}
