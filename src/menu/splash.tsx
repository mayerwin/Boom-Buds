// Loading screen of the modern menus: the key art, the logo and a progress bar while the sprites download.

import { render } from 'preact';
import './menu.css';
import artUrl from './art/home-bg.webp';
import { Logo } from './logo.tsx';

export interface Splash {
  progress(fraction: number): void;
  done(): void;
}

export function showSplash(): Splash {
  const root = document.createElement('div');
  root.id = 'splash-root';
  document.body.appendChild(root);
  let bar: HTMLDivElement | null = null;
  render(
    <>
      <div class="menu-art" style={{ backgroundImage: `url(${artUrl})` }} />
      <div class="splash-shade" />
      <div class="splash-box">
        <Logo class="splash-logo" />
        <div class="splash-track" role="progressbar" aria-label="loading">
          <div class="splash-bar" ref={(el) => { bar = el; }} />
        </div>
      </div>
    </>,
    root,
  );
  return {
    progress(f) {
      if (bar) bar.style.width = `${Math.round(Math.max(0.04, Math.min(1, f)) * 100)}%`;
    },
    done() {
      render(null, root);
      root.remove();
    },
  };
}
