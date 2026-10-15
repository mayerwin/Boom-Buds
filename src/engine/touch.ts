// On-screen controls for phones and tablets, in the side bars left and right of the 4:3 game picture.
// One player: the stick on the left, the two action buttons on the right. Two players on one device: each
// side bar is one player's controls (special button, stick, bomb button from top to bottom).

import { IN_UP, IN_DOWN, IN_LEFT, IN_RIGHT, IN_ACT1, IN_ACT2 } from './input.ts';

const LONG_PRESS_MS = 700;

/** One player's stick and buttons. */
class Unit {
  readonly pad: HTMLDivElement;
  readonly knob: HTMLDivElement;
  readonly btnA: HTMLDivElement;
  readonly btnB: HTMLDivElement;
  pointer = -1;
  center = { x: 0, y: 0 };
  radius = 60;
  dirBits = 0;
  aDown = new Set<number>();
  bDown = new Set<number>();

  constructor(root: HTMLElement, el: (css: string) => HTMLDivElement) {
    this.pad = el('position:absolute;border-radius:50%;background:rgba(255,255,255,0.10);border:2px solid rgba(255,255,255,0.25);pointer-events:auto;');
    this.knob = document.createElement('div');
    this.knob.style.cssText = 'position:absolute;border-radius:50%;background:rgba(255,255,255,0.35);pointer-events:none;';
    this.pad.appendChild(this.knob);
    const btn = (bg: string, label: string) => {
      const b = el(`position:absolute;border-radius:50%;background:${bg};border:2px solid rgba(255,255,255,0.35);pointer-events:auto;color:#fff;font:bold 20px system-ui;display:flex;align-items:center;justify-content:center;user-select:none;`);
      b.textContent = label;
      return b;
    };
    this.btnA = btn('rgba(255,80,60,0.35)', 'A');
    this.btnB = btn('rgba(60,140,255,0.35)', 'B');
    root.append(this.pad, this.btnA, this.btnB);
    this.pad.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.pointer = e.pointerId;
      this.pad.setPointerCapture(e.pointerId);
      this.move(e.clientX, e.clientY);
    });
    this.pad.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.pointer) this.move(e.clientX, e.clientY);
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.pointer) return;
      this.pointer = -1;
      this.dirBits = 0;
      this.knob.style.transform = 'translate(0px, 0px)';
    };
    this.pad.addEventListener('pointerup', end);
    this.pad.addEventListener('pointercancel', end);
    this.button(this.btnA, this.aDown);
    this.button(this.btnB, this.bDown);
  }

  private button(el: HTMLDivElement, set: Set<number>): void {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      set.add(e.pointerId);
      el.style.filter = 'brightness(1.8)';
      navigator.vibrate?.(8);
    });
    const up = (e: PointerEvent) => {
      set.delete(e.pointerId);
      if (set.size === 0) el.style.filter = '';
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  private move(cx: number, cy: number): void {
    const dx = cx - this.center.x;
    const dy = cy - this.center.y;
    const dist = Math.hypot(dx, dy);
    const max = this.radius * 0.6;
    const k = dist > max ? max / dist : 1;
    this.knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
    let bits = 0;
    if (dist > this.radius * 0.22) {
      // 8-way: a direction is active when the angle is within 67.5 degrees of its axis
      const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
      if (deg > -67.5 && deg < 67.5) bits |= IN_RIGHT;
      if (deg > 112.5 || deg < -112.5) bits |= IN_LEFT;
      if (deg > 22.5 && deg < 157.5) bits |= IN_DOWN;
      if (deg < -22.5 && deg > -157.5) bits |= IN_UP;
    }
    this.dirBits = bits;
  }

  bits(): number {
    let b = this.dirBits;
    if (this.aDown.size) b |= IN_ACT1;
    if (this.bDown.size) b |= IN_ACT2;
    return b;
  }

  reset(): void {
    this.dirBits = 0;
    this.pointer = -1;
    this.aDown.clear();
    this.bDown.clear();
    this.knob.style.transform = 'translate(0px, 0px)';
  }

  placePad(cx: number, cy: number, r: number, opacity: string): void {
    this.radius = r;
    this.center = { x: cx, y: cy };
    Object.assign(this.pad.style, { left: `${cx - r}px`, top: `${cy - r}px`, width: `${2 * r}px`, height: `${2 * r}px`, opacity });
    const kr = r * 0.8;
    Object.assign(this.knob.style, { left: `${r - kr / 2}px`, top: `${r - kr / 2}px`, width: `${kr}px`, height: `${kr}px` });
  }

  static placeButton(el: HTMLDivElement, cx: number, cy: number, b: number, opacity: string): void {
    Object.assign(el.style, { left: `${cx - b / 2}px`, top: `${cy - b / 2}px`, width: `${b}px`, height: `${b}px`, opacity, fontSize: `${Math.round(b * 0.36)}px` });
  }

  show(on: boolean): void {
    for (const e of [this.pad, this.btnA, this.btnB]) e.style.display = on ? 'flex' : 'none';
    this.pad.style.display = on ? 'block' : 'none';
  }
}

export class TouchControls {
  readonly root: HTMLDivElement;
  private units: Unit[];
  /** 1: one player (stick left, buttons right); 2: one player per side bar */
  private players: 1 | 2 = 1;
  visible = false;
  private menuBtn: HTMLDivElement;
  /** ESC button: `long` when it was held for LONG_PRESS_MS (quits a round, like Ctrl-Q) */
  onMenu: ((long: boolean) => void) | null = null;
  private menuDownAt = 0;
  private menuTimer = 0;
  private last: { vw: number; vh: number; game: { x: number; y: number; w: number; h: number } } | null = null;

  constructor(parent: HTMLElement) {
    const root = document.createElement('div');
    root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:10;display:none;touch-action:none;';
    this.root = root;
    const el = (css: string) => {
      const d = document.createElement('div');
      d.style.cssText = css;
      return d;
    };
    this.units = [new Unit(root, el), new Unit(root, el)];
    this.menuBtn = el('position:absolute;border-radius:8px;background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.3);pointer-events:auto;color:#fff;font:bold 14px system-ui;display:flex;align-items:center;justify-content:center;user-select:none;');
    this.menuBtn.textContent = 'ESC';
    root.append(this.menuBtn);
    parent.appendChild(root);
    this.menuBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.menuBtn.setPointerCapture(e.pointerId);
      this.menuDownAt = performance.now();
      this.menuBtn.style.background = 'rgba(255,255,255,0.4)';
      clearTimeout(this.menuTimer);
      this.menuTimer = window.setTimeout(() => {
        if (!this.menuDownAt) return;
        this.menuDownAt = 0;
        this.menuBtn.style.background = 'rgba(255,80,60,0.6)';
        navigator.vibrate?.(30);
        this.onMenu?.(true);
      }, LONG_PRESS_MS);
    });
    const menuUp = () => {
      clearTimeout(this.menuTimer);
      this.menuBtn.style.background = 'rgba(255,255,255,0.15)';
      if (!this.menuDownAt) return;
      this.menuDownAt = 0;
      this.onMenu?.(false);
    };
    this.menuBtn.addEventListener('pointerup', menuUp);
    this.menuBtn.addEventListener('pointercancel', menuUp);
    this.units[1].show(false);
  }

  /** IN_* bits of the on-screen controls: the whole set (one player) or one side bar (two players). */
  bits(side: 'both' | 'left' | 'right' = 'both'): number {
    if (this.players === 1) return side === 'right' ? 0 : this.units[0].bits();
    return side === 'right' ? this.units[1].bits() : side === 'left' ? this.units[0].bits() : this.units[0].bits() | this.units[1].bits();
  }

  /** One player or two players on this device. */
  setPlayers(n: 1 | 2): void {
    if (this.players === n) return;
    this.players = n;
    this.units[1].show(n === 2);
    for (const u of this.units) u.reset();
    if (this.last) this.layout(this.last.vw, this.last.vh, this.last.game);
  }

  show(on: boolean): void {
    this.visible = on;
    this.root.style.display = on ? 'block' : 'none';
    if (!on) for (const u of this.units) u.reset();
  }

  /**
   * Lay out the controls (CSS pixels): in the side bars left and right of the 4:3 picture when they are
   * wide enough (phones in landscape), otherwise over the bottom corners of the picture (tablets).
   */
  layout(vw: number, vh: number, game: { x: number; y: number; w: number; h: number }): void {
    this.last = { vw, vh, game };
    const sideL = game.x;
    const sideR = vw - (game.x + game.w);
    const margin = Math.max(8, Math.min(vw, vh) * 0.03);
    const m = 44;
    Object.assign(this.menuBtn.style, { left: `${vw - m - margin}px`, top: `${margin}px`, width: `${m}px`, height: `${m * 0.7}px` });
    if (this.players === 2) {
      this.layoutColumn(this.units[0], sideL / 2, sideL, vh, margin, false);
      this.layoutColumn(this.units[1], vw - sideR / 2, sideR, vh, margin, true);
      return;
    }
    const u = this.units[0];
    // stick
    let r = Math.min((sideL - 2 * margin) / 2, vh * 0.3, 110);
    const padOverlay = r < 50;
    if (padOverlay) r = Math.min(vh * 0.17, 90);
    r = Math.max(r, 40);
    u.placePad(padOverlay ? margin + r : sideL / 2, vh - margin - r - vh * 0.04, r, padOverlay ? '0.7' : '1');
    // A (drop bomb) low on the right, B (action) above and to the left of it
    let b = Math.min((sideR - 2 * margin) * 0.62, vh * 0.24, 96);
    const btnOverlay = b < 48;
    if (btnOverlay) b = Math.min(vh * 0.15, 72);
    b = Math.max(b, 44);
    const col = btnOverlay ? vw - margin - b * 0.9 : vw - sideR / 2;
    const aCX = col + (btnOverlay ? 0 : b * 0.18);
    const aCY = vh - margin - b / 2 - vh * 0.06;
    const op = btnOverlay ? '0.7' : '1';
    Unit.placeButton(u.btnA, aCX, aCY, b, op);
    Unit.placeButton(u.btnB, col - b * (btnOverlay ? 1.15 : 0.32), aCY - b * 1.05, b, op);
  }

  /** Two players: one column per side bar, special button on top, the stick, the bomb button below. */
  private layoutColumn(u: Unit, cx: number, width: number, vh: number, margin: number, right: boolean): void {
    const overlay = width < 100;
    const x = overlay ? (right ? cx - 70 : cx + 70) : cx;
    const r = Math.max(36, Math.min((width - margin * 2) / 2, vh * 0.2, 90));
    const b = Math.max(40, Math.min(width - margin * 2, vh * 0.16, 76));
    const op = overlay ? '0.7' : '1';
    u.placePad(x, vh / 2, r, op);
    Unit.placeButton(u.btnB, x, vh / 2 - r - margin - b / 2, b, op);
    Unit.placeButton(u.btnA, x, vh / 2 + r + margin + b / 2, b, op);
  }
}

/** A phone or tablet: the primary pointer is a finger and there is no mouse. */
export function isTouchDevice(): boolean {
  return matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
}
