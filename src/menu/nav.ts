// Keyboard and gamepad navigation for the menus. The arrow keys (or the d-pad / a stick) always move the focus to
// the nearest control in that direction. Enter (gamepad A) uses the focused control: a button is pressed; a card
// (a player of a line-up: data-group) is entered, its own controls are then reached with the arrows, and Escape
// (B) or an arrow past its edge leaves it; a setting with values to go through (data-edit: steppers, stars, the
// arena) starts being changed: Left / Right change it, and Enter, Escape, Up or Down are done with it. A text
// field keeps Left / Right for its caret once it is typed in (or clicked). Escape (B) goes back.
// In a line-up, holding a button of a gamepad that does not play yet (or the remote's OK) adds a player with it
// (`joinHook`); a short press of that button does its menu job when it is let go.

import { connectedPads, padMenuBits, IN_DOWN, IN_LEFT, IN_RIGHT, IN_UP } from '../engine/input.ts';

const FOCUSABLE = 'button:not([disabled]), [tabindex="0"], input:not([disabled]), summary, a[href]';
const GROUP = '[data-group]';
const EDIT = '[data-edit]';
const DIRS: Record<string, [number, number]> = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
const PAD_DIRS: [number, string][] = [[IN_UP, 'ArrowUp'], [IN_DOWN, 'ArrowDown'], [IN_LEFT, 'ArrowLeft'], [IN_RIGHT, 'ArrowRight']];
/** a gamepad button held this long adds a player (ms) */
export const JOIN_HOLD_MS = 800;
/** a hold starts showing its progress after this long (ms): quick presses show nothing */
const HOLD_SHOW_MS = 150;

/** A player joining with a gamepad: their control set, and the new set of the player they share the gamepad with. */
export interface PadJoin {
  id: string;
  /** how the set reads ("Xbox Wireless Controller (right)") */
  label: string;
  /** the hold it takes (ms) */
  hold: number;
  swap?: { from: string; to: string };
}

export interface JoinHook {
  /** what holding button `button` of `gp` would do (null: the button does its menu job at once) */
  candidate(gp: Gamepad, button: number): PadJoin | null;
  join(j: PadJoin): void;
}

function visible(el: HTMLElement): boolean {
  if (!el.getClientRects().length) return false;
  const s = getComputedStyle(el);
  return s.visibility !== 'hidden' && s.display !== 'none';
}

function isTextField(el: EventTarget | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (el instanceof HTMLTextAreaElement) return true;
  return el instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit', 'range', 'color', 'file'].includes(el.type);
}

/** The element focus should stay inside: the topmost open dialog, else the current screen. */
function scope(root: HTMLElement): HTMLElement {
  const modals = root.querySelectorAll<HTMLElement>('.modal-wrap');
  return modals.length ? modals[modals.length - 1] : root;
}

/** The card an element is inside of (not the card itself), or null. */
function groupOf(el: Element | null, root: HTMLElement): HTMLElement | null {
  const g = el?.parentElement?.closest<HTMLElement>(GROUP) ?? null;
  return g && root.contains(g) ? g : null;
}

/**
 * The controls the arrows go between: inside `group`, its own controls; else every control of the screen (or
 * the open dialog) that is not inside a card, and the cards themselves.
 */
export function focusables(root: HTMLElement, group: HTMLElement | null = null): HTMLElement[] {
  const all = [...scope(root).querySelectorAll<HTMLElement>(FOCUSABLE)].filter((e) => e.tabIndex >= 0 && visible(e));
  if (group) return all.filter((e) => e !== group && group.contains(e));
  return all.filter((e) => !groupOf(e, root));
}

/** The best control in direction (dx, dy) from rectangle `a`: the nearest along the way, then the best aligned. */
function nearest(items: HTMLElement[], a: DOMRect, dx: number, dy: number, skip: HTMLElement | null): HTMLElement | null {
  const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of items) {
    if (el === skip) continue;
    const b = el.getBoundingClientRect();
    const bx = b.left + b.width / 2, by = b.top + b.height / 2;
    // distance along the direction, measured edge to edge so that wide neighbours are reachable
    const along = dx ? (dx > 0 ? b.left - a.right : a.left - b.right) : dy > 0 ? b.top - a.bottom : a.top - b.bottom;
    const centre = dx ? (bx - ax) * dx : (by - ay) * dy;
    if (centre <= 2) continue;
    const across = dx ? Math.abs(by - ay) : Math.abs(bx - ax);
    const overlap = dx ? Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) : Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const score = Math.max(0, along) + across * (overlap > 0 ? 0.3 : 2);
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

/** Is a gamepad there? (Browsers list one only after its first button press.) */
function padsPresent(): boolean {
  return connectedPads().length > 0;
}

/** Send a key to an element as if it had been pressed (gamepad -> the same handlers as keys); true if taken. */
function synthKey(el: Element, key: string, code = ''): boolean {
  const ev = new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev.defaultPrevented;
}

interface Hold {
  since: number;
  join: PadJoin;
  /** the player joined (the release does nothing) */
  done: boolean;
}

export class Nav {
  private root: HTMLElement;
  onBack: () => void = () => {};
  /** a key or gamepad button was used: show focus rings, focus something */
  onKeyboardUse: () => void = () => {};
  private raf = 0;
  /** when a gamepad's direction went down, for its repeat (key: pad index * 4 + direction) */
  private padHeld = new Map<number, number>();
  /** each gamepad's buttons at the last reading (1: pressed) */
  private padPrev = new Map<number, Uint8Array>();
  private active = false;
  private hook: JoinHook | null = null;
  /** gamepad buttons held for a join (key: pad index * 64 + button) */
  private holds = new Map<number, Hold>();
  private holdEl: HTMLDivElement | null = null;
  private holdText: HTMLElement | null = null;
  private holdBar: HTMLElement | null = null;
  /** the setting being changed (data-edit) */
  private editing: HTMLElement | null = null;
  /** the text field being typed in: its caret takes Left / Right */
  private typing: HTMLElement | null = null;
  /** the control being focused by the navigation (a text field reached with the arrows is not typed in yet) */
  private moving: HTMLElement | null = null;
  /** where the focus was, and in which card: to find the nearest control when the focused one goes away */
  private lastRect: DOMRect | null = null;
  private lastGroup: HTMLElement | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('gamepadconnected', () => this.wake());
    root.addEventListener('focusin', (e) => this.onFocusIn(e.target as HTMLElement));
    root.addEventListener('focusout', (e) => this.onFocusOut(e.target as HTMLElement));
    root.addEventListener('input', (e) => {
      if (isTextField(e.target)) this.typing = e.target;
    });
  }

  /** Holding a gamepad's button adds a player (a line-up is open), or null. */
  set joinHook(h: JoinHook | null) {
    this.hook = h;
    // a hold in progress belongs to the screen that started it: its release does nothing any more
    for (const hold of this.holds.values()) hold.done = true;
    this.showHold(null, 0);
  }

  get joinHook(): JoinHook | null {
    return this.hook;
  }

  start(): void {
    this.active = true;
    this.wake();
  }

  /** Poll the gamepads every display frame, but only while one is connected (no wake-ups otherwise). */
  private wake(): void {
    if (this.active && !this.raf && padsPresent()) this.raf = requestAnimationFrame(() => this.pollPads());
  }

  stop(): void {
    this.active = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.endEdit();
    this.forgetPads();
    this.showHold(null, 0);
  }

  /** The gamepads' state goes (a gamepad read again starts afresh: its first reading only notes what is held). */
  private forgetPads(): void {
    this.holds.clear();
    this.padPrev.clear();
    this.padHeld.clear();
  }

  private onFocusIn(t: HTMLElement): void {
    this.typing = isTextField(t) && t !== this.moving ? t : null;
    this.lastRect = t.getBoundingClientRect();
    this.lastGroup = groupOf(t, this.root);
  }

  private onFocusOut(t: HTMLElement): void {
    if (t === this.editing) this.endEdit();
    if (t === this.typing) this.typing = null;
    // the focused control went away (a player removed, a dialog closed): the nearest control takes the focus
    requestAnimationFrame(() => {
      if (!this.active || t.isConnected) return;
      const a = document.activeElement;
      if (a && a !== document.body && this.root.contains(a)) return;
      this.refocus(0, 0);
    });
  }

  /** Focus `el` (and show it), as the navigation does. */
  private focusEl(el: HTMLElement, scroll = true): void {
    this.moving = el;
    el.focus({ preventScroll: true });
    this.moving = null;
    if (scroll) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /**
   * Nothing (of the screen or dialog) has the focus: the control nearest to where it was takes it, in direction
   * (dx, dy) if there is one that way; the screen's first control else.
   */
  private refocus(dx: number, dy: number): void {
    const group = this.lastGroup?.isConnected ? this.lastGroup : null;
    let items = group ? focusables(this.root, group) : [];
    if (!items.length) items = focusables(this.root, null);
    const r = this.lastRect;
    if (!r || !items.length) return this.focusFirst();
    let best = dx || dy ? nearest(items, r, dx, dy, null) : null;
    if (!best) {
      let d = Infinity;
      for (const el of items) {
        const b = el.getBoundingClientRect();
        const e = Math.hypot(b.left + b.width / 2 - (r.left + r.width / 2), b.top + b.height / 2 - (r.top + r.height / 2));
        if (e < d) {
          d = e;
          best = el;
        }
      }
    }
    if (best) this.focusEl(best);
  }

  /** Move the focus in direction (dx, dy): within the card it is in (out of it past its edge), else on the screen. */
  private move(dx: number, dy: number): void {
    const cur = document.activeElement as HTMLElement | null;
    if (!cur || cur === document.body || !scope(this.root).contains(cur)) return this.refocus(dx, dy);
    const group = groupOf(cur, this.root);
    const items = focusables(this.root, group);
    // (focus on something that is no stop of its own, such as a stepper's arrow clicked with the mouse: its stop)
    const from = items.includes(cur) ? cur : items.find((e) => e.contains(cur));
    if (!from) return this.refocus(dx, dy);
    let best = nearest(items, from.getBoundingClientRect(), dx, dy, from);
    if (!best && group) best = nearest(focusables(this.root, null), group.getBoundingClientRect(), dx, dy, group);
    if (best) this.focusEl(best);
  }

  private startEdit(el: HTMLElement): void {
    this.endEdit();
    this.editing = el;
    el.dataset.editing = '';
  }

  private endEdit(): void {
    if (!this.editing) return;
    delete this.editing.dataset.editing;
    this.editing = null;
  }

  /** Into a card: its preferred control (data-autofocus), else its first one. */
  private enterGroup(g: HTMLElement): void {
    const inner = focusables(this.root, g);
    const first = inner.find((e) => e.hasAttribute('data-autofocus')) ?? inner[0];
    if (first) this.focusEl(first);
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.active || e.defaultPrevented) return;
    const t = e.target as HTMLElement | null;
    const dir = DIRS[e.key];
    if (dir) {
      // Left / Right: the caret of a text field being typed in; the value of a setting being changed (an end of it)
      if (dir[0] && t && (t === this.typing || t === this.editing)) return;
      e.preventDefault();
      this.endEdit();
      this.onKeyboardUse();
      this.move(dir[0], dir[1]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (this.editing) return this.endEdit();
      const group = groupOf(t, this.root);
      if (group) return this.focusEl(group);
      this.onBack();
    } else if ((e.key === 'Enter' || e.key === ' ') && t && this.root.contains(t)) {
      if (isTextField(t)) {
        // Enter starts typing (on the TV, OK opens the on-screen keyboard), and is done with it
        if (e.key === 'Enter') this.typing = this.typing === t ? null : t;
        return;
      }
      if (t === this.editing) {
        e.preventDefault();
        return this.endEdit();
      }
      if (t.matches(EDIT)) {
        e.preventDefault();
        return this.startEdit(t);
      }
      if (t.matches(GROUP)) {
        e.preventDefault();
        return this.enterGroup(t);
      }
      if (t.tagName !== 'BUTTON' && t.tagName !== 'SUMMARY' && t.tagName !== 'A' && t.tabIndex >= 0) {
        e.preventDefault();
        t.click();
      }
    } else if (e.key === 'Tab') {
      this.onKeyboardUse();
    }
  }

  /** Gamepad A: as Enter on the focused control (a button is pressed). */
  private activate(): void {
    this.onKeyboardUse();
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body || !this.root.contains(el)) return this.refocus(0, 0);
    if (!synthKey(el, 'Enter')) el.click();
  }

  /** Gamepad B: as Escape (out of a setting or a card, closes a dialog, else back). */
  private back(): void {
    synthKey((document.activeElement as HTMLElement | null) ?? document.body, 'Escape', 'Escape');
  }

  /** What a gamepad button does in the menus. */
  private button(n: number): void {
    if (n === 0) this.activate();
    else if (n === 1) this.back();
  }

  /** Gamepads: d-pad / stick with key-like repeat, A = activate, B = back, holds for joining. */
  private pollPads(): void {
    this.raf = 0;
    if (!this.active || !padsPresent()) {
      this.forgetPads();
      return this.showHold(null, 0);
    }
    this.raf = requestAnimationFrame(() => this.pollPads());
    const now = performance.now();
    const pads = connectedPads();
    let shown: Hold | null = null;
    for (const gp of pads) {
      const bits = padMenuBits(gp);
      for (let d = 0; d < 4; d++) {
        const id = gp.index * 4 + d;
        const since = this.padHeld.get(id);
        if (!(bits & PAD_DIRS[d][0])) {
          if (since !== undefined) this.padHeld.delete(id);
          continue;
        }
        const fire = since === undefined || now - since > 420;
        if (since === undefined) this.padHeld.set(id, now);
        else if (fire) this.padHeld.set(id, now - 300);
        if (fire) {
          this.onKeyboardUse();
          synthKey((document.activeElement as HTMLElement | null) ?? document.body, PAD_DIRS[d][1]);
        }
      }
      const count = Math.min(gp.buttons.length, 64);
      let prev = this.padPrev.get(gp.index);
      // (a gamepad's first reading only notes what is held)
      const first = !prev || prev.length !== count;
      if (first) this.padPrev.set(gp.index, (prev = new Uint8Array(count)));
      for (let n = 0; n < count; n++) {
        // (a button may have started a match: the menus are gone)
        if (!this.active) return;
        const on = gp.buttons[n].pressed ? 1 : 0;
        const was = prev![n];
        prev![n] = on;
        if (first) continue;
        const key = gp.index * 64 + n;
        const hold = this.holds.get(key);
        if (on && !was) {
          const join = this.hook?.candidate(gp, n) ?? null;
          if (join) this.holds.set(key, { since: now, join, done: false });
          else this.button(n);
        } else if (!on && hold) {
          // a short press: what the button does in the menus
          this.holds.delete(key);
          if (!hold.done) this.button(n);
        } else if (on && hold && !hold.done) {
          if (now - hold.since >= hold.join.hold) {
            // (one join per gamepad: its other buttons held meanwhile are done too)
            for (const [k, h] of this.holds) if (Math.floor(k / 64) === gp.index) h.done = true;
            this.hook?.join(hold.join);
          } else if (now - hold.since >= HOLD_SHOW_MS && (!shown || hold.since < shown.since)) shown = hold;
        }
      }
    }
    // gamepads that went away: their holds end, and they start afresh when they come back
    if (this.holds.size) for (const key of this.holds.keys()) if (!pads.some((p) => p.index === Math.floor(key / 64))) this.holds.delete(key);
    if (this.padPrev.size > pads.length) for (const index of this.padPrev.keys()) if (!pads.some((p) => p.index === index)) this.padPrev.delete(index);
    this.showHold(shown, now);
  }

  /** The progress of the longest hold for a join (null: none). */
  private showHold(h: Hold | null, now: number): void {
    if (!h) {
      if (this.holdEl) {
        this.holdEl.remove();
        this.holdEl = this.holdText = this.holdBar = null;
      }
      return;
    }
    if (!this.holdEl) {
      const el = document.createElement('div');
      el.className = 'hold-join';
      el.setAttribute('role', 'status');
      el.innerHTML = '<span></span><i><b></b></i>';
      document.body.appendChild(el);
      this.holdEl = el;
      this.holdText = el.querySelector('span');
      this.holdBar = el.querySelector('b');
    }
    const text = h.join.swap ? `Keep holding: a second player on this gamepad · ${h.join.label}` : `Keep holding to join · ${h.join.label}`;
    if (this.holdText!.textContent !== text) this.holdText!.textContent = text;
    const f = Math.min(1, (now - h.since - HOLD_SHOW_MS) / Math.max(1, h.join.hold - HOLD_SHOW_MS));
    this.holdBar!.style.transform = `scaleX(${f.toFixed(3)})`;
  }

  /** Focus the screen's preferred control (data-autofocus), else the first one. */
  focusFirst(): void {
    const items = focusables(this.root);
    const pref = items.find((e) => e.hasAttribute('data-autofocus'));
    const el = pref ?? items[0];
    if (el) this.focusEl(el, false);
  }
}
