# Testing the TV app

## Unit tests

- `npm test` (repository root) includes `tests/tv.test.ts`: the controller adapter `tv/tv.js` (standard
  mapping of buttons, d-pad, hat, sticks and triggers; the remote's devices merged into one "TV remote"
  gamepad; quick taps kept until a display frame has seen them; key repeats; Back meaning B in the menus and
  Start in a round; releasing everything when the app goes to the background).
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
arrows move the menu focus and OK opens Local Game; player 1 is the gamepad, the remote's OK does not join,
Add player picks the remote; a round starts with gamepad, remote and computer players; both move their bombers;
with trigger bombs the gamepad's A still drops one at once and B sets it off; the remote's OK drops a bomb at
once, and with trigger bombs a short OK drops one when let go while a long OK (the special) sets it off; every effect and voice is preloaded in `SoundPool` and the bombs play there (no Web
Audio fallback); Back pauses (the simulation stops), Back resumes, Quit returns to the lobby; Back returns to the main
screen and, there, leaves the app; the WebView covers the whole output and the game canvas has one pixel per
physical pixel; no page errors. Screenshots and a JSON record go to `app/build/qa/<serial>/`.

`emulator-keyboard.cjs` plays with a virtual keyboard: the menus follow the arrows and Enter, the arrow keys and
E S D F play two bombers, Esc pauses.

`emulator-screenshots.cjs` makes the store screenshots on the 4K emulator. `emulator-release-smoke.cjs` plays
the signed release APK (no DevTools there) with the virtual remote and takes screenshots to look at.

The emulators render with SwiftShader at a few frames per second: they prove input paths, sound routing and
pixels, not smoothness or real audio latency (HDMI, soundbars and a TV's own processing are outside the app).

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
