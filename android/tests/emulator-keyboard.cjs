// A keyboard on the TV (a virtual Linux keyboard: letters and arrows): its keys reach the game as on the website.
// The menus follow the arrows and Enter; in Local Game, player 1 is the arrow keys (no gamepad), A joins player
// 2 (E S D F); both move and drop bombs in a round; Esc pauses and resumes.
// Usage: BB_QA_SERIAL=emulator-5556 node android/tests/emulator-keyboard.cjs [apk]
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { connect, inputDevices, sleep, adb, packageId } = require('./emulator-driver.cjs');

const apk = process.argv[2] || path.resolve(__dirname, '../app/build/outputs/apk/sideload/debug/app-sideload-debug.apk');
const output = path.resolve(__dirname, '../app/build/qa', process.env.BB_QA_SERIAL || 'emulator-5556');
const K = 3;
const game = (expr) => `(()=>{const g=window.__boombuds.game;return ${expr};})()`;

async function main() {
  adb('install', '-r', apk);
  adb('shell', 'pm', 'clear', packageId);
  const input = inputDevices();
  input.keyboard(K);
  await sleep(1500);
  adb('shell', 'am', 'start', '-W', '-n', `${packageId}/com.github.boombuds.MainActivity`);
  const app = await connect();
  try {
    await app.waitFor((s) => s.menus && s.screen === 'home', 'Expected the main screen', 30000);
    await sleep(1500);
    // the arrows move the focus, Enter opens Local Game
    const press = async (key) => {
      const was = (await app.snapshot()).focused;
      await input.key(K, key);
      await app.waitFor((t) => t.focused !== was, `${key} moves the focus`, 4000);
    };
    await press('DPAD_DOWN');
    for (let i = 0; i < 6 && !(await app.snapshot()).focused.includes('Local Game'); i++) await press('DPAD_UP');
    await input.key(K, 'KEY_ENTER');
    await app.waitFor((s) => s.heading === 'Local Game', 'Enter opens the Local Game lobby');
    await sleep(500);
    // A (the left set's bomb key) joins a second player
    await app.evaluate('document.activeElement.blur()');
    await input.key(K, 'KEY_A');
    await sleep(600);
    const cards = await app.evaluate(`[...document.querySelectorAll('#menu-root .pcard')].map(c=>c.innerText.replace(/\\s+/g,' '))`);
    console.log('lobby: ' + JSON.stringify(cards));
    await app.evaluate(`[...document.querySelectorAll('#menu-root button')].find(b=>b.textContent.trim()==='Start ▶').focus()`);
    await input.key(K, 'KEY_ENTER');
    await app.waitFor((s) => s.round, 'Enter starts the round', 20000);
    const slots = await app.evaluate(game(`g.session.slots.slice(0,3).map(s=>s.type+':'+(s.ctl||''))`));
    assert.deepEqual(slots.slice(0, 2), ['2:kb-arrows', '2:kb-esdf'], 'two keyboard players: ' + slots);
    await sleep(3500);
    const pos = (i) => app.evaluate(game(`{x:g.runner.s.players[${i}].x,y:g.runner.s.players[${i}].y,tick:g.runner.s.tick}`));
    const bombs = (i) => app.evaluate(game(`g.runner.s.bombs.filter(b=>b.active===1&&b.owner===g.runner.s.players[${i}].id).length`));
    const moves = async (i, keys) => {
      for (const k of keys) {
        const a = await pos(i);
        await input.key(K, k, 700);
        const b = await pos(i);
        if (a.x !== b.x || a.y !== b.y) return true;
      }
      return false;
    };
    assert.ok(await moves(0, ['DPAD_RIGHT', 'DPAD_DOWN', 'DPAD_LEFT', 'DPAD_UP']), 'the arrows move player 1');
    assert.ok(await moves(1, ['KEY_F', 'KEY_D', 'KEY_S', 'KEY_E']), 'E S D F move player 2');
    await input.key(K, 'KEY_DOT');
    await sleep(300);
    assert.equal(await bombs(0), 1, '. drops player 1\'s bomb');
    await input.key(K, 'KEY_A');
    await sleep(300);
    assert.equal(await bombs(1), 1, 'A drops player 2\'s bomb');
    await app.screenshot(path.join(output, 'keyboard-round.png'));
    await input.key(K, 'KEY_ESC');
    await app.waitFor((s) => s.paused, 'Esc pauses');
    await sleep(500);
    await input.key(K, 'KEY_ESC');
    await app.waitFor((s) => !s.paused, 'Esc resumes');
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
