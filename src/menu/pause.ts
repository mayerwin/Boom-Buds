// The pause menu of a round (Esc, or the ESC button on touch screens). The round stands still while the game
// is paused: in a network game for everybody (src/screens/round.ts), and whoever paused, anyone can resume.

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
  const prev = new Map<number, boolean[]>();
  const close = () => {
    if (closed) return;
    closed = true;
    window.removeEventListener('keydown', onKey, true);
    cancelAnimationFrame(raf);
    panel.remove();
    if (!host.childElementCount) host.classList.remove('open');
  };
  const choose = (i: number) => {
    if (closed || !ready()) return;
    close();
    onChoice(choices[i].value);
  };
  buttons.forEach((b, i) => (b.onclick = () => choose(i)));
  const move = (d: number) => {
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(i + d + buttons.length) % buttons.length].focus();
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
  const poll = () => {
    raf = requestAnimationFrame(poll);
    for (const gp of navigator.getGamepads?.() ?? []) {
      if (!gp) continue;
      const now = gp.buttons.map((b) => b.pressed);
      const was = prev.get(gp.index);
      prev.set(gp.index, now);
      if (!was || !padReady()) continue;
      const edge = (n: number) => now[n] && !was[n];
      if (edge(0)) activate();
      else if (edge(1) || edge(9)) choose(0);
      else if (edge(12)) move(-1);
      else if (edge(13)) move(1);
    }
  };
  raf = requestAnimationFrame(poll);
  return { close };
}
