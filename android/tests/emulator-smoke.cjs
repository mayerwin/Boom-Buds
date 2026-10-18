// The debug APK on a Google TV emulator, played with a virtual TV remote and a virtual gamepad (real Linux input
// devices, so the events go through Android's input stack, MainActivity and tv.js):
//   the remote and the pad show up as gamepads; the remote opens Local Game, where the pad is player 1, a short
//   OK of the remote is a menu press and a held one adds the remote as player 2; a button held on the pad says it
//   already plays and a second hold shares it (its left half for player 1, its right half for a third player,
//   whose removal gives the whole pad back); a round starts; both move their bombers, the remote drops a bomb;
//   the effects play through native SoundPool;
//   Back pauses (the round stops), Back resumes; quitting returns to the lobby at once; Back leaves the menus and,
//   on the main screen, the app; the game canvas is drawn at the WebView's full physical resolution.
// Usage: BB_QA_SERIAL=emulator-5556 node android/tests/emulator-smoke.cjs [apk]
// Evidence (screenshots, emulator-smoke.json) goes to android/app/build/qa/<serial>/.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect, inputDevices, sleep, adb, packageId } = require('./emulator-driver.cjs');

const serial = process.env.BB_QA_SERIAL || 'emulator-5556';
const apk = process.argv[2] || path.resolve(__dirname, '../app/build/outputs/apk/sideload/debug/app-sideload-debug.apk');
const output = path.resolve(__dirname, '../app/build/qa', serial);
const ACTIVITY = `${packageId}/com.github.boombuds.MainActivity`;
const REMOTE = 1;
const PAD = 2;

const game = (expr) => `(()=>{const g=window.__boombuds.game;return ${expr};})()`;

async function main() {
  fs.mkdirSync(output, { recursive: true });
  adb('install', '-r', apk);
  adb('shell', 'pm', 'clear', packageId);
  const input = inputDevices();
  input.remote(REMOTE);
  input.pad(PAD);
  await sleep(1500);
  adb('shell', 'am', 'start', '-W', '-n', ACTIVITY);
  const app = await connect();
  const checkpoints = [];
  const check = async (label, extra = {}) => {
    const s = await app.snapshot();
    checkpoints.push({ label, ...s, ...extra });
    console.log(`${label}: ${s.round ? 'round' : s.screen}${s.paused ? ' (paused)' : ''} ${JSON.stringify(extra)}`);
    return s;
  };
  const audio = async () => JSON.parse(await app.evaluate('AndroidHost.getAudioInfo()'));
  const shot = (name) => app.screenshot(path.join(output, name + '.png'));
  try {
    const home = await app.waitFor((s) => s.menus && s.screen === 'home', 'Expected the main screen', 30000);
    assert.ok(home.pads.includes('TV remote'), 'the remote is a gamepad: ' + home.pads);
    assert.ok(home.pads.includes('BB QA Pad ' + PAD), 'the gamepad is a gamepad: ' + home.pads);
    const devices = JSON.parse(await app.evaluate('AndroidHost.getDevices()'));
    await check('home', { devices: devices.filter((d) => d.bridged).map((d) => `${d.name}${d.remote ? ' (remote)' : ''}`) });
    await sleep(2000); // (the splash fades out)
    await shot('1-home');

    /**
     * A press, until the game has acted on it. This emulator draws a few frames a second and now and then falls
     * seconds behind, so one press can land while the page is still catching up with the one before.
     */
    const pressUntil = async (id, key, check, message, timeout = 12000) => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        await input.key(id, key);
        try {
          return await app.waitFor(check, '', timeout);
        } catch (_) {
          /* again */
        }
      }
      throw new Error(`${message}; screen=${JSON.stringify(await app.snapshot())}`);
    };
    // the remote: arrows move the focus, OK opens Local Game
    const focusButton = (scope, re) => app.evaluate(`(()=>{const b=[...document.querySelectorAll('${scope} button')].find(b=>${re}.test(b.textContent));b.focus();return !!b;})()`);
    // the arrows take the focus around the screen (which control it lands on is the business of the menu tests in
    // Chrome: a held key repeats on an emulator that draws a few frames a second, and an edge stops it)
    const visited = new Set();
    for (const key of ['DPAD_DOWN', 'DPAD_RIGHT', 'DPAD_LEFT', 'DPAD_DOWN']) {
      await input.key(REMOTE, key);
      await sleep(400);
      visited.add((await app.snapshot()).focused);
    }
    assert.ok(visited.size > 1, 'the arrows move the focus: ' + JSON.stringify([...visited]));
    await focusButton('#menu-root', /Local Game/);
    await pressUntil(REMOTE, 'DPAD_CENTER', (s) => s.heading === 'Local Game', 'Expected the Local Game lobby');
    // player 1 is the gamepad; a short OK of the remote is a menu press, holding OK joins the remote; a button
    // held on the gamepad says it already plays, and held again shares it (left half for player 1, right half for
    // a third player) until that player's ✕ gives player 1 the whole gamepad back
    const lineup = () => app.evaluate(`[...document.querySelectorAll('#menu-root .pcard')].map(c=>c.innerText.replace(/\s+/g,' ').slice(0,60))`);
    // every note the menus show, kept as it appears (each one goes again after a couple of seconds, and this
    // emulator can take longer than that to answer)
    await app.evaluate(`(()=>{window.__notes=[];new MutationObserver(()=>{const t=document.querySelector('.toast');
      if(t&&window.__notes[window.__notes.length-1]!==t.innerText)window.__notes.push(t.innerText);})
      .observe(document.body,{subtree:true,childList:true,characterData:true});return true;})()`);
    const notes = () => app.evaluate('window.__notes.slice()');
    const waitNote = async (re, message) => {
      for (let i = 0; i < 20; i++) {
        if ((await notes()).some((n) => re.test(n))) return;
        await sleep(300);
      }
      assert.fail(`${message}; notes so far: ${JSON.stringify(await notes())}`);
    };
    const stored = () => app.evaluate(`JSON.parse(localStorage.getItem('boombuds.settings.v1')).localPlayers`);
    const PAD_ID = `pad:0:BB QA Pad ${PAD}`;
    const cards0 = await lineup();
    await app.evaluate('document.activeElement.blur()'); // (OK on a focused button clicks it)
    await input.key(REMOTE, 'DPAD_CENTER');
    await sleep(600);
    assert.equal((await lineup()).length, cards0.length, "a short OK does not join: " + JSON.stringify(await lineup()));
    await app.evaluate('document.activeElement.blur()');
    await input.key(REMOTE, 'DPAD_CENTER', 2000); // (the emulator draws a few frames a second: a generous hold)
    await sleep(600);
    assert.equal((await lineup()).length, cards0.length + 1, 'holding OK joins the remote: ' + JSON.stringify(await lineup()));
    assert.deepEqual(await stored(), [PAD_ID, 'pad:0:TV remote']);
    await input.key(PAD, 'BUTTON_L1', 2600);
    await waitNote(/already plays/, 'the first hold says that the gamepad already plays');
    assert.deepEqual(await stored(), [PAD_ID, 'pad:0:TV remote'], 'and nobody joins');
    await input.key(PAD, 'BUTTON_L1', 2600);
    await sleep(600);
    assert.deepEqual(await stored(), [`padL:0:BB QA Pad ${PAD}`, 'pad:0:TV remote', `padR:0:BB QA Pad ${PAD}`], 'held again: the gamepad is shared, its right half for a third player');
    await app.evaluate(`[...document.querySelectorAll('#menu-root button')].find(b=>b.getAttribute('aria-label')==='remove Player 3').click()`);
    await sleep(600);
    assert.deepEqual(await stored(), [PAD_ID, 'pad:0:TV remote'], 'the whole gamepad back to player 1');
    await app.evaluate(`[...document.querySelectorAll('#menu-root button')].find(b=>/Add computer player/.test(b.textContent)).click()`);
    await sleep(300);
    await check('lobby', { cards: await lineup() });
    await shot('2-lobby');
    await focusButton('#menu-root', /^Start ▶$/);
    await pressUntil(REMOTE, 'DPAD_CENTER', (s) => s.round, 'Expected a round', 20000);
    const slots = await app.evaluate(game(`g.session.slots.slice(0,4).map(s=>s.type+':'+(s.ctl||''))`));
    assert.deepEqual(slots.slice(0, 3), [`3:${PAD_ID}`, '3:pad:0:TV remote', '1:'], 'gamepad, remote, computer: ' + slots);
    // wait for the round's start (the bombers can move)
    await sleep(3500);
    // players 1 and 2 cannot die during the test (their own trigger bombs, the computer players' bombs): the round
    // must outlive it
    const guard = () => app.evaluate(game('[0,1].forEach((i)=>g.runner.s.players[i].invulnMs=30000)'));
    await guard();

    // the gamepad moves player 1, the remote player 2 and drops a bomb; the effects play natively
    const pos = (i) => app.evaluate(game(`{x:g.runner.s.players[${i}].x,y:g.runner.s.players[${i}].y,bombs:g.runner.s.bombs.filter(b=>b.active===1).length,tick:g.runner.s.tick}`));
    const moves = async (id, i) => {
      for (const dir of ['DPAD_RIGHT', 'DPAD_DOWN', 'DPAD_LEFT', 'DPAD_UP']) {
        const a = await pos(i);
        await input.key(id, dir, 700);
        const b = await pos(i);
        if (a.x !== b.x || a.y !== b.y) return true;
      }
      return false;
    };
    assert.ok(await moves(PAD, 0), 'the gamepad moves player 1');
    assert.ok(await moves(REMOTE, 1), 'the remote moves player 2');
    // the other controllers keep their own two buttons: with trigger bombs, the gamepad's A still drops one at once
    // (while held) and B sets it off
    const p1 = (expr) => app.evaluate(game(`(p=>(${expr}))(g.runner.s.players[0])`));
    const owned1 = (type) => p1(`g.runner.s.bombs.filter(b=>b.active===1&&b.owner===p.id&&b.type===${type}).length`);
    await guard();
    await p1('(p.counts[9]=1, p.counts[0]=Math.max(3,p.counts[0]))');
    input.down(PAD, 'BUTTON_A');
    await sleep(250);
    assert.equal(await owned1(1), 1, "the gamepad's A drops a trigger bomb at once");
    input.up(PAD, 'BUTTON_A');
    await sleep(200);
    await input.key(PAD, 'BUTTON_B');
    await sleep(300);
    assert.equal(await owned1(1), 0, "the gamepad's B sets it off");

    // the remote's OK: a bomb at once (its fuse made long here, so that player 2 outlives the test)
    const p2 = (expr) => app.evaluate(game(`(p=>(${expr}))(g.runner.s.players[1])`));
    const owned = (type) => p2(`g.runner.s.bombs.filter(b=>b.active===1&&b.owner===p.id&&b.type===${type}).length`);
    await guard();
    await p2('(p.fuse=600, p.counts[0]=Math.max(3,p.counts[0]))');
    const sound0 = await audio();
    await input.key(REMOTE, 'DPAD_CENTER');
    await sleep(300);
    assert.equal(await owned(0), 1, 'OK drops a bomb');
    // with trigger bombs, a short OK drops one when let go, and holding OK (the special) sets it off
    await p2('p.counts[9]=1');
    assert.ok(await moves(REMOTE, 1), 'player 2 steps off its bomb');
    await input.key(REMOTE, 'DPAD_CENTER', 60);
    await sleep(300);
    assert.equal(await owned(1), 1, 'a short OK drops a trigger bomb');
    await input.key(REMOTE, 'DPAD_CENTER', 700);
    await sleep(300);
    assert.equal(await owned(1), 0, 'a long OK sets it off');
    checkpoints.push({ label: 'remote: OK = bomb; with trigger bombs, short OK = bomb, long OK = special' });
    await sleep(1500); // the explosions
    const sound1 = await audio();
    assert.equal(sound1.backend, 'Android SoundPool');
    assert.ok(sound1.loaded > 20, 'effects preloaded natively: ' + JSON.stringify(sound1));
    assert.ok(sound1.plays > sound0.plays, 'the bombs sounded natively: ' + JSON.stringify(sound1));
    await check('playing', { audio: sound1 });
    await shot('3-round');

    // Back pauses, Back resumes
    await pressUntil(REMOTE, 'BACK', (s) => s.paused, 'Back pauses');
    const t1 = (await pos(0)).tick;
    await sleep(800);
    assert.equal((await pos(0)).tick, t1, 'the round stops while paused');
    await check('paused');
    await shot('4-paused');
    await pressUntil(REMOTE, 'BACK', (s) => !s.paused, 'Back resumes');
    // (after the countdown)
    for (let i = 0; i < 40 && (await pos(0)).tick === t1; i++) await sleep(200);
    assert.ok((await pos(0)).tick > t1, 'the round goes on');
    // quit from the pause menu
    await pressUntil(REMOTE, 'BACK', (s) => s.paused, 'Back pauses again');
    await sleep(500); // (the pause menu ignores gamepads for 300 ms: other players may be pressing a button)
    // (a pause menu that just opened ignores the gamepads for a moment: another player may be pressing a button)
    let backInMs = -1;
    for (let attempt = 1; attempt <= 3 && backInMs < 0; attempt++) {
      await app.evaluate(`(()=>{const b=[...document.querySelectorAll('#pause-root button')].find(b=>/Quit the match/.test(b.textContent));if(b)b.focus();return !!b;})()`);
      const quitAt = Date.now();
      await input.key(REMOTE, 'DPAD_CENTER');
      try {
        await app.waitFor((s) => s.menus && s.heading === 'Local Game', '', 8000);
        backInMs = Date.now() - quitAt;
      } catch (_) {
        await sleep(500);
      }
    }
    assert.ok(backInMs >= 0, 'Quit returns to the lobby');
    // (no end-of-match wait any more: the menus come back under a curtain — src/menu/curtain.ts)
    await check('quit', { backInMs });

    // the canvas is drawn at the WebView's physical resolution
    const display = JSON.parse(await app.evaluate('AndroidHost.getDisplayInfo()'));
    const canvas = await app.evaluate(`(()=>{const c=document.getElementById('game'),r=c.getBoundingClientRect();return {w:c.width,h:c.height,left:r.left*devicePixelRatio,top:r.top*devicePixelRatio,css:[r.width,r.height],dpr:devicePixelRatio};})()`);
    // the app gets the whole output (no upscaled surface), and the canvas draws every one of its pixels
    assert.equal(display.windowWidth, display.outputWidth, 'WebView width = output width');
    assert.equal(display.windowHeight, display.outputHeight, 'WebView height = output height');
    assert.equal(canvas.w, display.windowWidth, 'canvas backing width = WebView pixels');
    assert.equal(canvas.h, display.windowHeight, 'canvas backing height = WebView pixels');
    assert.equal(canvas.left, 0);
    assert.equal(canvas.top, 0);
    await check('display', { display, canvas });

    // Back: to the main screen, then out of the app
    await pressUntil(REMOTE, 'BACK', (s) => s.screen === 'home', 'Back returns to the main screen');
    // the privacy policy, in the app (Options), and Back closes its dialog
    await app.evaluate(`[...document.querySelectorAll('#menu-root button')].find(b=>b.textContent.trim()==='Options').click()`);
    await app.waitFor((s) => s.screen === 'options', 'Expected Options');
    await focusButton('#menu-root', /^Privacy policy$/);
    await input.key(REMOTE, 'DPAD_CENTER');
    const policy = () => app.evaluate(`document.querySelector('.modal-wrap')?.innerText||''`);
    for (let i = 0; i < 30 && !/Network games/.test(await policy()); i++) await sleep(150);
    assert.match(await policy(), /Network games/, 'the privacy policy shows in the app');
    await shot('5-privacy');
    await input.key(REMOTE, 'BACK');
    await sleep(500);
    assert.equal(await policy(), '', 'Back closes the dialog');
    await input.key(REMOTE, 'BACK');
    await app.waitFor((s) => s.screen === 'home', 'Back returns to the main screen');
    assert.equal(app.errors.length, 0, JSON.stringify(app.errors));
    await input.key(REMOTE, 'BACK');
    await sleep(1500);
    const top = adb('shell', 'dumpsys', 'activity', 'activities');
    const resumed = (top.match(/(?:topResumedActivity|mResumedActivity)[^\n]*/) || [''])[0];
    assert.ok(!resumed.includes(packageId), 'Back on the main screen leaves the app: ' + resumed);
    checkpoints.push({ label: 'exited', resumed });
    console.log('exited: ' + resumed.trim());
    console.log('PASS');
  } finally {
    fs.writeFileSync(path.join(output, 'emulator-smoke.json'), JSON.stringify({ checkpoints, errors: app.errors }, null, 2));
    input.close();
    await app.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
