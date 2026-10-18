// Diagnostics (Options > "Frame rate and input delay", or ?diag in the address): how long a press takes to
// reach a drawn frame on this device, and how often frames are drawn at all. Made to compare machines — a TV
// against a laptop — when the game feels less responsive on one of them.
//
// What the overlay shows:
//   fps / frame        the display frames the page really gets (a TV that draws 30 a second feels heavy
//                      however short the input path is)
//   press -> frame     from the moment of the press to the first frame drawn after it. Keys carry their own
//                      time (KeyboardEvent.timeStamp), gamepads the time their state was read; in the TV app
//                      the time Android saw the event, so the trip into the page is included.
//   app -> page        the TV app only: from the Android event to the page acting on it (android/tv/tv.js).
// What no page can measure is what comes after a frame is handed over: the compositor, HDMI and the screen's
// own processing. A TV in its usual picture mode adds 50-100 ms there; its game mode is what cuts that.

interface TvPads {
  edge: { seq: number; time: number; recv: number };
}

interface TvHost {
  now?: () => number;
  getDisplayInfo?: () => string;
}

const tvPads = (): TvPads | null => (window as unknown as { BoomBudsAndroid?: { pads?: TvPads } }).BoomBudsAndroid?.pads ?? null;
const tvHost = (): TvHost | null => (window as unknown as { AndroidHost?: TvHost }).AndroidHost ?? null;

/** Value at quantile `q` of sorted samples (0.5: the median). */
function at(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
}

/** The last `max` samples of one measurement. */
class Ring {
  private values: number[] = [];
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  add(v: number): void {
    this.values.push(v);
    if (this.values.length > this.max) this.values.shift();
  }

  get count(): number {
    return this.values.length;
  }

  stats(): { p50: number; p95: number; worst: number } {
    const s = [...this.values].sort((a, b) => a - b);
    return { p50: at(s, 0.5), p95: at(s, 0.95), worst: s.length ? s[s.length - 1] : 0 };
  }
}

class Diag {
  private el: HTMLDivElement;
  private raf = 0;
  private last = 0;
  private frames = new Ring(240);
  private presses = new Ring(40);
  private transport = new Ring(40);
  private fps = 0;
  private fpsFrames = 0;
  private fpsAt = 0;
  private shownAt = 0;
  /** presses waiting for the next frame (the page's clock) */
  private pending: number[] = [];
  /** the TV app's clock minus the page's (the forwarded events carry the app's) */
  private offset: number | null = null;
  private padEdge = 0;
  private padButtons = new Map<number, number>();
  private onKey = (e: KeyboardEvent) => {
    if (!e.repeat) this.pending.push(e.timeStamp || performance.now());
  };

  constructor() {
    this.el = document.createElement('div');
    this.el.id = 'diag-root';
    this.el.setAttribute('role', 'status');
    document.body.appendChild(this.el);
    window.addEventListener('keydown', this.onKey, { capture: true });
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.onKey, { capture: true });
    this.el.remove();
  }

  /** The TV app's clock, measured once against the page's (a reading between two of the page's). */
  private clockOffset(): number | null {
    if (this.offset !== null) return this.offset;
    const host = tvHost();
    if (!host?.now) return null;
    try {
      const before = performance.now();
      const app = Number(host.now());
      const after = performance.now();
      if (!Number.isFinite(app)) return null;
      this.offset = app - (before + after) / 2;
    } catch {
      return null;
    }
    return this.offset;
  }

  /** Presses since the last frame: the TV app's events, or else the gamepads' own reading times. */
  private collectPads(now: number): void {
    const pads = tvPads();
    if (pads) {
      const edge = pads.edge;
      if (edge.seq !== this.padEdge) {
        this.padEdge = edge.seq;
        const offset = this.clockOffset();
        const pressedAt = offset !== null && edge.time ? edge.time - offset : 0;
        if (pressedAt > 0 && pressedAt <= now + 1) {
          this.pending.push(pressedAt);
          this.transport.add(Math.max(0, edge.recv - pressedAt));
        } else if (edge.recv) this.pending.push(edge.recv);
      }
      return;
    }
    for (const gp of navigator.getGamepads?.() ?? []) {
      if (!gp) continue;
      let mask = 0;
      for (let i = 0; i < Math.min(gp.buttons.length, 24); i++) if (gp.buttons[i]?.pressed) mask |= 1 << i;
      const was = this.padButtons.get(gp.index) ?? 0;
      this.padButtons.set(gp.index, mask);
      // a gamepad's timestamp is when the browser read that state (the clock of performance.now())
      if (mask & ~was) this.pending.push(gp.timestamp > 0 && gp.timestamp <= now + 1 ? gp.timestamp : now);
    }
  }

  private frame(now: number): void {
    this.raf = requestAnimationFrame((t) => this.frame(t));
    if (this.last) this.frames.add(now - this.last);
    this.last = now;
    this.fpsFrames++;
    this.collectPads(now);
    for (const t of this.pending) this.presses.add(Math.max(0, now - t));
    this.pending.length = 0;
    if (now - this.fpsAt >= 500) {
      this.fps = (this.fpsFrames * 1000) / (now - this.fpsAt);
      this.fpsFrames = 0;
      this.fpsAt = now;
    }
    if (now - this.shownAt < 250) return;
    this.shownAt = now;
    this.draw();
  }

  /** The screen's output and this page's canvas: 4K at 60 Hz is not the same picture as 4K at 30. */
  private screenLine(): string {
    const canvas = document.querySelector('canvas');
    const dpr = window.devicePixelRatio || 1;
    const size = canvas ? `canvas ${canvas.width}x${canvas.height}` : `page ${Math.round(innerWidth * dpr)}x${Math.round(innerHeight * dpr)}`;
    let out = '';
    try {
      const info = JSON.parse(tvHost()?.getDisplayInfo?.() ?? '{}') as { outputWidth?: number; outputHeight?: number; refreshRate?: number };
      if (info.outputWidth) out = `screen ${info.outputWidth}x${info.outputHeight} @ ${Math.round(info.refreshRate ?? 0)} Hz · `;
    } catch {
      /* not the TV app */
    }
    return `${out}${size} · dpr ${dpr.toFixed(2)}`;
  }

  private draw(): void {
    const f = this.frames.stats();
    const p = this.presses.stats();
    const t = this.transport.stats();
    const ms = (v: number) => `${v.toFixed(1)} ms`;
    const lines = [
      `<b>Diagnostics</b> · ${this.fps.toFixed(1)} fps`,
      `frame ${ms(f.p50)} · 95% ${ms(f.p95)} · worst ${ms(f.worst)}`,
      this.presses.count
        ? `press → frame ${ms(p.p50)} · 95% ${ms(p.p95)} · worst ${ms(p.worst)} <i>(${this.presses.count})</i>`
        : 'press → frame: press a button or a key',
      this.transport.count ? `app → page ${ms(t.p50)} · 95% ${ms(t.p95)}` : '',
      this.screenLine(),
      '<i>the screen adds its own delay after this: use its game mode</i>',
    ];
    this.el.innerHTML = lines.filter(Boolean).map((l) => `<div>${l}</div>`).join('');
  }
}

let current: Diag | null = null;

/** Was ?diag asked for in the address? */
export function diagParam(): boolean {
  return typeof location !== 'undefined' && new URLSearchParams(location.search).has('diag');
}

/** Show or hide the overlay (it costs one display-frame callback and a few numbers). */
export function showDiag(on: boolean): void {
  if (on === !!current) return;
  if (on) current = new Diag();
  else {
    current?.dispose();
    current = null;
  }
}
