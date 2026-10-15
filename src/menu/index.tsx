// The modern menus: an HTML layer over the key art (the game canvas is hidden meanwhile). The game opens
// them with `open()` and gets back what the players chose (a local match, a network match, ...); the rounds
// themselves and the screens between them stay the original ones on the canvas.

import { render, type JSX } from 'preact';
import { useLayoutEffect, useState } from 'preact/hooks';
import './menu.css';
import artUrl from './art/home-bg.webp';
import type { Game } from '../app/Game.ts';
import { Ctx, type MenuContext, type MenuExit, type ScreenId } from './ctx.ts';
import { MenuArt } from './art.ts';
import { Nav } from './nav.ts';
import { Toast } from './ui.tsx';
import { Home } from './home.tsx';
import { LocalGame, initialLineup } from './local.tsx';
import { NetworkGame, Lobby, hasJoinLink } from './network.tsx';
import { Controls } from './controls.tsx';
import { Options } from './options.tsx';
import { HowTo } from './howto.tsx';
import { LobbyModel } from './lobbyModel.ts';
import type { NetSession } from '../net/netSession.ts';
import { findSet, loadKeyboardLayout } from '../app/controls.ts';
import { onUpdateReady } from '../app/update.ts';

const MUSIC: Partial<Record<ScreenId, number>> = { home: 1010, local: 1020, network: 1040, lobby: 1040 };

export class Menus {
  readonly g: Game;
  readonly art: MenuArt;
  readonly root: HTMLDivElement;
  private nav: Nav;
  private resolve: ((e: MenuExit) => void) | null = null;
  screen: ScreenId = 'home';
  private stack: ScreenId[] = [];
  net: NetSession | null = null;
  lobby: LobbyModel | null = null;
  toastMsg: { text: string; bad: boolean; id: number } | null = null;
  private redraw: () => void = () => {};
  private music = 0;
  private opened = false;

  constructor(g: Game) {
    this.g = g;
    this.art = new MenuArt(g);
    void loadKeyboardLayout();
    this.root = document.createElement('div');
    this.root.id = 'menu-root';
    document.body.appendChild(this.root);
    this.nav = new Nav(this.root);
    this.nav.onBack = () => {
      if (this.root.querySelector('.modal-wrap')) return;
      if (this.screen === 'lobby') this.leaveLobby();
      else if (this.screen !== 'home') this.back();
    };
    render(<App menus={this} />, this.root);
    onUpdateReady(() => this.redraw());
  }

  /** Show the menus on `screen` until the players start something. */
  open(screen: ScreenId = 'home'): Promise<MenuExit> {
    // a shared link (?join=CODE) leads straight into the game
    if (screen === 'home' && !this.opened && hasJoinLink()) {
      this.stack = ['home'];
      screen = 'network';
    }
    this.opened = true;
    this.g.app.input.suspended = true;
    this.g.app.touch.show(false);
    this.g.app.canvas.style.visibility = 'hidden';
    this.root.classList.add('open');
    this.show(screen, false);
    this.nav.start();
    return new Promise((res) => (this.resolve = res));
  }

  private show(screen: ScreenId, push: boolean): void {
    if (push && screen !== this.screen) this.stack.push(this.screen);
    this.screen = screen;
    const m = MUSIC[screen];
    if (m && m !== this.music) {
      this.music = m;
      this.g.app.audio.playMusic(m);
    }
    this.redraw();
    requestAnimationFrame(() => this.nav.focusFirst());
  }

  go(screen: ScreenId): void {
    this.g.ui.letter();
    this.show(screen, true);
  }

  back(): void {
    this.g.ui.menuExit();
    const prev = this.stack.pop() ?? 'home';
    this.show(prev === 'lobby' && !this.lobby ? 'network' : prev, false);
  }

  exit(e: MenuExit): void {
    this.nav.stop();
    this.root.classList.remove('open');
    this.g.app.canvas.style.visibility = '';
    this.g.app.input.suspended = false;
    this.g.ui.flushInput();
    this.music = 0;
    const r = this.resolve;
    this.resolve = null;
    r?.(e);
  }

  toast(text: string, bad = false): void {
    const id = Math.random();
    this.toastMsg = { text, bad, id };
    this.redraw();
    setTimeout(() => {
      if (this.toastMsg?.id === id) {
        this.toastMsg = null;
        this.redraw();
      }
    }, bad ? 3600 : 2200);
  }

  enterLobby(net: NetSession): void {
    const st = this.g.settings;
    this.g.session.beginNet(net);
    this.g.ui.netMode = this.g.session.netMode;
    // this machine brings the players of its last Local Game, with their colours and teams
    const players = initialLineup(this.g).players.flatMap((p) => {
      const s = findSet(st.controls, p.ctl);
      return s ? [{ ctl: s.id, label: s.name, color: p.look.color, team: p.look.team }] : [];
    });
    this.lobby?.dispose();
    this.lobby = new LobbyModel(this.g, net, players, net.role === 'host' ? st.localBots : []);
    this.stack = this.stack.filter((s) => s !== 'lobby' && s !== 'network');
    this.stack.push('network');
    this.show('lobby', false);
  }

  leaveLobby(): void {
    this.lobby?.dispose();
    this.lobby = null;
    this.net?.leaveRoom();
    this.g.session.endNet();
    this.g.ui.netMode = 0;
    this.g.ui.menuExit();
    this.stack = this.stack.filter((s) => s !== 'lobby' && s !== 'network');
    this.show('network', false);
  }

  /** After a network match: back to the lobby (or the Network Game screen if the room is gone). */
  afterNetMatch(): ScreenId {
    if (this.lobby && this.net && !this.net.hostLost) {
      this.lobby.resume();
      return 'lobby';
    }
    if (this.lobby) this.leaveLobby();
    return 'network';
  }

  bind(redraw: () => void): void {
    this.redraw = redraw;
    // catch up with a screen chosen before the first render was committed (open() right after construction)
    redraw();
  }

  context(): MenuContext {
    return {
      g: this.g,
      art: this.art,
      go: (s) => this.go(s),
      back: () => this.back(),
      exit: (e) => this.exit(e),
      toast: (t, bad) => this.toast(t, bad),
      sound: (k) => (k === 'no' ? this.g.ui.refuse() : k === 'ok' ? this.g.ui.menuExit() : this.g.ui.letter()),
      net: this.net,
      setNet: (n) => {
        this.net = n;
        this.redraw();
      },
      save: () => this.g.app.saveSettings(),
      setPadHook: (h) => (this.nav.padHook = h),
    };
  }
}

function App(props: { menus: Menus }): JSX.Element {
  const { menus } = props;
  const [, setTick] = useState(0);
  useLayoutEffect(() => menus.bind(() => setTick((t) => t + 1)), []);
  const ctx = menus.context();
  let screen: JSX.Element;
  switch (menus.screen) {
    case 'local': screen = <LocalGame />; break;
    case 'network': screen = <NetworkGame enterLobby={(n) => menus.enterLobby(n)} />; break;
    case 'lobby': screen = menus.lobby ? <Lobby model={menus.lobby} onLeave={() => menus.leaveLobby()} /> : <NetworkGame enterLobby={(n) => menus.enterLobby(n)} />; break;
    case 'controls': screen = <Controls />; break;
    case 'options': screen = <Options />; break;
    case 'howto': screen = <HowTo />; break;
    default: screen = <Home />;
  }
  return (
    <Ctx.Provider value={ctx}>
      <div class={`menu-art ${menus.screen === 'home' ? '' : 'blur'}`} style={{ backgroundImage: `url(${artUrl})` }} />
      {menus.screen !== 'home' && <div class="backdrop" />}
      <div key={menus.screen} style={{ position: 'absolute', inset: 0 }}>{screen}</div>
      {menus.toastMsg && <Toast text={menus.toastMsg.text} bad={menus.toastMsg.bad} />}
    </Ctx.Provider>
  );
}
