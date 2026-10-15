# Engine loop, timing model, input and in-game HUD (BM95.EXE)

Scope: program flow from `WinMain` to the in-game frame, the frame order of operations, the timing model
(what uses elapsed milliseconds and what counts rendered frames), keyboard, joystick and AI input, special keys,
the in-game HUD (score lines, round timer, HURRY, overlays), and how the loop detects the end of a round.
Other documents cover module internals (player, bombs, flames/map/powerups, extras/levels, graphics, menus,
audio, AI, match flow/scoring). Addresses refer to BM95.EXE. `V<n>` means VALUELST.RES entry *n*. `REF_MS` means
the reference frame (50 ms).

---------------------------------------------------------------------------------------------------------------

## 0. Key facts (TL;DR for implementers)

* The in-game frame is **`game_frame` @0042a191**. Ghidra did not recognise it as a function (it is only a label),
  so it is missing from the call graph. `play_match` (@0042a3f6, misnamed `results_screen`) registers it as a GNW
  *background process* (`add_bk_process`). Each `get_input()` call in the match loop then runs exactly one game
  frame. **There is no frame limiter, no Sleep and no vsync wait.** The game runs as fast as the machine allows.
* `dt` (`DAT_00464958`) = `timeGetTime()` delta in integer ms, clamped to **≤ V31 = 150** (unsigned compare, no lower
  bound, so it can be 0). `REF_MS` (`DAT_0046494c`) = `1000 / V30` = **50**. VALUELST "frames" are reference
  frames: `ms = frames × 50`.
* Most gameplay quantities use `dt`: movement, animation steps, fuses, flame lifetimes, disease timers, death
  animations, the start freeze and the team-colour delay.
  Some run on **wall-clock time** and ignore the clamp: the **round clock**, the enclosement brick cadence (250 ms)
  and tile regeneration.
  Some count **rendered frames**: the stun after a bomb hits your head (16 frames), disease "freshness" (V129 = 10
  frames), extras/powerup animations (conveyors, trampolines, random powerup), the HURRY blink (4 on / 4 off),
  goldman twinkles and the ice-delay buffer depth (30 frames). See §2.4.
* Movement keys are **level-triggered**: GNW `keys[]` is sampled once per frame. Action buttons are made
  **edge-triggered** by the player code, which compares them with the previous frame. When two or more directions
  are held, the directions that lead into a blocked cell are dropped (unless all of them are blocked). The
  highest-numbered remaining direction wins: **left > down > right > up**.
* The HUD is per-player outlined text `"S:%d K:%d"` (FONT6) at V115-119 / V113-114, a red-X sprite `xxx` over the
  text once a player is gone, and the round clock drawn with the `numeric font` sprites at (V110, V111) = (525, 36).
  HURRY.ANI is drawn at the screen centre while 55 < remaining < 60 s. It blinks every 4 rendered frames, and a
  hurry voice (group 2700) plays once.
* A round ends when fewer than 2 players (or teams) **exist**. A dying player still exists until their death
  animation finishes. A round also ends when the clock reaches 0 (counted as a draw) or when F10 is pressed. A
  dying player stays **alive** (keeps bombs ticking and the clock running) for V25 = 20 death-animation states
  (about 1 s): this is the "out-survive by 20 standard frames" rule.

---------------------------------------------------------------------------------------------------------------

## 1. Program flow

### 1.1 Entry chain

```
entry @0044bdcc -> CRT startup (FUN_0044f2ea) -> WinMain @00443c70 (GNW95 winmain, not a Ghidra function)
  WinMain:
    mutex = CreateMutexA(NULL, TRUE, "GNW95MUTEX")
    if (GetLastError() != 0) return 0;                              // already running (single instance)
    InitClass (FUN_00443d58) ; InitInstance (FUN_00443dc8)            // window class "GNW95", window
                                                                      // (any failure: CloseHandle(mutex); return 0)
    store hInstance/cmdline/nCmdShow (DAT_0045c4d4/d8/dc); parse argv; install 3 signal handlers
    GNW95_isActive (DAT_0045c4e0) = 1
    main(argc, argv)  = FUN_0042be22
main @0042be22:
    game_init();      // @0041095a
    title_screens();  // @0042b060
    main_menu();      // @0042b9ce  (never returns; program exits through exit_game_confirm -> fatal_error(0))
    win_exit();       // FUN_0043c668 (unreachable in practice)
```

### 1.2 game_init @0041095a (order matters for RNG and data)

```
srand(time(NULL))                      // FUN_00451e3e = time() (rounds up when ms>=500), FUN_0045192e = srand
win_set_title("Atomic Bomberman")      // FUN_0043e5cc: also CreateMutexA("Atomic Bomberman"); if it already exists
                                       // sets DAT_0045c460=1 and skips SetWindowText (second instance guard)
gnw_set_focus_func(app_focus_changed)  // FUN_0043adc0(&004108e1), see §4.1
FUN_0043e750(0,0); cfg_get(x3); FUN_00413b1c (debug output); FUN_004127ff (valuelst+messages, getenv("KWD"))
graf_init (GNW window 640x480 at (0,0), font 6, register_pause(-1), screen buffers, remaps 0..9)
options_init -> options_load_ini ; joy_init ; ani_load_master ; sound_init ; you_init ; FUN_0040a0fe (AI)
map_init ; bombs_init ; power_init ; extra_init ; flame_init ; scheme_init ; FUN_00403363
round_timer_init (FUN_00410465: total = V100+1, overwritten before every round)
net_init ; FUN_004021bd (stats) ; aliens_init ; FUN_00401066
srand(time(NULL))                      // re-seeded after all module inits
disease globals <- V120..V125; enclosement <- V27; conveyor speed idx = 1; V46; V40; V310; V14; playtime <- V100
options_defaults()                     // keydef defaults + options.ini (overrides) + registers save-on-exit
REF_MS (DAT_0046494c) = 1000 / V30     // = 50 (Watcom 64-bit idiv, integer)
gold player (DAT_0046492c) = -1 ; stats_load()
```

### 1.3 Top-level state machine

```
title_screens: music; (non-debug) iplogo.pcx, hslogo.pcx (each waits for key or V12=7 s); voice 2800; title.pcx
main_menu (loop):                               items at V700 (x=332,y=140,dy=38)
  0 "Start game"          -> play_match()               (@0042a3f6)
  1 "Start network game"  -> FUN_0042b0ce               (host)
  2 "Join network game"   -> FUN_0042b47d
  3 Options               -> FUN_004080dc               (also Alt-O 0x118)
  4 Credits               -> graf_load_images("credits.bm")
  5 Online manual         -> help_browser("*.BM")       (also F1)
  6 Exit                  -> exit_game_confirm()        (also Esc, Ctrl-Q)
  idle >= V92=30 s with no key (or Alt-A 0x11E) -> attract mode: g_attract=1, save player setup + team flag
                       (FUN_004224e2), team play off -> play_match() (one round with max(3,rand()%10+1) AI players
                       on a random level, then back to the menu, which restores the setup with FUN_00422552)
  Ctrl-E (code 5) pressed 6 times in a row -> level editor (FUN_0040330e)
play_match(): g_campaign=0; frames disabled; 100x net_send_critical; music 0x3fc
  player_select_screen() (@00410f81)  -> g_game_state 0 (go) / 2 (cancel)
  if go:  round_start() (@00410b6e) ; add_bk_process(game_frame) ; frames enabled ; g_last_frame_time = now
          match loop (§1.4) until g_game_state != 0
          remove_bk_process(game_frame); round_timer_stop(); close remap editor
g_game_state (DAT_00464a68): 0 = playing, 1 = match won (victory screen shown), 2 = aborted/quit
```

The player-select screen has these hidden keys (the menus doc covers the screen itself): Ctrl-A (code 1) sets every
player to AI (local games only). Pressing `c`/`C` five times starts hidden campaign mode (`FUN_004015c6`, local
only). In attract mode it picks a random player count `max(3, rand()%10+1)` and a random level `rand()%V35`.

### 1.4 Match loop (play_match @0042a3f6, the part that drives frames)

```c
do {
    g_round_forced_end = 0;                       // DAT_00464aec
    key = gnw_get_input();                        // runs ONE game_frame() (see 1.5)
    switch (key) {                                // §4.2 for exact behaviour
      case 0x1B: case 0x0D: if (g_attract) { g_gold_player=-1; g_game_state=2; } break;
      case 0x11 /*^Q*/:     g_gold_player=-1; g_game_state=2; break;
      case 0x13B /*F1*/:    if (net_mode()==0) { frames_disabled=1; help_browser(); frames_disabled=0; } break;
      case 0x144 /*F10*/:   if (debug && g_campaign) g_campaign_result=1;
                            if (net_mode()!=CLIENT) { g_round_forced_end=1; net_send_msg(0x26); net_send_critical(); } break;
      case 0x111 /*Alt-W*/: g_intergame_nowait=1; break;
      case 0x04 /*^D*/:     debug_output_reset(); break;
      case 0x01 /*^A*/:     if (debug) anims_lst(); break;        // writes anims.lst
      case 0x12 /*^R*/:     if (debug) remap_editor_toggle(); break;
      case 0x131 /*Alt-N*/: net_dump_stats(); break;              // itself requires debug -> netstats.txt
      case 0x120 /*Alt-D*/: debug_info_window(); break;           // modal, frames disabled meanwhile
    }
    if (players_alive_count() <= 1) round_timer_stop();          // FUN_00421969, FUN_00410522
    if (g_campaign) { ...campaign level end handling...; continue; }
    if (!g_round_forced_end && players_exist_count() > 1 && !round_time_up())
        continue;                                                 // round still running
    if (g_attract) break;                                         // demo: back to menu
    music(0x46a); frames_disabled = 1;
    ... winner / draw / results / next round  (match-flow doc) ...
    // a next round calls round_start() and frames_disabled = 0, but does NOT reset g_last_frame_time
} while (g_game_state == 0);
```

### 1.5 What one gnw_get_input() call does (FUN_0043a508, GNW library)

```
1. gnw95_process_message()   FUN_0043b5ec
     if (active && keyboard enabled):
        while (DirectInput keyboard buffer has events) gnw95_process_key(ev)   // -> kb_simulate_key -> keys[]
        auto-repeat: every held key re-sends a press after 500 ms, then every 80 ms (DAT_0045c3d0/3cc)
     while (PeekMessage(PM_REMOVE)) { TranslateMessage; DispatchMessage; }
2. if (!GNW95_isActive) gnw95_lost_focus()   FUN_0043b7d8 -- calls focus_func(0), BLOCKS pumping messages until the
                                             window is active again, then focus_func(1)
3. gnw_process_bk()          FUN_0043a56c
     a. gnw_do_bk_process(): if (!game_paused && !bk_disabled) { bk_time = timeGetTime(); call every bk process }
                             -> game_frame()
     b. vcr/mouse update, GNW button check
     c. one key from the keyboard ring buffer -> gnw_add_input_buffer():
           == pause key (-1, disabled)      -> pause_game()     (never)
           == screendump key 0x12E (Alt-C)  -> dump_screen()    (scr00000.bmp ...)
           else queued (40-entry buffer)
4. pop one input event (or -1; -2 when nothing queued but a mouse button is down); return it
```

So keyboard **state** (`keys[]`) is refreshed at step 1, before the frame runs. The **event** returned to the
match loop is processed after the frame.

### 1.6 game_frame @0042a191 — exact per-frame order

```c
void game_frame(void) {                                    // GNW background process
    if (g_frames_disabled /*DAT_004646ac*/) return;        // set via FUN_0042a16f(v)
    now = gnw_get_time();                                  // timeGetTime, 1 ms resolution (timeBeginPeriod)
    g_dt = now - g_last_frame_time;  g_last_frame_time = now;   // DAT_00464958, DAT_0046496c
    if ((unsigned)g_dt > (unsigned)value_get(31)) g_dt = value_get(31);   // 150
    if (net_mode()==CLIENT && !net_server_alive(1)) { g_game_state = 2; net_server_bailed(); }
    net_receive();                                         // FUN_0040e765 (no-op offline)
    g_frame_counter++;                                     // DAT_00464994
    round_timer_update_draw();                             // 004105d2 (§5.2) - queues clock sprites
    graf_restore_background();                             // 00415ca4: memcpy 640*480 background -> window buffer
    map_set_clip_full();                                   // 0042641f: clip rect (0,0,640,480)
    extras_update_draw();                                  // 004056ca arrows/warps/conveyors/trampolines
    bombs_update(0); net_pending_explosions_expire();      // 004245b9 -> maybe_bomb_update(0) (bombs not carried), 00422a25
    powerups_update_draw();                                // 00424f89
    sound_streams_update();                                // 0041b961
    flames_update_draw();                                  // 00426d06
    map_update();                                          // 00426818 regen tiles + enclosement (only if alive>=2)
    players_update();                                      // 00420f07 (§3.5): joy poll, input/AI, move, draw, HUD text
    if (g_campaign) campaign_update();                     // 004016da
    bombs_update(1);                                       // 0042459a -> maybe_bomb_update(1) (bombs carried by players)
    t = round_timer_remaining();                           // 00410578
    if (t < V101 && t > V101 - 5) {                        // 55 < t < 60
        if (!g_hurry_sound_played) { g_hurry_sound_played = 1; sound_play_group(2700); }
        f = ani_seqno_to_frameno(ani_find_seq("hurry"), 0);
        if (g_frame_counter & 4) graf_queue_sprite(640/2, 480/2, f);
    }
    watermark_draw();                                      // 00429f1a: empty string in retail -> no-op
    remap_editor_draw();                                   // 00415ed1: only when the debug remap window is open
    net_receive();
    sound_streams_update();
    graf_flush_and_present();                              // 00415c1f: draw sprite queue, win_draw -> blit to screen
    net_send_critical();                                   // 0040ea1e
}
```

**Render composition.** The graphics doc covers drawing in detail. These are the facts that matter for the HUD:

1. The background is restored by memcpy at the start of the frame. `graf_print` text (the HUD score lines) is drawn
   **immediately** into the window buffer during `players_update`.
2. Sprites are queued in a 400-entry list (`DAT_00460bb0`, 24-byte entries
   `{type, x, y, frameno, p4, p5}`). Exceeding 400 entries is `fatal_error(10)`. Types: 0 = normal
   (`graf_queue_sprite` @00415920), 2 = with a remap table (@00415a1c), 3 = with a player colour index
   (@00415a9f).
3. `graf_flush_sprites` (@00415b22) walks the list in order. A **type-3 entry is not drawn when reached**: it is
   converted into a type-2 entry and *appended* to the end of the list (`FUN_004158cf`). The loop re-reads the count,
   so it draws the appended entries afterwards. This gives two layers: **first all type-0/2 sprites in call order**
   (clock digits, extras, powerups, player shadows, `xxx` markers, HURRY), **then all colour-remapped sprites in call
   order** (ground bombs, flames, bombers, kface, goldman twinkles, carried bombs).
   As a result the HURRY sign is drawn *under* bombers, flames and bombs.

---------------------------------------------------------------------------------------------------------------

## 2. Timing model

### 2.1 Clocks

| clock | source | resolution | used for |
|---|---|---|---|
| `gnw_get_time()` @0043acf8 | `timeGetTime()` | 1 ms (GNW calls `timeBeginPeriod(max(1,wPeriodMin))`, FUN_0043b518) | frame dt, round clock, enclosement cadence, tile regen, key repeat, screen waits |
| `time()` @00451e3e | Watcom CRT, seconds (rounded up at ≥500 ms) | 1 s | RNG seeds, title/intro waits (V12), cursor blink (V690), "Sending data" progress |

### 2.2 Frame delta and reference frame

```
dt      = min( (unsigned)(now - last), (unsigned)V31 )      // V31 = 150; dt may be 0; no lower clamp
REF_MS  = 1000 / V30 = 50                                   // integer division, computed once in game_init
```

* **No frame-rate limiter.** V30 ("frames per second we attempt to get") only sets `REF_MS`. Nothing in the match
  loop sleeps. `Sleep()` is called only by the exit sequence (4000 ms) and by `delay_ms_pumping`
  (FUN_00413cb0, in 100 ms steps; used in network and screen code, never between frames). Presentation is a
  DirectDraw primary-surface Lock + copy + Unlock (GNW95) with no Flip and no WaitForVerticalBlank.
* `g_last_frame_time` is set to `now` only once per match, just before the first round's loop. Later rounds
  re-enable frames without resetting it, so **the first frame of every round after the first has `dt = 150`**
  (the clamp), because the results screens took longer than 150 ms.
* When a single frame takes longer than 150 ms, simulated time falls behind wall-clock time (slow motion). The round
  clock and the enclosement do not slow down (§2.4 group R).

### 2.3 Update patterns (with exact formulas)

**A. State stepping (animation states, "frames" of a sequence).** The accumulator is a signed short, normally at
`obj+0x32` (players also use `+0x52` for action animations):
```
acc += dt;  while (acc > 0) { state++; acc -= REF_MS; }
```
With `acc = 0` at the start, the state after `T` ms of simulated time is `ceil(T/50)`. The step happens at the
*start* of each 50 ms slice. Uses: bombs, flames, bombers (death, kick, punch, pickup, trampoline, idle
"cornerhead"), dud-bomb wait (in states).
`ani_seqno_to_frameno(seq, state)` wraps the state modulo the sequence's state count.

**B. Millisecond timers.** `t += dt` (or `t -= dt`) compared against `frames × REF_MS`:
* bomb fuse: age `bomb+0x44` starts at `-extra×50` and grows by `dt` (only while `players_alive_count() > 1` and the
  bomb is not in certain moving states). The bomb explodes when `age ≥ fuse`, where `fuse = V41(40)×50 = 2000 ms`
  (the bombs doc covers the short-fuse disease etc.)
* flame: `age += dt`; the flame is removed when `age > V10×50 = 500` (brick disintegration: `V20×50 = 500`)
* disease: `+0x78` starts at 1 and grows by `dt`; it wears off when `> V(130+k)×50` (300 frames → 15000 ms)
* round-start freeze `DAT_004621e0 = V30×REF_MS = 1000 ms` and team-colour delay `DAT_004621e8 = V32×REF_MS = 2000 ms`:
  both decrease by `dt` at the start of `players_update` and are clamped at 0
* ice-delay buffer entry ages (§3.5), campaign end timer (2×V25×50 = 2000 ms), network pending explosions (100 ms)

**C. Motion in 1/100 px.** `speed` is in 1/100 px per reference frame:
```
acc(+0x74) += (uint32)(speed * dt) / 50;          // product truncated to 32 bits, unsigned divide
while (acc > 0) { move 1 px (walk anim state +0x30 ++ per pixel); acc -= 100; }
```
Speed in px/s = `speed / 100 × 20`. Default V42 = 923 → 184.6 px/s; each skate (V90) adds 30 px/s; each clog
(V91) removes 30 px/s; the slow disease divides by 3, fast diseases multiply by 1.5. Conveyors V190-192
(250/350/450) are added or subtracted the same way. Bombs use a variant (kick V300 = 1000, punch V301 = 1300); see
the bombs doc. The angel death (#9) rises `V106 = 4` px per 50 ms slice (pattern A with a pixel step).

**D. Wall clock.** Uses `timeGetTime()` directly. See group R in §2.4.

**E. Per rendered frame.** Counters change by 1 per `game_frame` call. See group F in §2.4.

### 2.4 Classification of every frame-relevant quantity found

Group T: simulated time (`dt`-scaled, i.e. effectively ms of game time)

| quantity | where | formula |
|---|---|---|
| player movement, walk animation (per pixel) | player_update_anim / FUN_0041ec84 | C |
| conveyor push on players and bombs | player/bomb update | C with V(190+speed idx) |
| kicked, punched and sliding bomb movement | maybe_bomb_update | C |
| bomb animation, fuse | maybe_bomb_update | A, B |
| dud bomb wait V323(+rand V324) | maybe_bomb_update | in bomb animation states (A) → 120 states = 6 s |
| flame animation and lifetime | flames_update_draw | A, B |
| death animation; angel rise V106 | player_update_anim | A |
| kick, punch, pickup, trampoline, cornerhead animations (V665 = 2 states = 100 ms; V680 = 30 states = 1.5 s) | player_update_anim | A (`+0x52` accumulator) |
| disease duration | player_update_anim | B |
| respawn invulnerability `+0x66 = 20×REF_MS` (campaign) | player_update_anim | B (countdown) |
| round-start freeze (1000 ms) and team-colour delay (2000 ms) | players_update | B |
| ice-delay ages (V450+level) | player_update_anim | B |
| campaign "no enemies left" 2000 ms | campaign_update | B |

Group R: wall clock (timeGetTime; *not* clamped and *not* paused)

| quantity | where | detail |
|---|---|---|
| **round clock** | round_timer_update_draw @004105d2 | §5.2. It keeps counting while the frame is disabled (F1 help, Alt-D window) and while the window is inactive: the elapsed time is added on the next update |
| enclosement brick cadence | map_update @00426818 | first brick 250 ms after it starts, then every 250 ms; at most 4 bricks per frame (catch-up) |
| tile regeneration (V340+level seconds; only level 7 = 4 s) | FUN_00426704 | `now - last > V×1000` |
| key auto-repeat (menus only) | gnw95_process_message | 500 ms / 80 ms |
| results and draw screen auto-advance (6 s), minimum wait before a key is accepted (1 s local / V13 = 3 s network), attract idle V92 | play_match, main_menu | match-flow and menus docs |

Group F: per rendered frame (frame-rate dependent in the original)

| quantity | where | detail |
|---|---|---|
| **stun after a bomb lands on your head** | FUN_00421f7e sets `+0x3a = 16`, decremented once per frame in player_update_anim | while `> 0`: no input; when it reaches 0 the stun animation (state 3) is cleared |
| **disease freshness** (V129 = 10) | `+0x80`, decremented once per frame | a disease cannot be passed on while `> 0` |
| ice-delay buffer depth | 30 entries, one pushed per frame | caps the effective control delay at the time covered by the last 29 frames |
| standing animation state | player_update_anim (`+0x30++` when godir == -1) | |
| extras: conveyor animation, warp animation, trampoline bounce animation, arrows | extras_update_draw (`+0x30++`) | conveyor sequences have 4-5 states |
| powerup animation (`power random`: 12 states) and the powerup "age 4" network check | powerups_update_draw (`+0x30++`, `+0x44++`) | |
| HURRY blink | game_frame | visible when `frame_counter & 4` |
| goldman twinkle spawn (5/6 chance per frame) and twinkle age (1 state per frame) | FUN_00420d4e, goldman_twinkles_draw | §5.4 |
| disease colour flicker | player draw | uses `(disease_age_ms & 8)` (time), but a new `rand()%10` colour each frame |
| sound throttle: the same sound group not restarted within 3 frames | FUN_00427abb | audio doc |

`g_frame_counter` is set to 0x40 whenever a full-screen PCX is shown (`FUN_00429ff1` from `pcx_load_plt`), so the
HURRY blink phase is not continuous across rounds.

### 2.5 "Standard frames" (V25 comment) — operational meaning

The VALUELST header says speeds are "per frame", and V25 says "nominal frame rate used as a reference for other
frame-count-based values". In code this means: **every VALUELST value expressed in frames is multiplied by
`REF_MS = 1000/V30 = 50 ms`** and compared with `dt`-accumulated time. Every speed is "1/100 px per 50 ms of
simulated time". Examples: fuse V41 = 40 → 2000 ms; flames V10/V20 = 10 → 500 ms; team colours V32 = 40 → 2000 ms;
diseases V130-138 = 300 → 15 s; trampoline V680 = 30 → 1.5 s; dud bomb V323 = 120 → 6 s (+ V324 random).
The start freeze is `V30 × (1000/V30) ≈ 1000 ms` whatever V30 is set to.

Exceptions (true per-rendered-frame counts): V129 disease freshness and the hard-coded 16-frame stun.

V25 itself (20) is used twice:
* `player_update_anim`: a dying player still counts as **alive** (`DAT_004621d0`, team counters) while
  `death_anim_state < V25`, i.e. for about 20×50 = 1000 ms of game time after the death. See §6.
* `campaign_update`: a campaign level is complete after `2×V25×REF_MS = 2000 ms` with no enemy AI left.

### 2.6 Recommendations for the remake (decision for the lead)

* Run a fixed-step simulation with an integer `dt` per step and call every module in the order of §1.6. With a fixed
  step, wall-clock and simulated time coincide, which reproduces normal play (no frame above 150 ms, no pauses).
* Group F needs a frame rate. The original ran unthrottled, probably 25-60 fps on 1997 hardware (unknown). Choose
  one: (a) step and render at a fixed 60 Hz (dt pattern 17/17/16) and count group-F counters per step, or
  (b) keep 50 ms semantics for game logic but convert group-F counts to time at an assumed original rate.
  Either way, keep these items configurable: stun = 16 frames, freshness = 10 frames, blink period = 8 frames,
  extras animation rate.
* Whether the HUD clock should keep running during in-game help and focus loss is a design choice. The original
  keeps it running (§8).

---------------------------------------------------------------------------------------------------------------

## 3. Input

### 3.1 Keyboard pipeline

* DirectInput keyboard device in buffered mode (GNW95 dxinput, `FUN_004449b0` reads one event:
  `{dik, pressed}`). `gnw95_process_key` (@0043b700) maps the DIK code through the layout table
  (`DAT_004a2cb0`). For extended keys it sends an `0xE0` prefix, then calls `kb_simulate_key` (@00433e14).
* `kb_simulate_key` keeps **`keys[256]`** (`DAT_004a2ba0`), indexed by DirectInput-style scancode (extended keys =
  base + 0x80, e.g. Up = 0xC8, Left = 0xCB, Right = 0xCD, Down = 0xD0). Values: 0 = up, 1 = pressed,
  2 = held/repeated (any non-zero means down). Each press also pushes a translated GNW key code into a 64-entry
  ring buffer (used by `get_input`).
* **Gameplay reads `keys[]` directly** (level). Movement and actions are sampled once per frame, in `players_update`.
  A press and release that both happen between two frames is never seen.
* `input_flush()` (@0041043c) = GNW flush_input_buffer + `kb_clear` (zeroes `keys[]`, the ring buffer and the
  repeat timestamps; flushes DirectInput) + clears the injected-key queue. A key held through a flush reads as
  released until it is pressed again. Flushes happen before most screens and before the results waits.
* The keyboard layout (`DAT_004a2ca4`, 0 = US, 1 = French, 2 = German, 3 = Italian, 4 = Spanish) only changes the
  default for keyboard 1 Action 2 (see below).

### 3.2 Key definitions (keydefs)

Table `g_keydefs[2][10]` at `DAT_004645bc` (set *s*, action *a* at `0x4645bc + (s*10+a)*4`), holding DIK scancodes.
Actions: 0 = Move Up, 1 = Move Right, 2 = Move Down, 3 = Move Left, 4 = Action 1 (drop bomb), 5 = Action 2
(special). 6-9 are unused (0). Message ids 1120-1125.

Defaults (`keydefs_set_defaults` @0040614a, called by options_defaults before options.ini is read and by
"Return to default keys"):

| set | Up | Right | Down | Left | Action1 | Action2 |
|---|---|---|---|---|---|---|
| KEY 0 | 0xC8 Up | 0xCD Right | 0xD0 Down | 0xCB Left | 0x39 Space | 0x1C Enter |
| KEY 1 | 0x13 R | 0x22 G | 0x21 F | 0x20 D | 0x1F S | 0x1E A (French layout: 0x10, the physical A key on AZERTY) |

`options.ini` line format: `keydef=<set>,<action>,<dik>`. It is accepted only when `0 ≤ set < 2` and
`0 ≤ action < 10`; the scancode is **not** range-checked (a value ≥ 256 would read outside `keys[]`). The file is
re-saved on exit (`"keydef=%u,%u,%u\n"`, all 20 entries).
Rebinding (`keydef_capture_key` @00407ad9): show "Press key for '%s'", wait 500 ms, flush input, then loop.
The bound key is the **highest** scancode with `keys[k] != 0` at the first moment any key is down (Esc also ends
the wait and binds Esc, 0x01). The options screen shows the key name only when `(dik & 0x7F) < 0x59`.

### 3.3 Joysticks (winmm)

* `joy_init` (@0042971f): `n = min(joyGetNumDevs(), 10)`; reads caps for every joystick.
* Per joystick, a 0x38-byte record at `0x46309c + 0x38*j`:
  `+0 caps_read, +4 connected, +8 xmin, +0xC xmax, +0x10 ymin, +0x14 ymax, +0x18 raw_x, +0x1C raw_y,
   +0x20 x%, +0x24 y%, +0x28 buttons, +0x2C prev x%, +0x30 prev y%, +0x34 prev buttons`.
* `joy_poll` (@00429790) is called once per frame in `players_update` (and on each menu key poll). It copies
  current → previous, then calls `joyGetPosEx(j, {dwSize=0x34, dwFlags=JOY_RETURNX|JOY_RETURNY|JOY_RETURNBUTTONS})`.
  On success (re-reading caps when it was previously disconnected): clamp raw to `[min,max]`, then
  `x% = (raw_x - xmin)*100 / (xmax - xmin)` (integer; same for y). On failure: `x% = y% = 50`, buttons = 0,
  connected = 0.
* In game (`you_getinput`): **up if y% < 30, left if x% < 30, down if y% > 70, right if x% > 70** (strict),
  Action1 = button bit 0, Action2 = button bit 1. Several directions can be set together (diagonals), then §3.4
  resolves them.
* Easter egg (also in `you_getinput`): with **y% < 30 and buttons == 0x4A** exactly (buttons 2, 4 and 7), that
  player becomes the "kface" player (`DAT_0045be3c`, broadcast with `FUN_004101f1`). From then on a `kface <dir>`
  sprite (KFACE.ANI) is drawn on their head at (x-4, y-34). **Buttons == 0x8A** (2, 4 and 8) turns it off (-1).

### 3.4 Turning raw input into a player command — you_getinput @0041e61e

Player command fields (player struct base `0x461bc4`, stride 0x98; the player doc documents the rest):
`+0x10 input type` (0 OFF, 1 AI, 2 KEY, 3 JOY, 4 NET), `+0x11 device index` (keyboard set / joystick number),
`+0x2C facing`, `+0x2E godir` (-1 none, 0 N, 1 E, 2 S, 3 W; dx = {0,1,0,-1}, dy = {-1,0,1,0} at
0x45becc/0x45bedc), `+0x36/+0x37` Action1/Action2 of the previous frame, `+0x38/+0x39` Action1/Action2 this frame.

```c
int you_getinput(Player *p) {
    int dir[4] = {0,0,0,0}, pick = -1;
    switch (p->input_type) {
    case 0: return 0;
    case 1: break;                                   // AI: unused here (ai_think is called instead)
    case 2: { const int *k = g_keydefs[p->dev ? 1 : 0];   // any non-zero device index -> set 1
              if (keys[k[0]]) dir[0]=1;  if (keys[k[2]]) dir[2]=1;
              if (keys[k[3]]) dir[3]=1;  if (keys[k[1]]) dir[1]=1;
              if (keys[k[4]]) p->act1 = 1;  if (keys[k[5]]) p->act2 = 1;  break; }
    case 3: { joy_get_state(p->dev, &x, &y, &b);
              if (y < 30) { if (b == 0x4A) kface_on(p); if (b == 0x8A) kface_off(); }
              if (y < 30) dir[0]=1;  if (x < 30) dir[3]=1;  if (y > 70) dir[2]=1;  if (x > 70) dir[1]=1;
              if (b & 1) p->act1 = 1;  if (b & 2) p->act2 = 1;  break; }
    case 4: /* network: x,y,facing,anim copied from the last packet; godir = facing if the position changed */ break;
    default: fatal_error(0x69);
    }
    if (count(dir) > 1) {
        c = pixel_to_col(p->x); r = pixel_to_row(p->y);          // FUN_0042665c / FUN_004266a3
        open = 0;
        for d in 0..3: if (dir[d] && cell_is_open(c+dx[d], r+dy[d])) open++;
        if (open) for d in 0..3: if (!cell_is_open(c+dx[d], r+dy[d])) dir[d] = 0;
    }
    for d in 0..3: if (dir[d]) pick = d;                          // highest index wins: W > S > E > N
    if (pick != -1) p->godir = pick;
    return 1;
}
// cell_is_open(c,r) @0041e5c3 = (no bomb at c,r) && (tile type at c,r == 0)
```

So with two directions held, directions that point into a wall, brick or bomb are dropped (unless all of them do),
then the order Left > Down > Right > Up decides. There is no "last pressed wins" rule and no key repeat.

### 3.5 Command processing inside player_update_anim (hook points, in order)

For each player, `players_update` (@00420f07) calls `player_update_anim` (@0041f29b). The input part, in order:

```
1. if (input_type == OFF) return.  Before the input part come: spawn, exist/alive counting and the death animation
   (returns while dying, §6), the flame-contact death check, powerup pickup, and disease timer/spreading (player doc).
2. prev_act1 = act1; prev_act2 = act2; act1 = act2 = 0; godir = -1;
3. read_input = 1
   if (stun(+0x3a) > 0) { read_input = 0; stun--; if (stun==0 && anim==3) anim = 0, anim_state = 0; }
   boxed-in check: if all 4 neighbour cells are closed and anim==0 -> anim = 20 + rand()%V330 (cornerhead idle);
                   if not boxed and 20 <= anim < 40 -> anim = 0
   if (anim in {5,6,7}) read_input = 0
   if (anim == 4 /*pickup*/ && anim_state <= V665) { read_input = 0; act1 = 1; }
4. if (read_input && start_freeze(DAT_004621e0) == 0):
       if (input_type == AI) { campaign_reset_clear_timer(); ai_think(index); }   // AI writes the same fields
       else you_getinput(p);
5. if (godir != -1):
       validate 0..3 (else fatal "godir is invalid"); godir &= 3;
       if (disease_reversed (+0x8c, disease slot 8) && input_type != AI) godir = (godir + 2) & 3;   // REVERSED CONTROLS
       if (facing != godir && anim in {1 kick, 2 punch}) anim = anim_state = 0;
       facing = godir;
6. if (input_type != AI)  ICE-DELAY BUFFER (per player, 30 x {int age_ms; int dir}, ptr table DAT_004621c8):
       for i in 0..29: buf[i].age += dt;
       for i in 29..1: buf[i] = buf[i-1];
       buf[0] = {0, godir};
       for i in 0..29: { godir = (short)buf[i].dir; if (buf[i].age >= value_get(450 + level)) break; }
   (reset at round start: all {0,-1}. Only hockey rink V452 = 250 ms is non-zero.)
7. movement with godir (C pattern); then actions:
       act2 edge (act2 && !prev_act2): stop kicked bombs (if kick), punch (if glove && !act1), trigger detonate
       act1 edge (act1 && !prev_act1 && !constipation): grab or drop bomb (player and bombs docs)
       carrying: releasing act1 (level) throws the carried bomb; diarrhea or crack force act1=1, prev_act1=0 every frame
```

Consequences:
* Movement is held/level. Bomb drop, punch and detonate are press/edge. Carrying is hold/level.
* AI players are frozen by the start freeze, stuns and animation locks exactly like humans. They are **not**
  affected by reversed controls or the ice delay. `ai_think` also burns one `rand()` per call
  (`malloc(rand()%1000+100); free()`); see the AI doc.
* Facing (`+0x2C`) follows the *undelayed* input on ice; godir (movement) uses the delayed one.
* An action key that is still held when input reading resumes (after the start freeze, a stun or a pickup) gives an
  edge on the first readable frame, because `prev` was forced to 0.

### 3.6 Menu input helper — menu_get_key @004102b7

```c
int menu_get_key(void) {
    if (g_injected_count > 0) {                 // DAT_0046019c / DAT_00460174[10]; menu_inject_key @00410401 is
        k = g_injected[0]; shift left; g_injected_count--; return k;   // never called (dead code)
    }
    joy_poll();
    for (j = 0; j < 10; j++) if (joy_connected(j)) {
        joy_get_state(j,&x,&y,&b); joy_get_prev_state(j,&px,&py,&pb);
        if (x <= 30 && px > 30) return 0x14B;   // Left   (edge: crossing into the zone)
        if (x >= 70 && px < 70) return 0x14D;   // Right
        if (y <= 30 && py > 30) return 0x148;   // Up
        if (y >= 70 && py < 70) return 0x150;   // Down
        if ((b & 1) && !(pb & 1)) return 0x0D;  // Enter
    }
    return gnw_get_input();                     // keyboard/mouse (and runs bk processes if enabled)
}
```
Menu thresholds are inclusive (≤30 / ≥70); in-game thresholds are strict (<30 / >70). Joystick menu events are edges
only (no repeat). Keyboard menu keys repeat after 500 ms, then every 80 ms (GNW). Return codes: -1 = nothing,
-2 = mouse button.

---------------------------------------------------------------------------------------------------------------

## 4. Special keys

### 4.1 GNW-level (active everywhere get_input runs: menus and game)

* **Alt-C (0x12E)**: screenshot. `dump_screen` redraws every window into a buffer and writes **`scrNNNNN.bmp`**
  (first unused number from 00000 to 99999) in the current directory, as an 8-bit BMP with the palette. In game it
  happens inside the frame's `process_bk`, right after the frame was drawn.
* **Pause: disabled.** `graf_init` calls `register_pause(-1, NULL)` (00414e2a), so the GNW pause key (default Alt-P
  0x119) never matches. The GNW "Paused"/"Done" window (`default_pause_window` @0043a7c0, string @0045ab24) is never
  shown. The game has no pause.
* Ctrl-Break (keys[0xC6]): GNW clears the keyboard state.
* **Losing focus**: `gnw_get_input` blocks in `gnw95_lost_focus` until the window is active again (all game frames
  stop). The focus callback `app_focus_changed` @004108e1: on focus loss in a **network** game it sets
  `g_game_state = 2` (abort). A server first sends a quit message (key 0x1B, `FUN_0040f064`). Every network mode then
  sends the game-state message (`FUN_0040fb44(2)`) and pumps `net_send_critical` 10×100 ms. In local games it does
  nothing.

### 4.2 In-game keys (match loop, §1.4; one key per frame, handled after the frame)

| key | code | effect |
|---|---|---|
| Esc, Enter | 0x1B, 0x0D | **only in attract (demo) mode**: back to the main menu. Ignored in a normal game |
| Ctrl-Q | 0x11 | abort the match: `g_gold_player = -1`, `g_game_state = 2` → main menu |
| F1 | 0x13B | local games only: frames disabled, help browser (`*.BM`), frames enabled. The round clock keeps running |
| F10 | 0x144 | "forces a draw": ends the round without awarding a point (round result screens follow). Ignored on a network client; the server broadcasts it (msg 0x26). With debug on and in campaign: campaign level done |
| Alt-W | 0x111 | `g_intergame_nowait = 1`: result screens auto-continue after 6 s (as when no human plays) until the end of the match |
| Alt-D | 0x120 | "Internal debugging information window" (memory, net id, retransmit rate, audio cache). Modal; frames disabled; Enter/Esc closes it |
| Alt-N | 0x131 | debug only: writes `netstats.txt` |
| Ctrl-A | 0x01 | debug only: writes `anims.lst`. In the player-select screen Ctrl-A instead sets all players to AI |
| Ctrl-R | 0x12 | debug only: toggles the colour remap editor window |
| Ctrl-D | 0x04 | debug output reset (FUN_00413bb0) |

"Debug" = `DAT_00460260 = atoi(getenv("KWD"))` is non-zero. MANUAL.BM documents Alt-N as available to everyone,
but the code gates it.

### 4.3 Main menu (summary; the menus doc covers details)

Up/Down move the selection (wrapping 0..6). Enter or Space selects. Esc or Ctrl-Q selects Exit (with confirmation).
Alt-O opens Options, F1 the manual, Alt-D the debug window, Alt-A attract mode. Ctrl-E ×6 opens the editor. The
attract timer resets on any key.

---------------------------------------------------------------------------------------------------------------

## 5. In-game HUD

The status area is the black box at the top of every FIELDn.PCX (about x 6..633, y 5..47; FIELD1 differs). It is
part of the background, so it is restored every frame. Nothing else is static: all HUD elements are redrawn every
frame.

### 5.1 Player score lines (players_update @00420f07)

For every player `i = 0..9` whose input type ≠ OFF, every frame, right after that player's `player_update_anim`:

```
x = value_get(115 + i/2)          // V115..119 = 10,110,210,310,410
y = value_get(113 + (i & 1))      // V113 = 6 (even i), V114 = 26 (odd i)
text = sprintf(msg 37 "S:%d K:%d", (short)p->score /*+0x6A*/, (short)p->kills /*+0x6C*/)
graf_print(main_window, text, w=90, x, y, fg = player_text_color(i), outline = player_outline_color(i))
if (p->alive /*+0x00*/ == 0)       // gone: after the death animation finished (or never spawned)
    graf_queue_sprite(x, y, frame of seq "xxx" state 0)
```

Layout: players 0/1 share column x = 10 (rows y = 6 and 26), 2/3 x = 110, 4/5 x = 210, 6/7 x = 310, 8/9 x = 410.
S = round wins (`+0x6A`, +1 for the round winner and copied to teammates in team play). K = kills (`+0x6C`, +1 per
kill, -1 for a suicide unless win_by_kills is set). The match-flow doc covers both. Message 39 `"S:%u L:%u"` is
defined but never referenced.

**graf_print rendering** (@0041696c, `graf_print(win, str, w, x, y, fg, outline)`), using the current GNW font =
**FONT6.FON** (`text_font(6)` in graf_init; never changed):
* `wd = min(text_width(str), w)`, `pitch = wd + 2`, `bh = text_height() + 4`. Allocate a zeroed `pitch×bh` buffer.
* `text_to_buf` is called 5 times with max width `wd` (colour | 0x2000000 = transparent background): outline colour
  at offsets (0,0), (2,2), (0,2), (2,0); then fg colour at (1,1). Text wider than 90 px is truncated by text_to_buf.
* Fatal error if `x + pitch > 640` or `y + bh > 480`. Otherwise the buffer is copied with colour 0 transparent to
  the window at (x, y). So the glyphs start at (x+1, y+1) with a 1-pixel outline around them.

**Colours** (palette indices through GNW's RGB555 → palette table `colorTable` at `DAT_00495390`, index
`r5<<10 | g5<<5 | b5`):
* Non-team fg = `colorTable[min(R/3,31)<<10 | min(G/3,31)<<5 | min(B/3,31)]`, where (R,G,B) are the percentages
  stored in the last 3 bytes of `<i>.RMP`. These override V200-247 when the file exists (it does):

| i | colour | RMP R,G,B (%) | RGB555 (r,g,b) |
|---|---|---|---|
| 0 | white | 100,100,100 | 31,31,31 |
| 1 | black | 15,15,10 | 5,5,3 |
| 2 | red | 100,0,10 | 31,0,3 |
| 3 | blue | 0,10,85 | 0,3,28 |
| 4 | green | 0,100,0 | 0,31,0 |
| 5 | yellow | 100,100,0 | 31,31,0 |
| 6 | cyan | 0,90,95 | 0,30,31 |
| 7 | magenta | 95,0,90 | 31,0,30 |
| 8 | orange | 100,50,0 | 31,16,0 |
| 9 | purple | 50,0,100 | 16,0,31 |

* Non-team outline = black (`colorTable[0]`) for everyone except **player 1** (the black bomber), who gets a
  **white** outline (`colorTable[0x7FFF]`).
* Team play: fg = `team_text_color(team)`: team 0 = `colorTable[0x7FFF]` (white), team 1 = `colorTable[0x7D4A]`
  (31,10,10 → red). Outline always black.

Draw order: the text is drawn immediately (below every sprite of the frame). The `xxx` marker is a layer-1 sprite.
XXXX.TGA (MISC.ANI frame 10) is a red diagonal cross-hatch ("XXXX"), 77×20 with hotspot (10,3). Its top-left is
at (x-10, y-3), so it strikes through the score line.

### 5.2 Round clock — round_timer_update_draw @004105d2 (misnamed maybe_hud_init)

Called first in every game frame (§1.6). State (`DAT_004601xx`):

| addr | name | meaning |
|---|---|---|
| 0x4601a8 | total_s | round length in seconds; **1001 = infinite** |
| 0x4601ac | total_ms | total_s × 1000 |
| 0x4601b4 | running | 1 while counting |
| 0x4601a0 | last_tick | timeGetTime of the previous update |
| 0x4601b8 | elapsed_ms | accumulated |
| 0x4601a4 | remaining_s | displayed / tested value |
| 0x4601bc | elapsed_s | total_s − remaining_s (≥0); used by goldman twinkle (V1010) and powerups (V102) |
| 0x4601b0 | net_remaining | last value sent (server) / received (client) |

Round start (end of `round_start`): `set_total(playtime)` (options `playtime`: 60, 90, 120, 150, 180, 240, 300, 600 or
1001; clamped to [60, 600] except 1001), then `reset()` (stop, elapsed = 0, net_remaining = total), then `start()`
(running = 1, last_tick = now). `round_timer_stop()` is called by the match loop whenever ≤ 1 player (team) is
alive. Nothing restarts the clock until the next round.

```c
void round_timer_update_draw(void) {
    if (net_mode() == CLIENT) { rem = net_remaining; elapsed_s = max(0, total_s - net_remaining); }
    else {
        if (running) { now = timeGetTime(); elapsed_ms += now - last_tick; last_tick = now; }
        rem = (total_ms - elapsed_ms) / 1000;   if (rem < 0) rem = 0;     // C truncation
        remaining_s = rem;  elapsed_s = max(0, total_s - rem);
        if (net_mode() == SERVER && remaining_s != net_remaining) { net_remaining = remaining_s; net_send_timer(); }
    }
    if (total_s == 1001) {                                   // infinite
        graf_queue_sprite(V110, V111, frame("infinity", 0));  // KFONT frame 11 INF2.TGA 48x17 hot(0,16) -> top-left (525,20)
        remaining_s = 1001;
        return;
    }
    // (dead code: colour = rem <= 30 ? colorTable[0x5000] : colorTable[0x7FFF]; computed, never used)
    s = sprintf(msg 281 "%u:%02u", rem/60, rem%60);
    x = V110 (525); y = V111 (36); seq = ani_find_seq("numeric font");    // KFONT.ANI (BFONT.ANI is not loaded)
    for (c in s) { d = c - '0'; if (d < 0 || d > 10) continue;           // ':' (0x3A) -> 10
        f = ani_seqno_to_frameno(seq, d); graf_queue_sprite(x, y, f);
        x += frame_width(f) + V112 /*4*/; }
}
```

KFONT `numeric font` frames. The sequence's per-state offsets are **not** applied; the frame's own hotspot is used,
so the drawn top-left = (pen_x − hotX, 36 − hotY):

| char | frame | w×h | hotX,hotY |
|---|---|---|---|
| 0 | D0 | 18×27 | 9,26 |
| 1 | D1 | 12×26 | 7,25 |
| 2 | D2 | 18×26 | 8,25 |
| 3 | D3 | 18×27 | 8,26 |
| 4 | D4 | 19×26 | 8,25 |
| 5 | D5 | 19×27 | 8,26 |
| 6 | D6 | 18×27 | 8,26 |
| 7 | D7 | 18×26 | 7,25 |
| 8 | D8 | 18×27 | 8,26 |
| 9 | D9 | 18×27 | 7,26 |
| : | DC | 6×19 | 5,18 |

(Frames that are not 40×36 are trimmed of fully transparent borders at load time, adjusting the hotspot. These
frames have no transparent border, so the values above are final.) Example `2:29`: `2` at top-left (517,11), pen
547; `:` at (542,18), pen 557; `2` at (549,11), pen 579; `9` at (572,10).
Digit bottoms sit on y = 36.

Timing of the display: `rem = floor((total_ms − elapsed_ms)/1000)`. The first frame of a round (a few ms elapsed)
already shows `total−1` (e.g. **2:29** for 150 s). `round_time_up()` is true as soon as `rem < 1`, so
**a 150 s round lasts about 149.0 s** of wall-clock time. "0:00" is drawn for the single frame in which the round
ends.

`round_time_up()` @0041087d: `total == 1001 → false; client: net_remaining < 1; else remaining_s < 1`.

### 5.3 HURRY

* Condition, evaluated every frame after the module updates: `V101-5 < remaining < V101`, i.e. remaining ∈ {59, 58,
  57, 56}. That is 4 s of wall-clock time, starting `total_ms − 59 999 ms` after the round start. With a 60 s round
  it shows straight away.
* The first frame of the window plays `sound_play_group(2700)` (hurry voices 2700-2738) once per round
  (`g_hurry_sound_played` DAT_00464984, cleared in `round_start`).
* Sprite: seq `hurry` state 0 (HURRY.ANI, 278×91, hotspot 111,43), queued as a layer-1 sprite at
  (320, 240) → top-left (209, 197). It is drawn only on frames where `frame_counter & 4` (4 frames on, 4 off).
  It is under bombs, flames and bombers (§1.6).
* Related, in the map doc: when remaining ≤ 55 (and ≥ 2 players alive) the enclosement starts. One sound out of
  140-142 is chosen with `rand()%3` at the start; then one brick every 250 ms of wall-clock time.

### 5.4 Other overlays drawn during the round

* **Team colours** (V32): for the first `V32×50 = 2000 ms` of simulated time (`DAT_004621e8`), every bomber is drawn
  with remap = its player index (true colour). Afterwards remap = `player+0x3C`: the player index in free-for-all,
  `team ? 2 : 0` (red / white) in team play.
* **Disease flicker**: while `(disease_age_ms(+0x78) & 8) != 0` the bomber is drawn with remap `rand()%10` (one
  `rand()` per such frame).
* **Goldman twinkle**: shown when option `goldman=1` and not in attract mode, for the player that won the previous
  round (`g_gold_player`; in team play the team code 0 or 2). `g_gold_player` is only set in local games; network
  games set it to -1. Every frame, for that player while `alive(+0) != 0` (this includes dying),
  `goldman_twinkle_spawn` (@00420d4e) runs:
  ```
  slot = first free of 100 (DAT_004621cc, 16 bytes: active, x, y, age); none -> return
  if (V1010 && elapsed_s >= V1010 /*5*/) return
  if (rand() % 6 == 0) return
  slot = {1, p.x + rand()%40 - 20, p.y + rand()%50 - 48, age 0}
  ```
  After the player loop, `goldman_twinkles_draw` (@00420e39, misnamed goldman_init) queues every active slot as a
  colour-remap sprite with remap 0: seq `goldman` (MISC.ANI, 13 states) at state = age (wraps), at (x, y). Then, once
  per frame (guarded by `DAT_004621f0 != frame_counter`), `age++`, and the slot is freed when `age > 13`. So each
  twinkle shows 14 frames: states 0..12, then 0 again.
* **kface** easter egg (§3.3): `kface <facing>` sprite at (x−4, y−34), remap 0, after the bomber body.
* **Watermark** (`watermark_draw` @00429f1a): would print an Atbash-encoded string at the bottom (y = 476 − font
  height, width 640) every other 64 frames. The string is empty in retail, so nothing is drawn.

---------------------------------------------------------------------------------------------------------------

## 6. End-of-round detection (loop side)

Counters rebuilt every frame by `players_update` (cleared at its start, latched at its end):

| latched | accumulated in | counts | used by |
|---|---|---|---|
| `DAT_004621d8` = `players_exist_count()` @00421947 | `DAT_004621e4` | players with `alive(+0)=1` (alive **or dying**); team play: teams with ≥1 such member (`DAT_004621b4[2]` flags) | round continues while > 1 |
| `DAT_004621d4` / `DAT_004621dc` → `players_alive_count()` @00421969 | `DAT_004621d0`, `DAT_004621bc[2]` | players alive and not dying, **plus dying players whose death-animation state < V25 (20)**; team play: number of teams with such a member; campaign: always 2 | match loop: ≤1 → stop the round clock; bombs: fuses only tick while > 1; map_update: enclosement and regen only while > 1 |

A player's death animation advances one state per 50 ms of simulated time. The player is removed (`alive = 0`) when
the state reaches the sequence length (`die green N`, a per-death-type length). Sequence of events:

1. Player A is killed (dying flag `+8 = 1`, death animation state 0).
2. For the next 20 states (≈1 s of game time) A still counts as *alive*: bombs keep ticking, the clock and the
   enclosement keep running. If B dies in this window, both are dying and the round becomes a draw.
3. After the window `alive ≤ 1`: the round clock stops (the display freezes), every bomb fuse freezes, and the
   enclosement and tile regen stop. Flames already burning still finish.
4. The loop keeps running frames until `exist ≤ 1`, i.e. until A's death animation ends (the dying player
   disappears). That frame ends the round immediately (no extra delay). The winner is the first player (index
   order) with input ≠ OFF, (`lives(+0x68)` or `alive`) and not dying. If the clock reached 0 there is no winner
   (draw).
5. Other end conditions, checked in the same place: the clock reached 0 (draw), F10 (forced, no point).
   Campaign mode uses `g_campaign_result` instead.
6. Then the loop disables frames and plays music 0x46a. The draw screen (DRAW.PCX), results and victory screens
   follow; the match-flow doc covers them. Key acceptance on those screens needs at least
   `(net ? V13 = 3 : 1) × 1000 ms`. They auto-advance after 6000 ms when there are no human players or Alt-W was
   pressed.

---------------------------------------------------------------------------------------------------------------

## 7. Data structures and globals touched by the loop

* Sprite queue entry (24 bytes, `DAT_00460bb0`, max 400, count `DAT_00460bbc`): `+0 type (0 normal, 1 silhouette,
  2 remap-table, 3 colour index), +4 x, +8 y, +0xC frameno, +0x10 colour/remap (type 1/3), +0x14 remap table ptr
  (type 2)`. Drawing: top-left = (x − hotX, y − hotY), clipped to the current clip rect (full screen in game).
* Window: `g_main_window` `DAT_00464ae4` (GNW window 640×480). Screen size `DAT_00464a70 = 640`,
  `DAT_00464a6c = 480`. Background buffer `DAT_00460bcc`, window buffer `DAT_00460bc4`.
* Playfield origin: `x0 = (640−600)/2 = 20` (`DAT_00464898`), `y0 = 480−412 = 68` (`DAT_004648a8`), cell 40×36,
  15×11.
* Twinkle slot: `{int active, x, y, age}` ×100 at `*DAT_004621cc`.
* Ice-delay buffers: `DAT_004621c8` → 10 pointers → 30 × `{int age_ms, int dir}`.
* Joystick records: §3.3. Keydefs: §3.2. GNW `keys[]`: `DAT_004a2ba0`.

---------------------------------------------------------------------------------------------------------------

## 8. Bugs & quirks (replicate unless deliberately fixed)

1. **The round clock is wall-clock based and is not paused** by F1 help, the Alt-D window or window focus loss
   (which blocks the whole game). The time spent there is subtracted from the round when play resumes. dt-based
   objects only advance by one clamped 150 ms step.
2. **Rounds are one second short**: "2:30" shows for ~0 ms; the round ends as soon as the display would show 0:00.
   `round_timer_init` sets V100+1, which was probably meant to compensate, but `round_start` overwrites it with the
   option value (no +1).
3. First frame of every round after the first has `dt = 150` (stale `g_last_frame_time`). It eats 150 ms of the
   1000 ms start freeze and advances everything by 150 ms.
4. Unthrottled loop. Group-F counters (stun 16 frames, disease freshness 10 frames, extras and powerup animations,
   HURRY blink, twinkles) run faster on faster PCs. The ice-delay buffer (30 frames) shortens the effective ice delay
   above ~120 fps.
5. Pause is disabled (`register_pause(-1)`). The GNW "Paused" window code is dead.
6. In-game Esc does nothing outside attract mode. Quitting a game is Ctrl-Q only.
7. Alt-N is documented in MANUAL.BM but needs the `KWD` debug environment variable.
8. `keydef` scancodes from options.ini are not range-checked (out-of-bounds read of `keys[]`). Rebinding takes the
   highest held scancode, and Esc binds itself.
9. Short taps between two frames are lost (`keys[]` level sampling). Keys held through an `input_flush` read as
   released until pressed again.
10. Timer colour for ≤30 s remaining is computed but never used (the clock is sprites).
11. The `numeric font` / `hurry` / `xxx` sequence state offsets are ignored; only frame hotspots are used.
12. Goldman twinkles draw one extra frame (state 13 wraps to state 0).
13. HURRY is drawn under all colour-remapped sprites (two-layer sprite flush).
14. Dead code: `menu_inject_key` (never called), message 39, the watermark string (empty).

---------------------------------------------------------------------------------------------------------------

## 9. Uncertain

* **Original frame rate** (affects every group-F item): unknown. Best guess 25-60 fps on the 1997 target. There is no
  cap, so on modern Windows it is whatever DirectDraw emulation allows.
* Network semantics were not analysed (no agent covers networking). `FUN_0040e765` and `net_send_critical` are
  verified to return immediately when `net_mode == 0` (`DAT_00460058`), so they can be ignored for local play.
* GNW key codes (Alt-letter 0x110+, F1 0x13B, F10 0x144, Ctrl-letter 1..26) are confirmed in the US layout table
  (FUN_00435ec8). Other layouts were not checked.
* Whether DirectDraw `Lock` (flags not decoded) waits for vertical blank on some drivers. GNW95 normally uses
  `DDLOCK_WAIT` only, which does not sync to vblank.
* `text_height()` and glyph metrics of FONT6.FON are needed for exact HUD text pixels (graphics/fonts doc).
