// A match: setup screens (Goldman roulette, player/input setup, level and wins), the rounds, and the
// end-of-round screens (draw, results, victory). docs/re/screens.md §9–§17, match-flow.md §3.
//
// Network games follow the original's model: the host decides (slots, level, wins, when screens advance)
// and the clients mirror it; a client can only change its own players. Messages (control channel):
//   host -> all : setup {slots, teamPlay, winByKills, level, wins} | slots {slots} | opts {level, wins}
//                 key {k: 0x385 setup done, 0x386 options done, 0x387 results, 0x388 draw} | abort
//                 match {params} (everything needed to build the identical simulation)
//   client -> host: set {s, type, dev} (change one of its own slots)

import type { Game } from '../app/Game.ts';
import { K } from '../ui/menuInput.ts';
import { isRealKey } from '../ui/ui.ts';
import { helpScreen } from '../ui/helpViewer.ts';
import { screenShowPcx } from './title.ts';
import { MatchRunner, slotCtrl } from './round.ts';
import { flattenValues, roundWinner, awardRoundPoint, type MatchConfig } from '../game/sim/sim.ts';
import { AI_DEFAULT, INPUT_AI, INPUT_JOY, INPUT_KEY, INPUT_NET, INPUT_OFF, type Slot } from '../app/session.ts';
import type { Scheme } from '../engine/assets.ts';
import { DrawMode } from '../engine/gl/Renderer.ts';
import { TEXT_SHADOW } from '../ui/gnw.ts';
import { CAMP_FAILED } from '../game/sim/campaign.ts';
import { allSchemes, parseSchemeText, schemeFileText } from '../app/schemes.ts';
import { specialLevels } from '../game/levels.ts';
import { cleanLevels } from '../app/settings.ts';
import { classicChoices, classicInput, idsClash, keyboardsHere, slotSetId } from '../app/controls.ts';
import { originalMouse } from '../app/modes.ts';
import { lineupFromSlots, savedLineupSlots, schemeTeams, storeLineup } from '../menu/lineup.ts';

/** power-up type -> "power <name>" sequence */
const POWER_SEQ = ['bomb', 'flame', 'disease', 'kicker', 'skate', 'punch', 'grab', 'spooge', 'goldflame', 'trigger', 'jelly', 'disease3', 'random', 'clog'];
/** roulette prize table (0x45b7bc) */
const PRIZES = [0, 1, 3, 8, 4, 13];

const KEY_SETUP_DONE = 0x385;
const KEY_OPTIONS_DONE = 0x386;
const KEY_RESULTS = 0x387;
const KEY_DRAW = 0x388;

/** Everything that defines the simulation of a match (sent by the host in network games). */
export interface MatchParams {
  scheme: string;
  level: number;
  numToWin: number;
  winByKills: number;
  teamPlay: number;
  randomStart: number;
  enclosementDepth: number;
  conveyorSpeed: number;
  stomped: number;
  diseasesDestroyable: number;
  playtime: number;
  smallMemory: number;
  goldWinner: number;
  goldPrize: number;
  seed: number;
  /** network games: the scheme file itself (it may exist only on the host, made with the editor) */
  schemeText?: string;
  /** with level -1: the arenas to pick from (Boom Buds' random special arena and arena lists) */
  levels?: number[];
}

function findScheme(g: Game, file: string): Scheme {
  const name = file.toUpperCase();
  const list = allSchemes(g.app);
  return list.find((s) => s.file.toUpperCase() === name) ?? list.find((s) => s.file.toUpperCase() === 'BASIC.SCH') ?? list[0];
}

export function buildParams(g: Game, level: number): MatchParams {
  const st = g.settings;
  const session = g.session;
  const ui = g.ui;
  const local = session.netMode === 0;
  // a random choice among special arenas or among a list: the match picks a random arena from those
  const levels = level === -2 ? specialLevels(g.app.text.values, g.app.text.extras) : level === -3 ? cleanLevels(st.levelList) : [];
  return {
    scheme: st.schemefilename,
    level: level < -1 ? -1 : level,
    levels: levels.length ? levels : undefined,
    numToWin: st.num_to_win_match,
    winByKills: st.team_play ? 0 : st.win_by_kills,
    teamPlay: st.team_play,
    randomStart: st.random_start,
    enclosementDepth: st.enclosement_depth,
    conveyorSpeed: st.conveyor_speed,
    stomped: st.stomped_bombs_detonate,
    // the host forces destroyable diseases in network games
    diseasesDestroyable: local ? st.diseases_destroyable : 1,
    playtime: st.playtime,
    smallMemory: st.smallmemory,
    goldWinner: local && st.goldman && !session.attract ? session.goldPlayer : -1,
    goldPrize: session.rouletteResult,
    seed: ((Date.now() & 0x7fffffff) ^ (ui.rand() << 15) ^ ui.rand()) >>> 0,
  };
}

function configFromParams(g: Game, p: MatchParams): MatchConfig {
  const app = g.app;
  const scheme = p.schemeText !== undefined ? parseSchemeText(p.scheme.toUpperCase(), p.schemeText, app.values) : findScheme(g, p.scheme);
  const values = flattenValues(app.text.values);
  if (p.smallMemory) {
    // valuelst_load's small-memory overrides
    values[7] = values[9];
    values[105] = 1;
    values[330] = 1;
    values[3] = 1;
    values[4] = 0;
  }
  return {
    slots: g.session.slots.map((sl) => ({ ctrl: slotCtrl(sl.type), team: sl.team })),
    values,
    scheme,
    extras: app.text.extras,
    levelno: p.level,
    levels: p.levels ? cleanLevels(p.levels) : undefined,
    numToWin: p.numToWin,
    winByKills: p.winByKills,
    teamPlay: p.teamPlay,
    randomStart: p.randomStart,
    enclosementDepth: p.enclosementDepth,
    conveyorSpeed: p.conveyorSpeed,
    stompedBombsDetonate: p.stomped,
    diseasesDestroyable: p.diseasesDestroyable,
    playtime: p.playtime,
    // network games play with the local-game rules: the original's network restrictions (no duds, no
    // swap disease, ...) worked around its netcode, which the deterministic simulation does not need
    netMode: 0,
    goldWinner: p.goldWinner,
    goldPrize: p.goldPrize,
    attract: g.session.attract,
    seed: p.seed,
  };
}

/** View of the host's settings that the screens display (clients use the host's values). */
interface SetupView {
  teamPlay: number;
  winByKills: number;
}

/** match_play (0x42a3f6) */
export async function matchPlay(g: Game): Promise<void> {
  const ui = g.ui;
  const session = g.session;
  const app = g.app;
  const net = session.net;
  session.campaign = 0;
  app.audio.playMusic(1020);
  const params = await matchSetup(g);
  if (session.matchEnd || !params) {
    if (net?.role === 'host') net.broadcast({ t: 'abort' });
    return;
  }
  if (session.campaign) {
    await campaignPlay(g, params);
    await ui.delay(1000, () => {});
    return;
  }
  await playMatch(g, params);
}

/**
 * The rounds of a match and the screens between them (draw, results, victory), once the players and the
 * parameters are known: the end of match_play, shared by the classic and the modern menus.
 */
export async function playMatch(g: Game, params: MatchParams): Promise<void> {
  const ui = g.ui;
  const session = g.session;
  const app = g.app;
  const net = session.net;
  session.matchEnd = 0;
  const runner = new MatchRunner(g, configFromParams(g, params));
  if (net) net.inMatch = true;
  if (net && net.role === 'host') {
    net.onLeave = (id) => {
      runner.playerMachineLost(id);
      net.broadcast({ t: 'slots', slots: session.slots });
    };
  }
  try {
    await runner.startRound();
    session.autoContinue = 0;
    for (;;) {
      await runner.playRound();
      if (session.attract) return; // straight back to the menu, no screens, no delay
      if (session.matchEnd) break;
      app.audio.playMusic(1130);
      const s = runner.s;
      const w = roundWinner(s);
      const name = w === -1 ? ui.msg(32) : ui.fmt(params.teamPlay ? 34 : 33, w + 1);
      if (w === -1) {
        await drawScreen(g);
        ui.gamePalette();
      }
      if (!session.matchEnd) await resultsScreen(g, runner, name, params);
      if (session.matchEnd) break;
      await runner.startRound();
    }
    // end-of-match pause: 10 x 100 ms with the screen unchanged
    await ui.delay(1000, () => {});
  } finally {
    runner.dispose();
    if (net) {
      net.onLeave = null;
      net.inMatch = false;
    }
  }
}

/** match_setup (0x410f81): returns the parameters of the match, or null when it was aborted. */
async function matchSetup(g: Game): Promise<MatchParams | null> {
  const ui = g.ui;
  const session = g.session;
  const st = g.settings;
  const net = session.net;
  session.matchEnd = 0;
  g.app.audio.maybeRecull();
  if (net && net.role === 'client') return clientSetup(g);
  const scheme = findScheme(g, st.schemefilename);
  if (!session.attract && st.goldman && session.netMode === 0 && session.goldPlayer !== -1) {
    await rouletteScreen(g);
    if (session.matchEnd) return null;
  }
  if (session.netMode === 0) {
    // the line-up kept by the modern menus (or by this screen at an earlier visit), the first time (a demo
    // leaves it for the next setup)
    if (session.fromLineup && !session.attract) {
      session.slots = savedLineupSlots(g);
      session.fromLineup = false;
    }
    for (const sl of session.slots) if (sl.type === INPUT_NET) sl.type = INPUT_OFF;
  } else if (net) hostAssignSlots(g);
  // scheme_parse: the teams come from the scheme's start entries at every match setup (Boom Buds: except the
  // team a player chose, in the modern menus or with T here)
  session.slots.forEach((sl, i) => {
    const sst = scheme.starts[i];
    if (!sl.teamChosen || session.attract) sl.team = sst ? sst[2] : i & 1;
  });
  await ui.randomGlue();
  if (session.attract) {
    for (const sl of session.slots) {
      sl.type = INPUT_OFF;
      sl.dev = 0;
      sl.ctl = undefined;
    }
    let n = (ui.rand() % 10) + 1;
    if (n < 3) n = 3;
    let level = ui.rand() % Math.max(ui.value(35), 1);
    if (session.bench) {
      n = session.bench.players;
      if (session.bench.level >= 0) level = session.bench.level;
    }
    for (let p = 0; p < n; p++) {
      session.slots[p].type = INPUT_AI;
      if (session.bench?.ai) session.slots[p].ai = session.bench.ai;
    }
    return buildParams(g, level);
  }
  const view: SetupView = { teamPlay: st.team_play, winByKills: st.team_play ? 0 : st.win_by_kills };
  net?.broadcast({ t: 'setup', slots: session.slots, ...view, level: st.levelno, wins: st.num_to_win_match });
  await playerSetupScreen(g, view);
  keepLineup(g);
  if (session.matchEnd) return null;
  net?.broadcast({ t: 'key', k: KEY_SETUP_DONE });
  if (session.campaign) return buildParams(g, st.levelno); // campaign: no level/wins screen
  const opt = await matchOptionsScreen(g, view, st.levelno, st.num_to_win_match);
  if (session.matchEnd || !opt) return null;
  st.levelno = opt.level;
  st.num_to_win_match = opt.wins;
  g.app.saveSettings();
  const params = buildParams(g, opt.level);
  if (net) {
    params.schemeText = schemeFileText(g.app, params.scheme) ?? undefined;
    dropLostMachines(g);
    net.broadcast({ t: 'match', params, slots: session.slots });
    net.broadcast({ t: 'key', k: KEY_OPTIONS_DONE });
  }
  return params;
}

/** A local game's player setup is the Local Game's line-up of the modern menus too: it keeps what was set here. */
function keepLineup(g: Game): void {
  const session = g.session;
  if (session.netMode !== 0 || session.attract || session.campaign) return;
  const { players, bots } = lineupFromSlots(g, session.slots, g.settings.schemefilename);
  storeLineup(g, players, bots);
  g.app.saveSettings();
}

/** Host: players of machines that left become computer players or are switched off. Returns true if any. */
function dropLostMachines(g: Game): boolean {
  const session = g.session;
  const net = session.net;
  if (!net || net.role !== 'host') return false;
  const members = new Set(net.members.map((m) => m.id));
  let changed = false;
  for (const sl of session.slots) {
    if ((sl.type === INPUT_KEY || sl.type === INPUT_JOY) && sl.owner !== net.myId && !members.has(sl.owner)) {
      sl.type = g.settings.lost_net_revert_ai ? INPUT_AI : INPUT_OFF;
      sl.dev = 0;
      sl.ctl = undefined;
      sl.owner = net.myId;
      changed = true;
    }
  }
  return changed;
}

/** Host: the slot table of a network match (owners = machines). */
function hostAssignSlots(g: Game): void {
  const session = g.session;
  const net = session.net!;
  const members = new Set(net.members.map((m) => m.id));
  if (session.afterNet) {
    // first match of the session: the host's keyboard player, then one player per client
    session.afterNet = false;
    for (const sl of session.slots) {
      sl.type = INPUT_OFF;
      sl.dev = 0;
      sl.ctl = undefined;
      sl.owner = 0;
    }
    session.slots[0] = { ...session.slots[0], type: INPUT_KEY, dev: 0, owner: net.myId };
    let i = 1;
    for (const m of net.members) {
      if (i >= 10) break;
      session.slots[i] = { ...session.slots[i], type: INPUT_KEY, dev: 0, owner: m.id };
      i++;
    }
  } else dropLostMachines(g);
  void members;
}

/** Client: follow the host through the setup screens. */
async function clientSetup(g: Game): Promise<MatchParams | null> {
  const ui = g.ui;
  const session = g.session;
  const net = session.net!;
  await ui.randomGlue();
  // wait for the host's setup message
  type SetupMsg = { slots: Slot[]; teamPlay: number; winByKills: number; level: number; wins: number };
  let setup: SetupMsg | null = null;
  while (!setup) {
    const m = net.take('setup');
    if (m.length) setup = m[m.length - 1].msg as unknown as SetupMsg;
    if (net.aborted || net.hostLost) {
      session.matchEnd = 2;
      return null;
    }
    ui.restore();
    const k = await ui.flip();
    if (k === K.ESC) {
      session.matchEnd = 2;
      return null;
    }
  }
  const got: SetupMsg = setup;
  session.slots = got.slots.map((x) => ({ ...x }));
  const view: SetupView = { teamPlay: got.teamPlay, winByKills: got.winByKills };
  await playerSetupScreen(g, view);
  if (session.matchEnd) return null;
  const opt = await matchOptionsScreen(g, view, got.level, got.wins);
  if (session.matchEnd || !opt) return null;
  return opt.params ?? null;
}

// ------------------------------------------------------------------------------------ player setup

function inputLabel(g: Game, p: number): string {
  const ui = g.ui;
  const sl = g.session.slots[p];
  const type = g.session.displayType(p);
  // a player of this machine with a control set of its own (Boom Buds offers every set: KEY 2, JOY 0 L, MOUSE...)
  if ((type === INPUT_KEY || type === INPUT_JOY) && sl.ctl) {
    const c = classicInput(g.settings.controls, sl.ctl);
    if (c.word) return c.word;
    if (c.dev < 0) return c.type === INPUT_JOY ? `JOY ?${c.extra}` : 'KEY ?';
    return c.type === INPUT_JOY ? ui.fmt(223, c.dev) + c.extra : ui.fmt(222, c.dev);
  }
  switch (type) {
    case INPUT_AI: return `${ui.msg(221)} ${sl.ai}`; // skill level: Boom Buds addition
    case INPUT_KEY: return ui.fmt(222, sl.dev);
    case INPUT_JOY: return ui.fmt(223, sl.dev);
    case INPUT_NET: return ui.msg(224);
    default: return ui.msg(220);
  }
}

interface SlotInput {
  type: number;
  dev: number;
  ai: number;
  /** the control set of a human player */
  ctl?: string;
}

/**
 * player_cycle_input (0x421e80): the next input of slot `p` (not applied):
 * OFF -> AI -> KEY 0 -> KEY 1 -> JOY 0 .. -> OFF. (The computer player's skill is set separately.) Boom Buds
 * goes through every control set of this machine where the original had KEY 0, KEY 1 and the joysticks: the other
 * keyboard sets after KEY 1, each half of a gamepad after it, then the mouse and touch controls (src/app/controls.ts
 * classicChoices); a pixel replay of the original, with two keyboard sets and no gamepad, cycles as it did.
 */
function cycledInput(g: Game, p: number): SlotInput {
  const session = g.session;
  const sl = session.slots[p];
  const prefs = g.settings.controls;
  const choices = classicChoices(prefs, !originalMouse(g.settings), g.app.isTouch, keyboardsHere(g.app.input));
  const ai = sl.ai;
  const human = (id: string | undefined): SlotInput => {
    if (!id) return { type: INPUT_OFF, dev: 0, ai };
    const c = classicInput(prefs, id);
    return { type: c.type, dev: Math.max(0, c.dev), ai, ctl: id };
  };
  switch (sl.type) {
    case INPUT_OFF:
      return session.netMode === 2 || session.campaign ? human(choices[0]) : { type: INPUT_AI, dev: 0, ai };
    case INPUT_AI:
      return human(choices[0]);
    case INPUT_KEY:
    case INPUT_JOY: {
      const i = choices.indexOf(slotSetId(prefs, sl));
      return human(i >= 0 ? choices[i + 1] : undefined);
    }
    default:
      return { type: sl.type, dev: sl.dev, ai, ctl: sl.ctl };
  }
}

/** Change a slot as machine `actor` (the host applies its own changes and the clients' requests). */
function applySlot(g: Game, p: number, type: number, dev: number, ai: number, actor: number, ctl?: unknown): void {
  const sl = g.session.slots[p];
  const human = type === INPUT_KEY || type === INPUT_JOY;
  sl.type = type;
  sl.dev = dev;
  sl.ai = Number.isInteger(ai) ? Math.max(0, Math.min(5, ai)) : AI_DEFAULT;
  sl.ctl = human && typeof ctl === 'string' && ctl.length <= 200 ? ctl : undefined;
  sl.owner = human ? actor : g.session.net ? g.session.net.hostId : 0;
}

/** players_count_input_conflicts: two players of one machine on the same control set (or parts of one). */
function inputConflicts(g: Game): number {
  const slots = g.session.slots;
  const prefs = g.settings.controls;
  const human = (i: number) => slots[i].type === INPUT_KEY || slots[i].type === INPUT_JOY;
  let n = 0;
  for (let a = 0; a < 10; a++) {
    for (let b = a + 1; b < 10; b++) {
      if (human(a) && human(b) && slots[a].owner === slots[b].owner && idsClash(prefs, slotSetId(prefs, slots[a]), slotSetId(prefs, slots[b]))) n++;
    }
  }
  return n;
}

/** a tap on a computer player's "AI n" (no key has this code) */
const TAP_SKILL = 0x10000;

async function playerSetupScreen(g: Game, view: SetupView): Promise<void> {
  const ui = g.ui;
  const session = g.session;
  const net = session.net;
  const client = session.netMode === 2;
  const host = session.netMode === 1;
  ui.flushInput();
  let sel = 0;
  let cCount = 0;
  const start = performance.now();
  const X = ui.value(710), Y = ui.value(711), YS = ui.value(712), W = ui.value(713);
  for (;;) {
    // network: the host applies the clients' requests, clients follow the host
    if (host && net) {
      let changed = dropLostMachines(g);
      for (const { from, msg } of net.take('set')) {
        const p = Number(msg.s);
        if (p < 0 || p > 9) continue;
        const sl = session.slots[p];
        const human = sl.type === INPUT_KEY || sl.type === INPUT_JOY;
        if (human && sl.owner !== from) continue; // another machine's player
        applySlot(g, p, Number(msg.type), Number(msg.dev), Number(msg.ai), from, msg.ctl);
        changed = true;
      }
      if (changed) net.broadcast({ t: 'slots', slots: session.slots });
    } else if (client && net) {
      const m = net.take('slots');
      if (m.length) session.slots = (m[m.length - 1].msg.slots as Slot[]).map((x) => ({ ...x }));
      if (net.aborted || net.hostLost) {
        session.matchEnd = 2;
        return;
      }
      if (net.take('key').some(({ msg }) => msg.k === KEY_SETUP_DONE)) {
        ui.menuExit();
        return;
      }
    }
    ui.restore();
    ui.print(ui.msg(50), ui.value(708), ui.value(705), ui.value(706), ui.col.white, ui.col.black);
    for (let p = 0; p < 10; p++) {
      const [fg, outline] = ui.col.player(p, -1);
      ui.print(ui.fmt(51, p + 1, inputLabel(g, p)), W, X, Y + YS * p, fg, outline);
      if (p === sel) ui.cursor(X - 15, Y + YS * p + 16);
      if (view.teamPlay) {
        const t = session.slots[p].team;
        const team = ui.msg(230);
        ui.print(team, ui.textWidth(team), X + W, Y + YS * p, t === 0 ? ui.col.white : ui.col.lightRed, ui.col.black);
      }
    }
    ui.print(ui.msg(40), ui.value(718), ui.value(715), ui.value(716), ui.col.white, ui.col.black);
    const joys = g.joystickCount();
    for (let j = 0; j < 10; j++) {
      const t = j < joys ? ui.fmt(41, j, g.joystickName(j)) : '';
      ui.print(t, ui.value(723), ui.value(720), ui.value(721) + ui.value(722) * j, ui.col.white, ui.col.black);
    }
    if (joys === 0) ui.print(ui.msg(42), 320, 320, 170, ui.col.white, ui.col.black);
    // Boom Buds addition: how to set the skill of the selected computer player
    if (!client && session.slots[sel].type === INPUT_AI) {
      ui.print(ui.pointerMenus ? 'Skill: + -, 1-5, click AI (0: 1997)' : 'Skill: + - or 1 to 5 (AI 0: 1997)', 310, 315, 400, ui.col.grey, ui.col.black);
    }
    if (!client) ui.pressF1();
    let k = await ui.flip();
    if (k === K.MOUSE && ui.pointerMenus) {
      // touch or mouse (Ui.pointerMenus): tap a row to select it, tap the selected row to cycle its input, tap TEAM to switch team
      const t = ui.taps[0];
      const row = Math.floor((t.y - Y) / YS);
      if (row >= 0 && row < 10 && t.x >= X - 30 && t.x < X + W + 50) {
        const labelX = X + 1 + ui.textWidth(ui.fmt(51, row + 1, ''));
        if (view.teamPlay && t.x >= X + W) {
          sel = row;
          k = 0x74;
        } else if (row === sel && session.slots[row].type === INPUT_AI && t.x >= labelX) {
          k = TAP_SKILL; // tapping "AI n" steps the skill: 0 (the original's computer player) to 5, then 0
        } else if (row === sel) k = K.RIGHT;
        else sel = row;
      }
    }
    if (isRealKey(k)) ui.letter();
    const sl = session.slots[sel];
    const remote = session.displayType(sel) === INPUT_NET;
    const change = (type: number, dev: number, ai = sl.ai, ctl?: string) => {
      if (client && net) net.send(net.hostId, { t: 'set', s: sel, type, dev, ai, ctl });
      else {
        applySlot(g, sel, type, dev, ai, session.myId, ctl);
        if (net) net.broadcast({ t: 'slots', slots: session.slots });
      }
    };
    switch (k) {
      case K.UP:
        if (--sel < 0) sel = 9;
        break;
      case K.DOWN:
        if (++sel > 9) sel = 0;
        break;
      case K.RIGHT:
        if (remote) ui.refuse();
        else {
          const c = cycledInput(g, sel);
          change(c.type, c.dev, c.ai, c.ctl);
        }
        break;
      case 0x31:
      case 0x32:
      case 0x33:
      case 0x34:
      case 0x35:
        // number keys: skill of a computer player (Boom Buds addition)
        if (client || sl.type !== INPUT_AI) ui.refuse();
        else change(INPUT_AI, 0, k - 0x30);
        break;
      case 0x2b:
      case 0x3d:
      case 0x2d:
      case 0x5f:
        // + and -: one step of skill up or down (Boom Buds addition)
        if (client || sl.type !== INPUT_AI) ui.refuse();
        else change(INPUT_AI, 0, Math.max(0, Math.min(5, sl.ai + (k === 0x2d || k === 0x5f ? -1 : 1))));
        break;
      case TAP_SKILL:
        if (client || sl.type !== INPUT_AI) ui.refuse();
        else change(INPUT_AI, 0, (sl.ai + 1) % 6);
        break;
      case K.LEFT:
        if (remote) ui.refuse();
        else change(INPUT_OFF, 0);
        break;
      case 0x30:
      case 0x4f:
      case 0x6f:
        if (client) ui.refuse();
        else change(INPUT_OFF, 0);
        break;
      case 0x54:
      case 0x74:
        if (client || sl.type === INPUT_OFF) ui.refuse();
        else {
          sl.team = sl.team === 0 ? 1 : 0;
          // (a team other than the scheme's stays for the next matches, and in the modern menus)
          sl.teamChosen = sl.team !== schemeTeams(g, g.settings.schemefilename)[sel];
          if (net) net.broadcast({ t: 'slots', slots: session.slots });
        }
        break;
      case K.CTRL_A:
        if (session.netMode === 0) {
          for (const s of session.slots) {
            s.type = INPUT_AI;
            s.dev = 0;
            s.ctl = undefined;
          }
        }
        break;
      case 0x43:
      case 0x63:
        if (session.netMode === 0 && ++cCount === 5) {
          cCount = 0;
          await campaignSelect(g);
        }
        break;
      case K.ENTER:
      case K.SPACE:
        if (client) {
          ui.refuse();
          break;
        }
        if (start + ui.minWaitSecs() * 1000 >= performance.now()) break;
        if (inputConflicts(g) !== 0) {
          ui.mouseShow();
          await g.dlg.msgboxOk(ui.msg(96), ui.msg(45), ui.col.darkRed, ui.col.yellow);
          ui.mouseHide();
          break;
        }
        if (!session.campaign && session.countSides(!!view.teamPlay) < 2) {
          ui.mouseShow();
          await g.dlg.msgboxOk(ui.msg(96), ui.msg(view.teamPlay ? 48 : 46), ui.col.darkRed, ui.col.yellow);
          ui.mouseHide();
          break;
        }
        ui.menuExit();
        return;
      case K.ESC:
        session.goldPlayer = -1;
        ui.menuExit();
        session.matchEnd = 2;
        return;
      case K.F1:
        if (client) ui.refuse();
        else await helpScreen(ui, g.dlg);
        break;
      case K.ALT_D:
        if (client) ui.refuse();
        else await g.debugWindow();
        break;
    }
  }
}

/** campaign_select_screen (0x4015c6): campaign play is not part of this version (docs/DIFFERENCES.md). */
/** campaign_select_screen (0x4015c6): choose a .CAM file; campaign mode lasts for this match. */
async function campaignSelect(g: Game): Promise<void> {
  const ui = g.ui;
  const session = g.session;
  const files = Object.keys(g.app.text.campaigns).map((f) => f.toUpperCase()).sort();
  if (!files.length) {
    await g.dlg.msgboxOk(ui.msg(97), ui.msg(1215), ui.col.darkRed, ui.col.white);
    return;
  }
  const i = await g.dlg.listSelect(ui.msg(1250), files, 100, 100, ui.col.white | TEXT_SHADOW);
  if (i < 0 || i >= files.length) return;
  session.campaignStages = (g.app.text.campaigns[files[i]] ?? []) as CampaignStageDef[];
  await g.dlg.msgboxOk(ui.msg(95), ui.msg(1210), ui.col.white, ui.col.black);
  session.campaign = 1;
  for (const sl of session.slots) {
    if (sl.type === INPUT_AI) {
      sl.type = INPUT_OFF;
      sl.dev = 0;
    }
  }
}

interface CampaignStageDef {
  name: string;
  level: number;
  scheme: string;
  rovers: number;
  roverSpeed: number;
  ghosts: number;
  ghostSpeed: number;
  ais: number;
}

/**
 * A campaign (match_play's campaign branch + campaign_next_stage 0x40133f): stages are played in order;
 * a stage ends when every alien and computer player is gone (next stage), when the time runs out
 * ("Campaign unsuccessful!", then the next stage: original behaviour) or when no human is left (the same
 * stage again). Points (the S: count) carry over from stage to stage.
 */
async function campaignPlay(g: Game, params: MatchParams): Promise<void> {
  const ui = g.ui;
  const session = g.session;
  const st = g.settings;
  const c = ui.col;
  const stages = session.campaignStages;
  let index = -1;
  let prev: MatchRunner | null = null;
  for (;;) {
    index++;
    if (index >= stages.length) {
      await g.dlg.msgboxOk(ui.msg(1220), ui.msg(1225), c.darkRed, c.white);
      session.matchEnd = 10;
      break;
    }
    const stage = stages[index];
    // the stage's scheme and level become the current settings (they stay so afterwards, as in the original)
    st.schemefilename = `${stage.scheme.toUpperCase()}.SCH`;
    st.levelno = stage.level;
    g.app.saveSettings();
    await g.dlg.msgboxOk(ui.msg(1230), ui.fmt(1235, stage.name), c.white, c.black);
    const cfg = configFromParams(g, {
      ...params,
      scheme: st.schemefilename,
      level: stage.level,
      seed: ((Date.now() & 0x7fffffff) ^ (ui.rand() << 15) ^ ui.rand()) >>> 0,
    });
    cfg.campaign = { rovers: stage.rovers, roverSpeed: stage.roverSpeed, ghosts: stage.ghosts, ghostSpeed: stage.ghostSpeed, ais: stage.ais };
    const runner = new MatchRunner(g, cfg);
    if (prev) {
      // points and kills carry over
      runner.s.players.forEach((p, i) => {
        p.score = prev!.s.players[i].score;
        p.kills = prev!.s.players[i].kills;
      });
      prev.dispose();
    }
    prev = runner;
    await runner.startRound();
    await runner.playRound();
    if (session.matchEnd) break;
    if (runner.s.camp.status === CAMP_FAILED) {
      await g.dlg.msgboxOk(ui.msg(1240), ui.msg(1245), c.darkRed, c.white);
      if (runner.s.camp.retry) index--;
    }
  }
  prev?.dispose();
}

/** Modern menus: choose a campaign and play it with the players already set up in session.slots. */
export async function playCampaign(g: Game): Promise<void> {
  const session = g.session;
  session.matchEnd = 0;
  session.campaign = 0;
  g.app.audio.playMusic(1020);
  await g.ui.randomGlue();
  g.ui.restore();
  await g.ui.present();
  g.ui.mouseShow();
  await campaignSelect(g);
  g.ui.mouseHide();
  if (!session.campaign) return;
  try {
    await campaignPlay(g, buildParams(g, g.settings.levelno));
  } finally {
    session.campaign = 0;
  }
}

// ------------------------------------------------------------------------------------ match options

async function matchOptionsScreen(
  g: Game,
  view: SetupView,
  level: number,
  wins: number,
): Promise<{ level: number; wins: number; params?: MatchParams } | null> {
  const ui = g.ui;
  const session = g.session;
  const net = session.net;
  const client = session.netMode === 2;
  await ui.randomGlue();
  ui.restore();
  await ui.present();
  // (the original's choices: one arena or any; Boom Buds' arena lists are a modern-menus thing)
  let optLevel = Math.max(-1, level);
  let optWins = wins;
  let sel = 0;
  let previewDirty = true;
  let preview: Preview | null = null;
  let start = performance.now();
  let params: MatchParams | undefined;
  const X = ui.value(735), Y = ui.value(736), YS = ui.value(737), W = ui.value(738);
  const nLevels = ui.value(35);
  const sendOpts = () => net?.broadcast({ t: 'opts', level: optLevel, wins: optWins });
  for (;;) {
    if (net && !client && dropLostMachines(g)) net.broadcast({ t: 'slots', slots: session.slots });
    if (client && net) {
      for (const { msg } of net.take('opts')) {
        if (Number(msg.level) !== optLevel) previewDirty = true;
        optLevel = Number(msg.level);
        optWins = Number(msg.wins);
        start = performance.now();
      }
      const pm = net.take('match');
      if (pm.length) {
        const m = pm[pm.length - 1].msg;
        params = m.params as MatchParams;
        session.slots = (m.slots as Slot[]).map((x) => ({ ...x }));
        net.take('slots'); // older tables, superseded by this one
      }
      if (net.aborted || net.hostLost) {
        session.matchEnd = 2;
        return null;
      }
      if (params && net.take('key').some(({ msg }) => msg.k === KEY_OPTIONS_DONE)) {
        ui.menuExit();
        return { level: optLevel, wins: optWins, params };
      }
    }
    ui.restore();
    if (preview) drawPreview(g, preview);
    ui.print(ui.fmt(210, ui.msg(150 + optLevel)), W, X, Y, ui.col.white, ui.col.black);
    ui.print(ui.fmt(211, optWins, ui.msg(208 + (view.winByKills ? 1 : 0))), W, X, Y + YS, ui.col.white, ui.col.black);
    if (!client) ui.cursor(X - 20, Y + YS * sel + 16);
    if (previewDirty) {
      // drawn into the background buffer: visible from the next frame on
      preview = await makePreview(g, optLevel);
      previewDirty = false;
    }
    if (!client) ui.pressF1();
    let k = await ui.flip();
    if (k === K.MOUSE && ui.pointerMenus) {
      // touch or mouse (Ui.pointerMenus): tap a row to select it; tap the left / right half of the selected row to change it
      const t = ui.taps[0];
      const row = Math.floor((t.y - Y) / YS);
      if ((row === 0 || row === 1) && t.x >= X - 30 && t.x < X + W) {
        if (row !== sel) sel = row;
        else k = t.x < X + W / 2 ? K.LEFT : K.RIGHT;
      }
    }
    if (isRealKey(k)) ui.letter();
    if (client && isRealKey(k) && k !== K.ESC) {
      ui.refuse();
      continue;
    }
    switch (k) {
      case K.LEFT:
        if (sel === 0) {
          if (--optLevel < -1) optLevel = nLevels - 1;
          previewDirty = true;
        } else optWins = Math.max(1, optWins - 1);
        start = performance.now();
        sendOpts();
        break;
      case K.RIGHT:
        if (sel === 0) {
          if (++optLevel >= nLevels) optLevel = -1;
          previewDirty = true;
        } else optWins = Math.min(100, optWins + 1);
        start = performance.now();
        sendOpts();
        break;
      case K.CTRL_LEFT:
        if (sel === 1) optWins = Math.max(1, optWins - 5);
        sendOpts();
        break;
      case K.CTRL_RIGHT:
        if (sel === 1) optWins = Math.min(100, optWins + 5);
        sendOpts();
        break;
      case K.UP:
      case K.DOWN:
        sel = sel ? 0 : 1;
        break;
      case K.ENTER:
      case K.SPACE:
        if (start + ui.minWaitSecs() * 1000 < performance.now()) {
          ui.menuExit();
          return { level: optLevel, wins: optWins };
        }
        break;
      case K.ESC:
        session.goldPlayer = -1;
        session.matchEnd = 2;
        return null;
      case K.F1:
        await helpScreen(ui, g.dlg);
        break;
      case K.ALT_D:
        await g.debugWindow();
        break;
    }
  }
}

interface Preview {
  field: Awaited<ReturnType<Game['app']['gfx']['loadScreen']>> | null;
  /** [col, row, sequence] of every tile drawn */
  tiles: [number, number, number][];
}

/** options_level_preview (0x406aa3): rand() is consumed on every redraw. */
async function makePreview(g: Game, optLevel: number): Promise<Preview> {
  const ui = g.ui;
  const gfx = g.app.gfx;
  const n = Math.max(ui.value(35), 1);
  const lvl = optLevel >= 0 ? optLevel : ui.rand() % n;
  const field = gfx.screenIndex[`FIELD${lvl}`] ? await gfx.loadScreen(`FIELD${lvl}`) : null;
  const XS = ui.value(732), YS = ui.value(733);
  const tiles: [number, number, number][] = [];
  for (let r = 0; r < YS; r++) {
    for (let c = 0; c < XS; c++) {
      let kind = '';
      if (c & 1 && r & 1) kind = 'solid';
      else if (c > 1 || r > 1) {
        if (ui.rand() % 5 !== 0) kind = 'brick';
      }
      if (kind) {
        const t = optLevel >= 0 ? optLevel : ui.rand() % n;
        tiles.push([c, r, gfx.seq(`tile ${t} ${kind}`)]);
      }
    }
  }
  return { field, tiles };
}

function drawPreview(g: Game, p: Preview): void {
  const ui = g.ui;
  const gfx = g.app.gfx;
  const X = ui.value(730), Y = ui.value(731), XS = ui.value(732), YS = ui.value(733);
  if (p.field) {
    gfx.fill(X - 22, Y - 20, XS * 40 + 24, YS * 36 + 22, ui.col.white);
    gfx.drawScreenPart(p.field, 0, 48, XS * 40 + 20, YS * 36 + 18, X - 20, Y - 18);
  }
  for (const [c, r, seq] of p.tiles) {
    // 40x36 bitmap blitted at the block's top-left, hotspot ignored
    const f = gfx.sprites.frames[gfx.seqList[seq][0][0][0]];
    gfx.r.draw(gfx.atlas, f[0], f[1], f[2], f[3], f[4], X + 40 * c, Y + 36 * r, 0, DrawMode.Sprite);
  }
}

// ------------------------------------------------------------------------------------ roulette

/** goldman_roulette_screen (0x4034bc) */
export async function rouletteScreen(g: Game): Promise<void> {
  const ui = g.ui;
  const session = g.session;
  await ui.setBackground('ROULETTE');
  ui.flushInput();
  const N = ui.value(1004) * 6;
  const X = (p: number) => Math.trunc(ui.value(1000) + ui.value(1002) * Math.cos((p * ui.value(1006) * 3.14159265 * 2.0) / N));
  const Y = (p: number) => Math.trunc(ui.value(1001) - ui.value(1003) * Math.sin((p * ui.value(1007) * 3.14159265 * 2.0) / N));
  const sector = ui.value(1004);
  let result = -1;
  const dir = (ui.rand() % 2) * 2 - 1;
  let state = 0;
  let wheelPos = ui.rand() % N;
  let ringPos = ui.rand() % N;
  let wheelSteps = (ui.rand() % 20) + 20;
  let ringSteps = (ui.rand() % 20) + wheelSteps;
  const ringFrame = ui.seqFrame('ring', 0);
  const prizeFrames = PRIZES.map((t) => ui.seqFrame(`power ${POWER_SEQ[t]}`, 0));
  for (;;) {
    ui.restore();
    if (ringSteps > 0) {
      const n = Math.max(6, ringSteps);
      for (let i = 0; i < n; i++) {
        ringPos = (ringPos + dir + N) % N;
        if (ringPos % sector === 0) {
          g.app.audio.playGroup(1300);
          if (state === 1 && --ringSteps === 0) break;
        }
      }
    }
    if (wheelSteps > 0) {
      const n = Math.max(6, wheelSteps);
      for (let i = 0; i < n; i++) {
        wheelPos = (wheelPos - dir + N) % N;
        if (wheelPos % sector === 0 && state === 1 && --wheelSteps === 0) break;
      }
    }
    for (let k = 0; k < 6; k++) {
      const p = (wheelPos + sector * k) % N;
      ui.sprite(X(p), Y(p), prizeFrames[k]);
    }
    ui.sprite(X(ringPos), Y(ringPos), ringFrame);
    if (state === 2) {
      ui.printCentered(ui.msg(790), 320, 240 - 20, ui.col.white, ui.col.black);
      ui.printCentered(ui.msg(800 + result), 320, 240, ui.col.white, ui.col.black);
      ui.printCentered(ui.msg(791), 320, 240 + 20, ui.col.white, ui.col.black);
    }
    ui.pressF1();
    if (wheelSteps === 0 && ringSteps === 0) {
      if (result === -1) {
        let q = ringPos;
        if (ringPos < wheelPos) q += N;
        result = PRIZES[Math.trunc((q - wheelPos) / sector)];
        g.app.audio.playGroup(result === 13 ? 1320 : 1310);
      }
      state = 2;
    }
    const k = await ui.flip();
    if (isRealKey(k)) ui.letter();
    if (k === K.ENTER || k === K.SPACE || (k === K.MOUSE && ui.pointerMenus)) {
      if (state === 0) state = 1;
      if (state === 2) {
        session.rouletteResult = result;
        return;
      }
    } else if (k === K.ESC) {
      session.goldPlayer = -1;
      session.matchEnd = 2;
      return;
    } else if (k === K.F1) {
      await helpScreen(ui, g.dlg);
    }
  }
}

// ------------------------------------------------------------------------------------ end of round

/** The wait loop shared by the draw and results screens; `key` is the host's "continue" key. */
async function waitScreen(g: Game, draw: () => void, key: number): Promise<void> {
  const ui = g.ui;
  const session = g.session;
  const net = session.net;
  const start = performance.now();
  ui.flushInput();
  for (;;) {
    if (net && session.netMode === 2) {
      if (net.hostLost) {
        await g.dlg.msgboxOk(ui.msg(95), ui.msg(111), ui.col.darkRed, ui.col.yellow);
        session.matchEnd = 2;
        return;
      }
      if (net.aborted) {
        session.matchEnd = 2;
        return;
      }
      if (net.take('key').some(({ msg }) => msg.k === key)) {
        ui.menuExit();
        return;
      }
    }
    draw();
    let k = await ui.flip();
    if (isRealKey(k)) ui.letter();
    if ((!session.hasHumans() || session.autoContinue) && performance.now() > start + 6000) k = K.ENTER;
    if (k === K.ESC) {
      session.matchEnd = 2;
      if (net?.role === 'host') net.broadcast({ t: 'abort' });
      return;
    }
    if (k === K.ENTER || k === K.SPACE || k === K.MOUSE) {
      if (session.netMode === 2) ui.refuse();
      else if (start + ui.minWaitSecs() * 1000 < performance.now()) {
        ui.menuExit();
        net?.broadcast({ t: 'key', k: key });
        return;
      }
    }
  }
}

/** Draw screen (§15): DRAW.PCX, tie announcer voice, wait. */
async function drawScreen(g: Game): Promise<void> {
  const ui = g.ui;
  await screenShowPcx(g, 'draw', false);
  g.app.audio.playVoiceGroup(1700);
  await waitScreen(g, () => ui.restore(), KEY_DRAW);
  await ui.blackFrame();
  ui.gamePalette();
}

/** Results screen (§16) and, when the match is decided, the victory picture (§17). */
async function resultsScreen(g: Game, runner: MatchRunner, winnerName: string, params: MatchParams): Promise<void> {
  const ui = g.ui;
  const session = g.session;
  const s = runner.s;
  const c = ui.col;
  const teamPlay = !!params.teamPlay;
  await ui.setBackground('RESULTS');
  ui.gamePalette();
  const texts: (() => void)[] = [];
  let matchWinner = -1;
  if (!s.forcedDraw) {
    texts.push(() => ui.print(ui.fmt(30, winnerName), ui.value(783), ui.value(780), ui.value(781), c.white, c.black));
    awardRoundPoint(s);
  }
  let maxKills = -Infinity;
  let nMax = 0;
  for (const p of s.players) {
    if (p.kills > maxKills) {
      maxKills = p.kills;
      nMax = 1;
    } else if (p.kills === maxKills) nMax++;
  }
  let rows = 0;
  const RX = ui.value(785), RY = ui.value(786), RYS = ui.value(787), RW = ui.value(788);
  if (teamPlay) {
    for (let t = 0; t < 2; t++) {
      const pi = s.players.findIndex((p) => p.ctrl !== 0 && p.team === t);
      if (pi < 0) continue;
      rows++;
      const score = s.players[pi].score;
      texts.push(() => ui.print(ui.fmt(38, t + 1, score), RW, RX, RY + RYS * t, t === 0 ? c.white : c.lightRed, c.black));
      if (score >= s.numToWin) matchWinner = t;
    }
  } else {
    for (let i = 0; i < 10; i++) {
      const p = s.players[i];
      if (p.ctrl === 0) continue;
      rows++;
      const [fg, outline] = c.player(i, -1);
      const line = ui.fmt(31, i + 1, p.score, p.kills);
      texts.push(() => ui.print(line, RW, RX, RY + RYS * i, fg, outline));
      if (s.pl.winByKills) {
        if (maxKills >= s.numToWin && nMax === 1 && p.kills === maxKills) matchWinner = i;
      } else if (p.score >= s.numToWin) matchWinner = i;
    }
  }
  const draw = () => {
    ui.restore();
    for (const t of texts) t();
  };
  draw();
  await ui.present();
  const MX = ui.value(800), MY = ui.value(801), MW = ui.value(803);
  if (matchWinner === -1) {
    const line = ui.fmt(120 + (s.pl.winByKills ? 1 : 0), s.numToWin);
    texts.push(() => ui.print(line, MW, MX, MY, c.grey, c.black));
  } else {
    if (session.netMode === 0 && g.settings.goldman) {
      // (original quirk kept: team play uses the team of the player whose index is the winning team)
      session.goldPlayer = teamPlay ? (session.slots[matchWinner].team !== 0 ? 2 : 0) : matchWinner;
    } else session.goldPlayer = -1;
    g.app.audio.playVoiceGroup(2000);
    await ui.delay(1500, draw);
    const line = s.pl.winByKills ? ui.fmt(36, matchWinner + 1) : ui.fmt(35, winnerName);
    texts.push(() => ui.print(line, MW, MX, MY, c.cyan, c.black));
  }
  await waitScreen(g, draw, KEY_RESULTS);
  if (session.matchEnd) return;
  if (matchWinner !== -1) {
    await screenShowPcx(g, teamPlay ? `team${matchWinner}` : `victory${matchWinner}`, false);
    await ui.delay(3000);
    session.matchEnd = 1;
    ui.flushInput();
    await ui.blackFrame();
    ui.gamePalette();
  } else if (rows < 2) {
    await g.dlg.msgboxOk(ui.msg(95), ui.msg(47), c.darkRed, c.yellow);
    session.matchEnd = 2;
  }
}
