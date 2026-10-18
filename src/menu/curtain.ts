// The curtain between a round and the menus. Leaving a match used to end with the last frame of the round
// standing still for a second (the original's end-of-match pause) and then the menus appearing, which looked
// like the game had frozen. Now the match ends at once and this curtain — a bomb with a burning fuse — covers
// the handover, however long the machine takes over it, so that something is always moving on screen.
//
// It is plain DOM, not a menu screen: it is shown from the round (src/screens/round.ts), while the menus are
// not mounted, and taken away once they have drawn their first frame (src/app/Game.ts).

let root: HTMLDivElement | null = null;

const ART = `<svg viewBox="0 0 120 120" aria-hidden="true">
  <path class="fuse" d="M70 34c6-12 18-14 24-6" />
  <circle class="spark" cx="94" cy="28" r="6" />
  <circle class="bomb" cx="54" cy="70" r="34" />
  <circle class="shine" cx="42" cy="58" r="9" />
</svg>`;

/** Show the curtain with a line of text (nothing happens if one is already up). */
export function showCurtain(text: string): void {
  if (root) {
    const line = root.querySelector('b');
    if (line) line.textContent = text;
    return;
  }
  const el = document.createElement('div');
  el.id = 'curtain-root';
  el.setAttribute('role', 'status');
  el.innerHTML = `<div class="curtain-box">${ART}<b></b></div>`;
  el.querySelector('b')!.textContent = text;
  document.body.appendChild(el);
  root = el;
}

/** Is the curtain up? (the game asks before taking it away) */
export function curtainUp(): boolean {
  return !!root;
}

/** Take the curtain away (it fades out). */
export function hideCurtain(): void {
  const el = root;
  if (!el) return;
  root = null;
  el.classList.add('gone');
  setTimeout(() => el.remove(), 220);
}
