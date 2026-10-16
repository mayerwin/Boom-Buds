// Store screenshots from the debug APK on the 4K Google TV emulator: the main screen, a Local Game lobby (two
// players sharing a gamepad, the second one joined by holding LB, and computer players) and a round with six
// bombers, captured at 3840 x 2160 and scaled to 1920 x 1080 (PowerShell's System.Drawing).
// Usage: BB_QA_SERIAL=emulator-5558 node android/tests/emulator-screenshots.cjs
// Output: android/publishing/screenshots/*.png (look at them before uploading: capturing is not judging).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { connect, inputDevices, sleep, adb, packageId } = require('./emulator-driver.cjs');

const apk = process.argv[2] || path.resolve(__dirname, '../app/build/outputs/apk/sideload/debug/app-sideload-debug.apk');
const raw = path.resolve(__dirname, '../app/build/qa/screenshots');
const out = path.resolve(__dirname, '../publishing/screenshots');

function scale(from, to) {
  const ps = `Add-Type -AssemblyName System.Drawing; $s=[Drawing.Image]::FromFile('${from}'); $b=New-Object Drawing.Bitmap 1920,1080;` +
    ` $g=[Drawing.Graphics]::FromImage($b); $g.InterpolationMode='HighQualityBicubic'; $g.PixelOffsetMode='HighQuality';` +
    ` $g.DrawImage($s,0,0,1920,1080); $b.Save('${to}',[Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $b.Dispose(); $s.Dispose()`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
}

async function main() {
  fs.mkdirSync(raw, { recursive: true });
  fs.mkdirSync(out, { recursive: true });
  adb('install', '-r', apk);
  adb('shell', 'pm', 'clear', packageId);
  const input = inputDevices();
  input.pad(2, 'Wireless Gamepad');
  await sleep(1500);
  adb('shell', 'am', 'start', '-W', '-n', `${packageId}/com.github.boombuds.MainActivity`);
  const app = await connect();
  const shot = async (name) => {
    await sleep(2500); // (the 4K software compositor can show an older frame for a while)
    const file = path.join(raw, name + '.png');
    await app.screenshot(file);
    scale(file, path.join(out, name + '.png'));
    console.log('captured ' + name);
  };
  const click = (re) => app.evaluate(`[...document.querySelectorAll('#menu-root button')].find(b=>${re}.test(b.textContent)).click()`);
  try {
    await app.waitFor((s) => s.menus && s.screen === 'home', 'Expected the main screen', 30000);
    // (the loading screen goes once the menus are drawn: a just-booted emulator draws slowly)
    for (let i = 0; i < 60 && (await app.evaluate("!!document.querySelector('.splash-box')")); i++) await sleep(500);
    await sleep(3000);
    await app.evaluate('document.activeElement && document.activeElement.blur()');
    await shot('1-home');
    await click(/Local Game/);
    await app.waitFor((s) => s.heading === 'Local Game', 'Expected the lobby');
    // a second player takes the left half of the gamepad, holding LB (once the lobby is set up: a slow emulator
    // draws the screen well before it listens)
    await sleep(2000);
    await input.key(2, 'BUTTON_L1', 4000);
    await sleep(500);
    const players = await app.evaluate("document.querySelectorAll('#menu-root .players')[0].querySelectorAll('.pcard[data-group]').length");
    if (players !== 2) throw new Error('LB held: expected two players sharing the gamepad, got ' + players);
    for (let i = 0; i < 4; i++) {
      await click(/Add computer player/);
      await sleep(250);
    }
    // the first player's card has the focus (a card is one stop of the navigation)
    await app.evaluate(`(document.getElementById('menu-root').classList.add('kbd'), document.querySelector('#menu-root .pcard[data-group]')?.focus())`);
    await sleep(2500); // (the "joined" note goes)
    await shot('2-lobby');
    await click(/^Start ▶$/);
    await app.waitFor((s) => s.round, 'Expected a round', 20000);
    await sleep(9000); // the computer players get going
    await shot('3-round');
    await sleep(6000);
    await shot('4-round');
  } finally {
    input.close();
    await app.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
