// The signed release APK (no DevTools socket there): a virtual TV remote plays a round, and screenshots record
// each step. Look at them: capturing is not checking.
// Usage: BB_QA_SERIAL=emulator-5556 node android/tests/emulator-release-smoke.cjs [apk]
// (The release and debug builds are signed differently: the test uninstalls the debug one first.)
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { inputDevices, sleep, adb, packageId } = require('./emulator-driver.cjs');

const serial = process.env.BB_QA_SERIAL || 'emulator-5556';
const apk = process.argv[2] || path.resolve(__dirname, '../publishing/releases/boom-buds-tv.apk');
const output = path.resolve(__dirname, '../app/build/qa/release', serial);
const R = 1;

async function main() {
  fs.mkdirSync(output, { recursive: true });
  try {
    adb('uninstall', packageId);
  } catch (_) {
    /* not installed */
  }
  adb('install', apk);
  const input = inputDevices();
  input.remote(R);
  await sleep(1500);
  const shot = async (name, wait = 3000) => {
    await sleep(wait); // (the 4K software compositor can show an older frame for a while)
    adb('shell', 'screencap', '-p', '/sdcard/bb-release-qa.png');
    adb('pull', '/sdcard/bb-release-qa.png', path.join(output, name + '.png'));
    console.log('captured ' + name);
  };
  try {
    adb('shell', 'am', 'start', '-W', '-n', `${packageId}/com.github.boombuds.MainActivity`);
    await shot('1-home', 12000);
    await input.key(R, 'DPAD_CENTER'); // Local Game (focused)
    await shot('2-lobby');
    await input.key(R, 'DPAD_CENTER'); // Start (focused)
    await shot('3-round', 6000);
    await input.key(R, 'DPAD_RIGHT', 500);
    await input.key(R, 'DPAD_CENTER'); // a bomb
    await shot('4-bomb', 1000);
    await input.key(R, 'BACK');
    await shot('5-paused', 2000);
    await input.key(R, 'DPAD_DOWN');
    await input.key(R, 'DPAD_DOWN');
    await input.key(R, 'DPAD_CENTER'); // Quit the match
    await shot('6-lobby', 8000);
    await input.key(R, 'BACK');
    await shot('7-home');
    await input.key(R, 'BACK'); // leaves the app
    await sleep(2000);
    const top = (adb('shell', 'dumpsys', 'activity', 'activities').match(/topResumedActivity[^\n]*/) || [''])[0];
    assert.ok(!top.includes(packageId), 'Back on the main screen leaves the app: ' + top);
    console.log('PASS (now look at the screenshots in ' + output + ')');
  } finally {
    input.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
