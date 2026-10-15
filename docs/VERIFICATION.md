# How Boom Buds was checked against the original

## Reference material

* **Specification** of the executable (`docs/re/*.md`), written from a full decompilation of `BM95.EXE`
  (Ghidra with a Watcom calling-convention model) and checked against the disassembly where the
  decompiler was ambiguous.
* **408 screenshots of the original game** running windowed (cnc-ddraw) from an unmodified copy, driven
  by scripted keyboard and mouse input injected through a DirectInput proxy, so every shot has a known
  input history (scratchpad `caps/ref`, listed with their inputs in its README).

## Screens and dialogs — pixel comparison

`tools/dev/replay-ref.ts` replays each capture script of the original on the production build, in 1997 mode
(the original menus, mouse and waits; same options, same keyboard and mouse input, the GLUE backgrounds the original happened to
pick) and compares every screenshot pixel by pixel (`tools/dev/compare.ts`). For this comparison the game shows the original
pictures instead of the Boom Buds artwork (`node tools/extract.ts --no-brand`, `REPLAY_ORIGINAL_PICTURES`),
so that the artwork does not hide other differences. `tools/dev/explain-diffs.ts` then checks that every
remaining differing pixel lies in a region with a known reason.

Result of the last run (14 capture scripts, 160 screenshots with a reference from the same run):

| | screenshots |
|---|---|
| pixel-identical | 43 |
| differ only in the places below | 117 |
| differences anywhere else | **0** |

| reason for the remaining differences | screenshots |
|---|---|
| the main menu's version label says V1.1 (also under dialogs opened from the menu) | 46 |
| main-menu cursor bomb: animation phase at the moment of the shot (also under dialogs opened from the menu) | 40 |
| rebranded text: "Gold Bud" settings row, credits (now opening with the Boom Buds credits) and manual pages, "Buds '93" scheme, editor title, memory-model question | 48 |
| "Internet" at the top of the network protocol list | 1 |
| computer players shown as "AI n" (skill level), and how to set the skill (a line under the joystick list) | 14 |
| *Return to default keys* gives Boom Buds' keyboard sets (shared with the modern menus) | 1 |
| dude cursor: blink phase | 6 |
| random content: level preview bricks, in-round brick layout and AI play | 16 |
| Alt-D debug window: browser memory figures instead of Windows ones | 1 |
| capture artefacts of the original's recording (cnc-ddraw presented the last cursor redraw or a key's effect late) | 6 |
| GNW cursor parked in the screen corner during text input: the original shows its 2×2 visible part only after the first key, Boom Buds at once | 4 |

A screenshot can have several reasons. A run on a busy machine once let a key repeat (one extra step in the
play-time setting); the same script replayed again matched.

Not comparable by design: the network entries with networking switched off (R5a) and the IPX / modem /
serial protocol prompt (R5b), which Boom Buds replaces with its WebRTC network screens.

The GNW rules themselves were also re-rendered from the specification by an independent Python
renderer: 91 dialog captures, 7.4 million pixels, 0 differences (`docs/re/gnw-widgets.md` §11).

## Gameplay timing

Measured on the original with timestamped screenshot bursts on an empty test field, compared with the
simulation fed the same input:

| quantity | original (capture) | Boom Buds |
|---|---|---|
| walking speed (no power-ups) | ≈ 188 px/s (capture presentation lags, ±5 %) | 184.6 px/s (V42 = 923 / 100 px per 50 ms) |
| bomb fuse (press → explosion) | 1.9 – 2.06 s | 2.0 s + the frame of the press |
| flame duration | ≈ 0.5 s | 0.5 s (V10 = 10 reference frames) |

The rest of the gameplay follows the specification line by line; `tests/sim.test.ts` runs every level
and scheme and checks determinism, `tests/features.test.ts` plays scenarios for the level features and
bomb actions (arrows turning kicked bombs around the field, conveyors carrying players and bombs and
slowing players who walk against them, warps, trampolines, kicking, jelly bombs, punching across the field
edge, trigger bombs), and the computer players exercise every rule in long tournaments
(`tools/ai-arena.ts`).

## Netplay

* `tests/e2e/net.spec.ts` (modern menus, the dev server's relay): a machine follows a join link into a room
  and both play a round whose state hashes match; the host ends the match and both are back in the lobby;
  three machines join by typing the room code, one closes its page during the round and the other two go on
  in sync (the departure is noticed at once through its goodbye); a machine the host gives up on in the lobby
  gets back into the room by itself, and a page frozen for 5 s during a round (a busy phone) is waited for: the
  round goes on afterwards with nobody dropped and the simulations identical; Esc on one machine pauses both
  simulations at the same tick (same state hash), a 9 s pause drops nobody, and after Resume on the other
  machine a countdown starts both again, in sync; in the lobby a chat message with an emoji reaches the host, a
  client's requests (round time, teams) are marked on its screen and listed in the host's chat, the host grants
  them with Apply and both see the new rules and the team balance, and a machine the host removes is back on
  the Network Game screen and refused if it tries to come back; over a simulated slow network
  (50 ms each way, 10 ms jitter, 1 % loss) a round runs at full speed (over 54 of 60 ticks a second) and in
  sync. The same checks with an emulated phone (CPU slowed 6x): a 7 s freeze in the lobby keeps it in the room.
* `tests/room.test.ts`: room codes, joining, refusals (unknown code, full, playing, other version), message
  relay between machines, leaving, and the MQTT packet codec.
* `tests/rollback.test.ts`: the rollback session converges with latency, jitter and 35 % packet loss, and
  its clock comparison counts the ticks a peer played while its last message travelled.
* `tools/dev/net2.ts` against a production build with the **public relays**: the host's game appears in the
  other browser's *Games on your network* list about 0.2 s after it was created; the other browser is in the
  lobby 1.2–2.2 s after clicking *Join*; the connection is a direct host-to-host UDP path with a 1 ms round
  trip; the two simulations stay identical (state hashes and desync counters). Creating a game shows its code
  about 0.2 s after the meeting service is reached (about 1 s after opening *Network Game*; *Create* and the
  code boxes already work while it connects). Of the public brokers probed,
  three accept WebSocket connections (EMQX, HiveMQ, Mosquitto); the game uses all three at once.
* The shared credentials of the formerly free "Open Relay" TURN service no longer work (allocation refused,
  checked 2026-10); public STUN servers (Cloudflare, Google, Twilio) do.

### Under latency

`tools/dev/netlag.ts` plays a network game between two browsers on the local server's relay, both with the
same simulated network conditions (`?netsim=delay,jitter,loss`: milliseconds each way, milliseconds of random
extra delay, percent of input packets lost; `src/net/mesh.ts`). Two people walk at random (a new direction
about every 0.3 s, no bombs) for 20 s per condition, on a 165 Hz display. Results of two runs each (2026-10):

| Each way: delay, jitter, loss | Round trip | Game speed | Rollbacks | Deepest | The other bomber visibly corrected | Desyncs |
|---|---|---|---|---|---|---|
| 0 ms | 5 ms | 99–100 % | 0–0.1/s | 0 (7*) | 0–0.2/s, ≤ 10 px | 0 |
| 25 ms, 5 ms, 0 % | 58–68 ms | 100 % | 5/s | 2 ticks | 0.3–0.7/s, ≤ 16 px | 0 |
| 50 ms, 10 ms, 1 % | 109–127 ms | 98 % | 5/s | 4–5 ticks | 1.2–1.7/s, ≤ 36 px | 0 |
| 100 ms, 20 ms, 2 % | 218–229 ms | 97–99 % | 5/s | 7–8 ticks (13*) | 1.2–2.2/s, ≤ 61 px | 0 |

Game speed is ticks played per second of a running round over 60. Rollbacks follow the other player's changes
of direction (about 5 a second here); with one tick of input delay none are needed on a LAN. A correction is
counted when the other bomber moves further in one frame than it can walk (a cell is 40 px wide). No condition
stalled the game. * After a hiccup of the test browser (0.2 s and 0.5 s) that froze both pages at once.

Since then the other machines' bombers are eased into place after a correction instead of jumping (only the
picture moves: a move longer than the bomber can walk, shorter than a warp, is caught up within about a quarter
of a second). Measured the same way on what is drawn, the largest jump of the other bomber in 20 s fell from
30–36 px to 10–16 px at 50 ms each way, and from 25–60 px to 10–15 px at 100 ms each way.

Before October 2026 the clock sync compared a peer's tick, as given in its last message, with the local tick,
forgetting that the peer had played on while the message travelled: every machine believed it was ahead and gave
time back until the game ran slowly enough for the delay to look small. The same tool measured 100 % game speed
at 0 and 25 ms each way, but 67 % at 50 ms and 41 % at 100 ms: friends playing over the internet saw the game in
slow motion. The sync now adds half the measured round trip to the peer's tick, and gives back at most one tick
every 100 ms. With two or three ticks of input delay instead of one, the corrections at 50 ms each way halved
(0.3–1.0 a second, ≤ 18 px), but at 100 ms they did not change; Boom Buds keeps one tick.

With the easing in place, a second tick of input delay for rounds where the round trip exceeds 80 ms was
tried again (2026-10, two runs per condition, each machine choosing its own delay: the rollback session
accepts machines with different delays). At 50 ms each way the raw corrections went from 1.2–1.8 to
0.8–1.7 a second and from ≤ 36 to ≤ 24–76 px; what is drawn after easing did not improve (0.1–1.4 against
0.2–1.4 a second, ≤ 14 against ≤ 19 px); at 100 ms each way nothing changed. Not worth 17 ms of extra input lag:
one tick it stays.

## Computer players

`tools/ai-arena.ts` plays the real simulation headless, bot against bot. The levels are meant to play like
people, measured against the original game's computer player (AI 0, the default): 1 a beginner who loses to it
most of the time, 2 a casual player about even with it who bombs whoever is in line, 3 a good player, 4 a strong
one, 5 a match for the very best (2026-10 retune). Their reaction times are human (900, 650, 300, 240 and
150 ms), and before laying a bomb they hesitate like people do: a random 0.5 to 1.5 times their decision lag
(1200, 900, 300, 180 and 90 ms), after which they drop only if the chance is still there. The weaker levels lose
the way people lose, by being slow rather than by blowing themselves up: they notice an opponent's bomb late,
think they have more time than they do, misjudge how far its blast reaches and miss chain reactions. All 11 arenas, 264 rounds against AI 0 and 528 per pair of neighbouring
levels:

| | skill 1 | skill 2 | skill 3 | skill 4 | skill 5 |
|---|---|---|---|---|---|
| wins against the original's computer player | 36 % | 49 % | 73 % | 84 % | 97 % |
| wins against the level below | | 65 % | 85 % | 72 % | 73 % |
| bombs a minute | 18 | 23 | 31 | 31 | 35 |
| deaths by its own bombs | 4.5 % | 3 % | 0.9 % | 0.9 % | 2.6 % |

Skipping a level, the higher one wins 91 % (skills 1 and 3), 91 % (2 and 4) and 94 % (3 and 5) of the decided
rounds. In four-bot free-for-alls of skills 2 to 5, skill 5 wins 34 of 37 decided games. Rounds between skills 1
and 2 last 45 s on average (median 39 s; 22 s when beginners still blew themselves up in 40 % of their deaths);
few rounds between bots reach the time limit (at most 6 %, between skills 3 and 4). The original's player blows
itself up in 36 % of its deaths. Besides placing bombs, the bots kick and punch bombs at their opponents and use trigger bombs.

**The arenas' extras are no matter of skill.** Every level takes warp holes (only skill 5 did before, and every
level died stepping out of the warp's spin too early: the spin lasts 51 steps, not 56; no death follows a warp
now), rides conveyor belts, and, when no safe cell is left, jumps on a trampoline next to it if its landing
spots are mostly safe (a bomber cannot be hurt while it bounces; about 77 % of those jumps survive, where nearly
every such bot died before). On The Coal Mine the bots of skills 1 to 5 take 18, 15, 12, 10 and 9 warps a round.

**No passive bots.** The arena measures, for every bot, the longest stretch during which it could have laid
a bomb safely (a bomb ready, an enemy within 5 cells, a way out) and did not, in same-skill duels, three-bot
games and 2-against-1 games with few bricks left. For every level, 90 % of those stretches are under 6.5 s,
and at most 1.2 % exceed 10 s (skill 3 reached 70 % before this was fixed). Against scripted opponents that
are not bots (one standing still, one wandering, one fleeing every bomb but never attacking), skills 2 to 5
kill the still and the wandering one in 15 or 16 rounds of 16, within 30 to 41 s on average. No bot stands
idle for more than 5 s while it can move. Two skill-3 bots still often reach the time limit together, since
skill 3 has no trap search to finish an opponent (see the roadmap).

**The original's computer player (AI 0)** (`tests/ai-original.test.ts`: it runs from a bomb and survives,
bombs a brick and gets away, bombs a player next to it but not near its own start point, chases a person across
the open field and kills them, punches, sets off trigger bombs and grabs; its forced fresh press; its 20 / 60 Hz
think rate; it never changes the state and only presses buttons the player code knows; the same seed gives the
same inputs; it runs on all 11 arenas). Against Boom Buds' levels (`node tools/ai-arena.ts --pairs 0-1,0-2,0-3
--rounds 100 --ffa 0 --ffa9 0`, all arenas, mixed schemes), it wins 24 % of the decided rounds against skill 1,
9 % against skill 2 and 5 % against skill 3, and none against skills 4 and 5 (50 rounds each); in four-bot
free-for-alls with skills 1 to 3 it is about as strong as skill 1. 43 % of its deaths are by its own bombs, as
expected from a player with no escape planning (docs/re/ai-original.md §11). Nine AI-0 bots take 0.008 ms per
simulation tick on average.

Cost (`node tools/ai-bench.ts --level 5 --repeat 3`, the fastest of three runs per tick so that pauses of a
busy machine do not count): nine skill-5 bots take 0.47 ms per simulation tick on average and 2.3 ms at worst
(nine bots of mixed skills: 0.23 ms, 2.5 ms). Their work per tick is bounded by a deterministic budget (never
by time, which would desynchronise network games).

## Performance

Headed Chrome on a laptop with Intel Arc graphics and a 165 Hz display, 40 s of endless demo rounds with 10
computer players on the conveyor level (`?bench=10&level=10&ai=S`):

| | frames per second | frame time p99 | main thread busy |
|---|---|---|---|
| 10 × skill 3 | 163.5 | 6.3 ms | 6.6 % |
| 10 × skill 5 | 165.0 | 6.3 ms | 10.0 % |
| 10 × skill 3, CPU throttled 4× (roughly a mid-range phone) | 157.5 | 6.3 ms | 30.1 % |
| 10 × skill 5, CPU throttled 4× | 164.4 | 6.2 ms | 38.8 % |

The machine runs other jobs, so single long frames show up now and then (up to about 1 s in throttled runs);
in a 75 s unthrottled run, none of the five frames over 60 ms had a long task behind it on the page's main
thread. The simulation step itself costs under 0.1 ms; the renderer issues a handful of instanced draw calls
per frame.

Menus: the game's frame loop sleeps while they are open, and their animations (sparks on the logo, bombers
walking along the bottom of the main menu, the "looking for games" pulse) use only transforms and opacity,
which the compositor runs: the main menu takes 0.2 % of the main thread (Local Game 0 %, Network Game 0.4 %),
and the compositor's own work (about 5 % renderer and 20 % GPU-process CPU at 165 Hz while something moves)
stops after 45 s without input, when the bombers leave and the sparks freeze. The audio device is opened
while the page is idle instead of in the first click, so a screen change takes about 30 ms from the click.

## Automated tests

`npm test` (unit: simulation, level features, arena lists, rollback, rooms and the MQTT codec, GNW tables,
scheme files, AI, the original's AI) and `npm run e2e` (Playwright: the modern menus — a local match with players joining by key press, the
pause menu, colours, teams and fast-forward with its speed and pause keys, recording a keyboard set, How to Play, Options, 1997 mode;
network games by link and by code with three machines, a dropped machine coming back, a frozen one waited
for, a round over a slow network, a pause for everybody, the lobby's chat, requests and removal; a saved arena
list that the match plays; the original menus in 1997 mode — every screen, a local match, attract mode, campaign mode). Both also run
against a production build (`E2E_URL`).
