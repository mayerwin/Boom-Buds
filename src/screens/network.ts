// Network game screens of the classic menus (docs/re/screens.md §18). The original connected over IPX /
// modem / serial / TCP-IP through DirectPlay-like "net objects"; Boom Buds meets in a room with a
// 6-character code on a public relay and connects the machines directly with WebRTC data channels
// (src/net/netSession.ts). The host's screen shows the room code; joining asks for it.

import type { Game } from '../app/Game.ts';
import { K } from '../ui/menuInput.ts';
import { isRealKey } from '../ui/ui.ts';
import { NetSession } from '../net/netSession.ts';
import { normalizeRoomCode } from '../net/room.ts';
import { matchPlay } from './match.ts';

const SPINNER = '/-\\|';

/** The machine's node name (nodename.ini; a random default name from the messages file). */
function nodeName(g: Game): string {
  const st = g.settings;
  if (!st.nodename) {
    const n = Math.max(g.ui.value(47), 1);
    st.nodename = g.ui.msg(500 + (g.ui.rand() % n));
    g.app.saveSettings();
  }
  return st.nodename;
}

/** net_connect: reach the relay ("Connecting network object..."); null on failure. */
async function netConnect(g: Game): Promise<NetSession | null> {
  const ui = g.ui;
  await ui.randomGlue();
  g.dlg.progressTitleSet(ui.msg(57));
  const p = NetSession.connect(nodeName(g)).then(
    (s) => s,
    () => null,
  );
  let result: NetSession | null | undefined;
  void p.then((r) => (result = r));
  let cancelled = false;
  while (result === undefined) {
    ui.restore();
    g.dlg.progressDraw(0);
    const k = await ui.flip();
    if (k === K.ESC) {
      cancelled = true;
      break;
    }
  }
  ui.restore();
  g.dlg.progressDraw(100);
  if (cancelled) {
    void p.then((s) => s?.close());
    return null;
  }
  if (!result) {
    await g.dlg.msgboxOk(ui.msg(96), ui.msg(291), ui.col.darkRed, ui.col.yellow);
    return null;
  }
  g.app.audio.playMusic(1040);
  return result;
}

function beginSession(g: Game, net: NetSession): void {
  g.session.beginNet(net);
  g.ui.netMode = g.session.netMode;
}

function endSession(g: Game): void {
  g.session.net?.close();
  g.session.endNet();
  g.ui.netMode = 0;
}

/** net_start_game_screen (0x42b0ce): host a game and wait for up to 4 clients. */
export async function netStartGameScreen(g: Game): Promise<void> {
  const ui = g.ui;
  const net = await netConnect(g);
  if (!net) return;
  let code: string;
  try {
    code = await net.create();
  } catch {
    net.close();
    await g.dlg.msgboxOk(ui.msg(96), ui.msg(291), ui.col.darkRed, ui.col.yellow);
    return;
  }
  beginSession(g, net);
  try {
    let start = performance.now();
    let lastCount = 0;
    ui.flushInput();
    for (;;) {
      const clients = net.members.filter((m) => m.open);
      if (clients.length !== lastCount) {
        lastCount = clients.length;
        start = performance.now();
      }
      ui.restore();
      ui.print(ui.fmt(73, net.name), ui.value(768), ui.value(765), ui.value(766), ui.col.cyan, ui.col.black);
      ui.print(`Room code: ${code}`, 560, ui.value(765), ui.value(766) + 24, ui.col.yellow, ui.col.black);
      ui.print(ui.msg(70), ui.value(773), ui.value(770), ui.value(771), ui.col.white, ui.col.black);
      for (let i = 0; i < 4; i++) {
        const c = clients[i];
        const text = c ? ui.fmt(71, c.name, c.id) : ui.msg(72);
        ui.print(text, ui.value(778), ui.value(775), ui.value(776) + ui.value(777) * i, ui.col.white, ui.col.black);
      }
      let k = await ui.flip();
      if (k === K.MOUSE && ui.pointerMenus) k = K.ENTER;
      if (isRealKey(k)) ui.letter();
      if (k === K.ESC) return;
      if ((k === K.ENTER || k === K.SPACE) && start + ui.minWaitSecs() * 1000 < performance.now()) {
        if (!clients.length) {
          await g.dlg.msgboxOk(ui.msg(95), ui.msg(105), ui.col.darkRed, ui.col.yellow);
          continue;
        }
        ui.menuExit();
        net.setOpen(false);
        net.aborted = false;
        net.broadcast({ t: 'start' });
        await matchPlay(g);
        // back to the lobby: new clients may join again
        net.setOpen(true);
        await ui.randomGlue();
        g.app.audio.playMusic(1040);
        start = performance.now();
        ui.flushInput();
      }
    }
  } finally {
    endSession(g);
  }
}

/** net_join_game_screen (0x42b47d): ask for the room code and join that game. */
export async function netJoinGameScreen(g: Game): Promise<void> {
  const ui = g.ui;
  const net = await netConnect(g);
  if (!net) return;
  try {
    for (;;) {
      ui.restore();
      ui.print(ui.fmt(66, net.name), ui.value(753), ui.value(750), ui.value(751), ui.col.cyan, ui.col.black);
      await ui.flip();
      ui.mouseShow();
      const typed = await g.dlg.getString('', 8, 'Enter the room code of the game:', 25, 180);
      ui.mouseHide();
      if (typed === null) return;
      const code = normalizeRoomCode(typed);
      if (!code) {
        await g.dlg.msgboxOk(ui.msg(96), 'A room code has 6 letters and digits!', ui.col.darkRed, ui.col.yellow);
        continue;
      }
      const res = await net.join(code);
      if (res !== 'ok') {
        const why = {
          'not-found': 'No game with this room code!',
          full: ui.msg(7),
          started: 'This game has already started!',
          version: 'This game runs another version of Boom Buds!',
          kicked: 'The host removed you from this game!',
          failed: ui.msg(100),
        }[res];
        await g.dlg.msgboxOk(res === 'full' ? ui.msg(96) : ui.msg(95), why, ui.col.darkRed, ui.col.yellow);
        continue;
      }
      beginSession(g, net);
      const stay = await waitForServer(g);
      g.session.endNet();
      ui.netMode = 0;
      if (!stay) return;
      await ui.randomGlue();
      g.app.audio.playMusic(1040);
    }
  } finally {
    net.close();
    g.session.endNet();
    ui.netMode = 0;
  }
}

/**
 * "Joined... waiting for server to start" loop; plays the matches the server starts. Returns true to go
 * back to the server list (the server stopped hosting), false to leave the network screens.
 */
async function waitForServer(g: Game): Promise<boolean> {
  const ui = g.ui;
  const net = g.session.net!;
  let counter = 0;
  ui.flushInput();
  for (;;) {
    if (net.hostLost) {
      await g.dlg.msgboxOk(ui.msg(95), ui.msg(110), ui.col.darkRed, ui.col.yellow);
      net.leaveRoom();
      return true;
    }
    if (net.take('start').length) {
      net.aborted = false;
      await matchPlay(g);
      if (net.hostLost) continue;
      if (!net.aborted && g.session.matchEnd === 2) {
        // this machine left the match: leave the game
        net.leaveRoom();
        return false;
      }
      await ui.randomGlue();
      g.app.audio.playMusic(1040);
      ui.flushInput();
      continue;
    }
    ui.restore();
    ui.print(ui.fmt(80, SPINNER[counter++ & 3]), 400, 150, 200, ui.col.white, ui.col.black);
    const k = await ui.flip();
    if (isRealKey(k)) ui.letter();
    if (k === K.ESC) {
      net.leaveRoom();
      return false;
    }
  }
}
