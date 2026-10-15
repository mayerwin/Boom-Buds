// New releases. A browser may run the game from its cache for a while after a release (GitHub Pages allows
// 10 minutes), so the running build compares its id (written into index.html by the build) with
// version.json on the server:
//  - at start-up, an outdated page reloads at once, before anyone plays;
//  - a game left open checks every 5 minutes and whenever it comes back to the foreground; the new build is
//    then offered in the main menu, and installed there by itself once the menu is left alone; it never
//    interrupts a match.
// Everything the new build needs has new URLs (content hashes, tools/build/versioning.ts), so one reload is
// enough.

import { buildId } from '../engine/build.ts';

const CHECK_MS = 5 * 60_000;
const TRIED_KEY = 'boombuds.update.tried';

let ready = false;
let checking = false;
const listeners = new Set<() => void>();

async function onlineBuild(): Promise<string | null> {
  try {
    const r = await fetch(`${import.meta.env.BASE_URL}version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return null;
    const v = (await r.json()) as { build?: unknown };
    return typeof v.build === 'string' ? v.build : null;
  } catch {
    return null;
  }
}

/** Load the newest build now (refreshing the cached page first: a plain reload could take it again). */
export async function installUpdate(): Promise<void> {
  try {
    await fetch(location.href.split('#')[0], { cache: 'reload' });
  } catch {
    /* offline: the reload will tell */
  }
  location.reload();
}

/** A newer build than the running one is online. */
export function updateReady(): boolean {
  return ready;
}

/** Called once when a newer build is found (the modern menus offer it; without a listener, a notice does). */
export function onUpdateReady(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

async function check(startup: boolean): Promise<void> {
  if (ready || checking) return;
  checking = true;
  const online = await onlineBuild();
  checking = false;
  if (!online || online === buildId()) return;
  if (startup) {
    // once per new build: if something between us and the server still hands out the old page, carry on
    let tried = '';
    try {
      tried = sessionStorage.getItem(TRIED_KEY) ?? '';
      sessionStorage.setItem(TRIED_KEY, online);
    } catch {
      /* no storage: try once anyway */
    }
    if (tried !== online) return installUpdate();
  }
  ready = true;
  if (listeners.size) for (const cb of listeners) cb();
  else showNotice();
}

/** For the original menus: a small button in the corner. */
function showNotice(): void {
  const b = document.createElement('button');
  b.textContent = 'New version available · Reload';
  b.style.cssText =
    'position:fixed;left:50%;top:8px;transform:translateX(-50%);z-index:40;padding:6px 14px;border-radius:999px;border:1px solid rgba(255,210,63,0.6);background:rgba(20,15,44,0.9);color:#ffd23f;font:600 13px system-ui;cursor:pointer;';
  b.onclick = () => void installUpdate();
  document.body.appendChild(b);
}

/** Watch for new builds (production builds only). */
export function watchForUpdates(): void {
  if (!buildId()) return;
  void check(true);
  setInterval(() => void check(false), CHECK_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void check(false);
  });
  window.addEventListener('online', () => void check(false));
}
