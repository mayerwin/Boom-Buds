# Match flow, settings and scoring — Atomic Bomberman (BM95.EXE) RE spec

Scope: options/settings, player slots, the match → round lifecycle, round start, round end and
draw rules, scoring and match victory, results/victory screens, statistics, Gold Bomberman
(roulette + sparkles), campaign mode (incl. aliens), and every network-only rule difference.

Conventions
- `Vn` = VALUELST.RES id n (value as shipped in brackets). `msg n` = MESSAGES.TXT id. `snd n` =
  SOUNDLST.RES group starting at id n. Addresses are BM95.EXE virtual addresses.
- "ref frame" = 50 ms (`g_ref_frame_ms` @0046494c = 1000 / V30[20]). `dt` = real elapsed ms of
  the current rendered frame, capped at V31[150] (`g_frame_dt_ms` @00464958).
- `rand()` is the Watcom CRT LCG @0045190a: `seed = seed*0x41C64E6D + 0x3039; return (seed>>16)&0x7FFF`.
  It is seeded with `time()` in `game_init` (twice). `rand()%n` below means exactly that.
- Proposed function/global names are in `docs/re/names/match-flow.txt`. Several existing names are
  misnomers: `results_screen`@0042a3f6 is the whole match loop (`match_run`), `maybe_level_load`
  @00410b6e is `round_start`, `maybe_hud_init`@004105d2 is `timer_update_and_draw`,
  `goldman_init`@00420e39 is the gold sparkle updater, `aliens_create`@00401b5c updates one alien,
  `player_net_death`@0041de63 is the generic "kill this player" entry point.

---------------------------------------------------------------------------------------------------

## 1. Settings (options.ini)

### 1.1 Lifecycle
1. All option globals live in `.bss` (start at 0).
2. `game_init`@0041095a sets defaults from VALUELST (see table), then calls `options_defaults`
   @00406a2a which sets a few hard-coded defaults, calls `options_default_keys`@0040614a,
   then `options_load_ini`@00406238, then registers `options_save`@00405de3 as an exit
   ("deinit") handler. So options.ini is **written once, at program exit**, never on change.
3. `options_init`@00406086 (earlier in `game_init`): if options.ini cannot be opened it shows the
   memory-model menu (msg 1300/1310/1311) and sets `smallmemory`, reloads VALUELST; if it can be
   opened it calls `options_load_ini` + `valuelst_load` (so the INI is parsed twice at startup;
   harmless).

INI parser (`options_load_ini`): reads lines with fgets(256); skips lines shorter than 2 chars;
splits at the first `=` (lines without `=` — e.g. the `;Bomberman Options file.` header — are
ignored); strips at the first `\n`; key compare is **case-insensitive** (stricmp @00451df7); values
are `atoi`. Unknown keys only produce a debug-log warning. Strings (`schemefilename`, `modemdial`)
are strcpy'd verbatim (no length check). After the loop the values are clamped (table).

`options_save` writes exactly (order matters only for diffing):
```
;Bomberman Options file.
levelno=%d                 num_to_win_match=%u      enclosement_depth=%u   conveyor_speed=%u
team_play=%u               random_start=%u          stomped_bombs_detonate=%u
win_by_kills=%u            goldman=%u               schemefilename=%s      playtime=%u
assign_keyboards=%u        diseases_destroyable=%u  lost_net_revert_ai=%u  disable_game_music=%u
modemport=%u  modembaud=%u  modemirq=%u  modemdial=%s  netprotocol=%u  smallmemory=%u
keydef=%u,%u,%u   (20 lines: set 0..1, index 0..9, DirectInput scancode)
```
(one `key=value` per line, in the order listed).

### 1.2 Fields
| key | global | default (source) | clamp on load | meaning / allowed values | used by |
|---|---|---|---|---|---|
| levelno | 00464998 | 0 (hardcoded in options_defaults; shipped INI has -1) | <-1→-1; ≥V35[11]→V35-1 | -1 = "Random Each Game" (new random level **every round**), 0..10 = level (msg 150+n) | round_start, attract |
| num_to_win_match | 00464a7c | V310[2] | <1→1 (no upper clamp) | wins (or kills) needed to win the match; level-select screen limits 1..100 | match_run |
| enclosement_depth | 00464974 | V27[1] | 0..V28[4]-1 | 0 None, 1 "A Little", 2 "A Lot", 3 "All the way!" (msg 315+n); number of closing rings = depth*2 | map (FUN_00426818) |
| conveyor_speed | 00464930 | 1 (hardcoded) | 0..V189[3]-1 | 0 Low,1 Medium,2 High (msg 295+n); speed = V(190+n) [250/350/450] | player, bombs |
| team_play | 00464964 | 0 (bss) | bool | two teams; forces win_by_kills=0 | many |
| random_start | 00464ae8 | V40[1] | bool | shuffle start positions once per match (and per campaign stage) | match_setup |
| stomped_bombs_detonate | 00464940 | V46[1] | bool | closing wall detonates (1) or destroys (0) bombs | map |
| win_by_kills | 0046497c | 0 | bool; forced 0 if team_play | match decided by kill total | match_run, kill accounting |
| goldman | 004648bc | 0 | bool | Gold Bomberman roulette + bonus (local games only) | match_setup, round init |
| schemefilename | 004648c4 | "BASIC.SCH" (strupr'd) | – | scheme file (extension is replaced by .SCH on load) | scheme_parse |
| playtime | 00464948 | V100[150] | <60→60; >600 and ≠1001→600 | seconds per round; UI choices 60,90,120,150,180,240,300,600,1001(=Infinite) | round_start/timer |
| assign_keyboards | 00464968 | V14[1] | bool | auto-assign KEY 0 when filling empty slots | slots_assign_default_inputs |
| diseases_destroyable | 00464990 | V120[1] | **not normalised** | 0: a disease powerup destroyed by a flame is re-placed elsewhere (FUN_004255b2(2)) | bombs, flames |
| lost_net_revert_ai | 00464928 | 0 | not normalised | lost NET player becomes AI (server) instead of OFF | slot_net_player_lost |
| disable_game_music | 004648c0 | 0 | not normalised | no level tune (music stopped) during rounds | round_start |
| modemport/modembaud/modemirq/modemdial | 00464970/0046482c/004648b8/00464830 | 2 / 19200 / 3 / "555-1212" | – | modem settings (irrelevant) | net |
| netprotocol | 00464828 | 0 | 0..3 | default protocol (irrelevant) | net |
| smallmemory | 00464824 | 0 (or menu) | bool | low-memory model: after each valuelst_load forces V7=V9, V105=1 (only death anim #1), V330=1, V3=1, V4=0 | valuelst_load |
| keydef=s,i,code | 004645bc[s*10+i] | set0: 200,205,208,203,57,28 (up,right,down,left,action1=space,action2=enter); set1: 19,34,33,32,31,30 (R,G,F,D,S,A — A becomes Q(16) for keyboard type 1) | s∈[0,2), i∈[0,10) | DirectInput scancodes (input agent) | input |

Other values copied at startup (not in the INI): `g_diseases_time_limited`=V121, `will_recycle`=V122,
`multiply`=V123, `curable`=V124, `cure_chance`=max(V125,1) (only meaningful if V125≥2).
`playtime` is also pushed into the round timer (`timer_set_playtime`) after loading and when the
settings screen is left.

### 1.3 Settings screen (`settings_screen`@004080dc, main menu "Options")
18 rows (row 18 "Adjust Audio" exists in code but is unreachable: row count is 0x12).
Up/Down move the cursor (wrap). Enter / Space / Right = "next", Left = "previous" (for booleans
both toggle). ESC leaves (then `timer_set_playtime(playtime)`). F1 help. Row actions:
0 team_play toggle (also `g_gold_id=-1`; turning it on sets win_by_kills=0) · 1 random_start ·
2 node name dialog · 3 conveyor +1/-1 (wrap 0..2) · 4 stomped toggle · 5 win_by_kills toggle
(immediately forced back to 0 if team_play) · 6 goldman toggle (also `g_gold_id=-1`) ·
7 enclosement +1/-1 (wrap 0..3) · 8 scheme chooser · 9 playtime next/prev
(`options_cycle_playtime`: 60→90→120→150→180→240→300→600→1001→60, reverse for prev; a value not in
the list resets to V100) · 10 assign_keyboards · 11 diseases_destroyable · 12 lost_net_revert_ai ·
13 disable_game_music · 14 modem dialog · 15 keyboard layouts · 16 default protocol ·
17 memory model. Display strings: booleans use msg 25/26 (" No "/" Yes "), playtime
"Infinite"/"%u:%02u".

### 1.4 Level-select screen (`level_select_screen`@00406dde) — once per match
Skipped entirely in campaign mode. Background = random glue. Works on copies of
`levelno`/`num_to_win`, committed on Enter/Space (after the minimum screen wait, §3.4) or on the
injected key 0x385/0x386 from the server; ESC aborts the match (`g_match_state=2`, `g_gold_id=-1`).
Row 0 (level): Left = -1 (below -1 wraps to V35-1), Right = +1 (≥V35 wraps to -1); text
`msg(150+level)` (msg 149 "Random Each Game" for -1). Row 1: Left/Right ±1, Ctrl-Left (0x173) /
Ctrl-Right (0x174) ±5, clamped 1..100; text `"%u %s to win match"` with msg 208 "Wins" or 209
"Kills" (win_by_kills). Clients cannot change anything (error sound snd 40); the server pushes
both values on every change. A level preview (`options_level_preview`) is redrawn on change.

### 1.5 How settings reach the game
- Local game: gameplay code reads the globals directly at the moment of use (conveyor speed when
  moving on a belt, enclosement depth when the hurry starts, stomped flag when a wall lands, team
  play at round init, playtime at round start, etc.). Settings cannot change during a match.
- VALUELST is reloaded (`valuelst_load`) when "Start Game" is chosen, then the scheme is parsed
  (scheme `-P` bornwith/override entries overwrite V50+i / V400+i in memory, see §4.1) — so scheme
  edits never leak into the next match.
- Network: on hosting/joining, `net_save_local_settings`@0040ff57 saves 8 settings
  (win_by_kills, stomped, conveyor, team_play, enclosement, playtime, diseases_destroyable,
  lost_net_revert_ai) and they are restored when the session ends (`net_restore_local_settings`).
  The host additionally forces `diseases_destroyable=1` and `g_gold_id=-1`. The host sends its
  values of those 8 settings, levelno + num_to_win (level select), the parsed scheme, the start
  positions after shuffling (msg 0x35), the chosen level of each round (msg 0x38, sent after a
  1 s network pump) and 79 VALUELST entries (table @0045b7d4: 10 20 25 31 41 42 43 50–64 90 91 101 102
  120–125 129–138 190–192 300 301 450–460 550–564 665 667 670 671 680 681). Clients use the
  host's values; goldman and random_start of clients are irrelevant (no roulette; positions are
  sent).

---------------------------------------------------------------------------------------------------

## 2. Player slots

### 2.1 Player record (10 × 0x98 bytes @00461bc4; slot i = "Player i+1")
Only fields relevant to this topic (others: see player doc).
| off | type | meaning |
|---|---|---|
| +0x00 | int | **alive**: 1 from spawn until the death animation has finished |
| +0x04 | int | death animation number 1..V105 (`die green %d`), 9 = angel (rises V106 px/ref frame) |
| +0x08 | int | **dying** (death animation running) |
| +0x10 | u8 | input type: 0 OFF, 1 AI, 2 KEY, 3 JOY, 4 NET |
| +0x11 | u8 | input index (KEY 0..1 = keydef set, JOY n) |
| +0x14/+0x18 | int | spawn pixel x/y (from start cell) |
| +0x1c/+0x20 | int | current pixel x/y (anchor: x = 40*cx+40, y = 36*cy+103) |
| +0x2c | i16 | facing (0 N,1 E,2 S,3 W); 2 at round init |
| +0x30/+0x32 | i16 | animation frame / ms accumulator (death frame counter) |
| +0x3c | u8 | **draw colour (remap)**: slot index; in team play 0 (team 0) or 2 (team 1) |
| +0x3e | i16 | player index (owner id written into bombs/flames) |
| +0x4a | i16 | fuse length = V41 |
| +0x54 | u8 | **team** 0/1 |
| +0x56..+0x64 | u8[15] | powerup counts (0 bomb,1 flame,2 disease,3 kick,4 skate,5 punch,6 grab,7 spooge,8 goldflame,9 trigger,10 jelly,11 superbad,12 random,13 clog,14 unused) |
| +0x66 | i16 | invulnerability ms (kills ignored while >0) |
| +0x68 | u8 | **lives** = pending spawns (1 at round init) |
| +0x6a | i16 | **score** (round wins; campaign points) |
| +0x6c | i16 | **kills** |
| +0x70 | int | speed = V42 |
| +0x92 | u8 | "start area cleared" flag (0 → clear on next frame) |

### 2.2 Input types and the controller-setup screen (inside `match_setup`)
Types: OFF, AI, KEY n (n = 0,1 → keydef set; displayed **"KEY 0"/"KEY 1"**, zero-based), JOY n
(only joysticks that are present; displayed "JOY n", zero-based), NET (remote player; shown only
in net games). Row label `"Player %u: %s"` (i+1).

`slot_cycle_input`@00421e80 (Right arrow): OFF→AI→KEY0→KEY1→JOY0→JOY1…→(first missing joystick)→OFF.
AI is skipped (OFF→KEY0) on a net client and in campaign mode. NET slots cannot be changed
(Left/Right give error snd 40).

Keys on the controller-setup screen (any key also plays snd 20 "letter1"):
| key | effect |
|---|---|
| Up/Down | cursor (wraps 0..9) |
| Right | cycle input (not NET) |
| Left | set OFF (not NET) |
| `0`, `O`, `o` | set OFF — **no NET check** (server can switch a NET player off); clients: error |
| `T`/`t` | toggle team of the slot (`team = team==0 ? 1 : 0`); refused (error) if slot OFF or on a client; server sends it |
| Ctrl-A (0x01) | all 10 slots = AI 0 (local games only) |
| `C`/`c` | campaign counter++; on the 5th press (cumulative within this visit, local games only) → campaign selection (§9) |
| Enter, Space | start (after minimum wait, §3.4); clients: error |
| 0x385 | start (injected by the server on clients) |
| ESC | abort match (`g_match_state=2`, `g_gold_id=-1`, snd 10) |
| F1 / Alt-D | help / debug info (not on clients) |

Start validation (local/server): if two non-NET non-AI slots use the same KEY n or JOY n →
msg 45 "More than one player selected to an input device!" (clients silently resolve conflicts by
switching duplicates OFF). Then, unless campaign mode: `slots_count_sides()` < 2 → msg 46 "Must
have at least two players selected!" (team play: msg 48 "Must have at least one player on each
team!"). `slots_count_sides` = number of non-OFF slots, or number of distinct teams among them.

Default assignment `slots_assign_default_inputs`@0042123f (at program start and when hosting):
```
keyb_done = (assign_keyboards == 0); j = 0
for slot 0..9: if type==OFF:
    if joystick j present: type=JOY, index=j
    elif !keyb_done: keyb_done=1; type=KEY; index=0
    elif slot==1: type=AI
    j++
```
→ no joysticks: Player 1 = KEY 0, Player 2 = AI. Slot settings otherwise persist across matches
(non-net games turn NET slots OFF at match setup). AI personalities are re-rolled per match
(`FUN_0040a140`, rand()%V900).

### 2.3 Teams
- Team byte +0x54 is **taken from the scheme at every match setup**: `scheme_parse` ends with
  `team[i] = scheme_start[i].team` (4th field of `-S,p,x,y,team`; schemes with 3-field `-S` lines
  keep the default `i & 1`). BASIC.SCH and most "(10)" schemes: alternating (Players 1,3,5,7,9 =
  team 0; 2,4,6,8,10 = team 1). "(5)(5)" schemes (WALLYBOM, N_VS_S, E_VS_W, BACK, …): Players 1–5
  team 0, 6–10 team 1. `you_init` also initialises `team=i&1`.
- `T` toggles afterwards; because scheme_load runs before the controller screen of every match,
  manual toggles are lost at the next match.
- "TEAM" label (msg 230) drawn right of each row (x = V710.x + V710.w) in the team colour when
  team play is on.

### 2.4 Colours
- Slot i uses remap i (`i.RMP`, built from V(200+5i), V(201+5i), V(202+5i) RGB percent):
  0 white, 1 black, 2 red, 3 blue, 4 green, 5 yellow, 6 cyan, 7 magenta, 8 orange, 9 purple.
- Team play: draw colour +0x3c = 0 (white) for team 0, 2 (red) for team 1. For the first
  `g_round_teamcolor_delay_ms` = V32[40] × 50 = **2000 ms** of each round players are drawn in
  their true slot colour, afterwards in team colour (bombs always use +0x3c → team colour).
- Text colours (`FUN_0041672f`/`FUN_00416867`): non-team = the slot's remap RGB looked up in the
  palette, on black background except Player 2 (black) which gets a white background; team =
  white (team 0) / red (team 1) on black.

---------------------------------------------------------------------------------------------------

## 3. Match lifecycle

### 3.1 Main menu → match
`main_menu`@0042b9ce item 0 "Start Game": `valuelst_load(); match_run();`. Net host/join screens
end in `match_run()` as well. Attract mode: after V92[30] s without input (only if V92>5) or Alt-A
(0x11e): stats[15]++, `g_attract_mode=1`, slots + team_play + levelno saved, team_play=0, then
`match_run()`; restored when the main menu is re-entered.

### 3.2 `match_run`@0042a3f6 (pseudo-code, faithful order)
```
g_campaign_mode = 0                 // campaign must be re-activated every match
game_frame_set_paused(1)
100 x net_send_critical()
tunes_play_id(1020)                 // "win" tune = input-selection music
match_setup()                        // §3.3
if g_match_state != 0: return
round_start()                        // §4
register game_frame (0x42a191) as the per-frame GNW callback
game_frame_set_paused(0); g_last_frame_time = now(); g_intergame_nowait = 0
do {
  g_forced_draw = 0
  key = gnw_get_key()                // also runs one game_frame
  switch key:
    0x01 Ctrl-A: if debug(KWD) dump anim list
    0x04 Ctrl-D: debug-log output switch (no gameplay effect)
    0x0D Enter, 0x1B ESC: only in attract mode -> g_gold_id=-1, g_match_state=2
    0x11 Ctrl-Q: g_gold_id=-1, g_match_state=2          (ESC does NOT quit a real game)
    0x12 Ctrl-R: if debug: debug overlay
    0x111 Alt-W: g_intergame_nowait=1
    0x120 Alt-D: info screen;  0x131 Alt-N: net stats dump
    0x13B F1: if local game: pause, help, unpause
    0x144 F10: if debug && campaign: g_campaign_stage_status=1
               if net_mode != client: g_forced_draw=1; broadcast (msg 0x26)
  if round_alive_count() <= 1: timer_stop()          // §5.3
  if campaign:
     if g_campaign_stage_status != 0:
        pause; if status==2: msgbox "Oh Well!" / "Campaign unsuccessful!"
        round_start(); unpause
     continue
  if !g_forced_draw && g_round_ingame_count > 1 && !round_time_up(): continue
  if attract: break to exit (no end screens)
  -------- round over --------
  tunes_play_id(1130)                // "draw" tune, played for every round end
  pause
  name = "Error..."; w = round_get_winner(&name)
  if w == -1: show DRAW.PCX ("draw"), voice snd 1700, wait_screen(0x388)   // §6.5, §3.4
  if state==0:
     background RESULTS ("results.plt"); winner = -1
     if !g_forced_draw: print "Game Winner was %s !" (msg 30) ; player_award_points(1)
     list scores, determine match winner                                      // §7
     if winner == -1: print msg 120/121 "(Match winner must score %u victories/kills)"
     else:
        g_gold_id = (local && goldman) ? (team_play ? (team_of_player[winner]==0 ? 0 : 2) : winner) : -1
        voice snd 2000; sleep 1500 ms
        print win_by_kills ? "PLAYER %u WINS THE MATCH!" (winner+1) : "%s WINS THE MATCH!" (name)
     wait_screen(0x387)
     if state==0:
        if winner == -1:
           if sides_listed < 2: msgbox "NOTE!" "Too many players have left the game!"; state=2
           else: round_start(); unpause
        else:
           show team_play ? TEAM<winner>.PCX : VICTORY<winner>.PCX ; sleep 3000 ms; state = 1
} while g_match_state == 0
net end message; 10 x (net_send_critical; sleep 100)
unregister game_frame; timer_stop()
```
`g_match_state` @00464a68: 0 running, 1 match won, 2 aborted, 10 campaign finished.

### 3.3 `match_setup`@00410f81
```
g_match_state = 0; audio-cache housekeeping
scheme_load()                 // parse g_opt_schemefilename (clients: receive from host)
if !attract && goldman && net_mode==local: goldman_roulette()   (returns early if g_gold_id==-1)
   if g_match_state != 0: return
stats[0]++  (Matches Started)
if local game: NET slots -> OFF
(net session start handling: host assigns defaults & sends slots/teams; client waits)
match_reset_scores_and_shuffle()     // score=kills=0 for all 10; random_start shuffle (§4.2)
AI personalities re-rolled
graf_show_random_glue()              // GLUE<rand()%V16[7]>, background of the next screen
if attract:
   all slots OFF; n = rand()%10 + 1; if n<3: n=3; slots 0..n-1 = AI
   g_opt_levelno = rand() % max(V35,1)     // NOTE: ignores the V1150.. random-level mask
   return
controller-setup screen (§2.2)
if state==0: host sends start positions; level_select_screen()
campaign: g_campaign_stage_index = -1
```

### 3.4 Common screen-wait rules
"Minimum wait" = `screen_min_wait_seconds()`: 1 s local, V13[3] s in net games. Enter/Space/mouse
click (key -2) are ignored until `now > t_enter + minwait*1000`. On the draw and results screens,
if **no slot is human** (all OFF/AI, `slots_no_humans`) or Alt-W was pressed this match, the screen
auto-advances 6000 ms after it appeared. Net clients cannot advance (error sound); they advance
when the server injects 0x385 (controller setup) / 0x386 (level select) / 0x388 (draw) / 0x387
(results). ESC on draw/results screens aborts the match.

---------------------------------------------------------------------------------------------------

## 4. Round start (`round_start` = maybe_level_load @00410b6e)

```
game_frame_set_paused(1)
campaign_next_stage()                 // campaign only (§9); may set g_match_state=10
if g_match_state == 10: return
if net client: wait until server sent g_cur_level (ESC -> abort)
else:
   if g_opt_levelno < 0:
      repeat up to 200 times: g_cur_level = rand() % max(V35,1); if V(1150+g_cur_level) != 0: break
      // shipped mask: 1152 (Hockey Rink, ice) and 1156 (Aliens) = 0 -> never chosen randomly.
      // If all 200 tries fail, the last roll is used. V1161 (a 12th level) is never consulted.
   else g_cur_level = g_opt_levelno
   if server: pump the network for 1 s (10 x 100 ms), then send the level (msg 0x38)
stats[1]++ (Games Started = rounds)
build the field from the scheme rows (map agent), load field<g_cur_level>.plt, draw, flip
reset bombs, flames, powerups
players_round_init()                  // §4.3
power_place_round()                   // hidden powerups (V400+i / scheme override; net: no "random")
extras setup (trampolines skipped in net), campaign_stage_setup()
g_hurry_sound_played = 0
net data sync (server "Sending data to clients" / clients wait)
music: disable_game_music ? stop music : tunes_play_wave_tune()   // level tune snd 1100+level,
                                                                 // generic 1120 fallback (audio doc)
timer_set_playtime(playtime); timer_reset(); timer_start()
```
The level/tile/powerup layout is regenerated **every round**; the scheme and start positions are
fixed for the whole match.

### 4.1 Scheme and start positions (`scheme_parse`@00403eee, once per match)
1. `start[i] = (V(600+2i), V(601+2i))`, wrapped: `while x<0: x+=15; while x>=15: x-=15` (same
   with 11 for y). Defaults: P1 (0,0), P2 (14,10), P3 (0,10), P4 (14,0), P5 (6,4), P6 (8,0),
   P7 (12,4), P8 (2,6), P9 (10,8), P10 (6,10) — identical to BASIC.SCH.
2. `scheme_basic_grid`: default rows, density 90, scheme starts = same table with team = i&1,
   powerup tables cleared.
3. File `-S,p,x,y[,team]` (3 or 4 fields, p in 0..9): x<0 → add 15 repeatedly; x>15 → 14
   (x==15 is not clamped here, but round init clamps again); same for y; stores start[p] and
   scheme_start[p] (team only if 4 fields). Malformed → msg 751 warning.
4. `-P,n,bornwith,has_override,override,forbidden` (n 0..12): after parsing, for each n:
   `if bornwith>0: V(50+n) = bornwith` (in-memory VALUELST); `if has_override: V(400+n) = override`.
   `forbidden` excludes n from the "random" powerup re-roll.
5. Teams copied from scheme_start (§2.3).

### 4.2 Random start (`match_reset_scores_and_shuffle`@00421793)
Once per match (before the controller screen) and once per campaign stage:
```
for k in 0..199: a = rand()%10; b = rand()%10; if a != b: swap(start[a], start[b])   // x and y together
```
All 10 entries are shuffled (also those of OFF slots). Same positions are used for every round of
the match.

### 4.3 `players_round_init`@004214bc (all 10 records, also OFF slots)
```
clear per-player bomb lists
for i in 0..9:
  alive=0
  x = start_x[i]; while x<0: x+=15; if x>=15: x=14      (y: 11 / 10)
  spawn_px = (40*x + 40, 36*y + 103)                     // field origin (20,68), cell 40x36
  +0x92=0; +0x55=0; +0x4e=0; +0x50=0; facing=2 (south); +0x66 invuln=0; lives=1
  colour(+0x3c) = team_play ? (team==0 ? 0 : 2) : i ;  owner id(+0x3e) = i
  fuse = V41; speed = V42
  for n in 0..14: count[n] = V(50+n)          // V50=1 bomb, V51=2 flame, rest 0 (+ scheme bornwith)
  +0x65 = 0
  if goldman && 0 <= g_roulette_result < 15 &&
     (team_play ? (team==0?0:2) : i) == g_gold_id:  count[g_roulette_result] += 1
  clear diseases (FUN_0041df4c)
g_round_control_delay_ms  = V30 * g_ref_frame_ms = 1000
g_round_teamcolor_delay_ms = V32 * g_ref_frame_ms = 2000
```
Counts are not clamped to the V550+ limits here.

### 4.4 Spawn and start-area clearing (first frame, in `player_update_anim`)
For every non-OFF slot on its first processed frame: if `+0x92==0` → set 1 and
`clear_start_area(cx,cy)`: the spawn cell and each of its 4 neighbours (N,E,S,W) that is not
solid are cleared to blank; a hidden powerup in a cleared cell is moved to a random brick cell
without powerup (200 tries of `(rand()%15, rand()%11)`; if none is found the powerup record stays
in the now blank cell). Then, because
`alive==0 && lives>0`: `lives--, alive=1, dying=0, pos=spawn`. (OFF slots never spawn and their
start areas are not cleared.)

### 4.5 "Get ready" delay
No text is shown. Each frame `g_round_control_delay_ms -= dt` (clamped ≥0). While it is >0 neither
`you_getinput` nor `ai_think` runs, i.e. **players cannot act for the first 1000 ms** (the world,
timer and music already run). The first frame of a round uses a stale dt (capped to 150 ms).

### 4.6 Glue screens
`graf_show_random_glue` loads `glue<rand()%V16>.plt` (GLUE0–GLUE6) as the background of menu-type
screens: the controller-setup screen, the level-select screen, the settings screen and the net
screens. There is no glue/loading screen between rounds.

---------------------------------------------------------------------------------------------------

## 5. During a round

### 5.1 Frame order (`game_frame`, LAB_0042a191)
```
if paused: return
dt = now - g_last_frame_time; g_last_frame_time = now; if dt > V31: dt = V31
net client lost server -> state=2 + "server bailed out" box
net receive; g_frame_counter++
timer_update_and_draw()        // §5.2
lock; clip; extras; bombs pass 0; powerups; sound; flames; map (regeneration, enclosement)
players_update_all()           // §5.3 (+ gold sparkles)
if campaign: campaign_update() // §9
bombs pass 1
HURRY: rem = timer_get_remaining_s(); if rem < V101 && rem > V101-5:
          if !g_hurry_sound_played: play snd 2700 once
          if (g_frame_counter & 4): draw sprite "hurry" at (320,240)      // per rendered frame
debug text, unlock, net, sound, flip, net_send_critical
```
The round-over test (§6) is done by `match_run` after each frame.

### 5.2 Round timer (`timer_*`, @00410465–@004105d2)
- Wall-clock based: while running, `elapsed_ms += now - last` every frame (not capped by V31,
  and it keeps counting through pauses such as the in-game F1 help).
- `remaining_s = max(0, (playtime*1000 - elapsed_ms) / 1000)` (C truncation), `elapsed_s =
  playtime - remaining_s`. Clients take remaining from the server (sent when it changes).
- Display at (V110,V111)=(525,36) as "M:SS" with the "numeric font" sequence (digit spacing
  +V112); colour switches to red when remaining < 31; playtime 1001 → "infinity" sprite and
  `remaining` reported as 1001.
- Started in round_start, **stopped (never restarted that round) as soon as
  `round_alive_count() <= 1`**.
- Hurry/enclosement (map agent has the details): HURRY flashes and snd 2700 plays while
  56 ≤ remaining ≤ 59; the closing walls start when remaining ≤ V101-5 = 55 and place one block
  every 250 ms (wall clock), clockwise rings, `enclosement_depth*2` rings. At the hurry start
  warps and trampolines are removed (FUN_00405d0c). None of this happens with Infinite time.

### 5.3 Per-frame alive bookkeeping (`players_update_all`@00420f07 + `player_update_anim`)
```
control_delay -= dt; teamcolor_delay -= dt (both >= 0)
work counters = 0
for i in 0..9: player_update_anim(p[i])  and gold sparkles (§8.3) and HUD "S:%d K:%d"
inside player_update_anim(p):
   if p.input == OFF: return
   (first-frame clearing / spawn, §4.4; campaign respawn rule, §9.4)
   if !p.alive && p.lives == 0: return                 // out of the round
   ingame: non-team -> cnt_ingame++ ; team -> count each team once
   if p.dying:
       advance death anim (1 state per 50 ms of dt; anim #9 also moves up V106 px/50ms and ends
       when y < -20); when it ends: drop powerups, alive=0, dying=0, the player's remaining
       trigger bombs become normal bombs with a restarted fuse (FUN_00424c47)
       at death-anim state 25: 1-in-max(V95,1) chance of a taunt (snd 700)
       if death_frame >= V25[20]: return               // no longer counted as alive
       cnt_alive++ ; team_alive[team]++ ; return
   cnt_alive++ ; team_alive[team]++ ; ... normal update
after loop:
   g_round_ingame_count = cnt_ingame     // alive flag set (incl. whole death animation)
   g_round_alive_count  = cnt_alive      // alive, or dying for fewer than V25 death frames
   g_round_alive_teams  = (team_alive[0]>0) + (team_alive[1]>0)
round_alive_count() = campaign ? 2 : (team_play ? g_round_alive_teams : g_round_alive_count)
```
While `round_alive_count() < 2` (outside campaign): the round timer is stopped, **bomb fuses do
not advance and no bomb explodes** (maybe_bomb_update), tile regeneration and the closing walls
stop. Players, flames already burning, conveyors etc. keep running.

---------------------------------------------------------------------------------------------------

## 6. Round end

### 6.1 Condition (checked in `match_run` after every frame, non-campaign)
The round ends when **any** of:
1. `g_forced_draw` (F10 this frame, local game or server; clients receive it), or
2. `g_round_ingame_count <= 1` (at most one player — or one team — still has the alive flag), or
3. `round_time_up()`: playtime ≠ 1001 and remaining < 1 (clients: server's remaining < 1).

In attract mode the match then ends immediately (no screens).

### 6.2 Winner (`round_get_winner`@004219b0)
```
if round_time_up(): return -1 ("undetermined")
for i in 0..9 (slot order):
   if input != OFF && (lives != 0 || alive) && !dying:
       name = team_play ? "Team %u"(team+1) : "Player %u"(i+1)
       return team_play ? team : i
return -1 ("undetermined")
```
Consequences:
- **Last player standing wins** only if he is alive and not dying at the moment the round ends
  (the round ends one frame after the second-to-last player's death animation has completed).
- **Draw** if: time ran out; everybody is dead; or every remaining player is still in a death
  animation when the round ends — i.e. if the "survivor" starts dying at any time before the
  previous victim's death animation (12–93 states × 50 ms depending on anim 1..24) finishes.
- **Team play**: round continues while ≥2 teams have members with the alive flag; the winner is the
  team of the lowest-numbered qualifying player (the only team left).
- **F10 forced draw**: the round ends immediately; the DRAW picture is only shown if nobody
  qualifies (normally the first living player "qualifies", so the results screen comes directly);
  no "Game Winner" line and **no points** are awarded. Kills made in the round still count (and can
  decide a kills-mode match).

### 6.3 Time limit
Time running out does both: at 59..56 s HURRY + walls (from 55 s); when the clock reaches 0:00
(about playtime − 1 s of running clock) the round **ends immediately as a draw** with no points,
even if only one player is alive — unless the clock was already frozen because fewer than 2
players were counted alive. Infinite playtime: no hurry, no walls, never times out.

### 6.4 "Out-survive" window (V25 "how many frames do you have to out-survive the other guy")
After a death starts, the victim still counts as alive for V25 = 20 death-animation states
(20 × 50 ms = **1 s**). During that second everything continues normally (timer, fuses, walls),
so a second death within it makes the round a draw. After it, if only one player (team) is
counted alive the world freezes as described in §5.3 (no more explosions), so the survivor can
only still die by walking into flames that are already burning; any such death before the
victim's death animation completes still produces a draw. The round ends when the victim's death
animation is over (one frame later).

Death animation lengths (states of `die green N`, 50 ms each; from DATA\ANI): 1:83 2:62 3:63 4:93
5:17 6:79 7:14 8:12 9:28 (angel, ends earlier once y < -20) 10:77 11:36 12:63 13:75 14:36 15:35
16:69 17:63 18:85 19:48 20:20 21:59 22:54 23:41 24:75. So the "deciding death → round over" delay
is 0.6–4.65 s depending on the randomly chosen animation (anim = rand()%24+1). Animations shorter
than 20 states end before the out-survive window would have elapsed.

### 6.5 End-of-round screens and timings (see §3.2 for the exact order)
1. Music snd/tune 1130 ("draw") for every round end; game frame paused (field frozen).
2. Draw: DRAW.PCX full screen, announcer group snd 1700, wait (min 1 s / 3 s net; auto 6 s if no
   humans or Alt-W).
3. Results (shown after **every** round, draws included): background RESULTS.PCX; texts
   (graf_print(window, text, width, x, y, fg, bg)):
   - "Game Winner was %s !" at V780 (x 150, y 140, w 400), white on black (omitted after F10);
     `%s` = "Player n" / "Team n" / "undetermined" (msg 32) for a draw.
   - per active slot i (non-team): "Player %u score: %u (kills: %d)" (i+1, score, kills) at
     x 150, y 210 + i*20 (V785; inactive slots leave gaps), slot text colours.
   - team play: per team t with ≥1 active member: "Team %u score: %u" (t+1, score of the team's
     first active member) at y 210 + t*20, white/red.
   - no match winner: msg 120 "(Match winner must score %u victories)" / msg 121 "...kills)"
     (num_to_win) at V800 (150, 94), grey.
   - match winner: announcer snd 2000, sleep 1500 ms, then "%s WINS THE MATCH!" (round-winner name)
     or, in kills mode, "PLAYER %u WINS THE MATCH!" (winner+1) at (150, 94) in cyan.
   Wait as in 2.
4. Match won: VICTORY<slot>.PCX (non-team; 0 white … 9 purple, same order as the remaps) or
   TEAM<t>.PCX (TEAM0 = white team wins, TEAM1 = red team wins), sleep 3000 ms, back to the
   main menu. Otherwise: next round (`round_start`).

---------------------------------------------------------------------------------------------------

## 7. Scoring

### 7.1 Round points (`player_award_points`@00421b56, called with 1)
If `round_time_up()` → nothing. Else find the first qualifying player (same test as §6.2):
`score += 1`; in team play the winner's new score is **copied** (assigned) to every other non-OFF
slot of the same team. No points on a draw or after F10. Score and kills reset to 0 at every match
start (§3.3).

### 7.2 Kills (`player_start_death`@0041dcb2; victim, killer)
Called through `player_die`@0041de63 (picks death anim `rand()%max(V105,1)+1`; ignores NET
players and players in special states 5/6/7). Nothing happens if the victim is invulnerable
(+0x66>0) or already dying. Otherwise:
```
stats[5]++ ; if victim is AI: stats[6]++
if 0 <= killer < 10:
    if killer == victim: if !win_by_kills: kills[killer] -= 1        // suicide
    else: kills[killer] += 1 ;  if campaign && victim is AI: score[killer] += V1300[250]
    (net: broadcast)
if carrying a bomb (+0x94): that bomb is deleted (its active flag cleared; net msg)
snd 300 (scream); death-anim sound snd (340 + anim); dying=1; death frame=0
```
- killer = owner of the flame in the victim's cell (flame +0x3e). Deaths by the closing walls or
  by campaign aliens pass killer = -1 → no credit, no penalty.
- **Team kills count +1** (no team check).
- Suicide −1 only when win_by_kills is **off** (contrary to the help text, see quirks). Kills can
  go negative.

### 7.3 Match winner (results screen)
```
maxk = max over all 10 slots of kills; nmax = #slots with kills == maxk   (OFF slots included!)
non-team: for each non-OFF slot i (ascending):
    win_by_kills ? (maxk >= N && nmax == 1 && kills[i] == maxk) : (score[i] >= N)  -> winner = i
team:     for t in 0..1: first non-OFF slot p with team t: if score[p] >= N -> winner = t
```
N = num_to_win_match. Ties in kills mode → no winner, play another round. Only one player/team can
reach N wins in a round, so wins mode never ties.

### 7.4 HUD
Per active slot "S:%d K:%d" (score, kills) at x = V(115 + i/2), y = V(113 + (i&1)), width 90
(HUD doc). Same fields are used in campaign mode (score = points).

### 7.5 Statistics (`stats_load`@00402150 / `stats_save`@0040200c)
`bmstats.dat` = 100 little-endian int32 totals; on exit `total[k] += session[k]` and the file is
rewritten; `bmstats.txt` lists msg 900/905 headers and 19 lines `"%s:"` (msg 910+k) with total and
session values. Session counters @0046429c: 0 Matches Started (match_setup), 1 Games Started
(each round), 2 Frames Rendered, 3 Graphic Requests, 4 Bombs Dropped, 5 Player Deaths (all),
6 Local AI Player Deaths, 7 Bricks Destroyed, 8 Pixel Distances Run, 9 Net Games Hosted,
10 Net Games Joined, 11–14 net bytes/packets in/out, 15 Attract Modes Started, 16 Retransmits,
17/18 Ghost Bomb Actions Found/Lost. Purely informational.

---------------------------------------------------------------------------------------------------

## 8. Gold Bomberman (local games only)

### 8.1 Who is gold
At the end of a won match (local game, goldman on): `g_gold_id` = winning slot index; in team play
`team_of_player[winning_team_index] == 0 ? 0 : 2` (compared with the team colour of players —
note the bug in §12). Net games, goldman off, ESC/Ctrl-Q aborts and toggling team play or goldman
in the settings set `g_gold_id = -1`. Gold stays for the whole next match.

### 8.2 Roulette (`goldman_roulette`@004034bc), at the next match setup
Only if goldman && `g_gold_id != -1` (and not attract, not net). Background ROULETTE.PCX
("roulette.plt"). Positions on a 420-step circle (`R6 = V1004[70]*6 = 420`, sector = 70):
```
result = -1; dir = (rand()%2)*2 - 1
wheel = rand()%420; ptr = rand()%420
cw = rand()%20 + 20; cp = rand()%20 + cw          // per-frame step counts and stop counters
state = 0 (spinning)
each rendered frame:
  if cp > 0: repeat max(6,cp) times: ptr += dir (wrap 0..419);
             if ptr % 70 == 0: snd 1300 (tick); if state==1: cp--; if cp==0: stop stepping
  if cw > 0: repeat max(6,cw) times: wheel -= dir (wrap);
             if wheel % 70 == 0 && state==1: cw--; if cw==0: stop stepping
  draw 6 icons "power <name>" for types T = {0 bomb, 1 flame, 3 kick, 8 goldflame, 4 skate, 13 clog}
       icon k at pos = wheel + 70k
  draw "ring" sprite at pos = ptr
  pos -> x = trunc(cos(pos*V1006*2π/420)*V1002 + V1000) = trunc(cos(..)*200+320)
         y = trunc(sin(pos*V1007*2π/420)*V1003 + V1001) = trunc(sin(..)*150+240)   (π = 3.1415926)
  if state==2: centered texts at x 320: msg 790 "The Gold Player has" (y 220),
               msg 800+result (y 240), msg 791 "for the next match!!" (y 260), white
  if cw==0 && cp==0 && result==-1:
       sector = ((ptr < wheel ? ptr+420 : ptr) - wheel) / 70 ; result = T[sector]
       snd (result==13 ? 1320 : 1310); state = 2
  keys: Enter/Space: state 0 -> 1 (start braking); state 2 -> leave
        ESC: g_gold_id=-1, g_match_state=2 (match aborted)      F1: help
```
Speeds are in steps per **rendered frame** (not time-scaled). Both stop exactly on multiples of
70, so the pointer always rests on an icon. Outcome texts: 800 extra bomb, 801 longer flame,
803 kick, 808 goldflame, 804 extra speed, 813 speed brake (clog; slowness = V91 per clog, player
doc).

### 8.3 Applying the result
Every round of that match, `players_round_init` gives the gold player(s) `count[result] += 1`
(team play: every player whose team colour id equals `g_gold_id`).

Sparkles ("twinkle"): in `players_update_all`, for each slot, if not attract && goldman && the
slot is gold (team play: team colour id) && alive → `goldman_spawn_sparkle(p)`:
```
find a free slot among 100 {active,x,y,frame}; none -> return
if V1010 != 0 && timer_get_elapsed_s() >= V1010[5]: return      // first 5 s of each round
if rand()%6 == 0: return
active=1; frame=0; x = p.x + rand()%40 - 20; y = p.y + rand()%50 - 48
```
`goldman_sparkles_update` (every frame, after the players): draws sequence "goldman" (13 states)
state `frame % 13` at (x,y), then, if the frame counter changed since last call, `frame++` and the
sparkle dies when `frame > 13` (so 14 frames are shown: states 0..12 then 0). Advances once per
rendered frame. V1010 = 0 would make it permanent.

---------------------------------------------------------------------------------------------------

## 9. Campaign mode

### 9.1 Activation (reachable in the shipped game, hidden)
In the controller-setup screen of a **local** game press `C` (or `c`) five times. `campaign_select`
@004015c6 lists `data/res/*.cam` (shipped: CROUTON.CAM 9 stages, GHOSTS.CAM 4, SIMPLE.CAM 4; the
error text msg 1215 wrongly mentions CAMP*.RES), the chosen file is loaded (`campaign_load`), msg
1210 "Campaign Mode Activated!", `g_campaign_mode = 1`, all AI slots → OFF. The flag is cleared at
the start of every `match_run`, so it lasts one "match". In campaign mode: AI cannot be selected,
the 2-player minimum is not enforced, the level-select screen is skipped.

### 9.2 CAM file
Lines starting with `-C` and having exactly 9 fields after it (two passes: count, then fill):
`-C,name,levelno,scheme,rovers,rover_speed,ghosts,ghost_speed,AIs,AI_difficulty`. Record (0x70):
+0x00 name, +0x34 levelno, +0x38 scheme (≤30 chars, ".SCH" appended by the parser), +0x58 rovers,
+0x5c rover speed, +0x60 ghosts, +0x64 ghost speed, +0x68 AIs, +0x6c difficulty (unused).

### 9.3 Stage progression
- `match_setup` sets stage index = -1. `round_start` → `campaign_next_stage`@0040133f:
  `valuelst_load()`; `index++`; if index < count: schemefilename = stage.scheme, levelno =
  stage.levelno, re-parse scheme (starts/teams/bornwith), msgbox msg 1230 "Prepare to begin
  Campaign!" with "(name)" (msg 1235), random_start shuffle (200 swaps). Else msgbox 1220/1225
  "Congratulations! You made it through the whole campaign!" and `g_match_state = 10` (back to the
  main menu).
- `campaign_stage_setup`@0040151b (after players_round_init): status = 0; all AI slots → OFF;
  repeat stage.AIs times: random OFF slot → AI (100 tries of rand()%10); aliens cleared;
  spawn `ghosts` ghosts (type 2, speed) then `rovers` rovers (type 1, speed).
- `campaign_update`@004016da each frame (after the players):
```
aliens_update_all()                              // g_aliens_active = live aliens
if timer_get_remaining_s() < 2: status = 2       // time out
if g_aliens_active == 0: clear_ms += dt; if clear_ms > V25*50*2 (=2000): status = 1
else clear_ms = 0
// clear_ms is also reset to 0 every time an AI player thinks -> all AIs must be dead
if no slot is (non-OFF, non-AI) with alive flag: index--, status = 2   // retry same stage
```
- `match_run` on status ≠ 0: status 2 → msgbox msg 1240/1245 "Oh Well! Campaign unsuccessful!";
  then `round_start()` (next stage, or the same stage after a death).

### 9.4 Campaign-specific rules
- `round_alive_count()` is always 2: timer never stops, bombs/walls never freeze; normal round-over
  test and results screens are not used.
- Human respawn: when a non-AI player spawns while remaining ≥ V101 (60 s), lives is set back to 1
  and he gets 1000 ms invulnerability (V25-independent: `ref_ms*20`) and his start area is cleared
  again on the next frame. (In practice see quirk 7.)
- Points (score field): killing an AI player = V1300 [250] (to the flame owner); rover = V1310 [15];
  ghost = V1320 [25]. Kills are counted as usual. No end-of-campaign score screen exists.

### 9.5 Aliens (`alien_update`@00401b5c; 100 records of 0x98 @0045e020)
- Spawn (`alien_spawn_random`): up to 200 tries `(rand()%15, rand()%11)`; accepted if the cell is
  not solid and no player record (all 10, even OFF ones, using their current pixel position
  +0x1c/+0x20 converted to a cell) is within Manhattan distance ≤ 3 of it; pixel pos = cell
  anchor; direction 0 (north); speed from the CAM file.
- Rover first frame: clears its start area like a player (§4.4). Ghosts don't.
- Movement per frame: `acc += dt*speed/50 + 100; pos -= dir_vec;` then
  `while acc > 0: pos += dir_vec; anim++; acc -= 100;` and per step: when exactly at a cell centre
  along the move axis: if the next cell is not passable → acc = 0 and turn; else 1-in-max(V1200,1)
  [3] chance to turn. Turn = `dir = (dir + (rand()%2 == 0 ? -1 : +1)) & 3` (0 N,1 E,2 S,3 W); if the new next cell is not
  passable → acc = 0. Passable (`alien_cell_passable`): no bomb, and ghost: not solid (ghosts fly
  over bricks); rover: empty. Speed unit = 1/100 px per ref frame. V1205 is unused.
- After each step: a flame in its cell kills it (dying; removed next frame) and gives points to the
  flame owner; every non-AI, non-dying player in its cell is killed (`player_die(p, -1)`; up to 11
  iterations). Aliens never hurt AI players.
- Drawn with sequences "ghost <dir>" / "rover <dir>".

---------------------------------------------------------------------------------------------------

## 10. Network-game rule differences (all explicit checks found)
`net_mode()`@0040c06a: 0 local, 1 client, 2 server.
| # | rule | where | check |
|---|---|---|---|
| 1 | No Gold Bomberman: roulette skipped, gold reset | match_setup @00410fc1; match_run (gold=-1 when net); net_host_screen | `net_mode()!=0` |
| 2 | Swap disease (#7) never given: re-rolled (≤200 tries of rand()%9) | `player_give_disease`@0041dfb6 | net && d==7 |
| 3 | Head hit by a bomb: no stun spin and no powerup loss (local: stun +0x3a=16, special anim 3, lose V670+rand()%V671 random powerups) | `player_head_hit`@00421f7e | only if net==0 |
| 4 | Random powerup (#12) count forced to 0 when placing powerups | `power_place_round`@004258e5 | net!=0 && n==12 |
| 5 | Trampolines (`T` entries of EXTRA*.RES) not created | `extra_load_res`@00404e99 | net==0 required |
| 6 | Diseases always destroyable (host forces 1, restored after the session; value pushed to clients) | `net_host_screen`@0042b0ce | – |
| 7 | **Dud bombs disabled** (V320–V324) | bomb create `FUN_00422ede` | only if net==0 |
| 8 | **No relocation of over-powerful powerups** (punch 5, grab 6, super-bad 11) during the first V102 = 40 s of a round | `power_reveal`@00425107 | only if net==0 |
| 9 | Ctrl-A (all AI), `C`×5 campaign, F1 help: local only. Clients cannot pick AI, toggle teams, use `O`, start/advance screens or change level/wins | match_setup / level select / screens | various |
| 10 | F10 forced draw: local or server only (broadcast) | match_run | net!=1 |
| 11 | Minimum screen wait 3 s (V13) instead of 1 s | `screen_min_wait_seconds` | – |
| 12 | Tile regeneration, level/powerup/extras layout and level choice are done by the server and transmitted | map/power/extra/round_start | net==1 → receive |
| 13 | Lost players: `lost_net_revert_ai` → server turns the slot into AI 0, else slot OFF and alive=0; if fewer than 2 sides remain after a round: "Too many players have left the game!" | `slot_net_player_lost`@004222e8, match_run | – |
| 14 | Level music: when the level tune is not installed on the hard disk (minimum install), net games and random-level games play the generic tune 1120 instead of fetching the level tune | `tunes_play_wave_tune` | net!=0 or levelno==-1 |
| 15 | Remote deaths in small-memory mode always use death anim 1 | `net_rx_player_death`@0041de04 | smallmemory |
NET players are never killed, given diseases/powerups or moved locally (`player_die`,
`player_give_disease`, pickup, drop-powerups and movement all skip input type 4); their state comes
from their owner. The manual's "reduced disease transmission", "no grab/throw/punch animation" and
"Ebola does not flash" have **no explicit check**: they are side effects of this ownership model
(contact infection is only applied on the victim's own machine; remote players are drawn from
position/direction/frame packets only).

---------------------------------------------------------------------------------------------------

## 11. Other globals (see names file for the full list)
`g_cur_level`@0046499c · `g_gold_id`@0046492c · `g_roulette_result`@0045e02c ·
`g_forced_draw`@00464aec · `g_intergame_nowait`@004646b4 · `g_attract_mode`@00464938 ·
`g_campaign_mode`@0046489c · `g_campaign_stage_status`@00464894 · `g_campaign_stage_index`
@004648b0 · `g_start_x/y`@0046460c/0046465c (int[10]) · `g_scheme_starts`@0046481c (10×{x,y,team})
· `g_round_ingame_count`@004621d8 · `g_round_alive_count`@004621d4 · `g_round_alive_teams`
@004621dc · `g_round_control_delay_ms`@004621e0 · `g_round_teamcolor_delay_ms`@004621e8 ·
`g_gold_sparkles`@004621cc (100×16 bytes) · timer @004601a0–@004601bc · `g_debug_kwd`@00460260 =
atoi(getenv("KWD")) enables the debug keys.

---------------------------------------------------------------------------------------------------

## 12. Bugs & quirks (replicate unless noted)
1. **Suicide penalty is inverted vs. the help**: kills −1 for killing yourself only when
   win_by_kills is OFF; in kills mode suicides cost nothing (OPTIONS.BM says the opposite).
2. **Team-play gold id bug**: at match end the gold id is computed as
   `team_of_player[winning_team_index]` (team index used as a slot index). Correct for schemes
   where slot 0 is team 0 and slot 1 is team 1 (BASIC & all "(10)" schemes); with "(5)(5)" schemes
   (slots 0 and 1 both team 0) a red-team victory makes the **white** team gold.
3. In kills mode the maximum and the tie count include OFF slots. Normally harmless (OFF slots
   have 0 kills after the match reset), but a net player who left mid-match (slot set OFF) keeps his
   kills: if he holds the maximum nobody can win until someone exceeds it, and a tie with him
   blocks the win.
4. The timer is wall-clock and uncapped: in-game help (F1) and hitches eat round time.
5. The round ends about 1 s early: remaining reaches 0 when less than 1000 ms are left.
6. Campaign **timeout advances to the next stage** (status 2 without `index--`), while dying
   restarts the stage; both show "Campaign unsuccessful!".
7. Campaign respawn is mostly dead code: `campaign_update` runs after the players in the same
   frame in which a death animation ends and sees no human with the alive flag → stage failed
   before the respawn can happen (works only with ≥2 humans).
8. Attract mode picks `rand()%V35` levels, ignoring the random-level mask (Hockey Rink and Aliens
   can appear).
9. `0`/`O` in the controller screen turns a NET player OFF on the server (Left refuses NET).
10. Scheme `-S` x==15 / y==11 are not clamped by the parser (round init clamps them to 14/10).
11. Manual toggles of teams (`T`) are overwritten by the scheme at the next match.
12. Gold sparkles show one extra state (index 13 wraps to state 0).
13. Win-by-kills can be won through an F10 round (kills made before F10 are kept).
14. In the level-select screen a number string ("%u"/"?") is formatted but never displayed.
15. `num_to_win_match` from the INI has no upper bound (UI limits it to 100).

---------------------------------------------------------------------------------------------------

## 13. Uncertain / open
- Rendered frame rate for per-frame (not time-scaled) effects — roulette speed, HURRY blink
  (`frame_counter & 4`), sparkle animation — depends on the engine loop / flip pacing (engine doc).
- Exact receive-side handling of the server's settings/level/positions messages is inside the
  undecompiled net dispatcher (≈0x40d10b–0x40e412); behaviour inferred from the senders.
- Whether DirectDraw flip/vsync limits the original to the monitor rate (affects 1.).
- `FUN_004260f5` (field build) ignores the result of `rand(2)` for brick cells in the
  decompilation; brick density handling belongs to the map/extras doc.
