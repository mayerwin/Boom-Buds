# Testing the TV app

## Unit tests

- `npm test` (repository root) includes `tests/tv.test.ts`: the controller adapter `tv/tv.js` (standard
  mapping of buttons, d-pad, hat, sticks and triggers; the right stick from Z / RZ, or RX / RY on gamepads
  without them; the remote's devices merged into one "TV remote" gamepad; quick taps kept until a display frame
  has seen them; key repeats; Back meaning B in the menus and Start in a round; releasing everything when the
  app goes to the background; one snapshot per display frame; the events waiting in the app fetched when the
  game reads its controllers, acted on once each; a remote press the game saw only once taken for a tap), and
  `tests/controls.test.ts` (gamepads known by name, halves of a gamepad — A / RB bomb and X / RT special on the
  right one — the 1997 menus' KEY n / JOY n L / R).
- `npm run e2e` includes `tests/e2e/controls.spec.ts`, with made-up gamepads in Chrome: holding a button
  joins a gamepad whole, a short press is a menu press, a second hold shares it (left half, right half) while
  the first hold on a gamepad that already plays only says so, the controls dialog draws the controller it is
  about, the Controls screen shows everything the arrows reach on a television-sized screen, sticks in the pause
  menus, the d-pad in the fast-forward and the 1997 pause box, the modern line-up in the 1997 player setup.
- `gradlew.bat test lint` (in `android/`): `DisplayPolicy` (which display mode is 4K at the current refresh
  rate), `InputMath` (stick dead zones), `NativeAudio.assetPath` (game URLs to packaged files, nothing outside
  them).

## Google TV emulators

Two Android 36 Google TV AVDs (image `system-images;android-36;google-tv;x86_64`): `pongwars_tv_qa`
(`tv_720p`) and `pongwars_tv_4k_qa` (`tv_4k`, run with `-memory 4096`). Headless:

```powershell
$env:ANDROID_TMP = 'D:\Temp\boombuds-emulator'   # the read-only overlay grows to a few GB; keep it off a full drive
emulator -avd pongwars_tv_qa -port 5556 -no-window -read-only -no-snapshot-save -no-audio -no-boot-anim
emulator -avd pongwars_tv_4k_qa -port 5558 -memory 4096 -no-window -read-only -no-snapshot-save -no-audio -no-boot-anim
```

Stop them with `adb -s emulator-5556 emu kill` (a killed process leaves its overlay files in the temp folder).

`tests/emulator-driver.cjs` (Node 22) drives the debug APK: it refuses anything but an emulator, attaches to the
app's own WebView through its DevTools socket, and creates a virtual TV remote (d-pad, OK, Back) and virtual
gamepads with AOSP's `uinput` tool, so their events go through Android's input stack, `MainActivity` and
`tv.js` like a paired controller's.

```powershell
cd android; .\gradlew.bat assembleSideloadDebug; cd ..
$env:BB_QA_SERIAL = 'emulator-5556'; node android/tests/emulator-smoke.cjs
$env:BB_QA_SERIAL = 'emulator-5558'; node android/tests/emulator-smoke.cjs
```

`emulator-smoke.cjs` checks, from a fresh install: the remote and the gamepad show up as gamepads; the remote's
arrows move the menu focus and OK opens Local Game; player 1 is the gamepad, a short OK of the remote does not
join but a held one does, a button held on the gamepad says it already plays and held again shares it (its left
half for player 1, its right half for a third player) until removing that player gives player 1 the whole gamepad
back; a round starts with gamepad, remote and computer players; both move their bombers;
with trigger bombs the gamepad's A still drops one at once and B sets it off; the remote's OK drops a bomb at
once, and with trigger bombs a short OK drops one when let go while a long OK (the special) sets it off; every effect and voice is preloaded in `SoundPool` and the bombs play there (no Web
Audio fallback); Back pauses (the simulation stops), Back resumes, Quit returns to the lobby at once (the record says how many
milliseconds that took); Back returns to the main screen and, there, leaves the app; the WebView covers the whole output and the game canvas has one pixel per
physical pixel; no page errors. Screenshots and a JSON record go to `app/build/qa/<serial>/`.

`emulator-keyboard.cjs` plays with a virtual keyboard: the menus follow the arrows and Enter, the arrow keys and
E S D F play two bombers, Esc pauses.

`emulator-1997.cjs` plays 1997 mode with the remote: OK goes through the original menus to a round, "Back to
today" stays hidden during it, Back opens the original's pause box and its arrows and OK choose in it.

`emulator-screenshots.cjs` makes the store screenshots on the 4K emulator (the main screen, a lobby where a
second player took the right half of the gamepad by holding a button twice, two rounds); look at them, then send them with
`publishing/7-update-play-listing.bat -Screenshots`. `emulator-release-smoke.cjs` plays the signed release APK (no
DevTools there) with the virtual remote and takes screenshots to look at.

The emulators render with SwiftShader at a few frames per second: they prove input paths, sound routing and
pixels, not smoothness or real audio latency (HDMI, soundbars and a TV's own processing are outside the app).

## Results (18 October 2026)

- `npm test` (88 tests), `npm run e2e` (20), JVM tests and lint pass.
- On the 720p emulator: `emulator-smoke.cjs`, `emulator-keyboard.cjs` and `emulator-1997.cjs` pass. Leaving a
  match reached the lobby in about 0.3 s there (it used to wait a second on the round's last picture before the
  menus were even built).
- Ten single taps of the remote and of a gamepad all reached the menus (the emulator falls seconds behind while
  it loads, so the test driver now waits for what a press should do instead of pressing once and hoping).
- The input path was shortened for this release: Android hands a press to the page as soon as it has it instead
  of waiting for the next display frame, and the page takes whatever is waiting at the moment it reads its
  controllers (`AndroidHost.drainInput`), so a press lands in the frame that follows it.

## Results (15 October 2026)

- `npm test` (85 tests), `npm run e2e` (18), JVM tests and lint pass.
- On both emulators: `emulator-smoke.cjs` (a short OK of the remote is a menu press and a held one joins it; LB
  held on the gamepad adds a player on its left half; that player's ✕ gives the whole gamepad back),
  `emulator-keyboard.cjs` and `emulator-1997.cjs` pass. The smoke test now keeps players 1 and 2 from dying
  (their own trigger bombs, or a computer player's, could end the round before the pause step).
- Found and fixed on the way (reviews of the TV path): a held Back on Android 9–12 left the app (its repeats
  read as new presses); quick taps of a d-pad on the hat axes, or of a trigger, could be merged away between two
  frames; a gamepad whose Z / RZ are triggers (no key layout of its own) read its right stick as pushed up-left;
  the search key of remotes was swallowed; a dying page renderer closed the app (it now starts again).

## Results (14 October 2026, version 1.0.0)

- `npm test`, JVM tests and lint pass.
- Smoke test passes on both emulators. 720p: output 1280 x 720, WebView 1280 x 720, canvas 1280 x 720 at
  devicePixelRatio 1.33. 4K: output 3840 x 2160 at 60 Hz (the app's 4K request granted), WebView
  3840 x 2160, canvas 3840 x 2160 at devicePixelRatio 4; the arena is drawn at 4.5x with sharp pixel edges.
  Sound: 125 sounds (the session's effects and the announcers' next voices) loaded natively in about 5 s in
  the background on the idle 720p emulator (16.5 s for 238 sounds on one pool before: SoundPool creates a
  decoder for every file), 0 failures; every effect of the test round and the announcers played by
  `SoundPool`.
- Found and fixed on the way: the Android build unpacks `.gz` assets (the app now serves them under their
  web names); a menu bug that kept gamepads from joining a lobby when the browser hands out new gamepad
  objects on each poll (also fixed for the website); remote taps shorter than a slow frame were missed.

Before a release, try on the real TV: the remote, one and two gamepads, a network game against the website,
and whether the sound is in time with the picture through the TV's speakers and through a soundbar.
