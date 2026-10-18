# Boom Buds for Google TV

The Android TV / Google TV app is the website's game in a WebView. Gradle runs the repository's own
`npm run build` and packages the result, so there is no second copy of the game to maintain. The TV app adds
only what a TV needs, in this folder:

- **Controllers** (`tv/tv.js`, `MainActivity.java`): the WebView has no Gamepad API, so the app forwards the
  key and stick events of gamepads and of the TV remote, and `tv.js` answers `navigator.getGamepads()` with
  them in the standard mapping the game already reads. Keyboards and mice reach the WebView as usual. The
  website never loads `tv.js`.
- **Sound** (`NativeAudio.java`): the WebView's audio output adds a noticeable delay on TVs, so the game's
  effects and voices play through Android's `SoundPool`, preloaded from the packaged files in the background
  when the game starts (the round's effects first, then each announcer's next voice, picked in advance).
  `SoundPool` decodes every file it loads, tens of milliseconds each, so the app loads only the session's
  sounds (about 125), on 4 pools that decode in parallel; a sound not loaded yet plays through the WebView.
  Only the music stays on Web Audio: it follows no action, and `SoundPool` is meant for short sounds.
- **Picture**: the app asks the TV for its 4K mode at the current refresh rate (never 4K at 30 Hz) and for
  its low-latency game mode, and the game draws at the WebView's full physical resolution.

Network games work as on the web, with the website's players too.

## Controls

| | Move | Bomb | Special | Pause | Menus |
| --- | --- | --- | --- | --- | --- |
| Gamepad (Xbox, PlayStation, Switch Pro and other Bluetooth pads) | stick or d-pad | A | B | Start | d-pad or a stick, A selects, B goes back |
| Gamepad shared by two, left side | left stick or d-pad | LB | LT | Select | |
| Gamepad shared by two, right side | right stick | A or RB | X or RT | Start | |
| TV remote | arrows | OK | hold OK | Back | arrows, OK selects, Back goes back |
| Keyboard / mouse | as on the website | | | Esc | as on the website |

In Local Game, player 1 is a gamepad when one is connected, otherwise the remote. The others join by holding
any button of their gamepad, or the remote's OK, for 0.8 s (a short press is a menu press): a gamepad joins
whole. Holding a button on a gamepad that already plays says so, and holding one again (1.2 s) shares it between
two players — its player keeps the left half, the newcomer takes the right half — so that nobody shares one by
accident. **Add player** lists every set, with a drawing of the controller and the buttons that player uses, as
the **Controls** menu does. The line-up is remembered by gamepad name: a player whose gamepad is off is hidden
until it is back. In the menus the arrows always move to the nearest control (and scroll a screen that is taller
than the television, such as Controls); OK goes into a player's card (Back comes out) or starts changing a
setting (← → change it, OK is done). Back on the main screen leaves the app. Pair Bluetooth controllers in the
TV's settings first.

Leaving a match goes straight back to the menus, under a short curtain. If the game ever feels slow to answer,
**Options → Display → Frame rate and input delay** shows what this machine takes: the frames a second it draws,
how long a press takes to reach a drawn frame, and how long the app takes to hand a press to the page. A
television adds its own delay after that — its game mode (or "low latency mode") is what cuts it, and the app
asks for it.

The remote has one action button. OK is the bomb button: a bomb at once, and held, it carries a grabbed bomb.
When the special button has a use for its bomber (a boxing glove, trigger bombs, or one of its kicked bombs
still sliding), a short OK is the bomb button when let go and holding OK for 0.3 s is the special. The only
thing a two-button controller can do that the remote cannot: carry a grabbed bomb while also having a boxing
glove or trigger bombs (then a short OK picks the bomb up and throws it at once). Only the remote's player is
concerned: gamepads, keyboards and mice keep their two buttons.

## Google Play

In the **ErwinMayerLabs** developer account since 14 October 2026: package `com.github.boombuds` (Play
Console app ID 4972982491788034302; the sideload edition is `com.github.boombuds.sideload`, so both can be
installed). Closed testing on the **Alpha** track, all countries, testers from the **Erwin Mayer Labs Beta**
Google group (`erwin-mayer-labs-beta@googlegroups.com`, signup at
[its About page](https://groups.google.com/g/erwin-mayer-labs-beta/about)), opt-in link
`https://play.google.com/apps/testing/com.github.boombuds`. Version 1.0.0 (code 5) and the listing, app
content (rating ESRB Everyone 10+ / PEGI 7, audience 13+) and Android TV opt-in were sent for review the same
day. The existing Play service account has access, and the first AAB went up through the API
(`4-publish-to-play.bat` as a draft: an app created with its package name accepts it). Version 1.0.1 (code 6,
hold-to-join, two players per gamepad, the reworked menu navigation) went to Alpha as a completed release on
16 October 2026. Version 1.0.2 (code 7, the shorter input path, the drawings of the
controllers, sharing a gamepad on purpose, the Controls screen that scrolls on a TV and the instant way out of
a match) followed on 18 October 2026, and 1.0.3 (code 8) right after it, with the input-delay readout counting a press against the frame it is handed over in rather than the one already being drawn.

The signing keys are in `publishing/secrets/` (ignored by git): **keep a backup of that folder** (the keys,
their passwords, the version-code counter). The listing texts are in
[`publishing/store-listing.md`](publishing/store-listing.md), the app content answers in
[`publishing/data-safety.md`](publishing/data-safety.md), the privacy policy is
`https://mayerwin.github.io/Boom-Buds/privacy.html` (from `public/privacy.html`, also shown in the app).

Testers join the group once, then opt in to each app at its testing link and install from Play on the TV.
Production access for a personal account needs 12 testers opted in for 14 days in a row.

For each release: raise `versionName` in `version.properties`, write
`app/src/main/play/release-notes/en-US/default.txt`, run script 4. Version codes are reserved automatically
(`publishing/secrets/release-state.json`). When what the app does changes, the listing changes with it:
edit [`publishing/store-listing.md`](publishing/store-listing.md), make new screenshots on the 4K emulator
(`tests/emulator-screenshots.cjs`, then look at them) and run script 7 (`-Screenshots` to send them too).
Everything goes through the Play API; nothing needs Play Console except reading the review status.

## Scripts

| `publishing\` | |
| --- | --- |
| `0-build-sideload-apk.bat` | signed sideload APK (`releases/boom-buds-tv.apk`) |
| `1-generate-upload-keystore.bat` | the upload and sideload keys, once; never overwrites |
| `2-show-fingerprints.bat` | the keys' certificate fingerprints |
| `3-build-play-aab.bat` | signed Play AAB and sideload APK |
| `4-publish-to-play.bat` | build and release to the configured tracks (Alpha) |
| `5-publish-to-play-production.bat` | build and release to Alpha and production |
| `LAUNCH.bat` / `6-install-on-tv.bat` | build, install and start on a TV with network debugging (pairs once, then remembers it) |
| `7-update-play-listing.bat` | the listing's descriptions from `store-listing.md` (`-Screenshots`: and the TV screenshots); `-Tracks` shows the releases on each track, `-DryRun` changes nothing |

Requirements: Node.js 22+ (the scripts run `npm ci` when `node_modules` is missing), JDK 17+ (Android
Studio's is found automatically) and the Android SDK (platform 36). Paths can be set in
`publishing/local-config.ps1` (see the `.example`). From `android/`, `gradlew.bat assembleSideloadDebug`
builds a debug APK.

Testing: [TESTING.md](TESTING.md).
