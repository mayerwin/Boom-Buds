// The main menu: the logo, the two ways to play as big tiles (with a one-click rematch of the last local
// line-up), the secondary screens, and a few bombers strolling along the bottom of the picture.

import type { JSX } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { useMenu } from './ctx.ts';
import { Logo } from './logo.tsx';
import { MenuArt } from './art.ts';
import { quickMatchSlots } from './local.tsx';
import { installUpdate, updateReady } from '../app/update.ts';
import { enter1997 } from '../app/modes.ts';
import { REPO_URL } from '../ui/helpViewer.ts';
import { isTvApp } from '../app/controls.ts';

/** GitHub's mark (Octicons, MIT licence). */
export function GitHubMark(): JSX.Element {
  return (
    <svg class="ico" viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"
      />
    </svg>
  );
}

type IconName = 'couch' | 'network' | 'pad' | 'book' | 'gear' | 'play';

export function Icon(props: { name: IconName; class?: string }): JSX.Element {
  const p = { fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } as const;
  let body: JSX.Element;
  switch (props.name) {
    case 'couch':
      body = (
        <g {...p}>
          <path d="M5 11V8a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v3" />
          <path d="M3 13a2 2 0 0 1 4 0v2h10v-2a2 2 0 0 1 4 0v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
          <path d="M6 18v2M18 18v2" />
        </g>
      );
      break;
    case 'network':
      body = (
        <g {...p}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M3.5 12h17M12 3.5c2.5 2.6 3.6 5.4 3.6 8.5s-1.1 5.9-3.6 8.5M12 3.5C9.5 6.1 8.4 8.9 8.4 12s1.1 5.9 3.6 8.5" />
        </g>
      );
      break;
    case 'pad':
      body = (
        <g {...p}>
          <path d="M7.5 7h9a5 5 0 0 1 4.8 6.4l-1 3.5a2.5 2.5 0 0 1-4.2 1L14 16h-4l-2.1 1.9a2.5 2.5 0 0 1-4.2-1l-1-3.5A5 5 0 0 1 7.5 7z" />
          <path d="M8 10.5v3M6.5 12h3" />
          <circle cx="15.5" cy="11" r="0.6" fill="currentColor" />
          <circle cx="17.5" cy="13" r="0.6" fill="currentColor" />
        </g>
      );
      break;
    case 'book':
      body = (
        <g {...p}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.6" />
          <circle cx="12" cy="16.6" r="0.6" fill="currentColor" />
        </g>
      );
      break;
    case 'gear':
      body = (
        <g {...p}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
        </g>
      );
      break;
    default:
      body = <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" />;
  }
  return (
    <svg class={props.class ?? 'ico'} viewBox="0 0 24 24" aria-hidden="true">
      {body}
    </svg>
  );
}

/** Bombers walking across the bottom of the screen, both ways, at different paces. */
function Strollers(): JSX.Element {
  const { art } = useMenu();
  const walkers = useMemo(
    () =>
      [
        { colour: 2, dir: 'east', dur: 19, delay: -3 },
        { colour: 6, dir: 'east', dur: 23, delay: -14 },
        { colour: 0, dir: 'west', dur: 21, delay: -8 },
        { colour: 5, dir: 'west', dur: 27, delay: -20 },
      ].map((w) => ({ ...w, strip: art.walkStrip(w.colour, w.dir as 'east' | 'west') })),
    [],
  );
  return (
    <div class="strollers" aria-hidden="true">
      {walkers.map((w) => (
        <div
          class={`stroller ${w.dir}`}
          style={{ width: `${MenuArt.WALK_W}px`, height: `${MenuArt.WALK_H}px`, animationDuration: `${w.dur}s`, animationDelay: `${w.delay}s` }}
        >
          <div style={{ width: `${MenuArt.WALK_W * MenuArt.WALK_FRAMES}px`, backgroundImage: `url(${w.strip})` }} />
        </div>
      ))}
    </div>
  );
}

/**
 * True after `ms` without any input: the decorations then fade out and stop, so that a main menu left open
 * costs no CPU or GPU time (a moving picture keeps the compositor drawing at the display's refresh rate).
 */
function useIdle(ms: number): boolean {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    let timer = setTimeout(() => setIdle(true), ms);
    const wake = () => {
      clearTimeout(timer);
      setIdle(false);
      timer = setTimeout(() => setIdle(true), ms);
    };
    const events = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'];
    for (const e of events) window.addEventListener(e, wake, { passive: true });
    return () => {
      clearTimeout(timer);
      for (const e of events) window.removeEventListener(e, wake);
    };
  }, []);
  return idle;
}

export function Home(): JSX.Element {
  const { go, exit, g, sound, net } = useMenu();
  const quick = quickMatchSlots(g, false);
  const idle = useIdle(45_000);
  // a newer release is online: it installs by itself while the main menu is left alone
  useEffect(() => {
    if (idle && updateReady() && !net) void installUpdate();
  }, [idle]);
  // the bombers leave after the fade-out (unmounted: no animation left running)
  const [walkers, setWalkers] = useState(true);
  useEffect(() => {
    if (!idle) return setWalkers(true);
    const t = setTimeout(() => setWalkers(false), 1300);
    return () => clearTimeout(t);
  }, [idle]);
  return (
    <div class={`screen home ${idle ? 'calm' : ''}`}>
      <div class="home-shade" />
      {walkers && <Strollers />}
      <div class="home-col">
        <Logo class="home-logo" />
        <nav class="home-nav" aria-label="main menu">
          <div class="tile-row">
            <button class="tile primary" data-autofocus="" onClick={() => go('local')}>
              <Icon name="couch" />
              <span>
                <b>Local Game</b>
                <small>Up to 4 players on this device, plus computer players</small>
              </span>
            </button>
            {quick && (
              <button
                class="tile quick"
                title={`Quick match: ${quick}`}
                aria-label={`Quick match with the last line-up: ${quick}`}
                onClick={() => {
                  if (quickMatchSlots(g, true)) {
                    sound('ok');
                    exit({ kind: 'local' });
                  }
                }}
              >
                <Icon name="play" />
                <small>Rematch</small>
              </button>
            )}
          </div>
          <button class="tile" onClick={() => go('network')}>
            <Icon name="network" />
            <span>
              <b>Network Game</b>
              <small>Same network, or anywhere with a room code</small>
            </span>
          </button>
          <div class="home-small">
            <button class="chipbtn" onClick={() => go('controls')}>
              <Icon name="pad" />
              Controls
            </button>
            <button class="chipbtn" onClick={() => go('howto')}>
              <Icon name="book" />
              How to Play
            </button>
            <button class="chipbtn" onClick={() => go('options')}>
              <Icon name="gear" />
              Options
            </button>
          </div>
        </nav>
      </div>
      <div class="foot">
        {updateReady() && (
          <button class="linkish update" onClick={() => void installUpdate()}>
            New version · Reload
          </button>
        )}
        <button
          class="retro"
          title="Play like it's 1997: the original menus, mouse and waits, for this visit"
          onClick={() => {
            enter1997();
            exit({ kind: 'classic' });
          }}
        >
          <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 4h16v11H4z M9 19h6 M12 15v4" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
            <path d="M7 7h5v2H7z" fill="currentColor" />
          </svg>
          1997 mode
        </button>
        {/* (the TV app has no browser to open it in) */}
        {!isTvApp() && (
          <a class="linkish gh" href={REPO_URL} target="_blank" rel="noopener" aria-label="Boom Buds on GitHub">
            <GitHubMark />
            GitHub
          </a>
        )}
      </div>
    </div>
  );
}
