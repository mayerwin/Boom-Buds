// Persistent options: the original options.ini fields plus the web version's own.

import { defaultControlPrefs, type ControlPrefs } from './controls.ts';

export interface KeyDefs {
  /** keydef[set][action] = DIK scancode; actions: up, right, down, left, action1, action2 (+4 unused) */
  sets: number[][];
}

export interface Settings {
  /** the arena: 0-10, or random: -1 any (the original's choice), -2 an arena with something special, -3 one of levelList */
  levelno: number;
  num_to_win_match: number;
  enclosement_depth: number;
  conveyor_speed: number;
  team_play: number;
  random_start: number;
  stomped_bombs_detonate: number;
  win_by_kills: number;
  goldman: number;
  schemefilename: string;
  playtime: number; // seconds: 60, 90, 120, 150, 180, 240, 300, 600 or 1001 (= infinite)
  assign_keyboards: number;
  diseases_destroyable: number;
  lost_net_revert_ai: number;
  disable_game_music: number;
  nodename: string;
  modemport: number;
  modembaud: number;
  modemirq: number;
  modemdial: string;
  netprotocol: number;
  smallmemory: number;
  /** options.ini keydefs, kept as stored: the original menus now use the keyboard sets right and left as KEY 0
   * and KEY 1 (src/app/controls.ts classicLayouts) */
  keydefs: KeyDefs;
  /** web additions */
  sfxVolume: number;
  musicVolume: number;
  integerScale: number;
  aiLevel: number;
  touchLayout: number;
  /** control sets (src/app/controls.ts) */
  controls: ControlPrefs;
  /** 1997 ways (src/app/modes.ts): the original menus instead of the modern ones */
  classicMenus: number;
  /** 1997 ways: no mouse cursor in the original menus (except in dialogs), and clicks ignored there */
  classicMouse: number;
  /** 1997 ways: the original's minimum waits before the screens between rounds can be left */
  classicWaits: number;
  /** rounds run four times as fast once only computer players are left */
  fastForward: number;
  /** the last Local Game players' chosen colours and teams (by player, then by computer player; -1: none) */
  localLooks: { players: Look[]; bots: Look[] };
  /** the last Local Game line-up: control set of each human player, skill of each computer player */
  localPlayers: string[];
  localBots: number[];
  /** network games: list this machine's games on the local network */
  lanVisible: number;
  /** the arenas a match picks from with levelno -3, and the name of that list ('' when not saved) */
  levelList: number[];
  levelListName: string;
  /** arena lists saved in the modern menus (src/menu/rules.tsx) */
  arenaLists: ArenaList[];
  /** the stored line-up was looked at since the original's computer player became the default */
  botsOriginal: number;
}

/** A named list of arenas: a match on it plays them in random order. */
export interface ArenaList {
  name: string;
  levels: number[];
}

/** Arena numbers 0-10, each once. */
export function cleanLevels(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is number => Number.isInteger(x) && x >= 0 && x <= 10))].sort((a, b) => a - b);
}

/** A player's chosen colour (0-9, the bomber of that slot) and team (0 white, 1 red); -1 when not chosen. */
export interface Look {
  color: number;
  team: number;
}

export const DEFAULT_KEYDEFS: number[][] = [
  [0xc8, 0xcd, 0xd0, 0xcb, 0x39, 0x1c, 0, 0, 0, 0], // cursor keys, space, enter (manual defaults)
  [0x13, 0x22, 0x21, 0x20, 0x1f, 0x1e, 0, 0, 0, 0], // R G F D, S A
];

export function defaultSettings(): Settings {
  return {
    levelno: -1,
    num_to_win_match: 2,
    enclosement_depth: 1,
    conveyor_speed: 1,
    team_play: 0,
    random_start: 1,
    stomped_bombs_detonate: 1,
    win_by_kills: 0,
    goldman: 0,
    schemefilename: 'BASIC.SCH',
    playtime: 150,
    assign_keyboards: 1,
    diseases_destroyable: 1,
    lost_net_revert_ai: 0,
    disable_game_music: 0,
    nodename: '',
    modemport: 2,
    modembaud: 19200,
    modemirq: 3,
    modemdial: '555-1212',
    netprotocol: 4, // Internet (Boom Buds' addition to the original list)
    smallmemory: 0,
    keydefs: { sets: DEFAULT_KEYDEFS.map((s) => [...s]) },
    sfxVolume: 1,
    musicVolume: 0.8,
    integerScale: 0,
    aiLevel: 0,
    touchLayout: 0,
    controls: defaultControlPrefs(),
    classicMenus: 0,
    classicMouse: 0,
    classicWaits: 0,
    fastForward: 1,
    localLooks: { players: [], bots: [] },
    localPlayers: [],
    localBots: [0],
    lanVisible: 1,
    levelList: [],
    levelListName: '',
    arenaLists: [],
    botsOriginal: 1,
  };
}

const KEY = 'boombuds.settings.v1';

export function loadSettings(): Settings {
  const s = defaultSettings();
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) Object.assign(s, JSON.parse(raw));
    // options_load_ini clamps
    // (Boom Buds: -2 and -3 are its random choices among special arenas and among a list)
    if (s.levelno < -3) s.levelno = -1;
    if (s.levelno > 10) s.levelno = 10;
    s.levelList = cleanLevels(s.levelList);
    s.levelListName = typeof s.levelListName === 'string' ? s.levelListName.slice(0, 24) : '';
    if (s.levelno === -3 && !s.levelList.length) s.levelno = -1;
    s.arenaLists = Array.isArray(s.arenaLists)
      ? s.arenaLists.flatMap((l) => (l && typeof l.name === 'string' && cleanLevels(l.levels).length ? [{ name: l.name.slice(0, 24), levels: cleanLevels(l.levels) }] : []))
      : [];
    if (s.num_to_win_match < 1) s.num_to_win_match = 1;
    if (s.enclosement_depth < 0 || s.enclosement_depth > 3) s.enclosement_depth = 1;
    if (s.conveyor_speed < 0 || s.conveyor_speed > 2) s.conveyor_speed = 1;
    if (s.playtime < 60) s.playtime = 60;
    if (s.playtime > 600 && s.playtime !== 1001) s.playtime = 600;
    if (s.team_play) s.win_by_kills = 0;
    // built-in control sets come back if a stored list lost them
    const defaults = defaultControlPrefs().sets;
    if (!s.controls || !Array.isArray(s.controls.sets)) s.controls = defaultControlPrefs();
    for (const d of defaults) if (!s.controls.sets.some((x) => x.id === d.id)) s.controls.sets.unshift(d);
    if (!Array.isArray(s.localPlayers)) s.localPlayers = [];
    if (!Array.isArray(s.localBots)) s.localBots = [0];
    s.localBots = s.localBots.map((v) => (Number.isInteger(v) ? Math.max(0, Math.min(5, v)) : 0));
    // the original's computer player became the default (2026-10): a line-up left as it came gets it too
    if (!s.botsOriginal) {
      if (s.localBots.length === 1 && s.localBots[0] === 3) s.localBots = [0];
      s.botsOriginal = 1;
    }
    if (!s.localLooks || !Array.isArray(s.localLooks.players) || !Array.isArray(s.localLooks.bots)) s.localLooks = { players: [], bots: [] };
  } catch {
    /* storage unavailable */
  }
  return s;
}

/** Forget the stored settings (the page should reload): everything is back to its defaults. */
export function resetSettings(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}
