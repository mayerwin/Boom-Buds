# Boom Buds vs. the original game

Boom Buds reproduces Atomic Bomberman (Interplay / Hudson Soft, 1997, `BM95.EXE`) from its own data files
and from a reverse-engineered specification of the executable (`docs/re/*.md`). The game itself — rounds,
pictures, sprites, fonts, palettes, sounds, music, levels, schemes, rules, timings and the screens between
rounds (draw, results, victory, Gold Bud roulette) — follows the original pixel for pixel. The menus are new
(§0); the original menus and dialogs are still available and are reproduced pixel for pixel too. This file
lists every place where Boom Buds differs on purpose, and the original behaviours that cannot be carried
over to a browser.

## 0. Modern menus

By default Boom Buds starts with its own menus, an HTML layer with new artwork (logo, loading screen,
main-menu picture) built for mouse, touch, keyboard and gamepad: *Local Game* (up to four players on the
device plus computer players, the arena with a snapshot of each, the rules), *Network Game* (games on your
network, room codes, a lobby), *Controls* (control sets), *How to Play* and *Options*. They replace the
original title → main menu → control selection → map selection → settings chain. The rounds and the screens
between them are the original ones. The original program flow, menus and dialogs are still there, unchanged
except for the network screens (§4): see 1997 mode below.

New in the modern menus: every player picks a colour (the bomber picture on their card) and, in team games, a
team; in network games everybody does it for their own players and the host for the computer players (the
original tied colour and team to the player's row). In team games the players' cards are white or red, and the
list shows how many play for each side. A pause
menu during rounds (Esc: resume, end the round in a draw, quit the match). In a network game the pause stops
the round for everybody: the host's command channel carries it, so every machine's simulation stops and goes
on at the same tick, and the machines keep exchanging inputs meanwhile (nobody is given up on, however long the
pause); every machine shows who paused, anyone can resume, and a countdown (3, 2, 1) starts everybody at once.
The arena can also be a random special one (the arenas with ice, arrows, warp holes, conveyor belts, trampolines
or bricks that grow back) or a random one among a list the player ticks (lists can be named and kept). The
network lobby has a chat (with who comes and goes); the players who are not the host may change the rules and
the computer players too, as requests: their screen marks them "asked", the chat shows them to everybody, and the
host grants one with a click. The host can remove a machine from the room. *Extras* in Options reach the
original level editor and campaign mode.

During rounds the modern menus show score lines of their own instead of the original's "S:0 K:0": each
player's name in the colour of their bomber (dark grey for the black one), a trophy with the rounds won and a
skull with the kills; in team games the team scores come first (red, then white) and the players are grouped by
team, the red team on the first row and the white team on the second, with their kills. The players are in
columns whose colons line up, the names as long as the space allows (the longest are cut first, with "…"), and
a player out of the round has their name struck through. At the start of each round, a machine that has a single player marks that bomber for three seconds (it
glows, under a bobbing "YOU" and arrow). 1997 mode keeps the original's score lines.

**Fast-forward.** Once every person in a round is out (in a network game, on every machine) and computer
players play on, the round runs four times as fast; ← and → change the speed from 1× to 8×, ↑ or ↓ pauses
and resumes (in a network game the host decides, for everybody), and a badge over the game shows it. The end
of the round always plays at normal speed (one player or team left, or the last 5 s of the clock), so that
everybody sees how it ended. It works in 1997 mode too; Options can turn it off.

## 0b. 1997 mode

Boom Buds plays like a game of today by default; *1997 mode* brings back the original's ways all at once for
one visit (the *1997 mode* link on the main screen, *Play like it's 1997* in Options, or `?1997` in the
address, which makes a link that opens the game that way). The settings stay as they are; the *Back to today*
button in the top right corner (or Ctrl+M) ends it. It means:

* the original menus from the title picture on, pixel for pixel;
* the original mouse: no cursor outside dialogs, and clicks ignored on the menu screens (by default the
  cursor shows on every screen of the original menus once the mouse moves, until a key is pressed, and a click
  acts like a tap on a touch screen: it selects and activates);
* the original minimum waits before the draw, results and setup screens can be left (1 s, 3 s in network
  games; by default there is none, so Enter starts the next round at once).

Each of these can also be kept for good, on its own, under *Keep some of the original's ways* in Options.
Whatever the mode, the system's mouse cursor shows beside the game picture (in the bars around it), so that
the buttons there can be reached; Esc during a round opens a pause box in the original's style over the game
(resume, end the round in a draw, quit the match; in a network game it pauses everybody, like the modern
menus' pause menu); and the player setup
screen tells how to set a computer player's skill (+ and − from 0, the original's, to 5, the keys 1 to 5, or a
click on "AI n").
Two small changes stay in 1997 mode too: the main menu says **V1.1** (the original says V1.0), and the
*Set Default Network Protocol* list starts with **Internet**, which is how Boom Buds always connects (picking
IPX, Modem or Serial earns a wink and changes nothing). The credits start with the people behind Boom Buds
and a link to its repository, then introduce the original game's credits as such.

## 1. Name and branding

| Original | Boom Buds |
|---|---|
| The name in pictures: title picture (TITLE), main-menu items "About Bomberman" / "Exit Bomberman" (MAINMENU), "A.B." tiles (GLUE1), brick-wall graffiti (GLUE2), results header (RESULTS), manhole-cover engraving of level 10 (FIELD10) | "Boom Buds" / "B.B." redrawn in the same style, with each picture's own palette (`tools/brand/`, scripts and notes in its README) |
| Interplay and Hudson Soft logo screens before the title | not shown (they presented the original product) |
| Announcer line "Atomic Bomberman!" (voice group 2800) before the title | not played (it says the old name) |
| Texts mentioning the game name: messages 256, 500, 700, 900, 1300, 1321, 1323; the online manual (`*.BM`) | "Boom Buds", "Gold Bud", "bud(s)" (`tools/lib/rebrand.ts`); scheme `BMAN93.SCH` is listed as "Buds '93 (10)" |
| README.BM (installation from CD, DirectX, customer service, licence) and NETWORK.BM (IPX / modem / serial) | rewritten for the web version (`tools/brand/help/`) |

## 2. Timing

* **Game speed.** The original renders as fast as the PC allows and scales movement by the elapsed time,
  but advances some counters once per *rendered* frame, so parts of the game ran faster on faster PCs.
  Boom Buds runs the original frame function at a fixed **60 frames per second** (frame times 17, 16, 17 ms),
  i.e. exactly what the original does at 60 fps. The per-rendered-frame counters that only affect visuals
  or short timings (extra and power-up animations, the HURRY blink, gold sparkles, stun and disease
  "freshness" counters, the jelly-bounce sound throttle, the post-death taunt check) run at the game's
  nominal 20 reference frames per second (VALUELST 25/30) instead of at the display rate.
* **Menus** run 60 iterations per second (the original's menu loops were unthrottled: the main-menu bomb,
  the cursor blink and the roulette spun at whatever speed the PC reached).
* **Dud bombs** are scheduled in game seconds instead of wall-clock `time()` seconds.
* **Display rate.** The picture is presented at the display's refresh rate (60–240 Hz); the simulation does
  not depend on it.

## 3. Original bugs that are fixed

| # | Original behaviour | Boom Buds |
|---|---|---|
| 1 | Picking up a power-up shows only the first frame of the pickup animation (`pickup[walk/3]` with a counter that is reset every frame; player.md Q3) | the pickup animation plays |
| 2 | Carrying a bomb zeroes the carrier's walk counter every frame, freezing the "walkbomb" animation (bombs.md Q11, player.md Q4) | the carry walk animates |
| 3 | A player's "held bomb" pointer survives into the next round / after death (player.md Q2, bombs.md Q8) | cleared |
| 4 | Streamed voices longer than 512 KiB are cut (the "draw game" line `gump1` stops after 5.94 s of 6.80 s) | played completely |
| 5 | Joystick navigation mostly fails on the setup, options, settings and roulette screens (the screens poll the joysticks twice per frame, so the menu never sees an edge; screens.md quirk 2) | gamepads navigate every screen |

Quirks that players can notice and that are kept on purpose: the help viewer's tab expansion, the
"AWESOME" voice on the 7th, 12th, 17th... pickup, kills can go negative, the level preview using random tiles of all levels for "Random Each Game", the main-menu music
restarting after every sub-screen, the team gold-player computation, in the hidden campaign mode a
time-out saying "Campaign unsuccessful!" and then going on to the next stage (and the campaign's scheme and
level staying the current settings afterwards), and the others listed in `docs/re/*.md`.

## 4. Network games

* **Transport.** The original offered IPX, modem and serial links on a local network. Boom Buds connects
  browsers anywhere with WebRTC data channels. The machines meet under a 6-character room code on free
  public MQTT brokers (the handshake only, encrypted with a key derived from the code); games on the same
  network (same public address) are listed automatically, so a LAN needs no code. No player runs a server.
  In the original menus, *Start Network Game* shows the room code and *Join Network Game* asks for it
  instead of listing servers. The protocol and modem settings rows are kept in the original Options screen
  but have no effect.
* **Lobby (modern menus).** Every machine brings up to four players of its own and picks their control
  sets; the host picks the arena and rules and adds computer players; the host's *Start* starts the match on
  every machine, and after the match everybody is back in the lobby (new machines may join between matches).
* **Netcode.** Every machine runs the same deterministic simulation from everybody's inputs (rollback
  netcode with one frame of input delay), so all machines show exactly the same game.
* **Same rules as single-computer games.** The original disabled several features in network games because
  its netcode could not keep them in sync: trampolines, the swap disease, the random power-up, dud bombs,
  the stun and power-up loss when a bomb lands on a head, the relocation of over-powerful power-ups during
  the first 40 s, and some animations of other players. Boom Buds keeps all of them in network games. Still
  as in the original: no Gold Bud roulette in network games, diseases are always destroyable, Ctrl-A and
  computer-player selection are server-only, and the server advances all screens (in 1997 mode after a
  minimum time of 3 s on each, like the original).
* **Ownership.** Each machine sets up its own players (in the original menus on the control selection
  screen, where they show as "NET" on the other machines); computer players run on the host.
* **Lost players.** When a machine leaves during a round its players stand still (or, with "Lost net players
  revert to AIs", become computer players) until the end of the round, and are switched off (or stay
  computer players) from the next round on. The original switched them off immediately.
* **Losing focus** no longer aborts a network game (the original aborted when its window lost focus). A
  machine that closes its page says goodbye at once. One that goes silent (a phone locking its screen or
  switching apps, a busy or suspended page) is shown as "connection lost" after 3 s and counts as gone after
  8 s during a match, where everybody waits for it, or 20 s in the lobby (2 minutes when its page said it
  went to the background); a page that was itself stalled does not count the others' silence. A client that
  loses the host in the lobby gets back into the room by itself.

## 5. Computer players

The original's computer player is there, reproduced from the reverse-engineered game (docs/re/ai-original.md:
its eight strategies in their order, its walker search, its random draws and its quirks), and it is the default:
"AI 0", *Original 1997* in the modern menus. It thinks at the game's nominal 20 frames a second (the original
thought once per rendered frame) and sees the state as the original did at that moment of a frame. Next to it,
Boom Buds adds computer players of its own with **five skill levels** (Rookie, Casual, Skilled, Expert,
Master), chosen with stars in the modern menus (the *1997* chip in front of them is the original's). In the
original menus, [right] on the control selection screen still steps OFF → AI → KEY 0 → KEY 1 → JOY 0 … → OFF;
[+] and [−] step the skill of the selected computer player from 0 to 5, the keys [1]–[5] set it (the key [0]
keeps its original meaning, off), and so does a tap on the "AI n" text on a touch screen; the rows read
"AI 0" … "AI 5" instead of "AI". The attract-mode demo uses the original's computer player.

## 6. Input

* **Control sets (modern menus).** Each player plays with a control set: a keyboard layout (two built in:
  E S D F to move with A = bomb and Q = special, and the arrow keys with . = bomb and , = special; more can be
  recorded), a gamepad, the mouse (the bomber walks toward the pointer, left button = bomb, right button =
  special) or the on-screen touch controls (one player, or two players on one device with one side bar
  each). Keyboard sets use physical key positions, so they work on any keyboard layout; their labels follow
  the keyboard. The original menus' two keyboard layouts KEY 0 and KEY 1 are the sets "Keyboard right" and
  "Keyboard left": the same keys in both menus, changed from either (the original kept them in options.ini);
  *Return to default keys* gives them back as Boom Buds ships them (arrows with . and , ; E S D F with A and Q).
* Keys are read from the browser; GNW's key repeat (500 ms, then every 80 ms) is reproduced in the original
  menus.
* A key pressed and released between two game frames still counts for one frame (the original could miss
  it).
* Joysticks are browser gamepads (standard mapping: d-pad or left stick, A/X = action 1, B/Y = action 2;
  in menus B is also Esc; during a round Start pauses). They are numbered JOY 0, JOY 1... in the order the browser reports them.
* Phones and tablets get on-screen controls (stick, A, B, ESC) that play KEY 0; taps select and activate
  menu entries and dismiss the title picture; holding ESC for 0.7 s quits a round (Ctrl-Q). The original
  ignored the mouse on menu screens; Boom Buds treats a click there like a tap, except in 1997 mode (§0b).
* Text fields (node name, modem settings) open the device's keyboard on touch screens.
* The GNW mouse cursor (drawn by the game in dialogs, the help viewer, the keyboard layouts screen and the
  editor) sits where the real mouse is, instead of moving by the mouse's relative motion from the screen
  centre; before the mouse is first moved it starts at the centre like the original, so a list that opens
  under it highlights that row as in the original. Touch screens show no mouse cursor. A cursor pushed
  into the bottom-right corner (only its 2×2 top-left pixels visible) is drawn at once in text-input boxes;
  the original showed that sliver only after the first key press.

## 7. Program-level differences

* **Start-up:** there is no first-run "memory model" question (the setting is still in the Options
  screen); the "Loading data..." progress window shows the download of the sprite data.
* **Sound:** browsers only allow sound after the first key press or tap; if that happens on the title
  picture, the title music starts then (and the picture stays its full 7 s).
* **Exit:** a web page cannot close itself. After "Yes" the music stops and the quit voice plays as in the
  original; the screen then stays black until a key or tap restarts the game. Changing the memory model
  reloads the page instead of exiting.
* **Settings** are stored in the browser (localStorage) whenever they change instead of in `options.ini`
  at exit. The default level is "Random Each Game".
* **Alt-C** (screen dump) downloads `scrNNNNN.bmp` instead of writing it next to the program.
* **Alt-D** (debug window) shows the browser's memory figures; network ids are 0.
* **Window:** the 640×480 picture is scaled to the browser window (sharp pixels at any size); the original
  ran in a 640×480 full-screen mode.
* **Level editor** (Ctrl-E six times on the main menu, or *Scheme editor* in Options): schemes it saves are
  kept in the browser (localStorage) in the original `.SCH` text format and are listed together with the
  shipped ones (first, with a star, in the modern menus); *My schemes* in Options plays, exports (one `.SCH`
  file, or all of them in one file), imports and deletes them; a saved
  scheme with the name of a shipped one replaces it, as overwriting the file did. Their header comment
  says "Boom Buds Scheme File". Pressing Cancel at the file-name question saves under the current name
  like the original, but a name without extension ("Newfile") gets ".sch" (the original wrote such a file
  outside the scheme directory, where it could not be loaded again). On touch screens a tap paints like
  the left mouse button, holding a finger for half a second moves the selected player's start like the
  right button, and the d-pad up/down selects the player like '+' / '-' (the original ignores the cursor
  keys there).

## 8. Windows-specific artefacts not reproduced

* DirectDraw palette quirks on modern Windows (wrong colours without a compatibility shim) — Boom Buds shows
  the palette the game sets, 6-bit values expanded as `v << 2`, which is what the original displays on a
  correctly working DirectDraw.
* The 7th simultaneous sound effect "stealing" artefacts of particular DirectSound drivers; Boom Buds drops
  it like the code intends.
