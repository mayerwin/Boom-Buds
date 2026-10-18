// Runs the rounds of a match: the simulation at a fixed 60 Hz, player input (keyboard layouts, gamepads,
// touch controls, computer players), sound, music and the keys the match loop handles during a round
// (docs/re/screens.md §14, match-flow.md §3.2).
//
// Network games: every machine runs the same deterministic simulation. Inputs go through a rollback
// session (src/net/rollback.ts) with 11 "players": the 10 slots plus a host command channel (F10, the pause). Human
// slots are produced by their owner's machine, computer players and empty slots by the host (empty slots
// are known to everybody and never sent).

import type { Game } from '../app/Game.ts';
import { AnimDB } from '../game/sim/anims.ts';
import { FrameCtx } from '../game/sim/ctx.ts';
import { createGame, roundStart, step, type MatchConfig } from '../game/sim/sim.ts';
import { BombState, BombType, type GameState } from '../game/sim/types.ts';
import { GameRenderer } from '../game/render/GameRenderer.ts';
import { AudioPresenter } from '../game/audioPresenter.ts';
import { IN_UP, IN_RIGHT, IN_DOWN, IN_LEFT, IN_ACT1, IN_ACT2, connectedPads, padBits, padButtonMask } from '../engine/input.ts';
import { AI_DEFAULT, INPUT_AI, INPUT_JOY, INPUT_KEY, INPUT_OFF } from '../app/session.ts';
import { gnwCode, K, PadKeys } from '../ui/menuInput.ts';
import { helpScreen } from '../ui/helpViewer.ts';
import { createAi, type AiOptions, type AiPlayer } from '../game/ai/index.ts';
import { CLASSIC_SET_IDS, classicLayouts, findSet, keyBits, mouseBits, padOfSet, RemoteButton, TV_REMOTE, type ControlSet } from '../app/controls.ts';
import { openPauseMenu, type PauseMenu } from '../menu/pause.ts';
import { showCurtain } from '../menu/curtain.ts';
import type { Scheme } from '../engine/assets.ts';
import { RollbackSession } from '../net/rollback.ts';
import { cloneState } from '../game/sim/clone.ts';
import { encodeInputMsg } from '../net/mesh.ts';
import { MenuBox } from '../ui/dialogs.ts';
import { fastForward, originalMenus } from '../app/modes.ts';
import { playersAliveCount } from '../game/sim/players.ts';
import { timeRemainingS } from '../game/sim/enclosure.ts';

const STEP_MS = 1000 / 60;
/** at most this many simulation steps per display frame (a stalled tab must not fast-forward) */
const MAX_STEPS = 8;
/** fast-forward speeds: once only computer players are left the round starts running 4× as fast; 1× to 8× */
const FF_START = 4;
const FF_MAX = 8;
/** network: host command channel index in the rollback session */
const CMD = 10;
const CMD_FORCED_DRAW = 1;
/** the round stands still (every machine's simulation, from the same tick to the same tick) */
const CMD_PAUSE = 2;
/** the countdown (3, 2, 1) before a paused round goes on */
const RESUME_TICKS = 108;

export type RoundEnd = 'over' | 'abort';

export class MatchRunner {
  readonly g: Game;
  s: GameState;
  readonly ctx: FrameCtx;
  readonly gr: GameRenderer;
  readonly presenter: AudioPresenter;
  readonly scheme: Scheme;
  private ais: (AiPlayer | null)[] = [];
  private aiLevels: number[] = [];
  private acc = 0;
  private inputs = new Uint8Array(11);
  /** the TV remote's OK button of each slot that plays with it */
  private remotes: (RemoteButton | undefined)[] = [];
  /** the control set of each slot this machine plays with one (found at the start of each round) */
  private sets: (ControlSet | null)[] = [];
  /** the on-screen controls play the keyboard set KEY 0 too (nobody has them as their own controls) */
  private touchKey0 = true;
  /** the gamepads' keys for the 1997 pause box and the fast-forward (the modern pause menu reads them itself) */
  private padKeys = new PadKeys();
  private focusLost = false;
  /** the computer player that takes over a machine's players when it leaves (lost_net_revert_ai) */
  private aiLevel: AiOptions['level'];
  private seed: number;
  private rb: RollbackSession<GameState> | null = null;
  private round = 0;
  private cmd = 0;
  private frameNo = 0;
  /** the state changed since it was last drawn (display frames between two game frames draw nothing) */
  private dirty = true;
  readonly detach: () => void;

  constructor(g: Game, cfg: MatchConfig) {
    this.g = g;
    this.scheme = cfg.scheme;
    this.seed = cfg.seed;
    this.s = createGame(cfg);
    this.ctx = new FrameCtx(new AnimDB(g.app.gfx.sprites.seqs));
    this.gr = new GameRenderer(g.app.gfx);
    this.gr.values = this.s.opts.values;
    this.gr.messages = g.app.text.messages;
    this.presenter = new AudioPresenter(g.app.audio);
    g.runner = this;
    this.aiLevel = AI_DEFAULT as AiOptions['level'];
    const onBlur = () => (this.focusLost = true);
    const onFocus = () => (this.focusLost = false);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    this.detach = () => {
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
    };
  }

  private get net() {
    return this.g.session.net;
  }

  /** Computer players are run by the host (or locally): one AI per AI slot. */
  private makeAis(): void {
    const sess = this.g.session;
    const runsAi = !this.net || this.net.role === 'host';
    for (let i = 0; i < 10; i++) {
      // (campaign stages add computer players of their own: the simulation's controls are the reference)
      const isAi = this.s.players[i].ctrl === 1;
      if (isAi && runsAi) {
        // 0: the original's computer player; 1-5: Boom Buds' levels
        const level = Math.max(0, Math.min(5, sess.slots[i].ai ?? AI_DEFAULT)) as AiOptions['level'];
        if (!this.ais[i] || this.aiLevels[i] !== level) {
          this.ais[i] = createAi({ level, seed: (this.seed ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0 });
          this.aiLevels[i] = level;
        }
      } else this.ais[i] = null;
    }
  }

  /** round_start (maybe_level_load): new field, level music, timer. */
  async startRound(): Promise<void> {
    const g = this.g;
    const sess = g.session;
    if (sess.netMode === 0) g.app.audio.maybeRecull();
    // clients: the host's latest slot table (sent before the key that started this round)
    const net = this.net;
    if (net && net.role === 'client') {
      const m = net.take('slots');
      if (m.length) sess.slots = (m[m.length - 1].msg.slots as typeof sess.slots).map((x) => ({ ...x }));
    }
    // slots may have changed between rounds (players who left a network game)
    for (let i = 0; i < 10; i++) {
      const t = sess.slots[i].type;
      this.s.players[i].ctrl = t === INPUT_OFF ? 0 : t === INPUT_AI ? 1 : 2;
    }
    roundStart(this.s, this.scheme, g.app.text.extras);
    this.makeAis();
    for (const ai of this.ais) ai?.reset();
    await this.gr.prepareLevel(this.s.opts.level);
    g.ui.gamePalette();
    this.presenter.reset();
    if (g.settings.disable_game_music) g.app.audio.stopMusic();
    else g.app.audio.playMusic(g.app.audio.hasSound(1100 + this.s.opts.level) ? 1100 + this.s.opts.level : 1120);
    this.acc = 0;
    this.cmd = 0;
    this.ffPaused = false;
    this.endPause();
    this.simPaused = false;
    this.localTick = 0;
    this.classicKeys = classicLayouts(g.settings.controls);
    this.remotes = [];
    // this machine's players' control sets, found once for the round (sampled every tick)
    this.sets = sess.slots.map((sl, i) => (sl.ctl && sess.isLocalHuman(i) ? findSet(g.settings.controls, sl.ctl) : null));
    // the on-screen controls also play KEY 0 (as in the original menus on a phone) unless a player has them as
    // their own: one player's layout, or a side bar each (the original menus too, where Game.prepareTouch does not run)
    const touch = this.sets.filter((s) => s?.kind === 'touch');
    this.touchKey0 = !touch.length;
    if (touch.length) g.app.touch.setPlayers(touch.some((s) => s!.side !== 'both') ? 2 : 1);
    // modern menus: Boom Buds' score lines, and where this machine's only player is for the first seconds
    const modern = !originalMenus(g.settings) && !!g.menus && !sess.attract;
    this.gr.hud = modern ? { names: sess.slots.map((sl, i) => hudName(sl.type === INPUT_AI ? 'CPU' : sl.name, i)) } : null;
    const mine = sess.slots.flatMap((sl, i) => (sl.type !== INPUT_OFF && sl.type !== INPUT_AI && sess.isLocalHuman(i) ? [i] : []));
    this.gr.you = modern && mine.length === 1 ? { slot: mine[0], until: performance.now() + 3000 } : null;
    g.app.input.clearLatched();
    this.gr.smooth = null;
    this.gr.easeReset();
    if (this.net) this.startNetRound();
  }

  /** Input bits of the players controlled by this machine (humans here; AI on the host / local games). */
  private sampleInputs(): void {
    const app = this.g.app;
    const input = app.input;
    const sess = this.g.session;
    const sets = this.classicKeys;
    const out = this.inputs;
    const menu = !!this.menu;
    for (let i = 0; i < 10; i++) {
      const slot = sess.slots[i];
      let bits = 0;
      if (sess.isLocalHuman(i) && menu) {
        bits = 0; // the pause menu is open: this machine's players stand still
        this.remotes[i]?.suspend();
      } else if (sess.isLocalHuman(i) && slot.ctl) {
        bits = this.controlBits(i);
      } else if (sess.isLocalHuman(i)) {
        if (slot.type === INPUT_KEY) {
          const k = sets[slot.dev ? 1 : 0];
          if (input.held(k[0])) bits |= IN_UP;
          if (input.held(k[1])) bits |= IN_RIGHT;
          if (input.held(k[2])) bits |= IN_DOWN;
          if (input.held(k[3])) bits |= IN_LEFT;
          if (input.held(k[4])) bits |= IN_ACT1;
          if (input.held(k[5])) bits |= IN_ACT2;
          if (slot.dev === 0 && app.touch.visible && this.touchKey0) bits |= app.touch.bits();
        } else if (slot.type === INPUT_JOY) {
          const gp = connectedPads()[slot.dev];
          if (gp) bits = this.wholePadBits(i, gp);
        }
      } else if (this.ais[i]) {
        // (nothing moves in a paused round: the computer players need not think)
        bits = this.simPaused ? 0 : this.ais[i]!.think(this.s, i);
      }
      out[i] = bits;
    }
    // the command channel: one-off commands, and the pause for as long as the deciding machine says so
    const target = this.rb ? this.rb.tick + this.rb.inputDelay : this.localTick;
    out[CMD] = this.cmd | (this.decides() && this.pausedAt(target) ? CMD_PAUSE : 0);
    this.cmd = 0;
    input.clearLatched();
  }

  /** Input bits of a whole gamepad playing slot `i`. */
  private wholePadBits(i: number, gp: Gamepad): number {
    let bits = padBits(gp);
    // one button: a long press of OK is the special when the bomber has a use for it
    if (gp.id === TV_REMOTE) return (this.remotes[i] ??= new RemoteButton()).bits(bits, specialUseful(this.s, i), performance.now());
    // kface easter egg: up held with exactly buttons 2,4,7 (on) or 2,4,8 (off)
    const mask = bits & IN_UP ? padButtonMask(gp) : 0;
    if (mask === 0x4a || mask === 0x8a) bits |= mask === 0x4a ? 0x40 : 0xc0;
    return bits;
  }

  /** Input bits of a player's control set (the modern menus' choice, or one of Boom Buds' in the original menus). */
  private controlBits(i: number): number {
    const app = this.g.app;
    const set = this.sets[i];
    if (!set) return 0;
    switch (set.kind) {
      case 'keys': {
        const bits = keyBits(app.input, set.keys!);
        return this.touchKey0 && set.id === CLASSIC_SET_IDS[0] && app.touch.visible ? bits | app.touch.bits() : bits;
      }
      case 'pad': {
        const gp = padOfSet(set);
        if (!gp) return 0;
        return set.half ? padBits(gp, set.half) : this.wholePadBits(i, gp);
      }
      case 'mouse': {
        const p = this.s.players[i];
        return mouseBits(app.input, p.x, p.y);
      }
      case 'touch':
        return app.touch.visible ? app.touch.bits(set.side ?? 'both') : 0;
    }
  }

  /** One simulation step (also the rollback session's step). A paused tick changes nothing. */
  private simStep(inputs: Uint8Array, replay: boolean): void {
    if (inputs[CMD] & CMD_FORCED_DRAW) this.s.forcedDraw = 1;
    this.simPaused = (inputs[CMD] & CMD_PAUSE) !== 0;
    if (this.simPaused) return;
    this.presenter.muted = replay;
    step(this.s, this.ctx, inputs);
    this.presenter.frame(this.ctx, this.s.frameCounter, this.s.refFrame);
    this.presenter.muted = false;
    this.dirty = true;
  }

  /**
   * Play frames until the round is over (or the match is aborted). Returns 'abort' when the match
   * ended from a key (Ctrl-Q, or Enter/Esc in attract mode) or the network game broke up.
   */
  async playRound(): Promise<RoundEnd> {
    const g = this.g;
    const ui = g.ui;
    const session = g.session;
    ui.flushInput();
    for (;;) {
      const f = await g.app.frame();
      this.frameNo++;
      const paused = this.paused();
      if (this.rb) {
        const speed = this.speedNow();
        this.netFrame(f.dt, speed);
        if (speed === 0) this.lastAdvance = performance.now();
        // everybody waits for a machine that is late (its inputs did not arrive): say so after a second
        const late = !this.s.roundOver && performance.now() - this.lastAdvance > 1000;
        this.showBadge(late ? `Waiting for ${this.lateNames()}…` : paused ? null : this.speedNote(speed));
      } else if (!(this.focusLost || document.hidden)) {
        const speed = this.speedNow();
        this.showBadge(paused ? null : this.speedNote(speed));
        this.acc += f.dt * speed;
        let steps = 0;
        while (this.acc >= STEP_MS && steps < MAX_STEPS && !this.s.roundOver) {
          this.acc -= STEP_MS;
          steps++;
          this.sampleInputs();
          this.simStep(this.inputs, false);
          this.localTick++;
        }
        if (steps >= MAX_STEPS) this.acc = 0;
      }
      this.syncPause();
      const box = this.menu?.box;
      if (this.dirty || box) {
        this.gr.render(this.s, this.ctx);
        this.dirty = false;
        if (box) this.drawBox(box);
      }
      // keys handled by the match loop (one per frame); the pause menu takes them while it is open
      for (const kr of f.keys) {
        const k = gnwCode(kr);
        if (k === -1) continue;
        if (this.menu) this.menuKey(k);
        else await this.roundKey(k);
        break;
      }
      // a gamepad's Start (or Select) pauses (in the 1997 box, resumes; the modern menu reads the gamepads itself)
      // and ends a demo
      if (this.padStart() && !this.menu?.html) {
        if (!this.menu) await this.roundKey(K.ESC);
        else if (performance.now() >= this.menu.padGraceUntil) this.menuKey(K.ESC);
      }
      // gamepads and the TV remote: the d-pad, a stick, A and B choose in the 1997 box; the directions set the
      // fast-forward (the players they would move are out); A and B end a demo
      for (const k of this.padKeys.poll(f.now)) {
        if (this.menu?.box) {
          if (performance.now() >= this.menu.padGraceUntil) this.menuKey(k);
        } else if (this.menu) break;
        else if (session.attract ? k === K.ENTER || k === K.ESC : (k === K.LEFT || k === K.RIGHT || k === K.UP || k === K.DOWN) && this.ffActive() && this.ffControl()) {
          await this.roundKey(k);
        }
      }
      if (this.menu?.box) this.boxPointer(f.pointer, f.now);
      if (session.net) await this.checkNet();
      const end = session.matchEnd ? 'abort' : (this.s.roundOver && (!this.rb || this.netRoundSettled())) || (this.s.pl.campaign && this.s.camp.status) ? 'over' : null;
      if (end) {
        this.showBadge(null);
        this.endPause();
        return end;
      }
    }
  }

  private async roundKey(k: number): Promise<void> {
    const g = this.g;
    const session = g.session;
    const local = session.netMode === 0;
    if ((k === K.LEFT || k === K.RIGHT || k === K.UP || k === K.DOWN) && this.ffActive() && this.ffControl()) {
      // fast-forward: ← → speed, ↑ ↓ pause (a network game follows its host)
      if (k === K.LEFT) this.ffSpeed = Math.max(1, this.ffSpeed - 1);
      else if (k === K.RIGHT) this.ffSpeed = Math.min(FF_MAX, this.ffSpeed + 1);
      else this.ffPaused = !this.ffPaused;
      this.net?.broadcast({ t: 'ff', speed: this.ffSpeed, paused: this.ffPaused });
      return;
    }
    if (session.attract && (k === K.ENTER || k === K.ESC)) {
      session.goldPlayer = -1;
      session.matchEnd = 2;
    } else if (k === K.CTRL_Q) {
      session.goldPlayer = -1;
      session.matchEnd = 2;
      if (this.net?.role === 'host') this.net.broadcast({ t: 'abort' });
    } else if (k === K.F10 && session.netMode !== 2) {
      if (this.rb) this.cmd |= CMD_FORCED_DRAW;
      else {
        this.s.forcedDraw = 1;
        this.s.roundOver = 1;
      }
    } else if (k === K.ALT_W) {
      session.autoContinue = 1;
    } else if (k === K.ESC && !session.attract) {
      const p = this.pause;
      // paused with the menu closed (a client's Resume is on its way to the host): the menu again
      if (p && !p.resumeTick && this.dismissed === p.seq) this.dismissed = -1;
      else this.askPause();
    } else if (k === K.F1 && local && !session.attract) {
      await this.pauseFor(() => helpScreen(g.ui, g.dlg));
    } else if (k === K.ALT_D && local) {
      await this.pauseFor(() => g.debugWindow());
    }
  }

  // ------------------------------------------------------------------------------------- pause

  /**
   * The pause (Esc): the round stands still for everybody. In a network game the host's command channel carries
   * it (CMD_PAUSE): every machine's simulation stops at the same tick and goes on at the same tick, and the
   * machines keep exchanging inputs meanwhile, so nobody falls silent and nobody is given up on. Whoever paused,
   * anyone can resume; a countdown (3, 2, 1) then starts everybody at once. The host decides (or this machine,
   * in a local game): the others ask it ('pause-req') and follow what it says ('pause').
   */
  private pause: PauseInfo | null = null;
  private pauseSeq = 0;
  /** the simulation's last tick was a paused one */
  private simPaused = false;
  /** ticks played in a local game (paused ones too: the countdown counts them) */
  private localTick = 0;
  /** a client asked for a pause that the host has not confirmed yet (its menu is open meanwhile) */
  private pauseAsked = false;
  /** the pause in which this machine's player chose Resume (a client's menu stays closed until the countdown) */
  private dismissed = -1;
  /** the pause menu over the round: in the original's style (1997 mode) or the modern one */
  private menu: OpenMenu | null = null;
  /** where the mouse points while the 1997 box is open (it shows the game's cursor) */
  private boxMouse: { x: number; y: number } | null = null;
  private countdown: HTMLDivElement | null = null;

  private tickNow(): number {
    return this.rb ? this.rb.tick : this.localTick;
  }

  /** This machine decides about the pause: the host, or the only machine of a local game. */
  private decides(): boolean {
    return !this.net || this.net.role === 'host';
  }

  /** The round is paused at tick `t`, as far as this machine knows. */
  private pausedAt(t: number): boolean {
    const p = this.pause;
    return !!p && (!p.resumeTick || t < p.resumeTick);
  }

  private startWas: boolean[] = [];

  /** A gamepad's Start button (or Select, nearer to whoever plays the left half of a gamepad) was just pressed. */
  private padStart(): boolean {
    let hit = false;
    for (const gp of connectedPads()) {
      const on = !!gp.buttons[9]?.pressed || !!gp.buttons[8]?.pressed;
      if (on && !this.startWas[gp.index]) hit = true;
      this.startWas[gp.index] = on;
    }
    return hit;
  }

  /** The round is paused now, or counting down to going on. */
  private paused(): boolean {
    return this.pausedAt(this.tickNow());
  }

  /** Esc during a round: pause it (or pause it again during the countdown). */
  private askPause(): void {
    const net = this.net;
    if (this.s.roundOver) return;
    if (this.decides()) this.setPause(true, net?.myId ?? 0, net?.name ?? '');
    else {
      this.pauseAsked = true;
      this.dismissed = -1;
      net!.send(net!.hostId, { t: 'pause-req', round: this.round, on: true });
    }
  }

  /** Resume: the countdown starts, for everybody. */
  private askResume(): void {
    const net = this.net;
    if (this.decides()) this.setPause(false, 0, '');
    else {
      this.pauseAsked = false;
      this.dismissed = this.pause?.seq ?? -1;
      net!.send(net!.hostId, { t: 'pause-req', round: this.round, on: false });
    }
  }

  /** The deciding machine pauses the round, or starts the countdown; the other machines hear about it. */
  private setPause(on: boolean, byId: number, by: string): void {
    const p = this.pause;
    if (on) {
      if (this.s.roundOver || (p && !p.resumeTick)) return;
      this.pause = { seq: ++this.pauseSeq, byId, by, resumeTick: 0 };
    } else {
      if (!p || p.resumeTick) return;
      this.pause = { ...p, resumeTick: this.tickNow() + (this.rb?.inputDelay ?? 0) + RESUME_TICKS };
    }
    this.net?.broadcast({ t: 'pause', round: this.round, ...this.pause });
  }

  /** What the pause menu shows now (null: no menu). */
  private wantedMenu(): MenuSpec | null {
    const p = this.pause;
    const pausedNow = !!p && !p.resumeTick && this.dismissed !== p.seq;
    if (!this.pauseAsked && !pausedNow) return null;
    const net = this.net;
    if (!net) {
      return { title: 'Game paused', note: null, remote: false, items: [['Resume', 'resume'], ['End this round (draw)', 'draw'], ['Quit the match', 'quit']] };
    }
    const mine = this.pauseAsked || !p || p.byId === net.myId;
    return {
      title: mine ? 'Game paused' : `Paused by ${p.by}`,
      note: 'Everybody waits until someone resumes.',
      remote: !mine,
      items:
        net.role === 'host'
          ? [['Resume', 'resume'], ['End this round for everyone (draw)', 'draw'], ['End the match for everyone', 'quit']]
          : [['Resume', 'resume'], ['Leave the match', 'quit']],
    };
  }

  /** Each frame: the pause menu and the countdown, as the pause stands. */
  private syncPause(): void {
    const want = this.wantedMenu();
    const key = want ? `${want.title}|${want.items.map((i) => i[0]).join('|')}` : '';
    if (this.menu && this.menu.key !== key) this.closeMenu();
    if (want && !this.menu) this.openMenu(want, key);
    const p = this.pause;
    const left = p && p.resumeTick ? p.resumeTick - this.tickNow() : 0;
    this.showCountdown(left > 0 ? Math.min(3, Math.ceil((left * 3) / RESUME_TICKS)) : null);
    if (this.net) this.net.paused = this.paused() || this.pauseAsked;
  }

  private openMenu(want: MenuSpec, key: string): void {
    const g = this.g;
    const actions = want.items.map((i) => i[1]);
    // a menu opened by someone else's pause ignores this machine's keys, buttons and clicks for a moment (a bomb
    // button pressed just then must not resume); one opened here only the gamepads (another player's bomb button)
    const grace = want.remote ? 800 : 0;
    const padGrace = want.remote ? grace : 300;
    if (originalMenus(g.settings) || !g.menus) {
      const box = new MenuBox(g.dlg, want.title, want.note, want.items.map((i) => i[0]), g.ui.col.yellow, g.ui.col.black);
      const now = performance.now();
      this.menu = { key, box, html: null, actions, graceUntil: now + grace, padGraceUntil: now + padGrace };
      return;
    }
    g.app.input.suspended = true;
    const html = openPauseMenu(
      want.title,
      want.note ?? '',
      want.items.map(([label, value]) => ({ label, value, danger: value === 'quit' })),
      (action) => {
        this.closeMenu();
        this.pauseChoice(action);
      },
      grace,
      padGrace,
    );
    this.menu = { key, box: null, html, actions, graceUntil: performance.now() + grace, padGraceUntil: performance.now() + padGrace };
  }

  private closeMenu(): void {
    const m = this.menu;
    if (!m) return;
    this.menu = null;
    if (m.box) {
      m.box.win.dispose(this.g.app.gfx);
      this.boxMouse = null;
      this.dirty = true;
    }
    if (m.html) {
      m.html.close();
      this.g.app.input.suspended = false;
    }
    this.g.app.input.clearLatched();
  }

  /** A choice in the pause menu. */
  private pauseChoice(action: PauseAction): void {
    const session = this.g.session;
    if (action === 'resume') this.askResume();
    else if (action === 'quit') {
      session.goldPlayer = -1;
      session.matchEnd = 2;
      if (this.net?.role === 'host') this.net.broadcast({ t: 'abort' });
      // the modern menus take over: a curtain instead of a still picture while they come up
      if (this.g.menus) showCurtain(session.net ? 'Back to the lobby…' : 'Back to the menu…');
    } else if (this.rb) {
      // the host ends the round in a draw: the pause ends at once, so that the command reaches the game
      this.cmd |= CMD_FORCED_DRAW;
      const p = this.pause;
      if (p && this.paused()) {
        this.pause = { ...p, resumeTick: this.rb.tick + this.rb.inputDelay };
        this.net?.broadcast({ t: 'pause', round: this.round, ...this.pause });
      }
    } else {
      this.s.forcedDraw = 1;
      this.s.roundOver = 1;
      this.pause = null;
    }
  }

  /** A key while the pause menu is open. */
  private menuKey(k: number): void {
    const m = this.menu!;
    if (performance.now() < m.graceUntil) return;
    let c = -1;
    if (m.box) c = m.box.key(k);
    else if (k === K.ESC) c = 0; // the ESC button of the touch controls (the modern menu has the keyboard)
    if (c < 0) return;
    this.closeMenu();
    this.pauseChoice(m.actions[c]);
  }

  /** Mouse and touch on the 1997 box: its buttons, and the game's cursor over the picture. */
  private boxPointer(events: { x: number; y: number; type: 'down' | 'up' | 'move'; kind: string }[], now: number): void {
    for (const p of events) {
      const box = this.menu?.box;
      if (!box) return;
      if (p.kind !== 'touch') this.boxMouse = p.x >= 0 && p.x < 640 && p.y >= 0 && p.y < 480 ? { x: p.x, y: p.y } : null;
      const code = box.win.pointer(p.type, p.x, p.y, now);
      if (code !== -1) this.menuKey(code);
    }
  }

  private drawBox(box: MenuBox): void {
    box.win.draw(this.g.app.gfx);
    if (this.boxMouse && !this.g.app.isTouch) this.g.gnw.drawCursor(this.boxMouse.x, this.boxMouse.y);
  }

  /** The countdown before a paused round goes on (3, 2, 1), big over the game; null hides it. */
  private showCountdown(n: number | null): void {
    if (n === null) {
      this.countdown?.remove();
      this.countdown = null;
      return;
    }
    if (!this.countdown) {
      const el = document.createElement('div');
      el.className = 'resume-countdown';
      el.setAttribute('role', 'status');
      el.style.cssText =
        'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:20;pointer-events:none;font:900 clamp(72px,20vmin,180px)/1 system-ui,sans-serif;color:#ffd23f;' +
        'text-shadow:-4px -4px 0 #140f2c,4px -4px 0 #140f2c,-4px 4px 0 #140f2c,4px 4px 0 #140f2c,0 8px 0 #140f2c;';
      document.body.appendChild(el);
      this.countdown = el;
    }
    const t = String(n);
    if (this.countdown.textContent !== t) this.countdown.textContent = t;
  }

  /** The round (or the match) is over: no pause any more. */
  private endPause(): void {
    this.closeMenu();
    this.showCountdown(null);
    this.pause = null;
    this.pauseAsked = false;
    this.dismissed = -1;
    if (this.net) this.net.paused = false;
  }

  /**
   * Frames are disabled while a dialog runs. The original's round clock was wall-clock based and kept running
   * meanwhile (the help, the debug window); a pause (`clock` false) stops it.
   */
  private async pauseFor(fn: () => Promise<void>, clock = true): Promise<void> {
    const t0 = performance.now();
    await fn();
    if (clock && this.s.timerRunning) this.s.elapsedMs += Math.round(performance.now() - t0);
    this.acc = 0;
    this.dirty = true;
    this.g.app.input.clearLatched();
  }

  // ------------------------------------------------------------------------------------- network

  private startNetRound(): void {
    const net = this.net!;
    const sess = this.g.session;
    this.round++;
    const local: number[] = [];
    const quiet: number[] = [];
    for (let i = 0; i < 10; i++) {
      const sl = sess.slots[i];
      if (sl.type === INPUT_OFF) {
        local.push(i);
        quiet.push(i);
      } else if (sess.isLocalHuman(i)) local.push(i);
      else if (sl.type === INPUT_AI && net.role === 'host') local.push(i);
    }
    if (net.role === 'host') local.push(CMD);
    const rb = new RollbackSession<GameState>(
      {
        saveState: () => cloneState(this.s),
        loadState: (x) => {
          this.s = cloneState(x);
          this.dirty = true;
        },
        step: (inputs, _tick, replay) => this.simStep(inputs, replay),
        checksum: () => 0,
      },
      11,
      local,
      1,
    );
    for (const q of quiet) rb.quiet.add(q);
    const round = this.round;
    rb.send = (msg) => net.mesh.broadcastInput(encodeInputMsg({ ...msg, round }));
    net.onInput = (m) => {
      if (m.round === (round & 0xff)) rb.receive(m);
    };
    this.rb = rb;
    // the other machines' bombers are eased into place when a rollback corrects them
    this.gr.smooth = new Set(Array.from({ length: 10 }, (_, i) => i).filter((i) => sess.slots[i].type !== INPUT_OFF && !local.includes(i)));
    this.lastAdvance = performance.now();
    this.nextHashTick = 120;
    this.myHashes.clear();
  }

  private netFrame(dt: number, speed: number): void {
    const rb = this.rb!;
    rb.sync();
    this.checkDesync();
    if (this.s.roundOver) {
      // the end of the round is decided on confirmed inputs only: keep sending until everybody has them
      rb.flush();
      return;
    }
    this.acc += dt * speed;
    // time sync: while this machine runs ahead of the slowest one (beyond what the network delay explains), it
    // gives back one tick at most ten times a second, whatever the display's refresh rate (a gentle slowdown)
    const now = performance.now();
    if (now - this.delaysAt > 1000) this.updateDelays(rb);
    if (speed > 0 && rb.frameAdvantage() > 1.5 && now - this.gaveBackAt > 100) {
      this.acc -= STEP_MS;
      this.gaveBackAt = now;
    }
    let steps = 0;
    while (this.acc >= STEP_MS && steps < MAX_STEPS) {
      this.sampleInputs();
      const inputs = this.inputs;
      if (rb.advance((p) => inputs[p])) this.lastAdvance = performance.now();
      else {
        this.acc = Math.min(this.acc, STEP_MS);
        break;
      }
      this.acc -= STEP_MS;
      steps++;
      if (this.s.roundOver) break;
    }
    if (steps >= MAX_STEPS) this.acc = 0;
  }

  private delaysAt = 0;
  private gaveBackAt = 0;

  /** The one-way delay to each remote player's machine (half the round trip measured by the pings). */
  private updateDelays(rb: RollbackSession<GameState>): void {
    const net = this.net!;
    const sess = this.g.session;
    this.delaysAt = performance.now();
    for (let p = 0; p < rb.players; p++) {
      if (rb.local.has(p)) continue;
      // players' inputs come from their machine; the computer players' and the command channel's from the host
      const owner = p < 10 && sess.slots[p].type !== INPUT_AI ? sess.slots[p].owner : net.hostId;
      rb.delayTicks[p] = net.rtt(owner) / 2 / STEP_MS;
    }
  }

  /**
   * Desync detection: every 120 confirmed ticks each machine sends a hash of the state it computed; a
   * mismatch is reported on the console (it would mean the simulation is not deterministic).
   */
  private checkDesync(): void {
    const rb = this.rb!;
    const net = this.net!;
    const c = rb.confirmedTick();
    while (this.nextHashTick <= c) {
      const t = this.nextHashTick;
      this.nextHashTick += 120;
      const snap = rb.snapshotAfter(t);
      if (!snap) continue;
      const h = hashState(snap);
      this.myHashes.set(t, h);
      net.broadcast({ t: 'hash', round: this.round, tick: t, h });
    }
    for (const { from, msg } of net.take('hash')) {
      if (Number(msg.round) !== this.round) continue;
      const mine = this.myHashes.get(Number(msg.tick));
      if (mine !== undefined && mine !== Number(msg.h)) {
        this.desyncs++;
        console.error(`DESYNC round ${this.round} tick ${msg.tick}: ${mine} vs ${msg.h} from ${net.memberName(from)}`);
      }
    }
  }

  private nextHashTick = 120;
  private myHashes = new Map<number, number>();
  desyncs = 0;

  /** The predicted end of the round is final once every input up to it is known. */
  private netRoundSettled(): boolean {
    const rb = this.rb!;
    if (rb.confirmedTick() < rb.tick - 1) return false;
    rb.sync();
    return !!this.s.roundOver;
  }

  /** Lost machines, host aborts. */
  private async checkNet(): Promise<void> {
    const g = this.g;
    const net = this.net!;
    const sess = g.session;
    if (net.role === 'client') {
      if (net.hostLost) {
        this.endPause(); // (the message must not hide behind the pause menu)
        await g.dlg.msgboxOk(g.ui.msg(95), g.ui.msg(111), g.ui.col.darkRed, g.ui.col.yellow);
        sess.matchEnd = 2;
        return;
      }
      if (net.aborted) sess.matchEnd = 2;
      for (const { msg } of net.take('takeover')) {
        const p = Number(msg.p);
        this.rb?.forceFrom(p, Number(msg.from));
      }
      for (const { msg } of net.take('ff')) {
        this.ffSpeed = Math.max(1, Math.min(FF_MAX, Math.round(Number(msg.speed)) || FF_START));
        this.ffPaused = !!msg.paused;
      }
      for (const { msg } of net.take('pause')) {
        if (Number(msg.round) !== this.round) continue;
        this.pause = { seq: Number(msg.seq), byId: Number(msg.byId), by: String(msg.by ?? ''), resumeTick: Number(msg.resumeTick) || 0 };
        if (!this.pause.resumeTick) this.pauseAsked = false;
      }
    } else {
      for (const { from, msg } of net.take('pause-req')) {
        if (Number(msg.round) === this.round) this.setPause(!!msg.on, from, net.memberName(from));
      }
    }
  }

  /**
   * Host: the machine `id` left. Its players are played by the host from now on (computer player when
   * "Lost net players revert to AIs" is on, otherwise standing still) and change at the next round.
   */
  playerMachineLost(id: number): void {
    const g = this.g;
    const net = this.net;
    const sess = g.session;
    if (!net || net.role !== 'host') return;
    for (let i = 0; i < 10; i++) {
      const sl = sess.slots[i];
      if ((sl.type === INPUT_KEY || sl.type === INPUT_JOY) && sl.owner === id) {
        const revert = !!g.settings.lost_net_revert_ai;
        if (this.rb) {
          const from = this.rb.takeOver(i);
          net.broadcast({ t: 'takeover', p: i, from });
        }
        if (revert) {
          this.ais[i] = createAi({ level: this.aiLevel, seed: (this.seed ^ Math.imul(i + 7, 0x9e3779b1)) >>> 0 });
          this.aiLevels[i] = this.aiLevel;
          sl.ai = this.aiLevel;
        }
        sl.type = revert ? INPUT_AI : INPUT_OFF;
        sl.dev = 0;
        sl.ctl = undefined;
        sl.owner = net.myId;
      }
    }
  }

  /** KEY 0 and KEY 1 of the original menus' players (src/app/controls.ts: the keyboard sets right and left) */
  private classicKeys: number[][] = [[], []];

  /** Fast-forward: the speed chosen with ← → for this match, and the pause (↑ ↓). */
  private ffSpeed = FF_START;
  private ffPaused = false;

  /**
   * Fast-forward (Settings.fastForward): once every person in the round is out (in a network game, on every
   * machine: the state is the same everywhere) and computer players play on.
   */
  private ffActive(): boolean {
    const sess = this.g.session;
    if (sess.attract || sess.bench || !fastForward(this.g.settings) || this.s.roundOver) return false;
    let people = 0;
    for (let i = 0; i < 10; i++) {
      const t = sess.slots[i].type;
      if (t !== INPUT_KEY && t !== INPUT_JOY) continue;
      people++;
      if (this.s.players[i].alive) return false;
    }
    return people > 0 && this.s.players.some((p, i) => p.alive && sess.slots[i].type === INPUT_AI);
  }

  /** This machine sets the fast-forward speed (a network game's host). */
  private ffControl(): boolean {
    return !this.net || this.net.role === 'host';
  }

  /** The end of the round is near (one player or team left, or the last seconds): it plays at normal speed. */
  private ending(): boolean {
    return playersAliveCount(this.s) <= 1 || timeRemainingS(this.s) < 5;
  }

  /** How fast the round runs now: 1, the fast-forward speed, or 0 while fast-forward is paused. */
  private speedNow(): number {
    // a paused round counts its ticks at the normal speed (the countdown)
    if (this.simPaused || this.paused() || !this.ffActive()) return 1;
    if (this.ffPaused) return 0;
    return this.ending() ? 1 : this.ffSpeed;
  }

  /** The note over the game while fast-forward is on, with its keys for whoever controls it. */
  private speedNote(speed: number): string | null {
    if (!this.ffActive() || (speed === 1 && this.ending() && !this.ffPaused)) return null;
    const keys = this.ffControl();
    if (speed === 0) return keys ? '❚❚ Paused · ↑↓ resume' : '❚❚ Paused by the host';
    const icon = speed > 1 ? '▶▶' : '▶';
    return keys ? `${icon} ${speed}× · ←→ speed · ↑↓ pause` : `${icon} ${speed}×`;
  }

  private badge: HTMLDivElement | null = null;
  /** when the network game last moved on (performance.now) */
  private lastAdvance = performance.now();

  /** A small note over the game ("▶▶ 4×" while it runs fast, who everybody waits for); null hides it. */
  private showBadge(text: string | null): void {
    if (text === null) {
      this.badge?.remove();
      this.badge = null;
      return;
    }
    if (!this.badge) {
      const el = document.createElement('div');
      el.setAttribute('role', 'status');
      el.style.cssText =
        'position:fixed;left:50%;bottom:max(12px,env(safe-area-inset-bottom));transform:translateX(-50%);z-index:20;padding:4px 12px;border-radius:999px;background:rgba(20,15,44,0.75);color:#ffd23f;font:700 14px system-ui,sans-serif;pointer-events:none;';
      document.body.appendChild(el);
      this.badge = el;
    }
    if (this.badge.textContent !== text) this.badge.textContent = text;
  }

  /** Names of the machines that fell silent (or "the other players"). */
  private lateNames(): string {
    const names = this.net?.members.filter((m) => m.stale).map((m) => m.name) ?? [];
    return names.length ? names.join(', ') : 'the other players';
  }

  /** Cheap hash of the simulation state (desync checks in tests). */
  hash(): number {
    return hashState(this.s);
  }

  /** Statistics of the rollback session (tests). */
  netStats(): { tick: number; confirmed: number; rollbacks: number; maxRollback: number; stalls: number } | null {
    const rb = this.rb;
    return rb ? { tick: rb.tick, confirmed: rb.confirmedTick(), rollbacks: rb.rollbacks, maxRollback: rb.maxRollback, stalls: rb.stalls } : null;
  }

  dispose(): void {
    this.showBadge(null);
    this.endPause();
    this.detach();
    if (this.g.runner === this) this.g.runner = null;
    if (this.net) this.net.onInput = null;
  }
}

type PauseAction = 'resume' | 'draw' | 'quit';

/** The pause as the deciding machine has it (a new pause gets a new number). */
interface PauseInfo {
  seq: number;
  /** the machine that paused (network games), and its name */
  byId: number;
  by: string;
  /** the tick the round goes on at (the end of the countdown); 0 while paused */
  resumeTick: number;
}

interface MenuSpec {
  title: string;
  note: string | null;
  /** opened by somebody else's pause */
  remote: boolean;
  items: [string, PauseAction][];
}

interface OpenMenu {
  /** what it shows (a different menu replaces it) */
  key: string;
  box: MenuBox | null;
  html: PauseMenu | null;
  actions: PauseAction[];
  /** keys and clicks count from then on (performance.now) */
  graceUntil: number;
  /** and the gamepads' buttons from then on (another player of this machine may be pressing a bomb button) */
  padGraceUntil: number;
}

/** A name the score lines' font can show (its characters are Latin-1), or "P1"... */
function hudName(name: string | undefined, i: number): string {
  const clean = Array.from(name ?? '')
    .filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) < 256)
    .join('')
    .trim();
  return clean || `P${i + 1}`;
}

/** Translate a slot's input type into the simulation's player control (remote humans are humans too). */
export function slotCtrl(type: number): number {
  return type === INPUT_OFF ? 0 : type === INPUT_AI ? 1 : 2;
}

/** FNV-style hash of the parts of the state that matter for desync detection. */
export function hashState(s: GameState): number {
  let h = 2166136261;
  const mix = (v: number) => {
    h = Math.imul(h ^ (v | 0), 16777619);
  };
  mix(s.tick);
  for (const p of s.players) {
    mix(p.x);
    mix(p.y);
    mix(p.alive);
    mix(p.score);
    mix(p.kills);
  }
  for (const b of s.bombs) {
    mix(b.state);
    mix(b.x);
    mix(b.y);
  }
  for (const v of s.map) mix(v);
  mix(s.rng.seed);
  return h >>> 0;
}

/** Whether the special button does something for bomber `i` now: punch, trigger bombs, or stopping a kicked bomb. */
function specialUseful(s: GameState, i: number): boolean {
  const p = s.players[i];
  if (p.counts[5] || p.counts[9]) return true;
  return !!p.counts[3] && s.bombs.some((b) => b.active === 1 && b.owner === p.id && b.type !== BombType.JELLY && b.state === BombState.SLIDING);
}
