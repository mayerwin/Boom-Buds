// Web Audio sound engine reproducing the original's tunes.c / sound.c behaviour (docs/re/audio.md):
//  - cached one-shot effects (sound_play_group / sound_play_id) share a 6-voice pool; a request made while
//    6 are playing is dropped (nothing is stolen), its play count still increments;
//  - streamed voices (draw / match winner / quit) are unlimited;
//  - one music tune at a time, looped seamlessly, hard cuts (restarting even the same tune);
//  - SOUNDLST series are randomly culled to a few files at start-up and re-culled every 30 minutes;
//    group plays pick a random least-played member.
// Everything plays at full volume, centred, at the files' 22050 Hz rate; the volume sliders are web
// additions.

import { assetUrl, loadJson } from './assets.ts';

export interface AudioManifest {
  [name: string]: { file: string; samples: number };
}

/** sound_cull_series calls made by soundlst_load: [base, last, keep (Enhanced model)] */
const CULL_SERIES: [number, number, number][] = [
  [200, 299, 3],
  [400, 499, 7],
  [700, 999, 7],
  [1200, 1299, 2],
  [1400, 1699, 7],
  [2300, 2599, 8],
  [2700, 2799, 5],
  ...Array.from({ length: 9 }, (_, k) => [3000 + 50 * k, 3049 + 50 * k, 4] as [number, number, number]),
];

/** groups played through the cached path that should be decoded ahead of time */
const PRELOAD_GROUPS = [10, 20, 40, 100, 120, 130, 135, 140, 141, 142, 150, 160, 170, 200, 300, 341, 350, 360, 400, 550, 700, 1200, 1300, 1310, 1320, 1330, 1400, 2300, 2700, 3000, 3050, 3100, 3150, 3200, 3250, 3300, 3350, 3400];

/**
 * The streamed voices (the draw and match-winner announcers, quitting). The TV app's mixer loads each group's
 * next voice ahead of time, picked in advance: loading a sound there takes tens of milliseconds, too many to
 * load them all.
 */
const VOICE_GROUPS = [1700, 2000, 2600];

const RECULL_MS = 1800 * 1000;

/**
 * The Android TV app (android/): its native mixer plays the short effects, the WebView's own audio output being
 * slow on TVs. play returns false for an effect it has not loaded yet: the page plays that one itself.
 */
interface NativeSounds {
  playSound(path: string, volume: number): boolean;
  preloadSounds(json: string): void;
}
const nativeSounds = (typeof window !== 'undefined' ? (window as unknown as { AndroidHost?: Partial<NativeSounds> }).AndroidHost : undefined) as NativeSounds | undefined;
const NATIVE = !!nativeSounds && typeof nativeSounds.playSound === 'function';

export class AudioEngine {
  ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  /** decoding happens at the files' native 22050 Hz to halve the memory of decoded PCM */
  private decoder: BaseAudioContext | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private loading = new Map<string, Promise<AudioBuffer | null>>();
  manifest: AudioManifest = {};
  /** SOUNDLST as loaded (id -> file name, upper case) */
  private soundListFull: Record<number, string> = {};
  /** after culling */
  soundList: Record<number, string> = {};
  private playCount = new Map<number, number>();
  /** cached one-shots currently playing (the 6-voice pool) */
  private sfxPlaying = 0;
  maxSfx = 6;
  sfxVolume = 1;
  musicVolume = 0.8;
  private music: { src: AudioBufferSourceNode | null; el: HTMLAudioElement | null; node: MediaElementAudioSourceNode | null; id: number; token: number } = { src: null, el: null, node: null, id: -1, token: 0 };
  private pendingMusic = -1;
  enabled = true;
  private lastCull = 0;
  smallMemory = false;
  /** random source for culling and selection (presentation only, never the simulation's RNG) */
  private seed = (Date.now() ^ 0x5bd1e995) >>> 0;

  rand(): number {
    this.seed = (Math.imul(this.seed, 1103515245) + 12345) >>> 0;
    return (this.seed >>> 16) & 0x7fff;
  }

  /** A hidden page is silent (the original's exclusive DirectSound went quiet without the focus). */
  private watchVisibility(): void {
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) void this.ctx.suspend();
      else void this.ctx.resume();
    });
  }

  async init(soundList: Record<string, string>): Promise<void> {
    this.watchVisibility();
    for (const [k, v] of Object.entries(soundList)) this.soundListFull[Number(k)] = v.toUpperCase();
    this.manifest = await loadJson<AudioManifest>('audio/audio.json').catch(() => ({}));
    this.cull();
    // opening the audio device takes tens of milliseconds (hundreds on some machines): do it while the
    // page is idle rather than in the first click; the context stays suspended until a gesture resumes it
    const idle = window.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 300));
    idle(() => this.createContext());
  }

  // ------------------------------------------------------------------------------------------ setup

  private preloaded = false;

  private createContext(): AudioContext {
    if (!this.ctx) {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctx({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      this.sfxGain = this.ctx.createGain();
      this.sfxGain.gain.value = this.sfxVolume;
      this.sfxGain.connect(this.master);
      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = this.musicVolume;
      this.musicGain.connect(this.master);
      if (this.pendingMusic >= 0) {
        const id = this.pendingMusic;
        this.pendingMusic = -1;
        this.playMusic(id);
      }
    }
    return this.ctx;
  }

  /** Must be called from a user gesture handler (autoplay policies). */
  unlock(): void {
    const ctx = this.createContext();
    if (!this.preloaded) {
      this.preloaded = true;
      void this.preload();
    }
    if (ctx.state === 'suspended') void ctx.resume();
  }

  get unlocked(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  private getDecoder(): BaseAudioContext {
    if (!this.decoder) {
      try {
        this.decoder = new OfflineAudioContext(2, 1, 22050);
      } catch {
        this.decoder = this.ctx ?? new OfflineAudioContext(2, 1, 44100);
      }
    }
    return this.decoder;
  }

  // ------------------------------------------------------------------------------------------ culling

  /**
   * soundlst_load's culling (sound_cull_series @00427f1b): compact each series so its defined names are
   * consecutive from the base, then remove random members until `keep` remain. Play counts reset.
   */
  cull(): void {
    const names: Record<number, string> = { ...this.soundListFull };
    for (const [base, last, keepEnh] of CULL_SERIES) {
      const keep = this.smallMemory ? 1 : keepEnh;
      const list: string[] = [];
      for (let id = base; id <= last; id++) if (names[id]) list.push(names[id]);
      for (let id = base; id <= last; id++) delete names[id];
      while (list.length > keep) list.splice(this.rand() % list.length, 1);
      list.forEach((n, i) => (names[base + i] = n));
    }
    this.soundList = names;
    this.playCount.clear();
    this.lastCull = performance.now();
  }

  /** sound_periodic_flush: re-cull every 30 minutes (checked at match setup and round start). */
  maybeRecull(): void {
    if (performance.now() > this.lastCull + RECULL_MS) {
      this.cull();
      void this.preload();
    }
  }

  // ------------------------------------------------------------------------------------------ loading

  private fileFor(name: string): string | null {
    const m = this.manifest[name.toUpperCase()];
    return m ? m.file : null;
  }

  load(name: string): Promise<AudioBuffer | null> {
    name = name.toUpperCase();
    const b = this.buffers.get(name);
    if (b) return Promise.resolve(b);
    let p = this.loading.get(name);
    if (!p) {
      const file = this.fileFor(name);
      p = (async () => {
        if (!file) return null;
        try {
          const r = await fetch(assetUrl('audio/' + file));
          if (!r.ok) return null;
          const data = await r.arrayBuffer();
          const buf = await this.getDecoder().decodeAudioData(data);
          this.buffers.set(name, buf);
          return buf;
        } catch (e) {
          console.warn('audio load failed', name, e);
          return null;
        } finally {
          this.loading.delete(name);
        }
      })();
      this.loading.set(name, p);
    }
    return p;
  }

  /** Decode every member of the cached-path groups so that effects start without delay. */
  async preload(): Promise<void> {
    const names = new Set<string>();
    for (const base of PRELOAD_GROUPS) {
      for (let id = base; this.soundList[id]; id++) names.add(this.soundList[id]);
    }
    const list = [...names];
    if (NATIVE) {
      this.nextVoice.clear();
      const voices = VOICE_GROUPS.flatMap((base) => this.voiceAhead(base));
      nativeSounds!.preloadSounds(JSON.stringify([...list, ...voices].flatMap((n) => this.nativeFile(n))));
    }
    // a few at a time to keep the main thread responsive
    for (let i = 0; i < list.length; i += 8) await Promise.all(list.slice(i, i + 8).map((n) => this.load(n)));
  }

  // ------------------------------------------------------------------------------------------ effects

  /** Number of consecutive defined ids starting at base (a group ends at the first undefined id). */
  groupSize(base: number): number {
    let n = 0;
    while (this.soundList[base + n]) n++;
    return n;
  }

  /** sound_play_group's choice: a random member among the least played (200 tries). */
  pickFromGroup(base: number): number {
    const n = this.groupSize(base);
    if (n === 0) return -1;
    let min = Infinity;
    for (let i = 0; i < n; i++) min = Math.min(min, this.playCount.get(base + i) ?? 0);
    let pick = base;
    for (let tries = 0; tries < 200; tries++) {
      pick = base + (this.rand() % n);
      if ((this.playCount.get(pick) ?? 0) === min) break;
    }
    return pick;
  }

  /** sound_play_group(base): cached path, subject to the 6-voice limit. */
  playGroup(base: number): void {
    const id = this.pickFromGroup(base);
    if (id < 0) return;
    this.playCached(this.soundList[id]);
    this.playCount.set(id, (this.playCount.get(id) ?? 0) + 1);
  }

  /** sound_play_id(id): exact file; stores the frame counter as its play count (original quirk). */
  playId(id: number, frameCounter = 0): void {
    const n = this.soundList[id];
    if (!n) return;
    this.playCached(n);
    this.playCount.set(id, frameCounter);
  }

  /** voice_stream_play_group(base): streamed path, unlimited. */
  playVoiceGroup(base: number): void {
    const id = this.nextVoice.get(base) ?? this.pickFromGroup(base);
    if (id < 0) return;
    this.playCount.set(id, (this.playCount.get(id) ?? 0) + 1);
    this.playStream(this.soundList[id]);
    if (NATIVE && this.nextVoice.delete(base)) nativeSounds!.preloadSounds(JSON.stringify(this.voiceAhead(base).flatMap((n) => this.nativeFile(n))));
  }

  /** the voice each streamed group plays next, picked in advance (the TV app's mixer loads it ahead) */
  private nextVoice = new Map<number, number>();

  /** Pick group `base`'s next voice now; its name (none for an empty group). */
  private voiceAhead(base: number): string[] {
    const id = this.pickFromGroup(base);
    if (id < 0) return [];
    this.nextVoice.set(base, id);
    return [this.soundList[id]];
  }

  private nativeFile(name: string): string[] {
    const file = this.fileFor(name);
    return file ? [assetUrl('audio/' + file)] : [];
  }

  private playCached(name: string): void {
    if (this.sfxPlaying >= this.maxSfx) return; // dropped, nothing is stolen
    if (NATIVE && this.enabled && this.playNative(name)) return;
    if (!this.enabled || !this.unlocked || !this.sfxGain) return; // nothing queues up before the first gesture
    const buf = this.buffers.get(name.toUpperCase());
    if (buf) {
      this.start(buf, true);
      return;
    }
    // not decoded yet (should be rare after preload): reserve the voice, play if still timely
    this.sfxPlaying++;
    const requested = this.ctx!.currentTime;
    void this.load(name).then((b) => {
      this.sfxPlaying--;
      if (b && this.ctx && this.ctx.currentTime - requested < 0.25 && this.sfxPlaying < this.maxSfx) this.start(b, true);
    });
  }

  /**
   * The Android app's native mixer. An effect still counts in the 6-voice pool for as long as it lasts (`counted`);
   * streamed voices do not.
   */
  private playNative(name: string, counted = true): boolean {
    const m = this.manifest[name.toUpperCase()];
    if (!m || !nativeSounds!.playSound(assetUrl('audio/' + m.file), this.sfxVolume)) return false;
    if (!counted) return true;
    this.sfxPlaying++;
    setTimeout(() => (this.sfxPlaying = Math.max(0, this.sfxPlaying - 1)), (m.samples / 22050) * 1000 + 20);
    return true;
  }

  private playStream(name: string): void {
    if (NATIVE && this.enabled && this.playNative(name, false)) return;
    if (!this.enabled || !this.unlocked) return;
    const buf = this.buffers.get(name.toUpperCase());
    if (buf) this.start(buf, false);
    else void this.load(name).then((b) => b && this.start(b, false));
  }

  private start(buf: AudioBuffer, counted: boolean): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.sfxGain!);
    if (counted) {
      this.sfxPlaying++;
      src.onended = () => {
        this.sfxPlaying = Math.max(0, this.sfxPlaying - 1);
      };
    }
    src.start();
  }

  stopAllSfx(): void {
    // one-shots finish on their own; nothing in the original stops them either
  }

  // ------------------------------------------------------------------------------------------ music

  hasSound(id: number): boolean {
    return !!this.soundListFull[id];
  }

  /** tunes_play_id(id): stop the current tune and start `id` from the beginning, looping forever. */
  playMusic(id: number): void {
    this.stopMusic();
    const name = this.soundListFull[id];
    if (!name) return;
    if (!this.ctx) {
      this.pendingMusic = id;
      return;
    }
    const token = ++this.music.token;
    this.music.id = id;
    const cached = this.buffers.get(name);
    const begin = (buf: AudioBuffer) => {
      if (token !== this.music.token || !this.ctx) return;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(this.musicGain!);
      src.start();
      this.music.src = src;
    };
    if (cached) {
      begin(cached);
      return;
    }
    void this.load(name).then((buf) => {
      if (buf) {
        begin(buf);
        // tunes are long: keep only the current one decoded
        for (const [n, b] of this.buffers) if (b !== buf && b.duration > 10) this.buffers.delete(n);
      }
    });
  }

  stopMusic(): void {
    this.music.token++;
    if (this.music.src) {
      try {
        this.music.src.stop();
      } catch {
        /* already stopped */
      }
      this.music.src.disconnect();
    }
    this.music.src = null;
    this.music.id = -1;
    this.pendingMusic = -1;
  }

  get currentMusic(): number {
    return this.music.id;
  }

  setSfxVolume(v: number): void {
    this.sfxVolume = v;
    if (this.sfxGain) this.sfxGain.gain.value = v;
  }

  setMusicVolume(v: number): void {
    this.musicVolume = v;
    if (this.musicGain) this.musicGain.gain.value = v;
  }
}
