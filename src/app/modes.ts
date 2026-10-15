// 1997 mode. By default Boom Buds plays like a game of today; 1997 mode brings back the original's ways
// (its menus, its hidden mouse, its waits between rounds), either all at once for one visit
// (`?1997` in the address: "Play like it's 1997" in Options or on the main menu, or a shared link), or one
// habit at a time through the settings of the "1997 ways" section, which are kept.

import type { Settings } from './settings.ts';

const PARAM = '1997';

let visit = typeof location !== 'undefined' && new URLSearchParams(location.search).has(PARAM);

/** This visit plays like 1997 (all the 1997 ways at once; the settings are left as they are). */
export function mode1997(): boolean {
  return visit;
}

/** The original menus instead of the modern ones. */
export function originalMenus(st: Settings): boolean {
  return visit || !!st.classicMenus;
}

/** The original's mouse handling in its menus: no cursor (except in dialogs), clicks ignored. */
export function originalMouse(st: Settings): boolean {
  return visit || !!st.classicMouse;
}

/** The original's minimum waits before the screens between rounds can be left. */
export function originalWaits(st: Settings): boolean {
  return visit || !!st.classicWaits;
}

/** Rounds run faster once only computer players are left (a Boom Buds addition, in 1997 mode too). */
export function fastForward(st: Settings): boolean {
  return !!st.fastForward;
}

function addressWith(on: boolean): string {
  const u = new URL(location.href);
  const rest = [...u.searchParams.entries()].filter(([k]) => k !== PARAM);
  const q = rest.map(([k, v]) => (v ? `${encodeURIComponent(k)}=${encodeURIComponent(v)}` : encodeURIComponent(k)));
  if (on) q.push(PARAM);
  return `${u.pathname}${q.length ? `?${q.join('&')}` : ''}${u.hash}`;
}

/** Start playing like 1997 (the address keeps ?1997, so a reload stays in 1997 mode). */
export function enter1997(): void {
  visit = true;
  history.replaceState(history.state, '', addressWith(true));
}

/** Back to today: the page reloads without ?1997. */
export function leave1997(): void {
  visit = false;
  location.replace(addressWith(false));
}
