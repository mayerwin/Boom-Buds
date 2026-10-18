// Options: sound, display, game, and 1997 mode: the original's menus, mouse and waits, all at once for one
// visit, or one at a time for good.

import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { useMenu } from './ctx.ts';
import { Modal, Stepper, Toggle } from './ui.tsx';
import { enter1997 } from '../app/modes.ts';
import { resetSettings } from '../app/settings.ts';
import { showDiag } from '../app/diag.ts';
import { REPO_URL } from '../ui/helpViewer.ts';
import { isTvApp } from '../app/controls.ts';
import { GitHubMark } from './home.tsx';
import { MySchemes } from './schemes.tsx';

const VOLUMES = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];

export function Options(): JSX.Element {
  const { g, back, exit, save, go } = useMenu();
  const [schemes, setSchemes] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const st = g.settings;
  const app = g.app;
  const [, redraw] = useState(0);
  const change = (f: () => void) => {
    f();
    save();
    redraw((x) => x + 1);
  };
  const pct = (v: number) => ({ value: v, label: v ? `${Math.round(v * 100)} %` : 'Off' });
  return (
    <div class="screen">
      <div class="topbar">
        <button class="btn" data-autofocus="" onClick={back}>◀ Back</button>
        <h1>Options</h1>
        <span style={{ width: 'calc(var(--tap) * 2)' }} />
      </div>
      <div class="body cols-2">
        <div class="panel scroll">
          <h2>Sound</h2>
          <Stepper label="Music" value={st.musicVolume} wrap={false} options={VOLUMES.map(pct)} onChange={(v) => change(() => { st.musicVolume = v; app.audio.setMusicVolume(v); })} />
          <Stepper label="Sound effects" value={st.sfxVolume} wrap={false} options={VOLUMES.map(pct)} onChange={(v) => change(() => { st.sfxVolume = v; app.audio.setSfxVolume?.(v); app.audio.playGroup(20); })} />
          <Toggle label="Music during rounds" value={!st.disable_game_music} onChange={(v) => change(() => (st.disable_game_music = v ? 0 : 1))} />
          <h2>Display</h2>
          <Toggle label="Sharp pixels only (whole-number scaling)" hint="smaller picture, no blending between pixels" value={!!st.integerScale} onChange={(v) => change(() => { st.integerScale = v ? 1 : 0; app.layout(); })} />
          <Toggle
            label="Frame rate and input delay"
            hint="how long a press takes to reach a drawn frame here: compare one screen with another"
            value={!!st.diagnostics}
            onChange={(v) => change(() => { st.diagnostics = v ? 1 : 0; showDiag(v); })}
          />
          <div class="setting">
            <label>Full screen</label>
            <button
              class="btn small"
              onClick={() => {
                if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
                else void document.documentElement.requestFullscreen?.().catch(() => {});
              }}
            >
              Toggle (Alt+Enter)
            </button>
          </div>
        </div>
        <div class="panel scroll">
          <h2>Game</h2>
          <Toggle
            label="Fast-forward when only computer players are left"
            hint="rounds run four times as fast once every player of this device is out"
            value={!!st.fastForward}
            onChange={(v) => change(() => (st.fastForward = v ? 1 : 0))}
          />
          <Toggle label="Computer players take over lost network players" value={!!st.lost_net_revert_ai} onChange={(v) => change(() => (st.lost_net_revert_ai = v ? 1 : 0))} />
          <h2>1997 mode</h2>
          <div class="small muted">
            Play exactly like the original game: its menus, pixel for pixel, its hidden mouse and its waits between
            rounds. Just for this visit: your settings stay as they are, and the Back to today button brings you
            back.
          </div>
          <button
            class="btn"
            onClick={() => {
              enter1997();
              exit({ kind: 'classic' });
            }}
          >
            Play like it's 1997
          </button>
          <details class="ways">
            <summary>Keep some of the original's ways</summary>
            <Toggle
              label="Start with the original menus"
              hint="with its level editor and campaign mode"
              value={!!st.classicMenus}
              onChange={(v) => change(() => (st.classicMenus = v ? 1 : 0))}
            />
            <Toggle
              label="Original mouse in those menus"
              hint="no cursor outside dialogs, clicks ignored"
              value={!!st.classicMouse}
              onChange={(v) => change(() => (st.classicMouse = v ? 1 : 0))}
            />
            <Toggle
              label="Original waits between rounds"
              hint="the next screen can only be reached after a moment"
              value={!!st.classicWaits}
              onChange={(v) => change(() => (st.classicWaits = v ? 1 : 0))}
            />
          </details>
          <h2>Extras</h2>
          <div class="row">
            <button class="btn small" onClick={() => exit({ kind: 'editor' })}>Scheme editor</button>
            <button class="btn small" onClick={() => setSchemes(true)}>My schemes</button>
            <button class="btn small" onClick={() => exit({ kind: 'campaign' })}>Campaign mode</button>
          </div>
          <h2>About</h2>
          <div class="small muted">
            Boom Buds is a fan remake of Atomic Bomberman (Interplay / Hudson Soft, 1997), running the original game data
            through a re-implementation of its rules. Network games meet through public relays and then play directly
            between the players' browsers.
          </div>
          <div class="row">
            {/* (the TV app has no browser: it shows the policy itself) */}
            {isTvApp() ? (
              <button class="btn small" onClick={() => setPrivacy(true)}>Privacy policy</button>
            ) : (
              <>
                <a class="btn small" href={REPO_URL} target="_blank" rel="noopener">
                  <GitHubMark />
                  Boom Buds on GitHub
                </a>
                <a class="btn small" href={`${import.meta.env.BASE_URL}privacy.html`} target="_blank" rel="noopener">
                  Privacy policy
                </a>
              </>
            )}
          </div>
          <div class="setting">
            <label>
              Reset all settings
              <div class="small muted">controls, rules, line-ups and options back to how they came; your schemes stay</div>
            </label>
            <button
              class="btn small ghost"
              onClick={() => {
                if (!resetting) return setResetting(true);
                resetSettings();
                location.reload();
              }}
            >
              {resetting ? 'Sure? Reset' : 'Reset'}
            </button>
          </div>
        </div>
      </div>
      {schemes && (
        <MySchemes
          onClose={() => setSchemes(false)}
          onPlay={(file) => {
            st.schemefilename = file;
            save();
            setSchemes(false);
            go('local');
          }}
        />
      )}
      {privacy && <PrivacyPolicy onClose={() => setPrivacy(false)} />}
    </div>
  );
}

/** The privacy policy (public/privacy.html) in a dialog; the remote's or a gamepad's up / down scroll it. */
function PrivacyPolicy(props: { onClose: () => void }): JSX.Element {
  const [html, setHtml] = useState('');
  useEffect(() => {
    void fetch(`${import.meta.env.BASE_URL}privacy.html`)
      .then((r) => r.text())
      .then((text) => {
        const main = new DOMParser().parseFromString(text, 'text/html').querySelector('main');
        main?.querySelector('h1')?.remove();
        setHtml(main?.innerHTML ?? '');
      });
  }, []);
  const scroll = (e: KeyboardEvent) => {
    const el = e.currentTarget as HTMLElement;
    const d = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    // at either end the arrow moves the focus on, as anywhere else
    if (!d || (d > 0 ? el.scrollHeight - el.clientHeight - el.scrollTop : el.scrollTop) < 2) return;
    e.preventDefault();
    el.scrollBy({ top: d * el.clientHeight * 0.6, behavior: 'smooth' });
  };
  return (
    <Modal title="Privacy policy" onClose={props.onClose} wide>
      <div class="small" tabIndex={0} data-autofocus="" onKeyDown={scroll} style={{ maxHeight: '60vh', overflowY: 'auto' }} dangerouslySetInnerHTML={{ __html: html }} />
    </Modal>
  );
}
