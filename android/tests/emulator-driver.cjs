// Development-only driver for the debuggable Boom Buds APK in an Android emulator (adapted from the Pong Wars
// Reloaded TV app's). It refuses physical devices, attaches only to the app's own local WebView, and plays the
// TV remote and gamepads as real Linux input devices (AOSP's uinput tool), so their events travel through
// Android's InputReader, MainActivity and android/tv/tv.js exactly like a paired controller's.
// Usage: BB_QA_SERIAL=emulator-5556 node android/tests/emulator-smoke.cjs
'use strict';
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const serial = process.env.BB_QA_SERIAL || 'emulator-5556';
const packageId = process.env.BB_QA_PACKAGE || 'com.github.boombuds.sideload';
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk');
const adbPath = process.env.ADB || path.join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
const port = Number(process.env.BB_QA_PORT || 9224);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function adb(...args) {
  if (!/^emulator-\d+$/.test(serial)) throw new Error('This test driver only permits Android emulator targets.');
  // (a busy emulator drops off the air for a moment now and then; installing 40 MB on a cold one also takes
  // its time)
  let failure = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) {
      spawnSync(adbPath, ['-s', serial, 'wait-for-device'], { encoding: 'utf8', timeout: 60000, windowsHide: true });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
    }
    const result = spawnSync(adbPath, ['-s', serial, ...args], { encoding: 'utf8', timeout: 300000, windowsHide: true });
    if (!result.error && result.status === 0) return result.stdout.trim();
    failure = result.error?.message || result.stderr || result.stdout || `adb ${args[0]} failed`;
  }
  throw new Error(failure);
}

/** Linux key codes (input-event-codes.h) of the devices we create */
const LINUX = {
  DPAD_UP: 103, DPAD_DOWN: 108, DPAD_LEFT: 105, DPAD_RIGHT: 106, DPAD_CENTER: 353, BACK: 158,
  KEY_ESC: 1, KEY_ENTER: 28, KEY_Q: 16, KEY_E: 18, KEY_A: 30, KEY_S: 31, KEY_D: 32, KEY_F: 33, KEY_COMMA: 51, KEY_DOT: 52,
  BUTTON_A: 304, BUTTON_B: 305, BUTTON_X: 307, BUTTON_Y: 308, BUTTON_L1: 310, BUTTON_R1: 311, BUTTON_START: 315,
};

/**
 * Virtual input devices: a TV remote (d-pad, OK, Back) and gamepads (buttons and d-pad). They exist while
 * this process runs.
 */
function inputDevices() {
  const proc = spawn(adbPath, ['-s', serial, 'shell', 'uinput', '-'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let diagnostic = '';
  proc.stdout.on('data', (c) => (diagnostic += c));
  proc.stderr.on('data', (c) => (diagnostic += c));
  const write = (command) => proc.stdin.write(JSON.stringify(command) + '\n');
  const add = (id, name, keys) =>
    write({ id, command: 'register', name, vid: 0x1209, pid: 0x4200 + id, bus: 'bluetooth', configuration: [{ type: 100, data: [1] }, { type: 101, data: keys.map((k) => LINUX[k]) }] });
  return {
    remote(id = 1) {
      add(id, 'BB QA Remote', ['DPAD_UP', 'DPAD_DOWN', 'DPAD_LEFT', 'DPAD_RIGHT', 'DPAD_CENTER', 'BACK']);
    },
    /** a full keyboard (letters and arrows): Android gives its keys to the WebView, as a browser would get them */
    keyboard(id) {
      add(id, 'BB QA Keyboard', ['KEY_ESC', 'KEY_ENTER', 'KEY_Q', 'KEY_E', 'KEY_A', 'KEY_S', 'KEY_D', 'KEY_F', 'KEY_COMMA', 'KEY_DOT', 'DPAD_UP', 'DPAD_DOWN', 'DPAD_LEFT', 'DPAD_RIGHT']);
    },
    /** a gamepad (its name: what the game shows, e.g. in the store screenshots) */
    pad(id, name = `BB QA Pad ${id}`) {
      add(id, name, ['BUTTON_A', 'BUTTON_B', 'BUTTON_X', 'BUTTON_Y', 'BUTTON_L1', 'BUTTON_R1', 'BUTTON_START', 'DPAD_UP', 'DPAD_DOWN', 'DPAD_LEFT', 'DPAD_RIGHT']);
    },
    /** press and let go */
    async key(id, code, holdMs = 40) {
      this.down(id, code);
      await sleep(holdMs);
      this.up(id, code);
      await sleep(160);
    },
    down(id, code) {
      if (LINUX[code] == null) throw new Error('Unknown test key ' + code);
      write({ id, command: 'inject', events: [1, LINUX[code], 1, 0, 0, 0] });
    },
    up(id, code) {
      write({ id, command: 'inject', events: [1, LINUX[code], 0, 0, 0, 0] });
    },
    close() {
      proc.stdin.end();
    },
    get diagnostic() {
      return diagnostic;
    },
  };
}

async function connect() {
  // The activity can be visible before Chromium's debug socket is listening, especially after a cold start.
  let matches = [];
  let lastError;
  for (const deadline = Date.now() + 20000; Date.now() < deadline; ) {
    try {
      const pid = adb('shell', 'pidof', packageId).trim();
      if (!/^\d+$/.test(pid)) throw new Error('Launch the debuggable Boom Buds APK first.');
      adb('forward', `tcp:${port}`, `localabstract:webview_devtools_remote_${pid}`);
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1500) })).json();
      matches = targets.filter((t) => t.url.startsWith('https://appassets.androidplatform.net/assets/index.html'));
      if (matches.length) break;
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  if (matches.length !== 1) throw new Error('Expected exactly one app-owned local WebView target.' + (lastError ? ' ' + lastError.message : ''));
  const socket = new WebSocket(matches[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const waiting = new Map();
  const errors = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && waiting.has(message.id)) {
      const callback = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.error) callback.reject(new Error(JSON.stringify(message.error)));
      else callback.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timeout = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`CDP timed out: ${method}`));
      }, 30000);
      waiting.set(id, { resolve: (v) => (clearTimeout(timeout), resolve(v)), reject: (e) => (clearTimeout(timeout), reject(e)) });
      socket.send(JSON.stringify({ id, method, params }));
    });
  await send('Runtime.enable');
  await send('Page.enable');
  /**
   * A reading of the page. It may be busy for a while — a fresh start loads the whole game on an emulator that
   * draws a few frames a second — and an answer that takes too long is asked for again rather than given up on.
   */
  async function evaluate(expression, tries = 3) {
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
      } catch (error) {
        if (attempt >= tries || !/timed out/.test(error.message)) throw error;
        await sleep(500);
      }
    }
  }
  /** what the player sees: the modern menus' screen, or the round */
  const snapshot = () =>
    evaluate(`(()=>{const g=window.__boombuds&&window.__boombuds.game;const m=document.getElementById('menu-root');
      return {menus:!!m&&m.classList.contains('open'),screen:g&&g.menus?g.menus.screen:null,heading:document.querySelector('#menu-root h1')?.textContent||'',
        focused:document.activeElement?.innerText?.slice(0,40)||'',paused:!!document.getElementById('pause-root')?.classList.contains('open'),
        round:!!(g&&g.runner)&&!(m&&m.classList.contains('open')),pads:navigator.getGamepads().filter(Boolean).map(p=>p.id),
        viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio}};})()`);
  const waitFor = async (predicate, message, timeout = 15000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const value = await snapshot();
      if (predicate(value)) return value;
      await sleep(150);
    }
    throw new Error(`${message}; screen=${JSON.stringify(await snapshot())}`);
  };
  async function screenshot(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    adb('shell', 'screencap', '-p', '/sdcard/bb-emulator-qa.png');
    adb('pull', '/sdcard/bb-emulator-qa.png', file);
  }
  async function close() {
    socket.close();
    try {
      adb('forward', '--remove', `tcp:${port}`);
    } catch (_) {
      /* already gone */
    }
  }
  return { adb, evaluate, snapshot, waitFor, screenshot, close, errors, sleep };
}

module.exports = { connect, inputDevices, sleep, adb, packageId };
