/*
 * Boom Buds on Android TV: the TV app's controllers, presented to the shared game as standard gamepads.
 *
 * The WebView has no Gamepad API, so MainActivity forwards the key and stick events of gamepads and of the TV
 * remote (window.BoomBudsAndroid.onInput) and this adapter answers navigator.getGamepads() with them, in the
 * standard mapping the game already reads (A = bomb / select, B = special / back, Start = pause, d-pad and left
 * stick = move). The remote is one gamepad: its arrows move, OK is A, and Back is B in the menus and Start
 * during a round (it pauses). Keyboards and mice are left to the WebView. Loaded before the game (android/
 * app/build.gradle adds it to the packaged index.html); the website never loads it.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BoomBudsTv = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  /** Android key names -> standard-mapping button index */
  const BUTTONS = {
    BUTTON_A: 0, DPAD_CENTER: 0, ENTER: 0, NUMPAD_ENTER: 0, BUTTON_B: 1, BUTTON_X: 2, BUTTON_C: 2, BUTTON_Y: 3, BUTTON_Z: 3,
    BUTTON_L1: 4, BUTTON_R1: 5, BUTTON_L2: 6, BUTTON_R2: 7, BUTTON_SELECT: 8, BUTTON_START: 9, MENU: 9,
    MEDIA_PLAY_PAUSE: 9, BUTTON_THUMBL: 10, BUTTON_THUMBR: 11,
    DPAD_UP: 12, DPAD_DOWN: 13, DPAD_LEFT: 14, DPAD_RIGHT: 15, BUTTON_MODE: 16,
  };
  /** a tap reads as pressed for at least this long (ms) and through the next display frame */
  const TAP_MS = 60;
  const REMOTE = 'remote';
  /** the d-pad's buttons on the hat axes: [button, axis (0 x, 1 y), direction] */
  const HAT_DIRS = [[12, 1, -1], [13, 1, 1], [14, 0, -1], [15, 0, 1]];

  /**
   * The gamepads, from the forwarded events. `backButton()` says which button Back is right now (B in the
   * menus, Start during a round).
   */
  class Pads {
    constructor(now, backButton) {
      this.now = now;
      this.backButton = backButton || (() => 1);
      this.pads = []; // index -> pad or null
      this.byKey = new Map(); // device key -> pad
      this.listeners = [];
      /** display frames so far (install() counts them): a tap stays pressed until a whole frame has seen it */
      this.frame = 0;
      /** the last snapshot, for the rest of its display frame (the game reads the gamepads many times a frame) */
      this.cache = null;
      this.cacheFrame = -1;
      this.cacheAt = 0;
    }

    on(fn) {
      this.listeners.push(fn);
    }

    emit(type, pad) {
      for (const fn of this.listeners) fn(type, pad);
    }

    /** All remotes (they often show up as several input devices) are one gamepad, "TV remote". */
    keyOf(device) {
      return device && device.remote ? REMOTE : 'id:' + (device ? device.id : -1);
    }

    pad(device, create = true) {
      const key = this.keyOf(device);
      let p = this.byKey.get(key);
      if (p || !create) return p || null;
      let index = this.pads.findIndex((x) => !x);
      if (index < 0) index = this.pads.length;
      p = {
        key, index, id: key === REMOTE ? 'TV remote' : (device && device.name) || 'Gamepad',
        held: new Array(17).fill(false), until: new Array(17).fill(0), at: new Array(17).fill(-9), analog: new Array(17).fill(0),
        axes: [0, 0, 0, 0], hat: [0, 0], timestamp: this.now(),
      };
      this.pads[index] = p;
      this.byKey.set(key, p);
      this.emit('connected', p);
      return p;
    }

    remove(device) {
      if (device && device.remote) return; // the remote gamepad stays: other remote devices may remain
      const p = this.byKey.get(this.keyOf(device));
      if (!p) return;
      this.byKey.delete(p.key);
      this.pads[p.index] = null;
      this.emit('disconnected', p);
    }

    /** Let go of everything (the app went to the background). */
    release() {
      for (const p of this.pads) if (p) { p.held.fill(false); p.until.fill(0); p.at.fill(-9); p.analog.fill(0); p.axes = [0, 0, 0, 0]; p.hat = [0, 0]; }
    }

    /** One forwarded event; returns the button pressed, if any. */
    input(e) {
      this.cache = null;
      const pressed = this.apply(e);
      // (a 'connected' listener may have read the gamepads before the event's button went down)
      this.cache = null;
      return pressed;
    }

    apply(e) {
      const now = this.now();
      if (e.type === 'device') {
        if (e.action === 'disconnected') this.remove(e.device);
        // (the remote is there from the start: the menus can offer it as the first player)
        else if (e.device && e.device.bridged) this.pad(e.device);
        return -1;
      }
      if (e.type === 'lifecycle') {
        if (e.action === 'pause') this.release();
        return -1;
      }
      if (e.type === 'key') {
        let b = e.code === 'BACK' ? this.backButton() : BUTTONS[e.code];
        if (b === undefined) return -1;
        const p = this.pad(e.device);
        p.timestamp = now;
        if (e.action === 'down') {
          if (!p.held[b]) { p.until[b] = now + TAP_MS; p.at[b] = this.frame; }
          p.held[b] = true;
          return e.repeat ? -1 : b;
        }
        // Back changes meaning with the screen: release whichever it pressed
        if (e.code === 'BACK') for (const k of [1, 9]) p.held[k] = false;
        else p.held[b] = false;
        return -1;
      }
      if (e.type === 'motion' && e.axes) {
        const p = this.pad(e.device);
        const a = e.axes;
        p.timestamp = now;
        // the right stick: Z and RZ on Android's gamepads; RX and RY on those without Z / RZ (MainActivity only
        // sends the axes a device has: a trigger on RX must not read as a stick pushed left), and on those whose
        // Z and RZ are triggers (a gamepad without its own key layout: both rest at -1 together, which no stick does)
        if ('rx' in a && 'z' in a && a.z <= -0.95 && a.rz <= -0.95) p.zTriggers = true;
        const zx = 'z' in a && !p.zTriggers, zy = 'rz' in a && !p.zTriggers;
        p.axes = [a.x || 0, a.y || 0, (zx ? a.z : a.rx) || 0, (zy ? a.rz : a.ry) || 0];
        // a d-pad on the hat axes: a direction pressed is kept for a tap, as a key is (press and release can both
        // come between two display frames)
        const hat = [a.hatX || 0, a.hatY || 0];
        for (const [b, axis, sign] of HAT_DIRS) {
          if (hat[axis] * sign > 0.5 && !(p.hat[axis] * sign > 0.5)) { p.until[b] = now + TAP_MS; p.at[b] = this.frame; }
        }
        p.hat = hat;
        const trigger = (v) => (p.zTriggers && v !== undefined ? (v + 1) / 2 : 0);
        p.analog[6] = Math.max(a.ltrigger || 0, a.brake || 0, trigger(a.z));
        p.analog[7] = Math.max(a.rtrigger || 0, a.gas || 0, trigger(a.rz));
      }
      return -1;
    }

    /** navigator.getGamepads(), standard mapping (the same snapshot again within a display frame, until an event) */
    snapshot() {
      const now = this.now();
      if (this.cache && this.cacheFrame === this.frame && now - this.cacheAt < 50) return this.cache;
      this.cacheFrame = this.frame;
      this.cacheAt = now;
      this.cache = this.pads.map((p) => {
        if (!p) return null;
        const buttons = p.held.map((h, i) => {
          let value = h || now < p.until[i] || this.frame <= p.at[i] + 1 ? 1 : 0;
          if (i === 6 || i === 7) value = Math.max(value, p.analog[i]);
          if (i === 12 && p.hat[1] < -0.5) value = 1;
          if (i === 13 && p.hat[1] > 0.5) value = 1;
          if (i === 14 && p.hat[0] < -0.5) value = 1;
          if (i === 15 && p.hat[0] > 0.5) value = 1;
          return { pressed: value > 0.5, touched: value > 0, value };
        });
        return { id: p.id, index: p.index, connected: true, mapping: 'standard', timestamp: p.timestamp, axes: p.axes.slice(), buttons, vibrationActuator: null };
      });
      return this.cache;
    }
  }

  /** What Back means now: B (back) in the menus, Start during a round (pause; in the pause menu, resume). */
  function backButtonFor(doc, game) {
    if (doc.getElementById('pause-root')?.classList.contains('open')) return 9;
    if (doc.getElementById('menu-root')?.classList.contains('open')) return 1;
    return game && game.runner ? 9 : 1;
  }

  /** Install in the TV app's page (the website never loads this file). */
  function install(win) {
    const doc = win.document;
    const game = () => win.__boombuds && win.__boombuds.game;
    const pads = new Pads(() => win.performance.now(), () => backButtonFor(doc, game()));
    Object.defineProperty(win.navigator, 'getGamepads', { configurable: true, value: () => pads.snapshot() });
    const frame = () => { pads.frame++; win.requestAnimationFrame(frame); };
    win.requestAnimationFrame(frame);
    pads.on((type, p) => {
      const ev = new win.Event(type === 'connected' ? 'gamepadconnected' : 'gamepaddisconnected');
      ev.gamepad = pads.snapshot()[p.index] || { id: p.id, index: p.index, connected: false };
      win.dispatchEvent(ev);
    });
    let unlocked = false;
    win.BoomBudsAndroid = {
      pads,
      onInput(e) {
        const pressed = pads.input(e);
        if (pressed < 0) return;
        // a controller press is a gesture for the game's sound
        if (!unlocked) {
          unlocked = true;
          win.__boombuds?.app?.audio?.unlock?.();
        }
        const g = game();
        // (a page that failed to start, or is still loading, has nothing to go back in: Back leaves, as TV apps do)
        if (e.code === 'BACK' && !g) {
          win.AndroidHost?.exit?.();
          return;
        }
        if (e.code === 'BACK' && pressed === 1 && g && g.menus && g.menus.screen === 'home' && !doc.querySelector('.modal-wrap') &&
          doc.getElementById('menu-root')?.classList.contains('open')) {
          win.AndroidHost?.exit?.(); // Back on the main screen leaves the app, as TV apps do
          return;
        }
        // OK on a text field: the on-screen keyboard (the forwarded key no longer opens it)
        const el = doc.activeElement;
        if (pressed === 0 && el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) win.AndroidHost?.showKeyboard?.();
      },
    };
    const ready = () => win.AndroidHost?.ready?.();
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', ready);
    else ready();
    return pads;
  }

  if (typeof window !== 'undefined' && window.AndroidHost) install(window);
  return { Pads, BUTTONS, backButtonFor, install };
});
