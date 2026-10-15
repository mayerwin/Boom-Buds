# Google Play listing

Entered in Play Console on 14 October 2026 (sent for review with release 1.0.0). The texts and files, for later edits.

| Field | Value |
| --- | --- |
| App name | Boom Buds |
| Default language | English (United States) |
| App or game | Game, category Arcade |
| Free or paid | Free (no ads, no purchases) |
| Form factor | Android TV (opt in under Setup > Advanced settings > Form factors) |
| Package | `com.github.boombuds` |
| Privacy policy | https://mayerwin.github.io/Boom-Buds/privacy.html |
| Website | https://mayerwin.github.io/Boom-Buds/ |
| Contact email | the account's support address, as for the other apps |

## Short description (80 characters at most)

The 1997 bomb-dropping party classic: up to 10 bombers, 4 on the couch.

## Full description

Up to ten bombers. One arena. The last one standing wins.

Boom Buds brings the bomb-dropping party classic of 1997 to your TV. Drop bombs, blast through the bricks, grab power-ups and corner your friends in chain reactions, across eleven arenas with conveyor belts, warps, trampolines and arrows.

PLAY ON THE COUCH
Up to four people on one TV, with Bluetooth gamepads (Xbox, PlayStation, Switch Pro and others) or the TV remote. Fill the arena with computer players: the original 1997 computer player, or five skill levels from Rookie to Master.

PLAY WITH FRIENDS ANYWHERE
Network games need no account and no setup: games on your home network show up by themselves, and friends elsewhere join with a six-character room code, from their TV or from a web browser on a computer or phone. Chat in the lobby, agree on the rules, and play at full speed.

EVERY RULE OF THE ORIGINAL
Kick, punch and grab bombs, trigger and jelly bombs, diseases, the walls closing in at the end of a round, teams, schemes and the Gold Bud roulette.

MADE FOR THE TV
Sharp pixels at 4K, quick sound effects, menus you drive with the remote or a gamepad. No accounts, no ads, no in-app purchases.

## Release notes

`app/src/main/play/release-notes/en-US/default.txt` (Gradle Play Publisher sends it with each release).

## Graphics

| Play Console field | File | Size |
| --- | --- | --- |
| App icon | `store-assets/icon-512.png` | 512 x 512 |
| Feature graphic | `store-assets/feature-graphic-1024x500.png` | 1024 x 500 |
| Android TV banner | `store-assets/tv-banner-1280x720.png` | 1280 x 720 |
| Android TV screenshots | `screenshots/1-home.png` ... `4-round.png` | 1920 x 1080 |

The icon, banner and feature graphic come from the website's main screen art
(`node android/tools/generate-store-graphics.ts http://localhost:8080/` with a production build served); the
launcher banner `app/src/main/res/drawable-xhdpi/tv_banner.png` (320 x 180) is made with them. The screenshots
are the app on the 4K Google TV emulator (`android/tests/emulator-screenshots.cjs`).

If Console asks whether the graphics were made with AI: the home screen art was.
