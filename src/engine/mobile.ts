// Mobile helpers: landscape-only presentation, fullscreen and orientation lock.

const ROTATE_CSS = `
#rotate { position: fixed; inset: 0; z-index: 50; display: none; flex-direction: column; align-items: center; justify-content: center;
  gap: 14px; padding: 24px; text-align: center; color: #fff; background: #140c2e; overflow: hidden; }
#rotate .art { position: absolute; inset: -24px; background: center / cover no-repeat; filter: blur(8px) brightness(0.45); }
#rotate > :not(.art) { position: relative; }
#rotate svg { width: 92px; height: 92px; filter: drop-shadow(0 6px 14px rgba(0, 0, 0, 0.5)); }
#rotate .phone { transform-box: view-box; transform-origin: 50px 50px; animation: rotate-phone 2.6s ease-in-out infinite; }
#rotate b { font: 400 26px/1.15 'Lilita One', system-ui, sans-serif; letter-spacing: 0.02em; color: #ffd23f; }
#rotate span { font: 500 15px/1.4 system-ui, sans-serif; color: rgba(255, 255, 255, 0.75); }
@keyframes rotate-phone { 0%, 22% { transform: rotate(0deg); } 48%, 82% { transform: rotate(-90deg); } 100% { transform: rotate(0deg); } }
@media (prefers-reduced-motion: reduce) { #rotate .phone { animation: none; transform: rotate(-90deg); } }
`;

/** A friendly 'turn your phone (tablet) sideways' screen over everything while a touch device is held upright. */
export function setupOrientationOverlay(artUrl?: string): () => boolean {
  const style = document.createElement('style');
  style.textContent = ROTATE_CSS;
  document.head.appendChild(style);
  const el = document.createElement('div');
  el.id = 'rotate';
  const device = Math.min(screen.width, screen.height) >= 600 ? 'tablet' : 'phone';
  el.innerHTML =
    '<div class="art"></div>' +
    '<svg viewBox="0 0 100 100" aria-hidden="true"><g class="phone">' +
    '<rect x="31" y="14" width="38" height="72" rx="8" fill="#2a1d5c" stroke="#fff" stroke-width="4"/>' +
    '<rect x="37" y="22" width="26" height="52" rx="3" fill="#ff9a24"/>' +
    '<circle cx="50" cy="80" r="2.6" fill="#fff"/></g></svg>' +
    `<b>Turn your ${device} sideways</b><span>Boom Buds plays in landscape</span>`;
  if (artUrl) (el.firstChild as HTMLElement).style.backgroundImage = `url(${artUrl})`;
  document.body.appendChild(el);
  const isPortrait = () => {
    const coarse = matchMedia('(pointer: coarse)').matches;
    return coarse && window.innerHeight > window.innerWidth;
  };
  const update = () => {
    el.style.display = isPortrait() ? 'flex' : 'none';
  };
  window.addEventListener('resize', update);
  window.addEventListener('orientationchange', update);
  update();
  return isPortrait;
}

/** Enter fullscreen and lock to landscape where supported (must be called from a user gesture). */
export async function enterFullscreenLandscape(): Promise<void> {
  const doc = document as Document & { webkitFullscreenElement?: Element };
  if (!document.fullscreenElement && !doc.webkitFullscreenElement) {
    const root = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
    try {
      if (root.requestFullscreen) await root.requestFullscreen({ navigationUI: 'hide' });
      else if (root.webkitRequestFullscreen) await root.webkitRequestFullscreen();
    } catch {
      /* not allowed (iOS Safari): fine */
    }
  }
  const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
  try {
    await orientation.lock?.('landscape');
  } catch {
    /* unsupported */
  }
}
