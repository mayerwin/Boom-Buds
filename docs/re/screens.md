# Non-gameplay screens (BM95.EXE) — reverse-engineering spec

Scope: every screen that is not the in-round playfield: startup, logos, title, main menu, attract
mode, exit, online manual / credits viewer, settings ("Options") and its sub-dialogs, the match
flow screens (Goldman roulette, player/input setup, level/wins options with level preview, draw,
results, victory), network lobby screens (layout only), hidden campaign entry, the secret level
editor menu, debug windows, and the shared UI primitives they are built from.

All addresses are BM95.EXE virtual addresses. "Vnnn" = VALUELST.RES id, "msg nnn" = MESSAGES.TXT id,
"snd nnn" = SOUNDLST.RES id. Proposed function names are in `docs/re/names/screens.txt`; the old
names in `names.txt` that were wrong are noted (`results_screen` is really the whole match,
`graf_load_images` is the .BM help viewer, `team_ring_draw` is the scheme editor,
`maybe_graf_lock` restores the background, `maybe_graf_flip` flushes sprites + blits).

---------------------------------------------------------------------------------------------------

## 0. Shared conventions and primitives

### 0.1 Screen, buffers, draw order

* One GNW window `g_main_win` (0x464ae4) covering 640x480, 8-bit. All screen drawing goes into the
  **draw target** `g_draw_target` (0x460bc4), normally the main window's buffer.
* A second 640x480 **background buffer** `g_bg_buffer` (0x460bcc).
  * `graf_target_background()` (0x4151ad) makes the background buffer the draw target,
    `graf_target_screen()` (0x415189) switches back to the window buffer.
  * `graf_restore_background()` (0x415ca4, old name maybe_graf_lock) = `memcpy(window_buf, bg_buf, 640*480)`.
  * `graf_clear()` (0x415ce3) = `memset(target, 0, 640*480)` (palette index 0 = black).
* Sprites (ANI frames) are not drawn immediately: `sprite_queue(x, y, frameno)` (0x415920) appends to
  a 400-entry list; `graf_flip()` (0x415c1f) first draws all queued sprites (in queue order, each frame
  placed with its frame hotspot at (x,y), index 0 transparent, clipped to the clip rect) and then
  blits the whole main window to the display (`win_draw`). Consequence: **sprites always appear on top
  of text drawn in the same frame**, regardless of call order.
* Typical menu frame: `restore_background → draw texts / queue sprites → flip → poll input`.
* There are **no palette fades anywhere** in the screen code. All transitions are hard cuts. Screens
  shown with `screen_show_pcx` first clear the window and flip (one black frame), then show the image.
* The menu loops contain **no frame limiter** and the GNW/DirectDraw blit does not wait for vblank
  (primary surface Lock/memcpy/Unlock, no WaitForVerticalBlank). Every per-frame animation step in
  the menus (main-menu cursor, cursor blink, roulette spin, network spinner) therefore advances once per
  loop iteration, i.e. at whatever rate the machine reached (see Uncertain U1).

### 0.2 Palettes and images

Two ways of putting a full-screen PCX (DATA\RES\NAME.PCX; the code asks for "name.plt", which
`datafile_path` maps to `DATA\RES\NAME.PCX`) on screen:

1. **Own palette** — `graf_show_pcx_own_palette(path)` (0x41522d), used only through
   `screen_show_pcx` (0x42a088): loads the PCX raw (no remap), copies its 8-bit palette to
   `g_cur_palette` (0x46059c), sets the system palette to `pal >> 2` (6-bit) immediately, copies the
   640x480 pixels to the draw target. Used for: IPLOGO, HSLOGO, TITLE, DRAW, VICTORY0..9, TEAM0/1.
   After such a screen the code always calls `palette_restore_game()` (0x4150bd: copy the game palette
   0x46089c → 0x46059c and set it) after clearing the screen.
2. **Remapped** — `pcx_load_remapped(path)` (0x4150f0) / `graf_load_pcx_to_target(path)` (0x4151cc):
   loads the PCX and remaps every pixel to the *current system palette* (the game palette = COLOR.PAL,
   entry 0 forced to black):
   `out = (p == 0) ? 0 : colorTable[((r>>3)<<10) | ((g>>3)<<5) | (b>>3)]` where (r,g,b) is the PCX's
   own 8-bit palette entry p and `colorTable` is the 32768-byte inverse table stored in COLOR.PAL at
   offset 768. The palette is **not** changed. Used for MAINMENU, RESULTS, ROULETTE, GLUE0..6, WINZ,
   FIELDn (level preview), help-file images (CREDBAR, JERM, KURT, QALOGO, BOMBDUDE, POW*).
   Note GLUE0/GLUE1, RESULTS and ROULETTE have palettes very different from COLOR.PAL; they are always
   shown remapped.

Because all text screens are drawn over remapped images, **all UI text uses the game palette**.

### 0.3 UI colours

Text colours are given to GNW as `colorTable[rgb555]` lookups (byte at 0x495390 + rgb555). Resolved
against COLOR.PAL (6-bit RGB values; convert to 8-bit with the graphics spec's rule):

| name    | rgb555 request | palette index | COLOR.PAL rgb (6-bit) | global used |
|---------|----------------|---------------|-----------------------|-------------|
| WHITE   | (31,31,31)     | 72            | (60,62,63)            | 0x49d38f |
| BLACK   | (0,0,0)        | 255           | (0,0,0)               | 0x495390 |
| GREY    | (20,20,20)     | 178           | (42,42,41)            | 0x49a624 |
| CYAN    | (10,31,31)     | 97            | (24,63,63)            | 0x497f8f |
| DKRED   | (20,0,0)       | 248           | (41,0,0)              | 0x49a390 |
| YELLOW  | (31,31,10)     | 182           | (63,62,22)            | 0x49d37a |
| TEAMRED | (31,10,10)     | 254           | (63,20,20)            | 0x49d0da |
| RED     | (31,0,0)       | 242           | (63,0,0)              | 0x49cf90 |

BLACK is index 255, not 0, so black text outlines are opaque (index 0 is the transparent colour of
the text blit).

**Player text colour** `player_text_color(p)` (0x41672f): if team play → `team_text_color(team(p))`;
else `colorTable[(min(31,R/3)<<10)|(min(31,G/3)<<5)|min(31,B/3)]` where R,G,B are the player's remap
percentages (`0x460bd0/0x460bda/0x460be4[p]`). Those come from VALUELST 200..247, but are overridden
by the last 3 bytes of `<p>.RMP` when that file exists (it does in the shipped game). Resulting
indices with the shipped RMP files:

| player | RMP % (R,G,B) | rgb555 | index | COLOR.PAL rgb |
|---|---|---|---|---|
| 1 | 100,100,100 | 31,31,31 | 72  | (60,62,63) |
| 2 | 15,15,10    | 5,5,3    | 194 | (9,9,7)    |
| 3 | 100,0,10    | 31,0,3   | 242 | (63,0,0)   |
| 4 | 0,10,85     | 0,3,28   | 49  | (0,0,58)   |
| 5 | 0,100,0     | 0,31,0   | 113 | (0,63,0)   |
| 6 | 100,100,0   | 31,31,0  | 181 | (63,62,0)  |
| 7 | 0,90,95     | 0,30,31  | 94  | (0,61,62)  |
| 8 | 95,0,90     | 31,0,30  | 15  | (61,0,61)  |
| 9 | 100,50,0    | 31,16,0  | 206 | (60,36,0)  |
| 10| 50,0,100    | 16,0,31  | 37  | (28,3,59)  |

`player_text_outline_color(p)` (0x416867): if team play → BLACK; else WHITE for p == 1 (player 2,
the black bomber) and BLACK for everyone else.
`team_text_color(t)` (0x4141f8): t == 0 → WHITE, otherwise TEAMRED.

### 0.4 Font and text drawing

* Only one font is ever selected: `text_font(6)` in `graf_init` → **FONT6.FON** (GNW .FON: 128
  glyphs, line height 16, letter spacing 0). Text width = sum of glyph widths.
* `graf_print(win, str, w, x, y, fg, outline)` (0x41696c) — every UI text except the help viewer,
  GNW dialogs and buttons:
  ```
  Wt = min(textWidth(str), w)            // text is clipped to Wt pixels
  BW = Wt + 2 ; BH = fontHeight + 4      // 16 + 4 = 20
  buf = zeroed BW x BH
  draw str (max width Wt) into buf at (0,0), (2,2), (0,2), (2,0) in colour `outline`
  draw str into buf at (1,1) in colour `fg`
  if (x + BW > winWidth || y + BH > winHeight) fatal_error(0x69)   // "coords off screen"
  transparent-blit buf (index 0 transparent) to window at (x, y)
  ```
  So glyph pixels land at (x+1, y+1); the outline is the union of the four diagonal 1-px offsets.
  (The colour arguments are OR'ed with 0x2000000 for GNW's text routine; that flag has no visible
  effect here.)
* `graf_print_centered(win, str, cx, y, fg, outline)` (0x4172ba): `w = textWidth+2`,
  `x = cx - (textWidth+2)/2` (C division), then graf_print.
* Below, text items are listed as **box (x,y)** = graf_print's x,y (glyphs at +1,+1), **W** = the
  width argument.

### 0.5 Keys, joystick and mouse

Keys arrive as GNW key codes: ASCII for printable keys / Enter 0x0D / Esc 0x1B / Space 0x20 / Tab 0x09,
Ctrl-letter = 1..26 (Ctrl-A 0x01, Ctrl-B 0x02, Ctrl-D 0x04, Ctrl-E 0x05, Ctrl-F 0x06, Ctrl-Q 0x11,
Ctrl-R 0x12), extended = 0x100+scancode: F1 0x13B, F10 0x144, Up 0x148, PgUp 0x149, Left 0x14B,
Right 0x14D, Down 0x150, PgDn 0x151, Ctrl-Left 0x173, Ctrl-Right 0x174, Alt-W 0x111, Alt-O 0x118,
Alt-P 0x119, Alt-A 0x11E, Alt-D 0x120, Alt-C 0x12E, Alt-N 0x131.
GNW `get_input()` returns -1 when there is nothing and **-2 for a mouse-button event** (press or
release of either button, mask 0x33).

**`input_get_menu_key()`** (0x4102b7) — used by every menu:
1. If the injected-key FIFO (0x460174, 10 entries, filled by `input_push_menu_key` 0x410401 from the
   network) is not empty, pop and return its head.
2. Poll joysticks (`joy_poll` 0x429790: for each attached joystick `prev := cur`, read `joyGetPosEx`,
   axes normalised to 0..100 from the calibrated range; a failed read gives x=y=50, buttons=0).
   For joysticks j = 0..9 that are present, return the first edge found:
   `cur.x<=30 && prev.x>30` → Left; `cur.x>=70 && prev.x<70` → Right; `cur.y<=30 && prev.y>30` → Up;
   `cur.y>=70 && prev.y<70` → Down; `(cur.buttons&1) && !(prev.buttons&1)` → Enter.
3. Otherwise return `get_input()`.

`input_flush()` (0x41043c) clears the GNW keyboard buffer and the injected FIFO; called when a
screen starts.

Mouse: the cursor is hidden on all menus (`mouse_hide`), shown only while GNW dialogs/lists, the
keydefs screen, the help viewer (if a mouse exists) and the editor are up. On menus a click only shows
up as -2; most screens ignore it, but the draw and results screens treat -2 like Enter.

**Global GNW keys** (handled inside `get_input`, so they work on every screen and in game):
Alt-C → screen dump to file. **Alt-P does nothing**: `graf_init` calls `register_pause(-1, NULL)`
(0x414e2f), which disables GNW's default "Paused" window (verified in the original: capture
`round_altp_does_nothing.png`; see docs/re/gnw-widgets.md §6.8).

### 0.6 UI sounds (all screens)

* Every real key (anything except -1/-2) plays **snd 20 group** (letter1/letter2) *before* it is
  interpreted — including keys that do nothing, and including the synthetic Enter produced by the
  title-screen timeout. Exceptions (silent): the help viewer, the keydefs screen, the debug window and
  the GNW dialogs (list selection, text input, yes/no of the editor, pause).
* Confirm / leave a screen: **snd 10** (menuexit).
* Action refused (e.g. a network client trying to change something, toggling the team of an OFF
  player, Left/Right on a NET player): **snd 40 group** (enrt1/enrt2).
* `sound_play_group(base)` picks among the consecutive defined ids starting at base (audio spec).

### 0.7 The blinking bomber-dude cursor — `graf_cursor(x, y)` (0x413bd6)

Used by player setup, options, settings and join-net screens (the main menu uses a different cursor).
Sequence `"cursor1"` (MISC.ANI, 5 states: frames 11,12,13,14,11). Globals: state 0x460559, next blink
time 0x46055d (both persist across screens, initially 0).
```
now = time(NULL)                         // whole seconds
if (now >= nextBlink) {
    state = 1
    nextBlink = now + V690 (2) + rand() % max(V691,1) (=rand()%2)   // 2 or 3 s
} else if (state != 0) {
    state++
    if (state >= numStates("cursor1") /*5*/) state = 0
}
sprite_queue(x, y, frame of "cursor1" state `state`)
```
So the dude shows frame 11 and every 2–3 s plays frames 12,13,14,11 (one per rendered frame).
The cursor is placed at `(listX - 15 or 20, rowY + 16)` (see each screen).

### 0.8 "Press F1 for help" — `draw_press_f1_help()` (0x413fb9)

`graf_print_centered(main, msg 330 "Press F1 for help", cx=V790 (320), y=V791 (440), CYAN, BLACK)`.
FONT6 width 144 → box (247,440) 146x20, glyphs from (248,441).

### 0.9 Minimum time on screen — `screen_min_wait_secs()` (0x4148ac)

Returns 1 for local games, V13 = 3 for network games. Screens that use it accept Enter/Space only when
`start + secs*1000 < now` (ms, `timeGetTime`; `start` is clamped to `now` if the clock went backwards,
and on the options screen `start` is reset on every value change). Before that, Enter is silently
ignored (it still makes the letter sound).

### 0.10 Dialog windows (GNW)

All dialogs are separate GNW windows (colour 0x100 → filled with index 205 = (22,21,20) on creation,
modal / move-on-top) drawn over the frozen screen; when they close the screen underneath is restored by
GNW. While a dialog is up nothing else animates. Note: GNW `win_add` (0x43c734) calls `rand()` twice
per window (random initial position values), so every dialog/progress window consumes two rand()
results from the game's RNG.

* **WINZ background** `window_fill_winz(win)` (0x41726b → nine-slice 0x416b43). WINZ.PCX (72x72,
  remapped) is cut into 3x3 tiles of 24x24 (`tw = w/3, th = h/3`). Order: (1) tile the centre tile
  (src 24,24) over the whole window from (0,0) in steps of 24, clipping the last column/row;
  (2) for x = 0,24,48..: top-middle (src 24,0) at (x,0), bottom-middle (src 24,48) at (x,H-24);
  (3) for y = 0,24..: left-middle (src 0,24) at (0,y), right-middle (src 48,24) at (W-24,y);
  (4) corners TL (0,0)→(0,0), TR (48,0)→(W-24,0), BL (0,48)→(0,H-24), BR (48,48)→(W-24,H-24).
  All opaque copies.
* **GNW text button** `win_register_text_button` (0x432298), Fallout-1 GNW implementation:
  size `(textW+16) x (fontH+6)` = (textW+16) x 22; background = the window colour (windows are created
  with colour 0x100, which `win_add` turns into colorTable[wcolor[0] = (10,10,10)] = index 205 because
  no GNW texture is loaded), the *normal* image is then passed through GNW `lighten_buf`; text at
  (8,3) normal / (9,4) pressed in wcolor[3] = GREY with GNW shadow flag;
  two nested shadowed rectangles (1,1)-(w-2,h-2) and (2,2)-(w-3,h-3) in wcolor[1] (15,15,15 → idx 60)
  / wcolor[2] (8,8,8 → idx 142), swapped when pressed; 1-px BLACK border. The button sends its key
  code to `get_input` (e.g. Esc).
* **`msgbox_ok(line1, line2, fg, outline)`** (0x414340):
  ```
  w = max(textW(line1), textW(line2)) (only the non-null ones);  w = max(w, 80);  W = w + 64
  H = (both lines ? 2*fontH : fontH) + 4*fontH + 64          // 144 or 160 with FONT6
  win at ((640-W)/2, (480-H)/2), WINZ background
  line1: graf_print_centered(cx = W/2, y = fontH + 32 (=48), fg, outline)
  line2: graf_print_centered(cx = W/2, y = fontH + 32 + fontH + 2 (=66), fg, outline)
  button msg 27 " Ok " at (W/2 - 32, H - fontH - 38); release → Esc
  loop: key → letter sound; Enter, Esc or Space closes
  ```
  mouse_show/mouse_hide are called around most uses.
  Every call passes explicit colours (EAX=line1, EDX=line2, EBX=fg, ECX=outline):

  | where | line1 / line2 | fg / outline |
  |---|---|---|
  | setup validation (sec. 11) | "Problem!!" / msg 45, 46 or 48 | DKRED / YELLOW |
  | results: msg 47 | "NOTE!" / "Too many players have left the game!" | DKRED / YELLOW |
  | help not available / no help files | "NOTE!" / msg 5 or 4 | TEAMRED / YELLOW |
  | scheme chooser: no files | "NOTE!" / msg 720 | DKRED / YELLOW |
  | scheme load warnings (scheme.c) | "Warning!" or msg 725 / msgs 726, 750–753, 711 | DKRED / YELLOW |
  | keydefs defaults restored | "NOTE!" / msg 1131 | WHITE / BLACK |
  | audio placeholder (unreachable) | "PLACEHOLDER!" / msg 320 | DKRED / YELLOW |
  | memory model changed | msg 1325 / msg 1326 | DKRED / WHITE |
  | campaign: activated / prepare | "NOTE!" / msg 1210; msg 1230 / "(%s)" | WHITE / BLACK |
  | campaign: not available / congratulations / unsuccessful | "Warning!" / msg 1215; msg 1220 / 1225; msg 1240 / 1245 | DKRED / WHITE |
  | all network messages (sec. 18) | "NOTE!" or "Problem!!" / ... | DKRED / YELLOW |
  | VALUELST load error | ... | DKRED / WHITE |
* **`msgbox_yes_no(line1, line2, fg, outline)`** (0x41456c): same geometry; buttons msg 26 " Yes "
  at (W/2-80, H-fontH-38) (sends 'Y') and msg 25 " No " at (W/2+22, H-fontH-38) (sends 'N').
  Returns 1 for Enter, Space, 'Y', 'y'; 0 for Esc, 'N', 'n', 'Q', 'q'. Letter sound on every key.
* **List selection** `list_select_dialog(title, items, n, 0, x, y, color)` (0x41485a) = mouse_show +
  GNW `win_list_select_at` (0x42dbcc, Fallout-1 GNW, identical to fallout-ce's
  `_win_list_select_at`): window at (x,y), width `max(maxItemW+16, titleW) + 20`, height
  `13*fontH + 22` (10 visible items; retries with fewer rows if the window cannot be created), title
  centred in a box at the top, list area, "\x18"/"\x19" arrow buttons, "Done" button (Esc), thumb
  strip; Up/Down move the highlight, PgUp/PgDn/Home/End scroll but keep the highlighted *row*
  (highlighted row is lightened), typing a letter (only when there are more than 10 items) jumps to the
  *first* item starting with it, Enter / clicking a row selects, Esc/Done returns -1; the row under a
  resting mouse cursor gets the highlight. Item text colour is the `color` argument (WHITE;
  WHITE|0x10000 = with GNW drop shadow for the scheme and campaign lists). Pixel-exact details:
  docs/re/gnw-widgets.md §6.2.
* **Text input** `win_get_str(dest, maxlen, title, x, y)` (0x42e938, GNW, = fallout-ce `_win_get_str`):
  window at (x,y) = (25,180) in all uses (editor powertype dialogs: (25,400)), width `W = max(titleW + 12,
  text_max*(maxlen+1)) + 16` (text_max = 17 → 543 for maxlen 30, 373 for maxlen 20), at least 160,
  height `H = 5*fontH + 16`; GNW border; field background
  fill at (14, fontH+14) size (W-28) x (fontH+2) in wcolor[0]; title at (8,8) in wcolor[4]
  (31,31,11 → idx 182); shadowed frame (14, fontH+14)-(W-14, 2*fontH+16); buttons "Done" (Enter) at
  (W/2-72, H-8-fontH-6) and "Cancel" (Esc) at (W/2+8, same y); edit text at (16, fontH+16) in
  wcolor[3] on wcolor[0]. Returns 0 on OK, -1 on cancel.
* **Yes/no question** `win_yes_no(question, x, y, color)` (0x42ede0, GNW, editor only): buttons
  "Yes" ('y') / "No" ('n'); Enter/Space/y/Y = 1, Esc/n/N = 0.
* **Progress window** `progress_set_title(str)` (0x412e0c, strcpy into the 100-byte buffer 0x45bc5c,
  initially "Completion") + `progress_window_update(percent)` (0x412e33):
  ```
  h = fontH (16); hh = h/2
  first call creates win_add(150, 200, 360, 8*h, 0x100, 4)
  clamp percent to 0..100; WINZ background
  title  : graf_print(win, title, textW, (360-textW)/2, h+hh (=24), WHITE, BLACK)
  frame  : rectangle (30, 5h+hh) - (331, 6h+hh)  i.e. (30,88)-(331,104), WHITE
  "%d%%" : graf_print centred-by-hand at x=(360-textW)/2, y=3h+hh (=56), YELLOW, BLACK
  bar    : fill (31, 5h+hh+1) size (percent*3) x (h-1) GREY; rest (100-percent)*3 x (h-1) BLACK
  win_draw; if percent >= 100: win_delete, window id := -1
  ```

---------------------------------------------------------------------------------------------------

## 1. Program flow overview

```
program_main (0x42be22)
  game_init()            -- first run: memory-model list + HIGHMEM.BM/LOWMEM.BM (sec. 2)
                         -- "Loading data..." progress window (MASTER.ALI)
  title_screens()        -- IPLOGO, HSLOGO, (speech) TITLE                         (sec. 3)
  main_menu()  (never returns)                                                    (sec. 4)
     0 Start Game ─────────► valuelst_load(); match_play()                         (sec. 9)
     1 Start Network Game ─► valuelst_load(); net_start_game_screen()            (sec. 18)
     2 Join Network Game ──► valuelst_load(); net_join_game_screen()             (sec. 18)
     3 Options ───────────► settings_screen()                                     (sec. 8)
     4 About Bomberman ───► help_view_file("credits.bm")                          (sec. 7)
     5 Online Manual ─────► help_screen()                                         (sec. 7)
     6 Exit Bomberman ────► confirm_exit()                                        (sec. 6)
     idle V92 s / Alt-A ─► attract mode = match_play() with AI only               (sec. 5)
     Ctrl-E x6 ──────────► editor_main_menu()                                    (sec. 19)

match_play (0x42a3f6, old name results_screen)
  music 1020 ("win")
  match_setup (0x410f81)
     [goldman_roulette_screen if Gold Bomberman on and a gold player exists]      (sec. 10)
     player/input setup screen                                                    (sec. 11)
     match_options_screen (level + preview, wins)                                (sec. 13)
  repeat per round:
     round (in-game, background process 0x42a191; keys sec. 14)
     music 1130 ("draw")
     [draw screen if nobody won the round]                                        (sec. 15)
     results screen                                                               (sec. 16)
     [victory screen if the match is won → back to main menu]                     (sec. 17)
```

---------------------------------------------------------------------------------------------------

## 2. Startup sequence (game_init 0x41095a)

Order of visible events:
1. `win_init`, `graf_init`: 640x480 main window filled black; WINZ loaded; font 6 selected.
   Window title "Atomic Bomberman".
2. `options_init` (0x406086): **only if `options.ini` does not exist** (first run):
   `list_select_dialog(msg 1300 "Please select Bomberman memory model:", {msg 1310 "Enhanced (32mb or
   more of RAM)", msg 1311 "Normal   (Less than 32mb of RAM)"}, 2, 0, 100, 100, WHITE)` over the
   black screen. If a choice is made: small-memory flag := index, then the help viewer (sec. 7.2)
   shows `highmem.bm` (choice 0) or `lowmem.bm` (choice 1). Esc → nothing (defaults). Otherwise
   options.ini is parsed.
3. `ani_load_master`: progress window titled msg 201 "Loading data..." updated with the percentage of
   MASTER.ALI consumed, closed at 100 %. (If sound pre-caching V3/V4 were enabled a "Loading
   sound..." progress window would follow; both are 0.)
4. `title_screens()` (sec. 3).

There is **no intro movie hook**: the executable imports nothing for video (no MCI/AVI/Smacker;
only DDRAW, DSOUND, DINPUT, WINMM joystick/timer, WSOCK32).

If the environment variable **KWD** is set to a nonzero number (`g_kwd_debug` 0x460260 =
atoi(getenv("KWD")), developer flag), the two logos and the quit speech are skipped and in-game debug
keys are enabled. A remake should treat it as 0.

---------------------------------------------------------------------------------------------------

## 3. Logo and title screens

### 3.1 `screen_show_pcx(name, wait)` (0x42a088, old name pcx_load_plt)
```
graf_clear(); graf_flip();                                 // one black frame
graf_show_pcx_own_palette("DATA/RES/<name>.PCX");          // palette + pixels, instant
draw_watermark();                                          // string at 0x45bf06 is empty: draws nothing
graf_flip();
input_flush(); input_get_menu_key();                       // discard one
if (wait) {
    start = time(NULL)                                     // seconds
    loop {
        key = input_get_menu_key()
        if (start + V12 (7) < time(NULL)) key = 0x0D      // timeout: 7..8 s (second granularity)
        if (key != -1 && key != -2) play snd 20
        if (key == Enter || key == Esc || key == Space) { play snd 10; break }
    }
}
```
Mouse clicks (-2) do not dismiss. Other keys make the letter sound but do not dismiss.

### 3.2 `title_screens()` (0x42b060)
```
music_play(1000)                       // "title"
if (!g_kwd_debug) {
    screen_show_pcx("iplogo", 1)       // Interplay logo
    screen_show_pcx("hslogo", 1)       // Hudson Soft logo
}
speech_play_group(2800)                // "ATOMIC BOMBERMAN!" (random least-played of GEN8A..ZAI08G)
screen_show_pcx("title", 1)            // TITLE.PCX
graf_clear(); graf_flip(); palette_restore_game()
```
Each image: until Enter/Esc/Space or 7–8 s; dismissal plays letter + menuexit. The title music keeps
playing until the main menu starts its own.

---------------------------------------------------------------------------------------------------

## 4. Main menu (0x42b9ce)

Background MAINMENU.PCX (remapped) loaded into the background buffer. The item labels ("Start Game",
"Start Network Game", "Join Network Game", "Options", "About Bomberman", "Online Manual", "Exit
Bomberman", yellow text at x≈357, baselines ≈ every 37–38 px from y≈118) are **part of the bitmap**.

State: `sel` (0..6, starts 0), `animCounter` (starts 0, never reset), `ctrlECount`, `musicPending`.

**Entry / re-entry** (the function loops back here after every sub-screen, at 0x42b9ea):
```
idleStart = timeGetTime()
if (g_attract_mode) {                     // coming back from attract mode
    players_restore_inputs(); g_attract_mode = 0
    g_level = g_attract_saved_level; g_team_play = g_attract_saved_team_play
}
input_flush(); graf_target_background(); load MAINMENU (remapped); graf_target_screen(); mouse_hide(); input_flush()
done = 0; musicPending = 1; ctrlECount = 0
```
**Per frame:**
```
graf_restore_background()
sprite_queue(V700 (332), V701 (140) + V702 (38) * sel,
             frame of "bomb trigger green" (TRIGANIM.ANI, 19 states: frames 0..9..0) state animCounter++ % 19)
graf_print(main, "V1.0", 50, 0, 0, GREY, BLACK)         // version, top-left; glyphs at (1,1)
graf_flip()
if (musicPending) { music_play(1010 "menu"); musicPending = 0 }   // restarts on every re-entry
key = input_get_menu_key()
if (key != -1 && key != -2) { play snd 20; idleStart = timeGetTime() }
if ((key == -1 || key == -2) && V92 > 5 && timeGetTime() - idleStart > V92*1000)  → attract (sec. 5)
```
**Keys:**

| key | effect |
|---|---|
| Enter, Space | snd 10; select `sel` |
| Esc, Ctrl-Q | snd 10; select 6 (Exit) |
| F1 | snd 10; select 5 (Online Manual) |
| Alt-O | snd 10; select 3 (Options) |
| Up | sel-- (wraps 0 → 6), no extra sound |
| Down | sel++ (wraps 6 → 0) |
| Alt-A | start attract mode immediately |
| Alt-D | debug info window (sec. 20) |
| Ctrl-E | ctrlECount++; when it reaches 6: count=0, snd 10, editor (sec. 19), then re-enter menu |
| any other real key | ctrlECount = 0 (Up/Down/F1/Alt keys and -1/-2 do not reset it) |
| -2 (mouse) | nothing (also does not reset the idle timer) |

**Dispatch** after a selection (then always re-enter, which reloads the background and restarts the
menu music from the beginning):

| sel | action | sel afterwards |
|---|---|---|
| 0 | `valuelst_load(); match_play()` | 0 |
| 1 | `valuelst_load(); net_start_game_screen()` | 1 |
| 2 | `valuelst_load(); net_join_game_screen()` | 2 |
| 3 | `settings_screen()` | reset to 0 |
| 4 | `help_view_file("credits.bm")` | 4 |
| 5 | `help_screen()` | 5 |
| 6 | `confirm_exit()` (returns only on "No") | reset to 0 |

---------------------------------------------------------------------------------------------------

## 5. Attract mode

Entered from the main menu after **V92 = 30 s** without a real key (only if V92 > 5; strictly more
than V92*1000 ms since the last key / menu entry) or with Alt-A:
```
stats.attractModes++
g_attract_mode = 1
players_save_inputs()                     // input type/device of all 10 players + team-play flag
g_attract_saved_level = g_level; g_attract_saved_team_play = g_team_play
g_team_play = 0
sel = 0 → valuelst_load(); match_play()
```
Inside `match_setup` (attract branch, no screens at all, no roulette):
```
for p in 0..9: player_set_input(p, OFF, 0)
n = rand() % 10 + 1;  if (n < 3) n = 3
for p in 0..n-1: player_set_input(p, AI, 0)
g_level = rand() % max(V35, 1)            // any of the 11 levels; the V1150.. random-level mask is NOT applied
```
The round is played normally with all-AI players. **Enter or Esc during the round** abort it
(`g_gold_player=-1, g_match_end=2`); Ctrl-Q too. As soon as the round ends, match_play returns
immediately (no draw/results/victory screens, no end-of-match delay). The main menu then restores
inputs, level and team flag and restarts (menu music, sel 0).

---------------------------------------------------------------------------------------------------

## 6. Exit — `confirm_exit()` (0x412987)
```
mouse_show()
r = msgbox_yes_no(msg 10 "Are you sure you want to exit?", NULL, fg DKRED, outline YELLOW)
mouse_hide()
if (r == 1) {
    music_stop()
    if (!g_kwd_debug) { speech_play_group(2600) /*quitgame/EOFM7A.. "go outside and play"*/; Sleep(4000) }
    fatal_error(0)    // win_exit, run deinit callbacks (options.ini and bmstats are written), exit(0)
}
```
The yes/no box is 1 line: W = textW(msg 10) + 64, H = 144, centred. During the 4 s the screen is
frozen (the dialog has already closed, main menu image visible).

---------------------------------------------------------------------------------------------------

## 7. Online manual, help files and credits

### 7.1 `help_screen()` (0x41431c) / `help_choose_file(pattern)` (0x414235)
```
if (V15 == 0) { msgbox_ok(msg 95 "NOTE!", msg 5 "Online Help is not available in this version.", TEAMRED, YELLOW); return }
names = find_files_upper("*.BM")        // current dir, FindFirst/FindNext order, names upper-cased
if (!names) { msgbox_ok("NOTE!", msg 4 "Unable to find any online help files.", TEAMRED, YELLOW); return }
loop {
    i = list_select_dialog(msg 600 "Available help files:", names, n, 0, 100, 100, WHITE)
    if (i == -1) break
    help_view_file(names[i])
}
```
Shipped files (alphabetical on NTFS): CREDITS.BM, EDITOR.BM, HIGHMEM.BM, INPUT.BM, LOWMEM.BM,
MANUAL.BM, NETWORK.BM, OPTIONS.BM, README.BM, ROULETTE.BM. Reached by main-menu item 5 / F1 and by F1
on most screens (except on a network client).

### 7.2 `help_view_file(filename)` (0x41302d, old name graf_load_images) — the .BM viewer
Credits ("About Bomberman") = `help_view_file("credits.bm")`.

**Window:** `win_add(20, 20, 600, 440, 0x100, 4)`.

**Loading:**
* Pass 1 counts lines (fgets, max 255 chars). Pass 2 stores each line after removing '\n' and
  expanding tabs with this exact (quirky) algorithm:
  ```
  col = 0
  for each char c until NUL or col >= 255:
      if (c == TAB) { do { out ' '; col++ } while (col % 4 != 0) }
      else out c
      col++                         // also after a TAB  → each TAB leaves col one ahead of the output
  ```
* In each stored line every `<IMGname>` tag (literal "<IMG", name up to '>') registers an image:
  `DATA\RES\name.PCX` loaded remapped. Image table: up to 100 entries of 32 bytes
  {name[20], +0x14 pixels, +0x18 width, +0x1c height}; a missing file is not registered.
* If the file cannot be opened the text is the 2 lines "unable to open file:" and the filename.

**Layout:** `pageLines = 344 / fontH = 21`; text area origin (34,34); line k of the page at
y = 34 + 16k; max text width 532. Buttons (GNW text buttons) at y = 388: "\x18" (↑ glyph) at x=30 →
Up, "\x19" at x=60 → Down, "Page \x18" at x=120 → PgUp, "Page \x19" at x=190 → PgDn, "Done" at x=516 → Esc.
Mouse cursor shown if a mouse exists.

**Rendering** (only when dirty: on open and after each scroll):
```
window_fill_winz(win)
for k = -16 .. pageVisible+15:                 // pageVisible = min(21, nLines - top)
    i = top + k; if (i < 0 || i >= nLines) continue
    line = copy of text[i]
    if (no "<IMG" in line) {
        if (0 <= k < pageVisible) draw line with GNW text_to_buf at (34, 34+16k), width 532, WHITE, no outline
        continue
    }
    x = 34; remain = 532; y0 = 16k + 34
    for each segment: text before the next tag:
        if (0 <= k < pageVisible) draw it at (x, y0) (width remain, WHITE)
        x += textW(seg); remain -= textW(seg)
        image = lookup tag name (case-insensitive compare) in image table
        if found:
            y = y0 - (img.h - fontH)/2               // vertically centred on the text line
            if (y + img.h >= 34 && y <= winH - 62 (378)):
                h = img.h; src = img.pixels
                if (y < 34) { src += (34-y)*img.w; h -= 34-y; y = 34 }
                w = min(img.w, remain)
                if (y + h > 378) h = 378 - y
                transparent blit (index 0) w x h at (x, y), src pitch img.w
            x += img.w; remain -= img.w             // even if clipped / not drawn
win_draw(win)
```
Lines in the 16-line margins above/below the page are processed only so that tall images from
neighbouring lines can poke into the visible area; their text is not drawn.

**Keys:** Enter or Esc → close. Up → top-- (if top > 0). Down → top++, clamped to
`max(0, nLines - 21)`. PgUp or Left → top -= 20, min 0. PgDn or Right → top += 20, clamped as Down.
No sounds. After closing, all images and lines are freed.

---------------------------------------------------------------------------------------------------

## 8. Settings screen (main menu "Options") — `settings_screen()` (0x4080dc)

Background: random glue (`graf_show_random_glue` 0x4148e5: `glue<rand() % max(V16,1)>.pcx`, i.e. one of
GLUE0..GLUE6, remapped into the background buffer), restore, flip, `input_flush`. No music change.
18 rows (index 0..17); a 19th case (msg 268 "Adjust Audio" → `settings_audio_placeholder`, shows
"PLACEHOLDER!"/"Audio Adjustment screen will be here...") exists in the switch but is neither drawn nor
reachable.

**Per frame:** restore background, poll joysticks, draw 18 rows with
`graf_print(main, text, W=V748 (500), x=V745 (55), y=V746 (40) + V747 (22)*i, WHITE, BLACK)`,
`graf_cursor(V745-20 = 35, 40 + 22*sel + 16)`, Press F1 for help, flip.

| i | text (msg) | value |
|---|---|---|
| 0 | 250 "Team Play: %s" | msg 25+teamPlay (" No "/" Yes ", note the embedded spaces) |
| 1 | 251 "Random Start: %s" | random start (V40 default) |
| 2 | 252 "Node Name: '%s'" | network node name |
| 3 | 253 "Conveyor Speed: %s" | msg 295+speed: Low/Medium/High (0..2) |
| 4 | 254 "Stomped Bombs Detonate: %s" | V46 default |
| 5 | 255 "Win Matches By Kill Total: %s" | kill mode |
| 6 | 256 "Gold Bomberman: %s" | gold option |
| 7 | 257 "Enclosement Depth: %s" | msg 315+depth: None / A Little / A Lot / All the way! (0..3) |
| 8 | 258 "Scheme File: %s" | g_scheme_filename (e.g. BASIC.SCH) |
| 9 | 259 "Play Time: %s" | `settings_playtime_string`: msg 280 "Infinite" if 1001 else msg 281 "%u:%02u" (t/60, t%60) |
| 10 | 260 "Assign Keyboard Player: %s" | V14 default |
| 11 | 261 "Diseases Can Be Destroyed: %s" | V120 default |
| 12 | 262 "Lost net players revert to AIs: %s" | |
| 13 | 263 "Disable music during gameplay: %s" | |
| 14 | 264 "Modem:  P:%u  I:%u  B:%u  #:%s" | port, IRQ, baud, phone |
| 15 | 265 "Define keyboard layouts" | |
| 16 | 266 "Set Default Network Protocol" | |
| 17 | 267 "Use Enhanced Memory Model: %s" | msg 25 + (smallMemory == 0) |

**Keys:** Up/Down move with wrap (0↔17). Esc → leave (sets the round timer from the play time:
`timer_set(g_play_time_secs)`), back to the main menu (sel reset to 0). F1 → help.
Enter, Space and **Right** = "increment/activate"; **Left** = "decrement/activate". No confirm sound
(only the letter sound).

| row | Enter/Space/Right | Left |
|---|---|---|
| 0 | toggle team play; g_gold_player=-1; if now on → kill mode := 0 | same |
| 1 | toggle random start | same |
| 2 | node name dialog: `win_get_str(buf=current, 30, msg 290 "Enter new node name:", 25, 180)`; OK → set | same |
| 3 | speed+1, wraps to 0 after V189-1 (2) | speed-1, wraps to 2 |
| 4 | toggle | same |
| 5 | toggle kill mode; forced 0 if team play | same |
| 6 | toggle gold; g_gold_player=-1 | same |
| 7 | depth+1, wraps after V28-1 (3) | depth-1, wraps to 3 |
| 8 | scheme file chooser (8.2) | same |
| 9 | play time next (8.1) | play time previous |
| 10–13 | toggle | same |
| 14 | modem dialogs (8.4) | same |
| 15 | keyboard layouts screen (8.3) | same |
| 16 | protocol list (8.4) | same |
| 17 | memory model change (8.4) | same |

Settings are persisted in `options.ini` by a deinit callback (0x405de3) when the program exits
(keys levelno, num_to_win_match, enclosement_depth, conveyor_speed, team_play, random_start,
stomped_bombs_detonate, win_by_kills, goldman, schemefilename, playtime, assign_keyboards,
diseases_destroyable, lost_net_revert_ai, disable_game_music, modemport, modembaud, modemirq,
modemdial, netprotocol, smallmemory, keydef=layout,action,scancode).

### 8.1 Play time list — `settings_playtime_step(dir)` (0x4076fe)
Values in seconds: 60, 90, 120, 150, 180, 240, 300, 600, 1001(=Infinite).
`dir >= 1`: 60→90→120→150→180→240→300→600→1001→60. `dir < 1`: 1001→600→300→240→180→150→120→90→60→1001.
A value not in the list is reset to V100 (150). Displayed as "1:00", "1:30", ... "10:00", "Infinite".

### 8.2 Scheme file chooser — `options_choose_scheme()` (0x407582)
`find_files_upper("DATA\SCHEMES\*.SCH")`; none → `msgbox_ok("NOTE!", msg 720 "No Scheme files found!", DKRED, YELLOW)`.
Each item = `"%s: %s"` (file name, internal scheme name read from the file). mouse_show,
`list_select_dialog(msg 721 "Available Scheme Files:", items, n, 0, 100, 100, WHITE|0x10000)`, mouse_hide.
On selection: cut the item at ':' and copy the file name (upper-cased) to `g_scheme_filename`.

### 8.3 Keyboard layouts — `keydefs_screen()` (0x407b9d)
Drawn over the settings glue (restore background each frame), mouse cursor shown.
* Title: `graf_print(main, msg 1100 "Keyboard definitions", 400, 20, 20, YELLOW, BLACK)`.
* 12 GNW text buttons (registered on the first frame): layout L = 0,1 and action a = 0..5 at
  `(100 + 320*L, 60 + 60*a)`, label `sprintf(msg 1110 "Key %u, %s", L, msg 1120+a)` (Move Up, Move Right,
  Move Down, Move Left, Action 1, Action 2), **mouse-down** code `1000 + 1000*L + a`.
* Under each button: if `(scancode & 0x7f) < 0x59`:
  `graf_print(main, sprintf(msg 1140 "Key: '%s'", g_scancode_names[scancode & 0x7f]), 200,
  100 + 320*L, 60 + 60*a + 22, WHITE, BLACK)`.
* Button msg 1130 "Return to default keys" at (40, 430), code 999.
* Keys: Enter/Esc/Space → leave (buttons unregistered, mouse hidden). F1 → help.
  Code 1000..2998 → `keydefs_capture_key(sprintf("Key %u, %s", L, action))` and store the returned
  DirectInput scan code into `keydefs[L][a]` (0x4645bc + L*0x28 + a*4). Code 999 →
  `keydefs_set_defaults()` + `msgbox_ok("NOTE!", msg 1131 "Default key controls restored", WHITE, BLACK)`.
* `keydefs_capture_key(label)` (0x407ad9): progress window titled `sprintf(msg 1105 "Press key for
  '%s'", label)` drawn at 0 % (so it shows "0%" and an empty bar), wait 500 ms (pumping), flush, then
  poll until Esc (returns 0 = unassigned) or any key is down in the DirectInput state array
  (returns the highest-numbered pressed scan code of that poll); close the window (100 %).
* Defaults (`keydefs_set_defaults` 0x40614a): layout 0 = Up 200, Right 205, Down 208, Left 203,
  Action1 0x39 (Space), Action2 0x1C (Enter); layout 1 = R(0x13), G(0x22), F(0x21), D(0x20), S(0x1F),
  A(0x1E) — Action2 is Q(0x10) on an AZERTY keyboard layout.
* Scan code names (`g_scancode_names`, index = scancode & 0x7f; index 0 and 0x54..0x56 are ""):
  01 Esc, 02..0B "1".."9","0", 0C "-_", 0D "+=", 0E BS, 0F Tab, 10..19 Q W E R T Y U I O P, 1A "[{",
  1B "]}", 1C Enter, 1D Ctrl, 1E..26 A S D F G H J K L, 27 ";", 28 "'", 29 "`~", 2A LShift, 2B "\|",
  2C..32 Z X C V B N M, 33 ",<", 34 ".>", 35 "/?", 36 RShift, 37 "(*)", 38 Alt, 39 Space, 3A Caps,
  3B..44 F1..F10, 45 Num, 46 Scroll, 47 "(7)Home", 48 "(8)Up", 49 "(9)PgUp", 4A "(-)", 4B "(4)Left",
  4C "(5)", 4D "(6)Right", 4E "(+)", 4F "(1)End", 50 "(2)Down", 51 "(3)PgDn", 52 "(0)Ins", 53 "(.)Del",
  57 F11, 58 F12. (So the default arrow keys display as "(8)Up" etc.)

### 8.4 Other settings dialogs
* **Modem** (`settings_modem_dialogs` 0x40798b): `win_get_str(port "%u", 20, msg 645 "Enter Port Number (1
  to 4)", 25, 180)`; `win_get_str(irq, 20, msg 646 "Enter IRQ (1 to 7)", 25, 180)`;
  `list_select_dialog(msg 647 "Select Baud Rate", {"9600","19200","38400","57600","115200"}, 5, 0, 100, 100, WHITE)`; `win_get_str(phone, 30, msg 648 "Enter Phone Number", 25, 180)`.
* **Protocol** (`settings_choose_protocol` 0x407f4f): items msg 629 "Prompt each time", 631 IPX,
  632 Modem, 633 Serial, 634 TCP/IP but only V1110 = 4 shown (TCP/IP is cut off);
  `list_select_dialog(msg 620 "Please select network protocol:", items, 4, 0, 150, 150, WHITE)`;
  result kept if 0..3.
* **Memory model** (`settings_memory_model` 0x407fee): mouse shown; `msgbox_yes_no(msg 1322, msg 1323)`
  (currently enhanced → normal) or `(msg 1320, msg 1321)` (→ enhanced), DKRED / WHITE; Yes →
  `msgbox_ok(msg 1325 "Memory Model Changed!", msg 1326 "Now exiting.  Click below.", DKRED, WHITE)`,
  flag toggled, `fatal_error(0x14)` (exit, options saved).

---------------------------------------------------------------------------------------------------

## 9. Match flow — `match_play()` (0x42a3f6)

```
g_campaign_mode = 0; game_set_paused(1); 100 x net_send_critical()
music_play(1020)                                  // "win" = setup music
match_setup()                                     // sec. 10, 11, 13
if (g_match_end) return                           // Esc on a setup screen → main menu
level_load_round()  /* maybe_level_load 0x410b6e */ // engine; field, level music
add_bk_process(game_frame 0x42a191); game_set_paused(0)
g_auto_continue = 0
loop {                                            // one iteration per get_input() call
    g_round_aborted_f10 = 0
    key = get_input()  → in-round keys, sec. 14
    if (players/teams alive <= 1) stop round timer
    if (campaign) {...}                            // sec. 12
    if (!f10Abort && alive > 1 && !round_time_up()) continue      // round still running
    if (g_attract_mode) goto finish_no_delay
    music_play(1130 "draw"); game_set_paused(1)
    winnerName = "Error..."; w = round_winner_name(winnerName)   // "Player %u"/"Team %u"/"undetermined"
    if (w == -1) draw_screen()                    // sec. 15 (also when the round timed out)
    if (!g_match_end) results_screen_part()       // sec. 16 (+ victory sec. 17, or next round)
    if (g_match_end) break
}
net notify; 10 x { net_send_critical(); delay_pumping(100) }       // ~1 s pause, screen unchanged
finish_no_delay: close debug remap window; stop round timer; remove_bk_process(game_frame)
```
`g_match_end` (0x464a68): 0 = continue, 1 = match won (normal end), 2 = aborted (Esc/Ctrl-Q/error),
10 = campaign finished.

---------------------------------------------------------------------------------------------------

## 10. Goldman roulette ("Bonus Game") — `goldman_roulette_screen()` (0x4034bc)

Called first in `match_setup` when not attract mode, local game (net mode 0), **Gold Bomberman option
on** and `g_gold_player != -1` (set by the results screen when the previous match was won, sec. 16).
Background ROULETTE.PCX ("BONUS GAME" art, remapped) into the background buffer. Music stays "win".

**Geometry:** N = V1004*6 = 420 positions on an ellipse. For position p:
```
a = p * V1006 (1) * 3.14159265 * 2.0 / N        // double; constant 3.14159265 (0x400921FB4D12D84A)
X(p) = trunc(V1000 (320) + V1002 (200) * cos(a))
a' = p * V1007 (1) * 3.14159265 * 2.0 / N
Y(p) = trunc(V1001 (240) - V1003 (150) * sin(a'))
```
(trunc = x87 round-toward-zero.) Increasing p moves counter-clockwise on screen.
Prize table (0x45b7bc): `{0 bomb, 1 flame, 3 kick, 8 goldflame, 4 skate, 13 clog}`; slot k sits at
wheelPos + k*70.

**Init** (rand() calls in this order):
```
result = -1
dir = (rand() % 2) * 2 - 1                // +1 or -1
state = 0
wheelPos = rand() % 420
ringPos  = rand() % 420
wheelSteps = rand() % 20 + 20             // 20..39
ringSteps  = rand() % 20 + wheelSteps     // 20..58
```
**Per frame:**
```
graf_restore_background(); joy_poll()
if (ringSteps > 0) repeat max(6, ringSteps) times {         // count fixed at frame start
    ringPos += dir; wrap into [0,420)
    if (ringPos % 70 == 0) { play snd 1300 (tick "1041"); if (state == 1 && --ringSteps == 0) break }
}
if (wheelSteps > 0) repeat max(6, wheelSteps) times {
    wheelPos -= dir; wrap into [0,420)
    if (wheelPos % 70 == 0 && state == 1 && --wheelSteps == 0) break
}
for k in 0..5: p = (wheelPos + 70k) mod 420; sprite "power <name of prize[k]>" frame 0 at (X(p), Y(p))
sprite "ring" (MISC.ANI frame 2) at (X(ringPos), Y(ringPos))        // queued after → on top
if (state == 2) {
    graf_print_centered(main, msg 790 "The Gold Player has", 320, 240-20, WHITE, BLACK)
    graf_print_centered(main, msg 800+result,             320, 240,    WHITE, BLACK)
    graf_print_centered(main, msg 791 "for the next match!!", 320, 240+20, WHITE, BLACK)
}
draw_press_f1_help(); graf_flip()
if (wheelSteps == 0 && ringSteps == 0) {
    if (result == -1) {
        q = ringPos; if (ringPos < wheelPos) q += 420
        result = prize[(q - wheelPos) / 70]
        play snd (result == 13 ? 1320 /*buzzer*/ : 1310 /*clapping*/)
    }
    state = 2
}
key = input_get_menu_key(); real key → snd 20
Enter/Space: if (state == 0) state = 1;  if (state == 2) leave
Esc: g_gold_player = -1; g_match_end = 2; leave           // aborts the whole match → main menu
F1: help (net client: snd 40)
```
While spinning (state 0) the speeds are constant (ring 20–58, wheel 20–39 positions per frame, opposite
directions). After the first Enter each slot boundary passed decrements the respective counter, so both
decelerate (never below 6 positions/frame) and stop exactly on a slot boundary; the ring therefore ends
exactly on a prize. Prize texts: 800 "an extra bomb", 801 "longer flame length", 803 "the ability to
kick bombs", 808 "goldflame", 804 "extra speed", 813 "a speed brake (slowness)".
`roulette_get_result()` (0x403a9c) returns `result` to the player code (who gets it: player spec).
VALUELST 805 (title position) and msg 650 "Goldman Roulette Wheel" are not used. During the next match
the gold player(s) sparkle with the "goldman" animation for V1010 = 5 s (player/HUD spec).

---------------------------------------------------------------------------------------------------

## 11. Player / input setup screen (inside `match_setup` 0x410f81)

Preparation: `players_net_to_off()` for local games; on the first match after a network session the
inputs are reset (network details omitted); `players_reset_match()` (0x421793: scores and kills := 0,
start slots shuffled when Random Start is on; match-flow spec); AI init; `graf_show_random_glue()`; `input_flush()`. `sel` starts at 0, `cCount` 0.

Player record (g_players 0x461bc4, 10 x 0x98 bytes): +0x10 byte input type (0 OFF, 1 AI, 2 KEY,
3 JOY, 4 NET), +0x11 byte device (key layout 0/1 or joystick number), +0x54 byte team (0/1, initially
`p & 1`). Defaults (`players_assign_default_inputs` 0x42123f at start-up): walking players 0..9 that
are OFF with a counter j of OFF players: if joystick j is present → JOY j; else if no keyboard player
was assigned yet and "Assign Keyboard Player" is on → KEY 0 (only once); else if p == 1 → AI.
With no joystick: Player 1 = KEY 0, Player 2 = AI, others OFF.

**Per frame:**
```
(net client and connection lost → "server bailed" msgbox, abort)
graf_restore_background(); joy_poll()
graf_print(main, msg 50 "Available players:", W=V708 (200), V705 (40), V706 (140), WHITE, BLACK)
for p in 0..9:
    s = type 1 "AI" (221) | 2 sprintf(222 "KEY %u", dev) | 3 sprintf(223 "JOY %u", dev) | 4 "NET" (224) | else "OFF" (220)
    text = sprintf(msg 51 "Player %u: %s", p+1, s)          // dev is printed 0-based: "KEY 0", "JOY 0"
    (team play flag temporarily cleared so colours are the player's own)
    graf_print(main, text, W=V713 (150), V710 (70), V711 (170) + V712 (24)*p,
               player_text_color(p), player_text_outline_color(p))
    if (p == sel) graf_cursor(V710 - 15 = 55, 170 + 24*p + 16)
    if (team play) graf_print(main, msg 230 "TEAM", textW("TEAM"), V710+V713 (220), 170 + 24*p,
                              team_text_color(team(p)), BLACK)
graf_print(main, msg 40 "Available Joysticks:", W=V718 (170), V715 (300), V716 (140), WHITE, BLACK)
for j in 0..9:
    t = joystick j present ? sprintf(msg 41 "Joy %u - %s", j, joystickName(j)) : ""
    graf_print(main, t, W=V723 (320), V720 (320), V721 (170) + V722 (24)*j, WHITE, BLACK)
if (no joystick) graf_print(main, msg 42 "None Detected", 320, 320, 170, WHITE, BLACK)
if (not net client) draw_press_f1_help()
graf_flip()
key = input_get_menu_key(); real key → snd 20
```
**Keys** ("client" = network client; "sync" = the change is also sent to the other machines):

| key | effect |
|---|---|
| Up / Down | sel -1 / +1, wraps 0↔9 |
| Right | if type == NET → snd 40; else `player_cycle_input(sel)`, sync |
| Left | if type == NET → snd 40; else set OFF (type 0, dev 0), sync |
| '0', 'O', 'o' | client → snd 40; else set OFF, sync |
| 'T', 't' | client → snd 40; if sel is OFF → snd 40; else team := (team == 0 ? 1 : 0), sync |
| Ctrl-A | local game only: all 10 players := AI (dev 0) |
| 'C', 'c' | local game only: cCount++; when cCount == 5 → campaign selection (sec. 12), cCount = 0 (never reset otherwise) |
| Enter, Space | client → snd 40; else if min wait (0.9) not elapsed → ignore; else **validate** |
| net 0x385 | (received from the server) validate immediately |
| Esc | g_gold_player = -1; snd 10; abort match (g_match_end = 2), tell the network |
| F1 | client → snd 40; else help |
| Alt-D | client → snd 40; else debug info window |

`player_cycle_input(p)` (0x421e80): OFF → AI → KEY 0 → KEY 1 → JOY 0 → JOY 1 … (while present) → OFF.
From OFF, AI is skipped (→ KEY 0) on a network client or in campaign mode. NET is never produced.
(JOY n advances to n+1 if present, else OFF; from KEY 1 it goes to JOY 0 if present else OFF.)

**Validate:**
```
if (net client) players_resolve_input_conflicts()      // clear duplicate KEY/JOY devices
else if (players_count_input_conflicts() != 0) {       // two players with the same KEY n or JOY n
    mouse_show(); msgbox_ok(msg 96 "Problem!!", msg 45 "More than one player selected to an input device!", DKRED, YELLOW); mouse_hide()
    stay
}
if (!campaign && players_count_sides() < 2) {          // active players, or distinct teams with team play
    msgbox_ok("Problem!!", team play ? msg 48 "Must have at least one player on each team!"
                                     : msg 46 "Must have at least two players selected!", DKRED, YELLOW)
    stay
}
snd 10; leave (server also sends 0x385)
```
Then `match_options_screen()` (sec. 13) and the campaign hook.

---------------------------------------------------------------------------------------------------

## 12. Hidden campaign mode (entry screens only)

`campaign_select_screen()` (0x4015c6), from 'C' x5 on the setup screen:
`find_files_upper("DATA\RES\*.CAM")` (shipped: CROUTON.CAM, GHOSTS.CAM, SIMPLE.CAM); none →
`msgbox_ok(msg 97 "Warning!", msg 1215 "Campaigns not available! (no CAMP*.RES files)", DKRED, WHITE)`.
Else `list_select_dialog(msg 1250 "Please select a campaign file:", files, n, 0, 100, 100, WHITE|0x10000)`;
on a choice: load it, `msgbox_ok(msg 95 "NOTE!", msg 1210 "Campaign Mode Activated!", WHITE, BLACK)`,
`g_campaign_mode = 1`, all players reset for campaign. In campaign mode the options screen is skipped,
each level start shows `msgbox_ok(msg 1230 "Prepare to begin Campaign!", sprintf(msg 1235 "(%s)",
levelName), WHITE, BLACK)`, the end shows `msgbox_ok(msg 1220 "Congratulations!", msg 1225 "You made it
through the whole campaign!", DKRED, WHITE)`, a failure `msgbox_ok(msg 1240 "Oh Well!", msg 1245
"Campaign unsuccessful!", DKRED, WHITE)`. (Campaign gameplay is outside this spec.)

---------------------------------------------------------------------------------------------------

## 13. Match options screen (level + wins) — `match_options_screen()` (0x406dde)

Skipped in campaign mode. New random glue background, restore, flip. Working copies:
`optLevel = g_level` (-1 = random), `optWins = g_wins_to_win`. 2 rows (`sel` 0 = level, 1 = wins),
`previewDirty = 1`, `start = timeGetTime()`.

**Per frame:**
```
graf_restore_background(); joy_poll()
graf_print(main, sprintf(msg 210 "%s", msg 150+optLevel), W=V738 (300), V735 (55), V736 (170), WHITE, BLACK)
        // optLevel -1 → msg 149 "Random Each Game"; 0..10 → Green Acres .. Inner City Trash
graf_print(main, sprintf(msg 211 "%u %s to win match", optWins, msg 208+killMode ("Wins"/"Kills")),
           300, 55, 170 + V737 (24), WHITE, BLACK)
if (not client) graf_cursor(V735 - 20 = 35, 170 + 24*sel + 16)
if (previewDirty) { options_level_preview(); previewDirty = 0 }   // draws into the BACKGROUND buffer
if (not client) draw_press_f1_help()
graf_flip()
(client: adopt level/wins from the server; any change resets `start`, level change sets previewDirty)
key = input_get_menu_key(); real key → snd 20
```
(The preview drawn in a frame becomes visible on the next frame, after the next background restore.)

**Keys** (client: every key below except Esc → snd 40):

| key | row 0 (level) | row 1 (wins) |
|---|---|---|
| Left | level-1; below -1 → V35-1 (10); previewDirty; start = now | wins-1, min 1; start = now |
| Right | level+1; ≥ V35 → -1 (Random); previewDirty; start = now | wins+1, max 100; start = now |
| Ctrl-Left | — | wins-5, min 1 |
| Ctrl-Right | — | wins+5, max 100 |
| Up / Down | sel ∓1 with wrap (0↔1) | |
| Enter / Space | if min wait elapsed since `start`: snd 10; g_level = optLevel; g_wins_to_win = optWins; leave | |
| net 0x386 | commit as above (client) | |
| Esc | g_gold_player = -1; abort match (g_match_end = 2) | |
| F1 / Alt-D | help / debug window | |

Values are sent to clients on every change.

### 13.1 Level preview — `options_level_preview()` (0x406aa3)
Draws into the background buffer (then switches back to the screen). X=V730 (400), Y=V731 (100),
XS=V732 (5), YS=V733 (5) blocks; cell 40x36.
```
lvl = optLevel >= 0 ? optLevel : rand() % max(V35,1)
img = pcx_load_remapped("field<lvl>.pcx")
if (img) {
    fill rect (X-22, Y-20) size (XS*40+24) x (YS*36+22) WHITE          // = (378,80) 224x202
    copy (opaque) from img at (0, 48), size (XS*40+20) x (YS*36+18), to (X-20, Y-18)   // (380,82) 220x198
}
for r in 0..YS-1: for c in 0..XS-1:
    kind = none
    if (c odd && r odd)            kind = "solid"
    else if (c > 1 || r > 1)       { if (rand() % 5 != 0) kind = "brick" }   // 80 %
    if (kind) {
        t = optLevel >= 0 ? optLevel : rand() % max(V35,1)     // random level: EVERY tile from a random level
        frame = frame 0 of sequence sprintf("tile %u %s", t, kind)
        transparent blit of the frame bitmap, 40x36, pitch 40, at (X + 40c, Y + 36r)   // hotspot NOT applied
    }
```
The top-left 2x2 corner minus (1,1) stays empty (player start). rand() is consumed on every redraw,
so the brick pattern changes each time the level selection changes.

---------------------------------------------------------------------------------------------------

## 14. Keys handled by the match loop during a round (cross-module, summary)

The round itself runs in the GNW background process 0x42a191 (engine spec); match_play's loop reads
`get_input()` (not input_get_menu_key, so no joystick menu edges here):

| key | effect |
|---|---|
| Enter, Esc | **attract mode only**: abort (g_gold_player = -1, g_match_end = 2). In a normal game: nothing |
| Ctrl-Q | abort the match → main menu (any mode) |
| F10 | (not on a net client) end the round now: g_round_aborted_f10 = 1, sent to clients. With KWD in campaign: skip level |
| F1 | local game: pause game, online manual, unpause |
| Alt-W | g_auto_continue = 1 for the rest of the match (post-round screens auto-advance after 6 s) |
| Alt-D | debug info window |
| Alt-N | KWD only: append network byte statistics to a text file (nothing on screen) |
| Ctrl-A / Ctrl-R | KWD only: animation list dialog (writes anims.lst) / colour remap editor |
| Ctrl-D | debug-log control (closes the debug log, re-read from CFG next time; nothing on screen) |
| Alt-P | nothing (GNW pause key disabled, see 0.5) |

---------------------------------------------------------------------------------------------------

## 15. Draw screen ("DRAW GAME")

When `round_winner_name()` returns -1 (no surviving player/team, or the round timer ran out):
```
screen_show_pcx("draw", 0)               // DRAW.PCX with its own palette, no wait inside
speech_play_group(1700)                  // tie-game lines (gump1, GEN11A, ...)
start = timeGetTime(); input_flush()
loop {
    net_send_critical()
    key = input_get_menu_key(); real key → snd 20
    if (net client && connection lost) key = Esc
    if ((players_no_humans() || g_auto_continue) && timeGetTime() > start + 6000) key = Enter
    if (key == Esc) { g_match_end = 2; break }               // abort match
    if (key == Enter || key == Space || key == -2 /*mouse*/) {
        if (net client) play snd 40
        else if (start + secs*1000 < now /*0.9*/) { snd 10; server sends 0x388; break }
    }
    if (key == 0x388 /*from server*/) { snd 10; break }
}
graf_clear(); graf_flip(); palette_restore_game()
```
Music: 1130 "draw" (started at the round end). The results screen follows.

---------------------------------------------------------------------------------------------------

## 16. Results screen

```
graf_load_pcx_to_target("results")      // RESULTS.PCX remapped, straight into the window buffer
matchWinner = -1
if (!g_round_aborted_f10) {
    graf_print(main, sprintf(msg 30 "Game Winner was %s !", winnerName), W=V783 (400), V780 (150), V781 (140), WHITE, BLACK)
          // winnerName = "Player %u" (index+1) / "Team %u" (team+1) / "undetermined"
    player_award_points(1)               // +1 victory to the round winner (copied to team mates)
}
maxKills = max over all 10 players of kills; nMax = number of players (all 10) with kills == maxKills
rows = 0
if (team play) for t in 0..1:
    p = first player with type != OFF and team == t; if none: continue
    rows++
    graf_print(main, sprintf(msg 38 "Team %u score: %u", t+1, score(p)), 400, V785 (150), V786 (210) + V787 (20)*t,
               team_text_color(t), BLACK)
    if (score(p) >= g_wins_to_win) matchWinner = t
else for p in 0..9 with type != OFF:
    rows++
    graf_print(main, sprintf(msg 31 "Player %u score: %u (kills: %d)", p+1, score(p), kills(p)), 400,
               150, 210 + 20*p, player_text_color(p), player_text_outline_color(p))   // row slot = player index (gaps for OFF players)
    if (killMode) { if (maxKills >= g_wins_to_win && nMax == 1 && kills(p) == maxKills) matchWinner = p }
    else if (score(p) >= g_wins_to_win) matchWinner = p
graf_flip()
if (matchWinner == -1) {
    graf_print(main, sprintf(msg 120+killMode "(Match winner must score %u victories|kills)", g_wins_to_win),
               W=V803 (400), V800 (150), V801 (94), GREY, BLACK); graf_flip()
} else {
    if (local game && gold option) g_gold_player = team play ? (team(player index matchWinner) != 0 ? 2 : 0) : matchWinner
    else g_gold_player = -1
    speech_play_group(2000)                         // "we have a winner"
    delay_pumping(1500)                             // screen frozen 1.5 s
    text = killMode ? sprintf(msg 36 "PLAYER %u WINS THE MATCH!", matchWinner+1)
                    : sprintf(msg 35 "%s WINS THE MATCH!", winnerName)
    graf_print(main, text, 400, 150, 94, CYAN, BLACK); graf_flip()
}
wait loop: identical to the draw screen's loop (auto Enter after 6000 ms if no humans or Alt-W;
           Esc aborts the match; Enter/Space/mouse after the minimum wait; client needs net key 0x387;
           a lost connection shows the "server bailed" msgbox and acts as Esc)
if (g_match_end) → end
if (matchWinner != -1) victory screen (sec. 17)
else if (rows < 2) { msgbox_ok(msg 95 "NOTE!", msg 47 "Too many players have left the game!", DKRED, YELLOW); g_match_end = 2 }
else { level_load_round(); game_set_paused(0) }    // next round directly, no setup screens
```
Texts are drawn once (static screen, no cursor). After a draw the first line reads
"Game Winner was undetermined !" and `player_award_points` awards nothing (it applies the same
time-up / survivor test as `round_winner_name`).

---------------------------------------------------------------------------------------------------

## 17. Victory screen
```
name = team play ? sprintf("team%u", matchWinner) : sprintf("victory%u", matchWinner)
screen_show_pcx(name, 0)                 // VICTORY0..9.PCX (winning player's colour) or TEAM0/TEAM1.PCX, own palette
delay_pumping(3000)                      // 3 s, cannot be skipped
g_match_end = 1; input_flush(); graf_clear(); graf_flip(); palette_restore_game()
```
Then the ~1 s end-of-match pause (sec. 9) on a black screen and back to the main menu (menu music).

---------------------------------------------------------------------------------------------------

## 18. Network screens (layout only)

Both start with `net_connect(mode)` (0x40c839): CFG.INI `netonoff` = 0 →
`msgbox_ok("Problem!!", msg 340 "Networking is disabled in the CFG.INI file!")`; protocol from settings
or, if "Prompt each time", `list_select_dialog(msg 620, {630 "None - cancel", 631 IPX, 632 Modem, 633 Serial}, V1110 = 4, 0, 150, 150, WHITE)`
(choice 0 = cancel); modem dial → `win_get_str(phone, 30, msg 648, 25, 180)`; progress window
msg 57 "Connecting network object..." at 0 % until connected (Esc cancels); failure →
`msgbox_ok("Problem!!", msg 291 "Unable to establish net connection.")`. Music 1040 "network",
random glue background.

**Start Network Game** (server, `net_start_game_screen` 0x42b0ce), per frame (no cursor):
* `sprintf(msg 73 "Our Nodename is: '%s'")` at (V765 120, V766 80), W=V768 400, CYAN/BLACK.
* msg 70 "Connected network players:" at (V770 120, V771 120), W=V773 250, WHITE/BLACK.
* 4 client slots i: msg 72 "<Empty Client Slot>" or `sprintf(msg 71 "'%s' (%u)", name, n)` at
  (V775 120, V776 140 + V777 20*i), W=V778 400, WHITE/BLACK.
* Enter/Space (after the min wait, reset whenever the client count changes): no clients →
  `msgbox_ok("NOTE!", msg 105 "Need to have at least one client connected!", DKRED, YELLOW)`; else
  snd 10, broadcast start 5x (100 ms apart) → `match_play()`. Esc → leave.

**Join Network Game** (client, `net_join_game_screen` 0x42b47d), per frame:
* `sprintf(msg 66 "Our Nodename is: '%s'")` at (V750 120, V751 80), W=400, CYAN/BLACK.
* msg 60 "Available net games:" at (V755 120, V756 120), W=250, WHITE/BLACK.
* 10 server slots i: msg 63 "<Empty Server Slot>" or `sprintf(msg 62 "'%s' (%u) (id:%u)", name,
  players, id)` at (V760 120, V761 140 + V762 20*i), W=V763 400, WHITE/BLACK;
  `graf_cursor(V760-20 = 100, 140 + 20*sel + 16)`.
* Up/Down wrap 0↔9; Esc leaves. Enter/Space: snd 10; empty slot → `msgbox_ok("NOTE!", msg 65 "Must
  select a server!")`; full (≥ 4 players) → `msgbox_ok("Problem!!", msg 7 "Requested server already
  full!")`; else join (retry 1 s, up to 3 s); failure → `msgbox_ok("NOTE!", msg 100 "Unable to connect
  to server...")`; success → loop drawing `sprintf(msg 80 "Joined... waiting for server to start - %c",
  "/-\|"[counter++ & 3])` at (150, 200) W=400 WHITE/BLACK over the restored glue until the server
  starts (→ `match_play()`), the server disappears (`msgbox_ok("NOTE!", msg 110 "Server decided not to be a
  server!")`, back to the list) or Esc.
* During a network match a lost server shows `msgbox_ok("NOTE!", msg 111 "The server seems to have
  bailed out on this game!")` once (0x42a015).
* Unused: V795 / msg 311–312 ("Continue with same net game?").

---------------------------------------------------------------------------------------------------

## 19. Secret level editor

**Entry:** Ctrl-E pressed 6 times on the main menu (counter rules in sec. 4) → `editor_enter()`
(0x40330e): saves and clears the team-play flag, runs the editor menu, restores it.

**Editor main menu** (`editor_main_menu` 0x403184): random glue background; per frame:
* `graf_print_centered(main, msg 700 "Atomic Bomberman Level Editor", 320, 10, WHITE, BLACK)`
* `graf_print(main, msg 730 "Editor Main Menu.  You may:", W=V813 400, V810 50, V811 100, YELLOW, BLACK)`
* items i = 0..2: msg 731 "1) Edit a scheme file", 732 "2) Create a new scheme file", 733 "Q) Exit" at
  `(V815 80, V816 140 + V817 20*i)`, W=400, WHITE/BLACK. No cursor.
* Keys (letter sound on each): '1' → scheme editor on an existing file (scheme chooser first);
  '2' → scheme editor on a new basic grid named msg 729 "Newfile"; Esc, 'Q', 'q' → back to the main
  menu; F1 → help, then mouse shown.

**Scheme editor** (`scheme_editor_screen` 0x4028d2, old name team_ring_draw; EAX = 1 for a new file).
It edits the game's global scheme buffers and uses the current scheme file name `g_scheme_filename`
(0x4648c4 = options.ini `schemefilename`) as the name of the file being edited. Verified pixel for pixel
against the original (caps/ref editor_*.png and an extra run: new file, line view, painting, right-button
start move, team toggle, typed power-up values).
```
saved = g_scheme_filename
graf_show_random_glue()                      // background buffer only: the chooser still shows the menu
new file: scheme_basic_grid(); g_scheme_filename = msg 729 "Newfile"
else:     options_choose_scheme() (Esc keeps the current name); scheme_parse(datafile_path(g_scheme_filename))
mouse_show(); brick = 0
10 x { input_get_menu_key(); delay(10) }     // delay(ms) waits ms/100 x 100 ms: nothing; then input_flush()
player = 0; changes = 0
loop:
  graf_restore_background()
  for y 0..10, x 0..14 (0x4022a1):           // cellX(x) = 40 + 40x, cellY(y) = 103 + 36y (map_init)
      sprite_queue(cellX, cellY, tile(blank)); if cell != blank: sprite_queue(cellX, cellY, tile(cell))
  (mx, my) = mouse_get_position(); buttons = mouse_get_buttons()
  sprite_queue(mx, my, tile(brick))          // the selected brick follows the mouse (hotspot 20,35)
  0x415b22: draw the queued sprites now      // so the texts below go over the cells
  graf_print(sprintf(msg 742 "Schemfile: %s - Name: '%s'", g_scheme_filename, name), 500, 20, 5, WHITE, BLACK)
  graf_print(sprintf(msg 743 "Brick Density: %u%%", density), 500, 20, 23, WHITE, BLACK)
  graf_print(sprintf(msg 738 "Player: %u", player + 1), 200, 20, 41, WHITE, BLACK)
  graf_print(msg 737 "Schemefile Editing - press F1 for editor help", 500, 20, 476 - fontH, WHITE, BLACK)
  for i 0..9: x = cellX(start[i].x) - 20; y = cellY(start[i].y) - 36
      graf_print(sprintf("%u", i + 1), 40, x, y, player_text_color(i), player_text_outline_color(i))  // team play off
      sprite_queue(x, y, frame of "teamring%u" start[i].team)   // MISC.ANI 21x22, hotspot (4,4): white / red square
  graf_flip()
  if buttons & 1: scheme_set_cell(px_to_cx(mx), px_to_cy(my), brick); changes++   // changes++ even off the field
  if buttons & 2: start[player].x,y = px_to_cx(mx) clamped 0..14, px_to_cy(my) clamped 0..10; changes++
  key = input_get_menu_key()                 // no letter sound on this screen
  dispatch key (below); leave when asked
msgbox_yes_no(sprintf(msg 722 "Make %s the current schemefile?", g_scheme_filename), NULL, WHITE, BLACK)
    <= 0 -> g_scheme_filename = saved
mouse_hide()
```
`tile(t)` = first frame of `"tile %d blank|solid|brick"` with %d = the global 0x45b7b8 (initially 0 = TILES0
graphics, -1 = EDIT.ANI line drawings; it keeps its value between editor sessions). Cell types: 0 blank
('.'), 1 solid ('#'), 2 brick (':'); `scheme_get_cell` (0x404852) answers solid outside the field,
`scheme_set_cell` (0x4048eb) ignores cells outside it.

Keys (jump table 0x402cb0: `repne scasw` of key-2 over 25 words, 26 targets at 0x402ce2; anything else,
including -1/-2, does nothing):

| key | action |
|---|---|
| F1 | `help_screen()` (the help-file list), then mouse_show |
| '+' '=' / '-' '_' | player + 1 (10 -> 0) / player - 1 (-1 -> 9) |
| '1' '2' '3' | brick = blank / solid / brick |
| Tab, Enter, Space | brick = brick + 1, 3 -> 0 |
| '0' | 0x45b7b8 += 1; if > 0 -> -1 (toggles 0 / -1) |
| 'N' 'n' | `win_get_str(name, 30, msg 728, 25, 180)`; OK -> name, changes++ |
| 'D' 'd' | `win_get_str(sprintf("%u", density), 30, msg 739, 25, 180)`; OK -> density = atoi clamped 0..100, changes++ |
| 'T' 't' | start[player].team = (team == 0); changes++ |
| 'P' 'p' | powertype editor (below); changes++ (always) |
| Ctrl-F | `msgbox_yes_no("Warning!", msg 760, DKRED, YELLOW)` = 1 -> every cell = brick, changes++ |
| Ctrl-B | with changes: `msgbox_yes_no("Warning!", msg 740, DKRED, YELLOW)` = 1 -> scheme_basic_grid; without: scheme_basic_grid; changes++ in all cases. The basic grid also resets the name ("Basic grid pattern", 0x4583e3), density 90, the starts (V600.. with team i&1) and the power-up tables. |
| Esc, 'Q', 'q' | if changes and `msgbox_yes_no("NOTE!", msg 735, WHITE, BLACK)` = 1: `win_get_str(buf = g_scheme_filename, 30, msg 736, 25, 180)`; OK -> g_scheme_filename = buf cut at its first '.' + ".sch" (0x40497c); OK or Cancel: `scheme_save(g_scheme_filename)`. Then leave. (Cancel on a new file therefore writes "Newfile", no extension, which datafile_path puts in the game directory where no scheme list sees it.) |

**Powertype table editor** (0x402595): over the same glue (no grid), mouse shown, input_flush; per frame:
`graf_print(msg 754, 300, 30, 30, CYAN, BLACK)`, msg 737 as above; for i = 0..12, y = 60 + 24i: a GNW text
button "Modify" (msg 755) registered once on the main window at (10, y-4) with **down** code 5000+i,
`graf_print(sprintf(msg 756 "'%s'", msg 850+i), 100, 90, y, YELLOW, BLACK)`,
`graf_print(sprintf(msg 757 "Bornwith: %d, Forbid: %s", bornwith[i], msg 25+forbidden[i] " No "/" Yes "), 300, 210, y, WHITE, BLACK)`,
`graf_print(override flag ? sprintf(msg 759 "Override: %d", override[i]) : msg 758 "No Override", 160, 450, y, WHITE, BLACK)`.
Keys: 5000..5012 -> entry editor; Enter, Esc, Space, 'Q', 'q' leave (the 13 buttons are deleted); F1 help +
mouse_show. The pressed "Modify" never sees its release (the dialogs eat it), so it stays drawn pressed.
Entry editor (0x4023a2), all at (25,400) (`win_move` lifts the 96-px text box to y = 384):
`win_get_str(sprintf("%u", bornwith), 20, sprintf(msg 762, name))` OK -> bornwith = atoi (not clamped);
`win_yes_no(sprintf(msg 764, name), WHITE)` -> forbidden; `win_yes_no(sprintf(msg 766, name), WHITE)` -> override
flag; flag set: `win_get_str(sprintf("%d", override), 20, sprintf(msg 768, name))` OK -> override = atoi;
flag clear: override = 0.

**`scheme_save`** (0x403c16): `fopen(datafile_path(name), "wt")` (CR LF line ends); failure ->
`msgbox_ok(sprintf(msg 710, path), NULL, DKRED, YELLOW)`. Writes, in this order: "\n; NOTE! This is an
Atomic Bomberman Scheme File.\n", "; Modify at your own risk.  It is machine-generated and updated.\n\n",
"\n; this is an internal version control number\n", `-V,%u` (2), "\n; this is the textual name of the
scheme\n", `-N,%s`, "\n; scheme brick density (0-100 percent)\n", `-B,%u`, "\n; actual array data (# is
solid, : is brick, . is blank)\n", ";               11111\n", ";     012345678901234\n", 11 x `-R,%2u,%s`,
"\n; player starting locations (playerno,X,Y)\n", 10 x `-S,%u,%d,%d,%d` (player, x, y, team), "\n; powerup
information; the fields are:\n", ";   powerup #, bornwith, has_override, override_value, forbidden\n",
";   (note the last text field has no effect; it is only a comment)\n", 13 x `-P,%2u,%2d,%d,%2d,%2d,%s`
(comment = msg 800+i). The 67 shipped files are exactly this output, except 31 older ones whose -S lines
have no team field (scheme_parse then keeps the basic grid's team i&1) and 5 that end in a ^Z.
`scheme_parse` details: lines read with fgets(99); fields split at commas (at most 10, the name ends at
the next comma); the type letter is case-sensitive; -R needs exactly 2 fields and 15 cells (else msg 750),
and every -R line warns 725/726 while no `-V,2` has been read; -S x < 0 -> +15, x > 15 -> 14, same for y
with 11/10; -P bornwith < 0 -> 0, flags != 0 -> 1.

---------------------------------------------------------------------------------------------------

## 20. Debug windows

* **Alt-D** `debug_info_window()` (0x413d45): game paused; `win_add(100, 100, 450, 300, 0x100, 4)`,
  WINZ background, lines (graf_print, W=400, WHITE/BLACK) at x=20: y=20 msg 400 "Internal debugging
  information window", y=40 msg 401 "Press [Enter] or [Esc] to continue", y=70 msg 405 "Total mem: %u,
  Audio mem: %u", y=90 msg 410 "Our local net id: %u", y=110 msg 411 "BOMBER_ID: %u", y=130 msg 415
  "Critical retrans rate:%6.3f", y=150 msg 420 "Audio cache hits: %u%%"; waits for Enter/Esc (no
  sounds). Available on main menu, setup, options and in game.
* KWD-only: Ctrl-A in game (msg 20 list of animation sequences + writes anims.lst), Ctrl-R remap
  editor ("Remap table %u (%u.rmp)").

---------------------------------------------------------------------------------------------------

## 21. VALUELST 700–815 (menu coordinates X, Y, YS, W) — usage

| id | values | used for |
|---|---|---|
| 700 | 332,140,38,0 | main-menu trigger-bomb cursor at (X, Y+YS*sel); W unused |
| 705 | 40,140,0,200 | setup: "Available players:" box (X,Y), W |
| 710 | 70,170,24,150 | setup: player rows (X, Y+YS*p, W); cursor (X-15, Y+YS*sel+16); "TEAM" at X+W |
| 715 | 300,140,0,170 | setup: "Available Joysticks:" |
| 720 | 320,170,24,320 | setup: joystick rows; "None Detected" at (X,Y) |
| 730 | 400,100,5,5 | level preview origin and block counts (X, Y, XSize, YSize) |
| 735 | 55,170,24,300 | options rows (level, wins); cursor (X-20, Y+YS*sel+16) |
| 745 | 55,40,22,500 | settings rows; cursor (X-20, Y+YS*sel+16) |
| 750/755/760 | 120,80,0,400 / 120,120,0,250 / 120,140,20,400 | join screen: nodename, header, server rows (+cursor X-20) |
| 765/770/775 | same values | start-net screen: nodename, header, client rows |
| 780 | 150,140,0,400 | results "Game Winner was %s !" |
| 785 | 150,210,20,400 | results player/team rows |
| 790 | 320,440,0,300 | "Press F1 for help" (centred at X; W unused) |
| 795 | 80,150,0,500 | unused ("Continue with same net game?") |
| 800 | 150,94,0,400 | results match line ("... WINS THE MATCH!" / "(Match winner must score ...)") |
| 805 | 320,30,0,400 | unused (roulette title) |
| 810 | 50,100,0,400 | editor menu header |
| 815 | 80,140,20,400 | editor menu items |

Other VALUELST used by screens: 12 (logo/title timeout 7 s), 13 (net min wait 3 s), 15 (help enabled),
16 (7 glue images), 35 (11 levels), 92 (attract 30 s), 100 (default/fallback play time 150 s), 189
(3 conveyor speeds), 28 (4 enclosement depths), 690/691 (cursor blink 2 + rand()%2 s), 1000–1007
(roulette), 1110 (4 protocols shown), 200–247 (player colour fallback when no .RMP).

## 22. Music / speech / sound ids used by screens

| id | file | where |
|---|---|---|
| music 1000 | title | title_screens (logos + title) |
| music 1010 | menu | main menu, restarted on every menu (re-)entry |
| music 1020 | win | match setup (roulette, player setup, options) |
| music 1040 | network | start/join network screens |
| music 1130 | draw | end of every round (draw/results/victory screens) |
| music 1030 | lose | never used |
| speech 2800 | GEN8A.. | before the title image |
| speech 1700 | gump1.. | draw screen |
| speech 2000 | proud.. | match won (results) |
| speech 2600 | quitgame.. | exit confirmed |
| snd 20/21 | letter1/2 | any key on any screen |
| snd 10 | menuexit | confirm/leave |
| snd 40/41 | enrt1/2 | refused |
| snd 1300 | 1041 | roulette tick |
| snd 1310 | 1000 | roulette good prize (clapping) |
| snd 1320 | 1049 | roulette clog (buzzer) |

---------------------------------------------------------------------------------------------------

## 23. Pseudo-code of the main-menu loop (faithful control flow)

```c
void main_menu(void) {                                   // 0x42b9ce
    int sel = 0, anim = 0;
reenter:
    g_menu_idle_start = timeGetTime();
    if (g_attract_mode) { players_restore_inputs(); g_attract_mode = 0;
                          g_level = g_attract_saved_level; g_team_play = g_attract_saved_team_play; }
    input_flush(); graf_target_background(); graf_load_pcx_to_target("mainmenu"); graf_target_screen();
    mouse_hide(); input_flush();
    int done = 0, music = 1, ctrlE = 0;
    for (;;) {
        graf_restore_background();
        sprite_queue(V700, V701 + V702 * sel, ani_frame("bomb trigger green", anim++));
        graf_print(g_main_win, "V1.0", 50, 0, 0, GREY, BLACK);
        graf_flip();
        if (music) { music_play(1010); music = 0; }
        int k = input_get_menu_key();
        if (k != -1 && k != -2) { sound_play_group(20); g_menu_idle_start = timeGetTime(); }
        if ((k == -1 || k == -2) && V92 > 5 && timeGetTime() - g_menu_idle_start > V92 * 1000) {
            stats.attract++; g_attract_mode = 1; players_save_inputs();
            g_attract_saved_level = g_level; g_attract_saved_team_play = g_team_play; g_team_play = 0;
            sel = 0; break;                                   // dispatch case 0
        }
        switch (k) {
        case 0x0D: case 0x20: sound_play_group(10); done = 1; break;
        case 0x11: case 0x1B: sound_play_group(10); sel = 6; done = 1; break;
        case 0x05: if (++ctrlE > 5) { ctrlE = 0; sound_play_group(10); editor_enter(); goto reenter; } break;
        case 0x118: sound_play_group(10); sel = 3; done = 1; break;
        case 0x11E: /* same as idle timeout */ ... sel = 0; goto dispatch;
        case 0x120: debug_info_window(); break;
        case 0x13B: sound_play_group(10); sel = 5; done = 1; break;
        case 0x148: if (--sel < 0) sel = 6; break;
        case 0x150: if (++sel > 6) sel = 0; break;
        case -1: case -2: break;
        default: ctrlE = 0; break;
        }
        if (done) break;
    }
dispatch:
    switch (sel) {
    case 0: valuelst_load(); match_play(); break;
    case 1: valuelst_load(); net_start_game_screen(); break;
    case 2: valuelst_load(); net_join_game_screen(); break;
    case 3: settings_screen(); sel = 0; break;
    case 4: help_view_file("credits.bm"); break;
    case 5: help_screen(); break;
    case 6: confirm_exit(); sel = 0; break;
    }
    goto reenter;
}
```

---------------------------------------------------------------------------------------------------

## Uncertain

* **U1 — menu frame rate.** The original menu loops are unthrottled (no sleep, no vblank wait). The
  speeds of the main-menu cursor pulse (19 states/cycle), cursor blink (4 frames), roulette spin
  (20–58 positions of 420 per frame) and the "/-\|" spinner therefore depended on the PC. Best guess
  for period hardware (P133–P200, 300 KB memcpy + full-window Lock/blit per frame) is ~40–60 loop
  iterations per second. Recommendation: run menu loops at a fixed 60 Hz (or expose the rate); the
  logic must stay per-iteration, not time-scaled.
* **U2 — resolved**: pixel-exact GNW widget spec in **docs/re/gnw-widgets.md** (+ docs/re/gnw-data.json),
  verified against the BM95 disassembly (BM95 differs from fallout1-ce in several details) and re-rendered
  with 0 differing pixels against 91 captures of the original. The "Paused" window is unreachable.
* **U3 — sprite placement.** `sprite_queue(x,y,frame)` subtracts the frame's hotspot (ANI frame header
  offsets) — the per-state offsets listed in ani_seqs.txt are not applied by these screens (they call
  `ani_seqno_to_frameno` only). Confirm against the graphics spec.
* **U4 — directory order of `find_files_upper`.** FindFirstFile/FindNextFile order (alphabetical on NTFS,
  creation order on FAT). Use alphabetical.
* **U5** — (resolved: baud list is 9600, 19200, 38400, 57600, 115200.)
* **U6** — (resolved: every msgbox call sets its colours, see the table in 0.10.)
* **U7 — resolved**: `W = max(textW(title)+12, text_max*(maxlen+1)) + 16`, min 160 (gnw-widgets.md §6.3).
* **U8 — keydefs_capture_key** returns the *last* scan code whose DirectInput state byte is set during a
  poll (loop overwrites); with a single key pressed this is that key.

## Bugs & quirks (replicate unless noted)

1. **Help viewer tab expansion off-by-one**: after a TAB the column counter is one ahead of the
   output, so later tabs land on irregular columns (sec. 7.2). Needed for identical help text layout.
2. **Joystick menu edges eaten on most screens**: setup, options, settings and roulette call
   `joy_poll()` themselves and then `input_get_menu_key()` polls again microseconds later, so prev/cur
   are almost identical and joystick navigation mostly fails there (works on the main menu, logos,
   dialogs). Probably worth fixing in a remake.
3. **Gold player in team play**: the results screen computes `team(player index == winning team index)`
   instead of the winning team itself; correct only while player 1 is on team 0 and player 2 on team 1
   (the defaults). Encoded value 0 = team 0, 2 = team 1 (the in-game sparkle uses the same encoding).
4. **Attract mode ignores the random-level mask** (V1150+): disabled levels (Hockey Rink, Under the
   Ocean) can appear.
5. Results rows use the player index for the y slot, leaving gaps for OFF players; `rows` counts only
   listed players/teams and triggers "Too many players have left the game!" when < 2.
6. Results "%s WINS THE MATCH!" uses the *round* winner's name (same as the match winner in practice);
   in kill mode it prints matchWinner+1 instead.
7. Esc during a round does nothing (only in attract mode); Ctrl-Q is the quit key.
8. The 'C' x5 campaign counter on the setup screen is never reset by other keys.
9. Settings row 18 ("Adjust Audio" placeholder) is in the switch but unreachable; the protocol list
   shows only 4 of its 5 entries (TCP/IP hidden) because V1110 = 4.
10. msg 1215 mentions CAMP*.RES but the code looks for DATA\RES\*.CAM.
11. Level preview uses a random level per tile when "Random Each Game" is selected (mixed tile sets),
    and consumes rand() on every redraw.
12. The level preview is drawn into the background buffer after the frame's restore, so it appears one
    frame late.
13. Main-menu music restarts from the beginning after every sub-screen (settings, help, credits,
    cancelled exit).
14. Keys 0 and ≥0x59 (after &0x7f) are not printed on the keydefs screen (no "Key:" line).
15. The hidden watermark (Atbash-encoded string at 0x45bf06, would be printed by `screen_show_pcx` with
    `graf_print(main, s, 640, 0, 476 - fontH (=460), WHITE, BLACK)`) is empty in this build — nothing is
    drawn.
16. Every GNW window creation (`win_add`: message boxes, progress windows, lists, help viewer, debug
    window, pause window) calls `rand()` twice, and the level preview / roulette / attract setup also
    draw from the same `rand()`; the menu path a player takes therefore changes the game's random
    sequence. Only matters if the remake wants bit-identical RNG streams.
17. The level-preview tile blit copies exactly 40x36 pixels with pitch 40 from each tile frame and
    ignores the frame hotspot/size (correct only because tile frames are 40x36).
