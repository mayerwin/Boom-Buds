// The pause menu of a round (Esc, or the ESC button on touch screens). The round stands still while the game
// is paused: in a network game for everybody (src/screens/round.ts), and whoever paused, anyone can resume.

import { connectedPads } from '../engine/input.ts';
import { K, PadKeys } from '../ui/menuInput.ts';

const ROOT_ID = 'pause-root';

export interface PauseChoice<T> {
  label: string;
  value: T;
  danger?: boolean;
}

export interface PauseMenu {
  /** Close the menu without a choice (the game resumed, or the round ended). */
  close(): void;
}

/**
 * Show the menu; `onChoice` gets the choice, once the menu has closed. Escape / gamepad B pick the first
 * choice. For `graceMs` after it opens, the menu ignores keys, buttons and clicks (it opened because someone
 * else paused: a bomb button pressed at that moment must not choose for the player), and the gamepads for
 * `padGraceMs` (another player of this device may be pressing a bomb button).
 */
export function openPauseMenu<T>(
  title: string,
  note: string,
  choices: PauseChoice<T>[],
  onChoice: (v: T) => void,
  graceMs = 0,
  padGraceMs = graceMs,
): PauseMenu {
  let root = document.getElementById(ROOT_ID);
  if (!root) {
    root = document.createElement('div');
    root.id = ROOT_ID;
    document.body.appendChild(root);
  }
  const host = root;
  const panel = document.createElement('div');
  panel.className = 'panel';
  const h = document.createElement('h2');
  h.textContent = title;
  panel.appendChild(h);
  if (note) {
    const p = document.createElement('div');
    p.className = 'small muted';
    p.textContent = note;
    panel.appendChild(p);
  }
  const buttons = choices.map((c, i) => {
    const b = document.createElement('button');
    b.className = `btn ${i === 0 ? 'primary' : ''} ${c.danger ? 'danger' : ''}`;
    b.textContent = c.label;
    panel.appendChild(b);
    return b;
  });
  host.appendChild(panel);
  host.classList.add('open');
  buttons[0].focus();
  const t0 = performance.now();
  const ready = () => performance.now() >= t0 + graceMs;
  const padReady = () => performance.now() >= t0 + Math.max(graceMs, padGraceMs);
  let raf = 0;
  let closed = false;
  const startWas = new Map<number, boolean>();
  const close = () => {
    if (closed) return;
    closed = true;
    window.removeEventListener('keydown', onKey, true);
    cancelAnimationFrame(raf);
    panel.remove();
    if (!host.childElementCount) host.classList.remove('open', 'kbd');
  };
  const choose = (i: number) => {
    if (closed || !ready()) return;
    close();
    onChoice(choices[i].value);
  };
  buttons.forEach((b, i) => (b.onclick = () => choose(i)));
  const move = (d: number) => {
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[i < 0 ? 0 : (i + d + buttons.length) % buttons.length].focus();
  };
  const activate = () => {
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (i >= 0) choose(i);
  };
  const onKey = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat || !ready()) return;
    if (e.key === 'Escape') choose(0);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'Tab') move(1);
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') move(-1);
    else if (e.key === 'Enter' || e.key === ' ') activate();
  };
  window.addEventListener('keydown', onKey, true);
  // gamepads and the TV remote: the d-pad or a stick move, A chooses, B, Start or Select resume
  const keys = new PadKeys();
  const poll = (t: number) => {
    raf = requestAnimationFrame(poll);
    const codes = keys.poll(t);
    let start = false;
    for (const gp of connectedPads()) {
      const on = !!gp.buttons[9]?.pressed || !!gp.buttons[8]?.pressed;
      const was = startWas.get(gp.index);
      startWas.set(gp.index, on);
      if (on && was === false) start = true;
    }
    if (!padReady() || closed) return;
    if (start) return choose(0);
    // (a focus ring for whoever moves with a gamepad, even after a click)
    if (codes.length) host.classList.add('kbd');
    for (const k of codes) {
      if (closed) return;
      if (k === K.ENTER) activate();
      else if (k === K.ESC) choose(0);
      else if (k === K.UP || k === K.LEFT) move(-1);
      else if (k === K.DOWN || k === K.RIGHT) move(1);
    }
  };
  raf = requestAnimationFrame(poll);
  return { close };
}
