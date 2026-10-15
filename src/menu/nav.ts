// Keyboard and gamepad navigation for the menus. Arrow keys (or the d-pad / left stick) move the focus to
// the nearest control in that direction; Enter / Space / gamepad A activate it; Escape / gamepad B go
// back. Controls that use Left / Right themselves (steppers, star ratings) handle those keys first.

const FOCUSABLE = 'button:not([disabled]), [tabindex="0"], input:not([disabled]), summary, a[href]';

function visible(el: HTMLElement): boolean {
  if (!el.getClientRects().length) return false;
  const s = getComputedStyle(el);
  return s.visibility !== 'hidden' && s.display !== 'none';
}

/** The element focus should stay inside: the topmost open dialog, else the current screen. */
function scope(root: HTMLElement): HTMLElement {
  const modals = root.querySelectorAll<HTMLElement>('.modal-wrap');
  return modals.length ? modals[modals.length - 1] : root;
}

export function focusables(root: HTMLElement): HTMLElement[] {
  return [...scope(root).querySelectorAll<HTMLElement>(FOCUSABLE)].filter((e) => e.tabIndex >= 0 && visible(e));
}

/** Move the focus to the best candidate in direction (dx, dy). */
export function moveFocus(root: HTMLElement, dx: number, dy: number): void {
  const items = focusables(root);
  const cur = document.activeElement as HTMLElement | null;
  if (!cur || !items.includes(cur)) {
    items[0]?.focus({ preventScroll: false });
    return;
  }
  const a = cur.getBoundingClientRect();
  const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of items) {
    if (el === cur) continue;
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
  best?.focus();
  best?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/** Send a key to the focused element as if it had been pressed (gamepad -> the same handlers as keys). */
/** Is a gamepad there? (Browsers list one only after its first button press.) */
function padsPresent(): boolean {
  return !!navigator.getGamepads && [...navigator.getGamepads()].some((p) => p && p.connected);
}

function synthKey(key: string): boolean {
  const el = (document.activeElement as HTMLElement | null) ?? document.body;
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev.defaultPrevented;
}

export class Nav {
  private root: HTMLElement;
  onBack: () => void = () => {};
  /** a key or gamepad button was used: show focus rings, focus something */
  onKeyboardUse: () => void = () => {};
  private raf = 0;
  private padHeld = new Map<string, number>();
  private padPrev = new Map<number, boolean[]>();
  private active = false;
  /** gets a gamepad button press first (by the pad's place in the browser's list); true = consumed */
  padHook: ((padOrder: number, button: number) => boolean) | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('gamepadconnected', () => this.wake());
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
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.active || e.defaultPrevented) return;
    const t = e.target as HTMLElement | null;
    const typing = t instanceof HTMLInputElement && t.type !== 'checkbox';
    const dir: Record<string, [number, number]> = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    if (dir[e.key]) {
      if (typing && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
      e.preventDefault();
      this.onKeyboardUse();
      moveFocus(this.root, dir[e.key][0], dir[e.key][1]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.onBack();
    } else if ((e.key === 'Enter' || e.key === ' ') && t && !typing && t.tagName !== 'BUTTON' && t.tagName !== 'SUMMARY' && t.tabIndex >= 0) {
      e.preventDefault();
      t.click();
    } else if (e.key === 'Tab') {
      this.onKeyboardUse();
    }
  }

  /** Gamepads: d-pad / stick with key-like repeat, A = activate, B = back. */
  private pollPads(): void {
    this.raf = 0;
    if (!this.active || !padsPresent()) return;
    this.raf = requestAnimationFrame(() => this.pollPads());
    const now = performance.now();
    for (const gp of navigator.getGamepads()) {
      if (!gp || !gp.connected) continue;
      const ax = gp.axes[0] ?? 0, ay = gp.axes[1] ?? 0;
      const b = (n: number) => !!gp.buttons[n]?.pressed;
      const dirs: [string, boolean][] = [
        ['ArrowUp', ay < -0.6 || b(12)],
        ['ArrowDown', ay > 0.6 || b(13)],
        ['ArrowLeft', ax < -0.6 || b(14)],
        ['ArrowRight', ax > 0.6 || b(15)],
      ];
      for (const [key, on] of dirs) {
        const id = `${gp.index}:${key}`;
        const since = this.padHeld.get(id);
        if (!on) {
          this.padHeld.delete(id);
          continue;
        }
        const fire = since === undefined || now - since > 420;
        if (since === undefined) this.padHeld.set(id, now);
        else if (fire) this.padHeld.set(id, now - 300);
        if (fire) {
          this.onKeyboardUse();
          if (!synthKey(key)) moveFocus(this.root, key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : 0, key === 'ArrowUp' ? -1 : key === 'ArrowDown' ? 1 : 0);
        }
      }
      const prev = this.padPrev.get(gp.index) ?? [];
      const pressed = gp.buttons.map((x) => x.pressed);
      const edge = (n: number) => pressed[n] && !prev[n];
      if (this.padHook) {
        // (by index: each getGamepads() call may return new snapshot objects)
        const order = [...navigator.getGamepads()].filter((p) => p && p.connected).findIndex((p) => p!.index === gp.index);
        let consumed = false;
        for (let n = 0; n < pressed.length; n++) if (edge(n) && this.padHook(order, n)) consumed = true;
        if (consumed) {
          this.padPrev.set(gp.index, pressed);
          continue;
        }
      }
      if (edge(0)) {
        this.onKeyboardUse();
        (document.activeElement as HTMLElement | null)?.click();
      }
      if (edge(1)) {
        // B closes the open dialog, as Escape does
        if (this.root.querySelector('.modal-wrap')) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        else this.onBack();
      }
      this.padPrev.set(gp.index, pressed);
    }
  }

  /** Focus the screen's preferred control (data-autofocus), else the first one. */
  focusFirst(): void {
    const items = focusables(this.root);
    const pref = items.find((e) => e.hasAttribute('data-autofocus'));
    (pref ?? items[0])?.focus({ preventScroll: true });
  }
}
