// Control sets: named ways to play one bomber (a keyboard layout, a gamepad or half of one, the mouse, on-screen
// touch controls). Players pick a set in the Local / Network Game menus; keyboard sets can be edited or created
// in the Controls menu or right from the player setup. Keys are physical positions (KeyboardEvent.code), so
// a set works the same on QWERTY, AZERTY or QWERTZ keyboards; labels come from the keyboard's layout.

import {
  codeFromDik,
  connectedPads,
  padRank,
  dikFromCode,
  IN_ACT1,
  IN_ACT2,
  IN_DOWN,
  IN_LEFT,
  IN_RIGHT,
  IN_UP,
  type Input,
  type PadHalf,
} from '../engine/input.ts';
import { INPUT_JOY, INPUT_KEY, type Slot } from './session.ts';

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
  /**
   * gamepad sets: the gamepad's name (Gamepad.id) and its rank among the connected gamepads of that name, so that
   * a player finds their gamepad again when it reconnects or at the next visit; `half`: one side of it
   */
  padName?: string;
  padRank?: number;
  half?: PadHalf;
  /** touch sets: the whole screen (one player) or one side (two players on one device) */
  side?: 'both' | 'left' | 'right';
  /** shipped with the game (cannot be deleted; can be reset) */
  builtin?: boolean;
}

/** Keyboard sets that work out of the box: up to four players can share one keyboard. */
export const BUILTIN_KEY_SETS: ControlSet[] = [
  { id: 'kb-esdf', name: 'Keyboard left', kind: 'keys', keys: ['KeyE', 'KeyF', 'KeyD', 'KeyS', 'KeyA', 'KeyQ'], builtin: true },
  { id: 'kb-arrows', name: 'Keyboard right', kind: 'keys', keys: ['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'Period', 'Comma'], builtin: true },
  { id: 'kb-ijkl', name: 'Keyboard middle', kind: 'keys', keys: ['KeyI', 'KeyL', 'KeyK', 'KeyJ', 'Semicolon', 'KeyP'], builtin: true },
  { id: 'kb-numpad', name: 'Numpad', kind: 'keys', keys: ['Numpad8', 'Numpad6', 'Numpad5', 'Numpad4', 'Numpad0', 'NumpadEnter'], builtin: true },
];

/** Persisted part: edited built-in sets and the player's own sets. */
export interface ControlPrefs {
  sets: ControlSet[];
}

export function defaultControlPrefs(): ControlPrefs {
  return { sets: BUILTIN_KEY_SETS.map((s) => ({ ...s, keys: [...s.keys!] })) };
}

/** Built-in sets missing from a stored list come back, after the built-in sets it has (before the player's own). */
export function addMissingBuiltins(prefs: ControlPrefs): void {
  for (const d of defaultControlPrefs().sets) {
    if (prefs.sets.some((x) => x.id === d.id)) continue;
    let at = 0;
    prefs.sets.forEach((x, i) => {
      if (x.builtin) at = i + 1;
    });
    prefs.sets.splice(at, 0, d);
  }
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
  // a set on the numpad says so once ("Num 8 4 5 6 · 0 Enter")
  const numpad = keys.length > 0 && keys.every((c) => c.startsWith('Numpad'));
  const k = keys.map((c) => (numpad ? keyLabel(c).replace(/^Num /, '') : keyLabel(c)));
  const arrows = keys[0] === 'ArrowUp' && keys[1] === 'ArrowRight' && keys[2] === 'ArrowDown' && keys[3] === 'ArrowLeft';
  return `${arrows ? 'Arrows' : `${numpad ? 'Num ' : ''}${k[0]} ${k[3]} ${k[2]} ${k[1]}`} · ${k[4]} ${k[5]}`;
}

// ------------------------------------------------------------------------------------- devices

/** A gamepad's name without the vendor/product noise browsers add. */
export function shortPadName(id: string): string {
  let n = id.replace(/\(.*?(Vendor|STANDARD GAMEPAD).*?\)/gi, '').replace(/\s+/g, ' ').trim();
  if (!n) n = 'Gamepad';
  return n.length > 28 ? `${n.slice(0, 27)}…` : n;
}

export function padName(gp: Gamepad): string {
  return shortPadName(gp.id);
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

// ------------------------------------------------------------------------------------- gamepad sets

const PAD_ID = /^pad([LR]?):(\d+):([\s\S]*)$/;

/**
 * Id of the set of the connected gamepad `pads[i]` (the whole pad, or one half): "pad:<rank>:<name>",
 * "padL:..." or "padR:...", where rank counts the gamepads of the same name before it (engine/input.ts padRank).
 */
export function padSetId(pads: Gamepad[], i: number, half?: PadHalf): string {
  return `pad${half === 'left' ? 'L' : half === 'right' ? 'R' : ''}:${padRank(pads[i])}:${pads[i].id}`;
}

export function parsePadId(id: string): { name: string; rank: number; half?: PadHalf } | null {
  const m = PAD_ID.exec(id);
  if (!m) return null;
  return { name: m[3], rank: Number(m[2]), half: m[1] === 'L' ? 'left' : m[1] === 'R' ? 'right' : undefined };
}

/** The connected gamepad of that name and rank (null when it is not connected). */
function padNamed(name: string, rank: number): Gamepad | null {
  for (const gp of connectedPads()) if (gp.id === name && padRank(gp) === rank) return gp;
  return null;
}

/** The connected gamepad of a gamepad set id (null when it is not connected). */
export function padOf(id: string): Gamepad | null {
  const p = parsePadId(id);
  return p ? padNamed(p.name, p.rank) : null;
}

/** The connected gamepad of a gamepad set (null when it is not connected). */
export function padOfSet(set: ControlSet): Gamepad | null {
  return set.padName === undefined ? null : padNamed(set.padName, set.padRank ?? 0);
}

/** Two players can share this gamepad (its layout is known: the standard mapping; not the TV remote). */
export function canSplit(gp: Gamepad): boolean {
  return gp.mapping === 'standard' && gp.id !== TV_REMOTE;
}

/** The same gamepad: the whole pad, or the other half of it. */
export function wholePad(id: string): string {
  const p = parsePadId(id);
  return p ? `pad:${p.rank}:${p.name}` : id;
}

export function otherHalf(id: string): string {
  const p = parsePadId(id);
  if (!p?.half) return id;
  return `pad${p.half === 'left' ? 'R' : 'L'}:${p.rank}:${p.name}`;
}

export function halfOf(id: string, half: PadHalf): string {
  const p = parsePadId(id);
  return p ? `pad${half === 'left' ? 'L' : 'R'}:${p.rank}:${p.name}` : id;
}

/**
 * After a player left: whoever played the other half of their gamepad gets all of it. `ids` are the remaining
 * players' sets; returns them changed, or as they are.
 */
export function mergeHalves(ids: string[], gone: string): string[] {
  if (wholePad(gone) === gone) return ids;
  const other = otherHalf(gone);
  const sharing = ids.filter((id) => wholePad(id) === wholePad(gone));
  return sharing.length === 1 && sharing[0] === other ? ids.map((id) => (id === other ? wholePad(gone) : id)) : ids;
}

/** The TV remote's set. */
export function isRemoteSet(s: ControlSet | null): boolean {
  return !!s && s.kind === 'pad' && s.padName === TV_REMOTE;
}

/** Ids of earlier versions ("pad-0": a place in the browser's list) as ids of today, while that gamepad is there. */
export function migrateSetId(id: string): string | null {
  const old = /^pad-(\d+)$/.exec(id);
  if (!old) return id;
  const pads = connectedPads();
  const n = Number(old[1]);
  return n < pads.length ? padSetId(pads, n) : null;
}

/** Keyboard sets can be played: phones, tablets and TVs offer them once a (Bluetooth or USB) keyboard was used. */
export function keyboardsHere(input: Pick<Input, 'keyboardSeen'>): boolean {
  return !(isTouchOnly() || isTvApp()) || input.keyboardSeen;
}

/**
 * Every set that can be picked on this device right now: keyboard sets, each connected gamepad (whole, or
 * either half of it), the mouse, and touch controls on touch screens.
 */
export function availableSets(prefs: ControlPrefs, input: Input, touch: boolean): ControlSet[] {
  const out: ControlSet[] = [];
  if (keyboardsHere(input)) for (const s of prefs.sets) if (s.kind === 'keys') out.push(s);
  const pads = connectedPads();
  pads.forEach((gp, i) => {
    out.push(findSet(prefs, padSetId(pads, i))!);
    if (canSplit(gp)) for (const h of ['left', 'right'] as const) out.push(findSet(prefs, padSetId(pads, i, h))!);
  });
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

/** The keyboard sets as the original menus number them: KEY 0 and KEY 1, then the other sets in list order. */
export function classicKeySets(prefs: ControlPrefs): ControlSet[] {
  const keys = prefs.sets.filter((s) => s.kind === 'keys');
  const first = CLASSIC_SET_IDS.flatMap((id) => keys.filter((s) => s.id === id));
  return [...first, ...keys.filter((s) => !first.includes(s))];
}

/**
 * The set a human slot plays with on its machine: its own (`ctl`: the modern menus, and the original menus'
 * choices since they offer every set), or else the original's input: the keyboard layout KEY n or the joystick
 * JOY n ("joy-n" when that gamepad is not connected).
 */
export function slotSetId(prefs: ControlPrefs, slot: Slot): string {
  if (slot.ctl) return slot.ctl;
  if (slot.type === INPUT_KEY) return classicKeySets(prefs)[slot.dev]?.id ?? CLASSIC_SET_IDS[slot.dev ? 1 : 0];
  if (slot.type === INPUT_JOY) {
    const pads = connectedPads();
    return slot.dev >= 0 && slot.dev < pads.length ? padSetId(pads, slot.dev) : `joy-${slot.dev}`;
  }
  return '';
}

/**
 * A set as the original menus show it: the input type and device number (KEY n, JOY n; -1 when the gamepad is
 * not connected or the keyboard set is gone) and what follows them in the label (" L" / " R" for half a gamepad);
 * the mouse and touch controls (Boom Buds' additions) have a word.
 */
export function classicInput(prefs: ControlPrefs, id: string): { type: number; dev: number; extra: string; word?: string } {
  const set = findSet(prefs, id);
  if (set?.kind === 'pad') {
    const gp = padOf(id);
    return { type: INPUT_JOY, dev: gp ? connectedPads().indexOf(gp) : -1, extra: set.half === 'left' ? ' L' : set.half === 'right' ? ' R' : '' };
  }
  if (set?.kind === 'mouse') return { type: INPUT_KEY, dev: 0, extra: '', word: 'MOUSE' };
  if (set?.kind === 'touch') return { type: INPUT_KEY, dev: 0, extra: '', word: set.side === 'left' ? 'TOUCH L' : set.side === 'right' ? 'TOUCH R' : 'TOUCH' };
  return { type: INPUT_KEY, dev: classicKeySets(prefs).findIndex((s) => s.id === id), extra: '' };
}

/**
 * What the original menus' player setup goes through, in its order after OFF and AI: KEY 0 and KEY 1 (then the
 * other keyboard sets, when `keyboards` are here), each gamepad (then each half of it), the mouse (`mouse`:
 * unless 1997's mouse is wanted) and the touch controls (`touch`: on touch screens).
 */
export function classicChoices(prefs: ControlPrefs, mouse: boolean, touch: boolean, keyboards = true): string[] {
  const out = classicKeySets(prefs).map((s) => s.id).slice(0, keyboards ? undefined : 2);
  const pads = connectedPads();
  pads.forEach((gp, i) => {
    out.push(padSetId(pads, i));
    if (canSplit(gp)) out.push(padSetId(pads, i, 'left'), padSetId(pads, i, 'right'));
  });
  if (mouse && hasMouse()) out.push('mouse');
  if (touch) out.push('touch', 'touch-left', 'touch-right');
  return out;
}

export function findSet(prefs: ControlPrefs, id: string): ControlSet | null {
  const k = prefs.sets.find((s) => s.id === id);
  if (k) return k;
  const pad = parsePadId(id);
  if (pad) {
    const base = pad.name === TV_REMOTE ? TV_REMOTE : `${shortPadName(pad.name)}${pad.rank ? ` ${pad.rank + 1}` : ''}`;
    return { id, name: pad.half ? `${base} (${pad.half})` : base, kind: 'pad', padName: pad.name, padRank: pad.rank, half: pad.half };
  }
  if (id === 'mouse') return { id, name: 'Mouse', kind: 'mouse' };
  if (id === 'touch' || id === 'touch-left' || id === 'touch-right') {
    const side = id === 'touch' ? 'both' : id === 'touch-left' ? 'left' : 'right';
    return { id, name: side === 'both' ? 'Touch controls' : `Touch, ${side} side`, kind: 'touch', side };
  }
  return null;
}

/** How a set reads, also one this device does not have now ("Gamepad 2" for an id of an earlier version). */
export function setName(prefs: ControlPrefs, id: string): string {
  const legacy = /^pad-(\d+)$/.exec(id);
  return findSet(prefs, id)?.name ?? (legacy ? `Gamepad ${Number(legacy[1]) + 1}` : id);
}

/** Two sets that cannot be used by two players at the same time. */
export function setsClash(a: ControlSet, b: ControlSet): boolean {
  if (a.id === b.id) return true;
  if (a.kind === 'pad' && b.kind === 'pad') return a.padName === b.padName && a.padRank === b.padRank && (!a.half || !b.half || a.half === b.half);
  if (a.kind === 'touch' && b.kind === 'touch') return a.side === 'both' || b.side === 'both' || a.side === b.side;
  if (a.kind === 'keys' && b.kind === 'keys') return a.keys!.some((k) => b.keys!.includes(k));
  return false;
}

/** Two set ids that cannot be played at the same time (unknown ids clash when equal). */
export function idsClash(prefs: ControlPrefs, a: string, b: string): boolean {
  if (a === b) return true;
  const x = findSet(prefs, a), y = findSet(prefs, b);
  return !!x && !!y && setsClash(x, y);
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
