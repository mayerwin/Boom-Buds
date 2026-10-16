// 1997 mode on the TV, played with the virtual remote: its OK goes through the original menus to a round; there
// "Back to today" stays hidden; Back opens the original's pause box, whose choice follows the remote's arrows and
// OK (here: end the round in a draw).
// Usage: BB_QA_SERIAL=emulator-5556 node android/tests/emulator-1997.cjs [apk]
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { connect, inputDevices, sleep, adb, packageId } = require('./emulator-driver.cjs');

const apk = process.argv[2] || path.resolve(__dirname, '../app/build/outputs/apk/sideload/debug/app-sideload-debug.apk');
const output = path.resolve(__dirname, '../app/build/qa', process.env.BB_QA_SERIAL || 'emulator-5556');
const REMOTE = 1;
const PAD = 2;
const game = (expr) => `(()=>{const g=window.__boombuds.game;return ${expr};})()`;

async function main() {
  adb('install', '-r', apk);
  adb('shell', 'pm', 'clear', packageId);
  const input = inputDevices();
  input.remote(REMOTE);
  input.pad(PAD);
  await sleep(1500);
  adb('shell', 'am', 'start', '-W', '-n', `${packageId}/com.github.boombuds.MainActivity`);
  const app = await connect();
  const until = async (expr, message, timeout = 15000) => {
    for (const end = Date.now() + timeout; Date.now() < end; await sleep(200)) if (await app.evaluate(expr)) return;
    throw new Error(message);
  };
  try {
    await app.waitFor((s) => s.menus && s.screen === 'home', 'Expected the main screen', 30000);
    await sleep(1500);
    await app.evaluate(`[...document.querySelectorAll('#menu-root button')].find(b=>/1997 mode/.test(b.textContent)).click()`);
    await app.waitFor((s) => !s.menus, '1997 mode opens the original menus');
    await sleep(3000);
    // the remote's OK: title -> main menu -> Start Game (player setup) -> options -> the round
    for (const wait of [1500, 2500, 2500, 0]) {
      await input.key(REMOTE, 'DPAD_CENTER');
      await sleep(wait);
    }
    await until(game('!!g.runner && !g.runner.s.roundOver'), 'OK leads to a round', 20000);
    for (let i = 0; i < 4; i++) {
      assert.equal(await app.evaluate(`document.querySelector('.back-today').hidden`), true, 'Back to today is hidden during the round');
      await sleep(700);
    }
    // Back: the pause box; the arrows go down to "End this round (draw)", OK chooses it
    await input.key(REMOTE, 'BACK');
    await until(game('!!g.runner.menu?.box'), 'Back opens the pause box');
    await sleep(600); // (the box ignores the controllers for a moment: another player may be pressing a bomb button)
    await input.key(REMOTE, 'DPAD_DOWN');
    await sleep(400);
    await input.key(REMOTE, 'DPAD_CENTER');
    await until(game('g.runner.s.forcedDraw === 1'), 'the arrows and OK chose "End this round (draw)"');
    await app.screenshot(path.join(output, '1997-draw.png'));
    assert.equal(app.errors.length, 0, JSON.stringify(app.errors));
    console.log('PASS');
  } finally {
    input.close();
    await app.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
