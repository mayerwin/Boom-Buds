# Levels, extras (arrows, warps, conveyors, trampolines), scheme files and campaign data

Scope: extra.c (0x404cf0–0x405dd0), scheme.c (0x403af0–0x404cf0), the level-related parts of level start
(`level_start` @0x410b6e, called `maybe_level_load` before), the per-level resources (field, tiles, music, ice,
regeneration), how extras act on players and bombs (code in you.c / bombs.c), and a short look at campaign.c/aliens.c.

Other docs cover the details referenced here: **flames-map-powerups.md** (map grid, `map_generate`, start-area
clearing, hurry/enclosement, regenerating tiles, power-up placement), **bombs.md**, the player doc (movement step,
cornering, special animations), engine loop, network, audio, match flow.

All addresses are BM95.EXE virtual addresses. "Vnnn" = VALUELST.RES id nnn, "Mnnn" = MESSAGES.TXT id nnn,
"Snnn" = SOUNDLST.RES id nnn.

---------------------------------------------------------------------------------------------------------------------

## 0. Conventions used below

- Directions: `0 = N, 1 = E, 2 = S, 3 = W`. `g_dir_dx = {0,1,0,-1}` (0x45becc), `g_dir_dy = {-1,0,1,0}` (0x45bedc).
  `dir_name(d)` (0x413aed) returns `{"north","east","south","west"}[d & 3]` (table 0x45bcc4).
- Grid: 15 x 11 cells of 40 x 36 px. Cell (x,y) top-left pixel = `(20 + 40x, 68 + 36y)`. Sprite anchor of a cell
  ("centre x, feet y") = `map_cell_center_x(x) = 40 + 40x` (0x426524), `map_cell_feet_y(y) = 103 + 36y` (0x42655f).
  Inverse helpers `map_px_to_cx` (0x42665c), `map_py_to_cy` (0x4266a3), in-cell offsets `map_offset_in_cell_x`
  (0x426599, range -20..19, 0 at the centre) and `map_offset_in_cell_y` (0x4265eb, range -18..17). Exact formulas in
  flames-map-powerups.md §1.3. Map cell values: 0 blank, 1 solid, 2 brick (`map_get` 0x425fb9 returns 1 outside).
- Time: `dt` = milliseconds of the current rendered frame (`DAT_00464958`, capped at V31 = 150). Reference frame =
  `DAT_0046494c` = 1000 / V30 = 50 ms. A speed V (1/100 px per reference frame) adds `(V * dt) / 50` to a movement
  accumulator (unsigned 32-bit multiply, then unsigned divide). Each 100 units in an accumulator = 1 pixel step.
- "Special animation" of a player = short at player+0x4e (`p.special`), its frame counter = short +0x50
  (`p.sp_frame`), its time accumulator = short +0x52 (`p.sp_time`). The counter advances "per reference frame":
  `p.sp_time += dt; while (p.sp_time > 0) { p.sp_frame++; p.sp_time -= 50; }`.
- `net_mode` = `DAT_00460058` (`net_mode_get` 0x40c06a): 0 local game, 1 client, 2 server.
- Player type byte player+0x10: 0 OFF, 1 AI, 2 keyboard, 3 joystick, 4 network (remote).
- `rand()` is the Watcom LCG (see flames-map-powerups.md): `seed = seed*1103515245 + 12345; return (seed>>16) & 0x7fff`.
- `sound_play_group(id)` plays one of the consecutive defined SOUNDLST ids starting at `id` (least played first).

---------------------------------------------------------------------------------------------------------------------

## 1. The 11 levels

V35 = 11 levels ("waves"), numbered 0..10. The current level number is `g_level` (`DAT_0046499c`). Everything
level-specific is found by substituting `g_level` into a name or a resource id:

| what | lookup | code |
|---|---|---|
| name | M150 + L | options screen |
| background | `"field%u.plt"` → `datafile_path` maps `.plt` to `data/res/FIELD%u.PCX` | `level_start` → `graf_load_field_bitmap` 0x4165fc |
| solid / brick tiles | ANI sequences `"tile %u solid"`, `"tile %u brick"` (file TILES%u.ANI) | `map_draw_cell` 0x425d22 |
| brick destruction | `"flame %s %u"` with `"brick"` → `"flame brick %u"` (XBRICK%u.ANI) | `flame_update_draw` 0x426d06 |
| extras | `"extra%u.res"` → `data/res/EXTRA%u.RES` | `extra_load_res` 0x404e99 |
| in-game music | S1100 + L (fallback S1120) | `tunes_play_wave_tune` 0x4293e5 |
| ice / control delay (ms) | V450 + L | `player_update` 0x41f29b |
| regenerating bricks (s, 0 = off) | V340 + L | `map_regen_tick` 0x426704 |
| eligible for "Random Each Game" | V1150 + L (0 = never picked) | `level_start` |

All TILES*.ANI, XBRICK*.ANI, EXTRAS.ANI and CONVEYOR.ANI files are loaded at start-up through MASTER.ALI, so the
level only selects sequence names; nothing is loaded per level except the FIELD PCX (and the EXTRA file).

| L | name (M150+L) | music S1100+L | ice V450+L | regen V340+L | random V1150+L | extras file |
|---|---|---|---|---|---|---|
| 0 | Green Acres | 1100 grnacres | 0 | 0 | 1 | – |
| 1 | Classic Green Acres | 1101 generic | 0 | 0 | 1 | – |
| 2 | The Hockey Rink | 1102 hockey | **250** | 0 | **0** | EXTRA2.RES: 12 arrows |
| 3 | Ancient Egypt | 1103 pyramid | 0 | 0 | 1 | EXTRA3.RES: 44 arrows |
| 4 | The Coal Mine | 1104 mineshft | 0 | 0 | 1 | EXTRA4.RES: 4 warp holes |
| 5 | The Beach | 1105 battle | 0 | 0 | 1 | – |
| 6 | Aliens | 1106 gieger | 0 | 0 | **0** | – |
| 7 | Haunted House | 1107 haunted | 0 | **4** | 1 | – |
| 8 | Under the Ocean | 1108 ocean | 0 | 0 | 1 | – |
| 9 | Deep Forest Green | 1109 swamp | 0 | 0 | 1 | EXTRA9.RES: 4 fixed + 4 random trampolines (local games only) |
| 10 | Inner City Trash | 1110 sewer | 0 | 0 | 1 | EXTRA10.RES: 32 conveyor tiles (one closed loop) |

V449 = 0 exists "just to prevent invalid access" (level -1). V1161 = 1 is unused (there is no level 11).
VALUELST comments: level 2 is excluded because "too annoying to have control delays", level 6 because "too hard to see
visually". The VALUELST comment on V347 says "cemetary/mortuary" for level 7.

### 1.1 FIELD%u.PCX (background)

- 640x480 8-bit PCX. `graf_load_field_bitmap` (0x4165fc) frees the previous field, loads the file through
  `file_load_image` (0x41bda4 → `pcx_load`) and remaps its palette into the game palette (0x41bbbd: each of the PCX
  palette entries 1..255 → `color_table[(r>>3)<<10 | (g>>3)<<5 | (b>>3)]`, entry 0 stays 0). It is a fatal error
  (0x69) if the file is missing or not exactly screen-sized.
- The field image contains the floor and the frame only. **No solid blocks are painted into it** (all 11 checked):
  every solid and brick is drawn from the TILES sequences (§3). Level 1 has a grey HUD band at the top, the others black.
- The same "field%u.plt" name is used by the options-screen preview (`options_level_preview` 0x406aa3, menus doc).

### 1.2 Music

`tunes_play_wave_tune` (0x4293e5, audio doc): name = SOUNDLST entry 1100+L; if that entry is empty → plays S1120
("generic", the tune for network play on a minimum install). If the tune file is not present locally, it is staged
from CD only when `net_mode == 0` and `levelno != -1`, otherwise S1120 is played. If the option
`disable_game_music` (`DAT_004648c0`) is set, the current tune is stopped instead (0x427342).

---------------------------------------------------------------------------------------------------------------------

## 2. Choosing the level

The option `levelno` (options.ini, `g_opt_levelno` = `DAT_00464998`): set to 0 by `options_defaults`, then read from
options.ini, then clamped: `< -1 → -1`, `>= V35 → V35-1`. `-1` is shown as "Random Each Game" (M149).

`level_start` (0x410b6e) runs at the start of **every game (round)** of a match:

```
level_start():
    campaign_next_stage()                         // 0x40133f, campaign mode only (§10)
    if g_game_state == 10: return                 // campaign finished
    if net_mode == CLIENT:
        g_level = -1; show "waiting"; loop net_send_critical() until the server's level arrives (Esc aborts)
    else if g_opt_levelno >= 0:
        g_level = g_opt_levelno
    else:
        for i in 0..199:
            n = (V35 < 2) ? 1 : V35               // 11
            g_level = rand() % n
            if V(1150 + g_level) != 0: break
        // if all 200 rolls hit disabled levels, the last roll is used anyway
    if net_mode == SERVER: 10 x { wait 100 ms; net_send_critical() }; send level (0x4101b5)
    ... continues in §2.1
```

- In campaign mode the stage's level number is copied into `g_opt_levelno` before this (§10).
- Attract (demo) mode (match-flow doc) sets `g_opt_levelno = rand() % V35` with **no** eligibility test (levels 2 and 6
  can appear) and restores the user's value afterwards.
- **LEVELS.DAT is not used.** No code references it. The file holds the 32-bit value 0x33BFFB81 = 1997-07-06
  20:09:37 UTC; the strings "levels.dat", "wb" and "Software expired.  Contact Interplay." sit next to each other in
  the data segment, unreferenced: leftovers of a removed beta expiry check.

### 2.1 Level start sequence (order matters for rand() and for what is visible on frame 1)

```
    if net_mode == LOCAL: audio cache flush check (0x428bb1 → 0x428aef, every V7 s; audio doc)
    stats; graf target = background buffer
    map_generate()                       // 0x4260f5: scheme grid + brick density (flames doc §1.4)
    graf_load_field_bitmap("field%u.plt" % g_level)
    map_draw_all()                       // 0x42633c: bake field + all tiles into the background buffer (§3)
    graf target = screen; copy/flip
    bombs reset; flames reset; power grid reset
    players_reset()                      // 0x4214bc: spawn pixel positions from g_start_x/y, teams, inventory
    power_place_level()                  // 0x4258e5: hidden power-ups under bricks
    extras_level_load()                  // 0x40551f: §5.4
    campaign_stage_setup()               // 0x40151b: campaign only (§10)
    server: send data to clients; client: receive (net doc)
    music (§1.2); game clock (match-flow doc)
```

The start areas of active players are cleared on their first update (`map_clear_start_area` 0x42583b, flames doc
§1.5), and warp holes knock out bricks on the first extras update (§6). Both happen during the first game frame.

---------------------------------------------------------------------------------------------------------------------

## 3. Background buffer: floor and tiles

- The game keeps a **background buffer** (the field PCX with all solid and brick tiles baked in). Every frame the
  background buffer is copied to the back buffer (`maybe_graf_lock` 0x415ca4), then sprites are queued and drawn on
  top (§6.3). Tiles are never sprites.
- `map_draw_all` (0x42633c) calls `map_draw_cell` for all 165 cells in row-major order (y outer, x inner).
- `map_set(x, y, v)` (0x425e9b) = `map_set_raw` + `map_draw_cell` into the background buffer (that is how bricks
  disappear, warps knock out cells, hurry blocks appear, bricks regenerate).

```
map_draw_cell(x, y):                               // 0x425d22
    v  = map_get(x, y)
    px = 20 + 40*x;  py = 68 + 36*y                // cell top-left
    graf_restore_bg_rect(px, py, 40, 36)           // 0x4166bf: copy that rect from the FIELD image
    if v == 0: return                              // blank: floor only
    name = (v == 1) ? sprintf("tile %u solid", g_level)
                    : sprintf("tile %u brick", g_level)    // 2 and any other non-zero value
    frame = ani_seqno_to_frameno(ani_find_seq(name), state 0)
    blit_transparent(frame bitmap, px, py, w=40, h=36, src pitch 40)   // 0x41532b, colour index 0 = transparent
```

- The tile bitmap is placed at the cell's top-left; the frame hotspot and the per-state offsets listed in
  ani_seqs.txt are ignored here. The floor shows through transparent pixels of the tile.
- There is no in-game "blank" tile. TILES0.ANI also contains `tile 0 blank`, only used by the scheme editor, which
  draws `"tile %d blank|solid|brick"` with its own tile-set variable `0x45b7b8` (initially 0). EDIT.ANI
  (`tile -1 ...`) is not listed in MASTER.ALI.

---------------------------------------------------------------------------------------------------------------------

## 4. Scheme files (.SCH)

A scheme defines the cell layout (solid/brick/blank), brick density, the 10 start positions with teams, and power-up
tweaks. 67 schemes ship in `DATA/SCHEMES`. The level (background, tiles, extras, music) is chosen separately.

### 4.1 Which scheme, and when it is read

- Option `schemefilename` (`g_scheme_filename` = `DAT_004648c4`, default "BASIC.SCH", chooser
  `options_choose_scheme` 0x407582 lists `data/schemes/*.SCH` and shows each file's `-N` name via
  `scheme_read_name` 0x404be9).
- Combat mode: `scheme_load` (0x4046cc) is called **once per match** at match setup (0x410f81). Server/local:
  `scheme_parse(g_scheme_filename)`. A server then sends 79 VALUELST values to the clients (ids listed at 0x45b7d4:
  10,20,25,31,41,42,43,50..64,90,91,101,102,120..125,129..138,190..192,300,301,450..460,550..564,665,667,670,671,680,
  681). A client waits ("Receiving Pregame .RES Data...", M302) and never reads the .SCH file: it receives the map
  cells, start positions (msg 0x35, 0x4100b9) and power-ups from the server.
- Campaign mode: `scheme_parse` is called at each stage start with the stage's scheme name (§10).

### 4.2 File format

Text file, read line by line with `fgets(buf, 99)` (a line keeps at most 98 characters; a longer line is continued as
a new line). The first `'\n'` is removed. Only lines whose **first character is `-`** are interpreted; everything
else (comments starting with `;`, blank lines) is ignored. The rest of the line is cut at every `,` (at most 10 cuts;
each comma becomes a NUL and token k is the text after comma k+1). There is no trimming: numbers go through `atoi`
(which skips leading blanks), strings keep their spaces. The type letter is the second character, case-sensitive.

| line | fields | meaning |
|---|---|---|
| `-V,n` | version | must be 2; otherwise a message box "Schemefile is wrong version number!" / "Some features might not work correctly..." (M725/M726). Parsing continues. |
| `-N,text` | name | scheme name (`g_scheme_name` 0x464700). Ends at the next comma (a comma inside the name truncates it). Needs ≥ 1 comma. |
| `-B,n` | density | brick density in percent (`g_scheme_density` 0x4647a0). Needs ≥ 1 comma. |
| `-R,row,cells` | row 0..10, 15 chars | exactly 2 commas, `0 <= row < 11` (otherwise silently ignored), `strlen(cells) == 15` (otherwise debug clue "wrong width of line..." + warning). Chars: `#` solid, `:` brick, **anything else** blank (files use `.`). |
| `-S,p,x,y[,team]` | start position | 3 or 4 commas; player 0..9. |
| `-P,pw,bornwith,has_override,override,forbidden,comment` | power-up tweak | ≥ 5 commas; pw 0..12; the comment field is ignored. |

Any other `-X` letter → warning "unknown line type in .SCH file" (M753, titled "Warning!" M97). Malformed R/S/P lines
give M750/M751/M752. Warnings are modal message boxes; parsing continues afterwards. Missing file → message box
"Unable to read Scheme file '%s'" (M711) and the defaults of §4.4 stay in effect.

The file name: the extension of `g_scheme_filename` is cut at the last `.`, `".sch"` is appended and
`datafile_path` maps `.sch` to `data/schemes/<name>.sch` (opened "rt").

### 4.3 Parser (scheme_parse @0x403eee)

```
scheme_parse(filename):
    // 1. default start positions from VALUELST (true modulo wrap)
    for i in 0..9:
        x = V(600 + 2i); y = V(601 + 2i)
        while x < 0: x += 15;   while x >= 15: x -= 15
        while y < 0: y += 11;   while y >= 11: y -= 11
        g_start_x[i] = x; g_start_y[i] = y              // 0x46460c / 0x46465c
    version = 0
    scheme_reset_defaults()                              // 0x4049c0, §4.4
    open file (see above); if it fails: message M711, goto post
    for each line:
        if line[0] != '-': continue
        switch line[1]:
        'V': version = atoi(tok0); if version != 2: warn(M725, M726)
        'N': if ncommas >= 1: strcpy(g_scheme_name, tok0)
        'B': if ncommas >= 1: g_scheme_density = atoi(tok0)
        'R': if version != 2: warn(M725, M726)          // repeated for every R line before/without -V,2
             if ncommas == 2:
                 row = atoi(tok0)
                 if 0 <= row < 11:
                     if strlen(tok1) == 15: copy 15 chars into g_scheme_rows[row]
                     else: debug_clue("wrong width of line..."); warn(M750)
                 // row out of range: ignored silently
             else: warn(M750)
        'S': if ncommas == 3 or 4:
                 p = atoi(tok0); x = atoi(tok1); y = atoi(tok2)
                 while x < 0: x += 15;  while y < 0: y += 11
                 if x > 15: x = 14       // note: '>' not '>=' (x = 15 / y = 11 pass)
                 if y > 11: y = 10
                 if 0 <= p < 10:
                     g_scheme_starts[p].x = x; g_scheme_starts[p].y = y
                     g_start_x[p] = x; g_start_y[p] = y
                     if ncommas == 4: g_scheme_starts[p].team = (atoi(tok3) != 0)
             else: warn(M751)
        'P': if ncommas >= 5:
                 pw = atoi(tok0); born = atoi(tok1); hasov = atoi(tok2); ov = atoi(tok3); forb = atoi(tok4)
                 if 0 <= pw < 13:
                     g_scheme_bornwith[pw]     = max(born, 0)
                     g_scheme_has_override[pw] = (hasov != 0)
                     g_scheme_override[pw]     = ov
                     g_scheme_forbidden[pw]    = (forb != 0)
             else: warn(M752)
        other: warn(M753)
post:
    for i in 0..9: player[i].team(+0x54) = g_scheme_starts[i].team        // 0x422437
    for pw in 0..12:
        if g_scheme_bornwith[pw] > 0: value_set(50 + pw, g_scheme_bornwith[pw])     // starting inventory
        if g_scheme_has_override[pw]: value_set(400 + pw, g_scheme_override[pw])    // level placement count
```

Meaning of the -P fields (consumers are in the power-up / player docs):
- **bornwith** → V50+pw = how many of that power-up every player starts each game with. Only values > 0 are written,
  so a scheme cannot lower a VALUELST default (V50 = 1 bomb, V51 = 2 flame) to 0.
- **has_override / override** → V400+pw = number placed under bricks per level (negative = that many 1-in-10
  chances), see flames doc §3.3.
- **forbidden** → the "random" power-up (type 12) re-rolls `rand() % 12` until it hits a type that is not forbidden
  (flames doc §3.6).
- The written values live in the in-memory VALUELST. They stay until `valuelst_load()` runs again: the main menu
  reloads VALUELST before starting a local game, a hosted or a joined network game (`main_menu` cases 0/1/2), and
  `campaign_next_stage` reloads it at every campaign stage. In combat mode the override therefore lasts for the whole
  match (scheme parsed once per match) and does not leak into the next match.

### 4.4 Defaults (scheme_reset_defaults @0x4049c0, was `scheme_basic_grid`)

```
g_scheme_name = "Basic grid pattern"; g_scheme_density = 90
row y: (y odd) ? ":#:#:#:#:#:#:#:" : ":::::::::::::::"
g_scheme_starts[i] = { x,y = V(600+2i), V(601+2i) wrapped as above, team = i & 1 }
bornwith / has_override / override / forbidden = 0 for indices 0..14
```

VALUELST 600..619 give (0,0) (14,10) (0,10) (14,0) (6,4) (8,0) (12,4) (2,6) (10,8) (6,10) — identical to BASIC.SCH.

### 4.5 Storage

- `g_scheme_rows` (0x45e040): `char*[11]`, each row `calloc(16)` (15 chars + NUL), allocated in `scheme_init`
  (0x403b73). `scheme_cell(x,y)` (0x404852): out of bounds → 1; `':'` → 2; `'#'` → 1; anything else → 0.
  `scheme_set_cell(x,y,t)` (0x4048eb, editor): 1 → `'#'`, 2 → `':'`, else `'.'`.
- `g_scheme_starts` (0x46481c): 10 x `{int x, int y, int team}` (12 bytes). The game uses `g_start_x/g_start_y`
  (0x46460c / 0x46465c) for spawning (players_reset clamps them again with `>=`); `random_start` shuffles these two
  arrays only (200 random pair swaps per match), never the teams.

### 4.6 How the scheme and the level combine

1. `map_generate` (0x4260f5) copies the scheme: every `:` cell keeps its brick if `rand() % 100 < density`
   (`rand()` is called for brick cells only, row-major), solids and blanks are copied (flames doc §1.4).
2. Hidden power-ups are put under random bricks (flames doc §3.3).
3. Each **active** player clears its start cell (forced blank even if solid) and the non-solid N/E/S/W neighbours on
   its first update (flames doc §1.5); campaign rovers do the same at their spawn cell (§10).
4. Extras are loaded from EXTRA%u.RES. **Extras cells are not forced blank.** Arrows, conveyors and trampolines lie
   under whatever the scheme put there and become visible and usable when the cell is blank. Only warp holes clear
   their own cell plus one random neighbour on the first frame (§6.2).
5. The editor (`editor_edit_scheme` 0x4028d2, reached from `editor_main_menu`) writes files with `scheme_save`
   (§4.7); it knows nothing about levels or extras.

### 4.7 Writer (scheme_save @0x403c16, editor only)

Opens `data/schemes/<name>.sch` with "wt" and writes exactly (C format strings, `\n` = newline):

```
"\n; NOTE! This is an Atomic Bomberman Scheme File.\n"
"; Modify at your own risk.  It is machine-generated and updated.\n\n"
"\n; this is an internal version control number\n"          "-V,%u\n"            (2)
"\n; this is the textual name of the scheme\n"               "-N,%s\n"
"\n; scheme brick density (0-100 percent)\n"                 "-B,%u\n"
"\n; actual array data (# is solid, : is brick, . is blank)\n"
";               11111\n"   ";     012345678901234\n"        "-R,%2u,%s\n"  x 11
"\n; player starting locations (playerno,X,Y)\n"            "-S,%u,%d,%d,%d\n" x 10 (p, x, y, team)
"\n; powerup information; the fields are:\n"
";   powerup #, bornwith, has_override, override_value, forbidden\n"
";   (note the last text field has no effect; it is only a comment)\n"
                                                             "-P,%2u,%2d,%d,%2d,%2d,%s\n" x 13 (comment = M800+pw)
```

---------------------------------------------------------------------------------------------------------------------

## 5. Extras: data, file format, loading

### 5.1 Extra object (generic 0x98-byte OBJ; 100 slots at `g_extras` = `DAT_0045e0a8`)

| offset | type | meaning |
|---|---|---|
| +0x00 | int | `active`: 0 free/removed, 1 active, -1 client waiting for network data (counts as active in `extra_at`) |
| +0x04 | int | `type`: 0 arrow, 1 warp hole, 2 conveyor, 3 trampoline |
| +0x1c | int | cell x |
| +0x20 | int | cell y |
| +0x2c | short | arrow/conveyor direction 0..3; warp **id** |
| +0x2e | short | warp **link-to id** |
| +0x30 | ushort | animation counter |
| +0x34 | short | warp graphic number (`"extra warp %u"`; 0 = invisible but still works) |
| +0x92 | byte | warp "knock-out done" flag |

Other fields are unused. `g_extras_count` (0x45e0b0) = slots allocated by the loader; `g_extras_loaded` (0x45e0ac)
= 1 after a local load (allows answering client requests).

- `extras_reset` (0x404d53): loaded = 0, count = 0, `memset` all 100 slots.
- `extra_alloc` (0x404e3c): `if count < 100: e = &g_extras[count++]; memset(e, 0, 0x98); return e` else NULL
  (further lines are silently dropped).
- `extra_at(x, y)` (0x405654): first slot in index order with `active != 0 && x,y match`, else NULL.
- `warp_find_dest(w, &x, &y)` (0x405a81): first slot in index order with `active != 0`, `!= w`, `type == 1` and
  `id == w.linkto` → its cell; if none, `w`'s own cell.

### 5.2 EXTRA%u.RES format and parser (extra_load_res @0x404e99)

```
extra_load_res():
    f = fopen(datafile_path(sprintf("extra%u.res", g_level)), "rt")
    if !f: debug "There is no extra.res file for this level!"; return       // no extras, not an error
    while not eof:
        fgets(buf, 255, f); cut at first '\n'
        if buf[0] != '-': continue                         // comments ';' and blank lines
        split buf+1 at every ',' → tok[0..n-1]  (n = number of tokens, unlimited)
        switch tok[0][0]:                                  // case-sensitive
        'A':  require n == 4  (A,dir,X,Y)            else fatal "dirarrow: needs to have 4 args total (A,dir,X,Y)"
              d = parse_dir(tok[1])                  else fatal "dirarrow: invalid dir given ('%s')"
              x,y = coord(tok[2]), coord(tok[3])
              e = extra_alloc(); if e: e.active=1; e.type=0; e.dir=d; e.x=x; e.y=y
        'C':  same with n == 4, messages "conveyor: ...", type = 2
        'W':  require n == 6  (W,type,idno,X,Y,linkto)  else fatal "warphole: needs to have 6 args total ..."
              x,y = coord(tok[3]), coord(tok[4])
              e = extra_alloc(); if e: e.active=1; e.type=1; e.gfx=atoi(tok[1]); e.id=atoi(tok[2]);
                                     e.linkto=atoi(tok[5]); e.x=x; e.y=y; e.knocked=0
        'T':  if net_mode != 0: continue                    // trampolines exist only in local games
              require n == 3  (T,X,Y)                 else fatal "trampoline: needs to have 3 args total (T,X,Y)"
              if toupper(tok[1][0]) == 'H':           // random placement, tok[2] ignored
                  for t in 0..99:
                      x = rand() % 15
                      y = rand() % 11
                      if (x & 1) != (y & 1) and extra_at(x, y) == NULL: break
                  // after 100 failures the last (x,y) is used as is
              else: x,y = coord(tok[1]), coord(tok[2])
              e = extra_alloc(); if e: e.active=1; e.type=3; e.x=x; e.y=y
        other: fatal "Unknown entry in extra*.res file (after a dash '-')"
    fclose(f)

parse_dir(s):  switch tolower(s[0]): 'n'→0, 'e'→1, 's'→2, 'w'→3, else -1      // 0x404db8, first char only
coord(s, size): v = atoi(s); while v < 0: v += size; if v >= size: v = size-1  // 15 for X, 11 for Y
```

"fatal" = `debug_clue` + `fatal_error(0x69)` (the game exits). Negative coordinates count from the right/bottom edge
(-1 = last column/row). Random trampolines only go on cells with exactly one odd coordinate (in the standard pattern
these are never solid pillars, never the even/even start cells, and never under the fixed trampolines).

### 5.3 Shipped files (coordinates resolved)

Arrows `^ > v <`, conveyors `n e s w`, warp ids `0..3`, fixed trampolines `T`. Every entry sits on an even/even cell.

```
EXTRA2 (Hockey Rink, arrows)  EXTRA3 (Ancient Egypt, arrows)  EXTRA10 (Inner City, conveyors)
   012345678901234               012345678901234                012345678901234
 0 ........<......             0 ..>.v.>.v.>.v..              0 ...............
 1 ...............             1 ...............              1 ...............
 2 ..v.........<..             2 >.^.>.^.>.^.>.v              2 ..eeeeeeeeees..
 3 ...............             3 ...............              3 ..n.........s..
 4 v...>.....v....             4 ^.<.>.v.v.<.v.<              4 ..n.........s..
 5 ...............             5 ...............              5 ..n.........s..
 6 ....^.....<...^             6 >.^.^.<.>.^.>.v              6 ..n.........s..
 7 ...............             7 ...............              7 ..n.........s..
 8 ..>.........^..             8 ^.<.v.<.v.<.v.<              8 ..nwwwwwwwwww..
 9 ...............             9 ...............              9 ...............
10 ......>........            10 ..^.<.^.<.^.<..             10 ...............

EXTRA4 (Coal Mine): warps, all gfx 1:  id0 (2,2)→id3   id1 (12,2)→id0   id2 (12,8)→id1   id3 (2,8)→id2
                    (cycle (2,2) → (2,8) → (12,8) → (12,2) → (2,2))
EXTRA9 (Deep Forest): trampolines at (2,2) (12,2) (2,8) (12,8) + 4 x "H,H" (random, see §5.2)
```

EXTRA10 is one clockwise loop. EXTRA2 has an outer loop (2,2)v → (2,8)> → (12,8)^ → (12,2)< and an inner loop
(4,4)> → (10,4)v → (10,6)< → (4,6)^, plus four border arrows.

### 5.4 Loading per game (extras_level_load @0x40551f)

```
extras_level_load():
    extras_reset()
    if net_mode == CLIENT:
        for all 100 slots: active = -1
        show "Receiving 'Extras' Data..." (M308)
        loop (100 ms period, Esc aborts the game):
            count slots with active == -1; if any and rand() % 2 != 0: request the first one (0x40f830)
            progress = 100 - count
        until count == 0
    else:
        extra_load_res(); g_extras_loaded = 1
```

Network (net doc): the server answers a request with `extras_net_send(idx)` (0x405bba): from `min(idx, 90)`, 10
slots, each as shorts `{index, x, y, active, type, dir/id, linkto, gfx}`. The client stores them with
`extra_net_set` (0x405b3a) and `extras_net_clear_from(idx)` (0x405d7e) clears the slots idx..99 at the end of the
list. After "Sending data to clients" the server calls `extras_net_send_done` (0x405ced, loaded = 0). Since a
server never loads 'T' lines, **network games never have trampolines** (level 9 is plain there).

### 5.5 Removal when the enclosement starts

`map_update` (0x426818, flames doc §4.1) calls `extras_remove_for_hurry` (0x405d0c) once, on the frame where the
remaining time first becomes ≤ V101 − 5 = 55 s (with at least 2 players/teams alive): every active **warp and
trampoline** slot gets `active = 0`. Arrows and conveyors stay until the end of the game. This happens whatever the
enclosement depth is (also with "None"); with unlimited play time (clock value 1001) it never happens.

---------------------------------------------------------------------------------------------------------------------

## 6. Per-frame extras update and drawing (extras_update_draw @0x4056ca, was `extra_create_objects`)

### 6.1 Code

Called once per rendered frame by `game_frame` (0x42a191) right after the background copy, before bombs,
power-ups, flames, the map/hurry update and the players. It runs on every machine, also on clients.

```
extras_update_draw():
    for i in 0..99:
        e = &g_extras[i]; if e.active == 0: continue
        px = map_cell_center_x(e.x); py = map_cell_feet_y(e.y)
        switch e.type:
        case 0 (arrow):
            if map_get(e.x, e.y) == 0:
                e.anim++
                queue_sprite(px, py, frame("extra arrow " + dir_name(e.dir), e.anim))
        case 1 (warp):
            if e.knocked == 0:
                e.knocked = 1
                if net_mode != CLIENT:
                    map_set(e.x, e.y, 0); net_send_cell(e.x, e.y, 0)       // 0x40fde8: server only
                    do { r = rand() % 4; nx = e.x + dx[r]; ny = e.y + dy[r] }
                    while (nx < 0 || nx >= 15 || ny < 0 || ny >= 11)
                    debug "knocking out %u,%u"
                    map_set(nx, ny, 0); net_send_cell(nx, ny, 0)
            if e.gfx != 0:
                e.anim++
                queue_sprite(px, py, frame(sprintf("extra warp %u", e.gfx), e.anim))   // no blank test
        case 2 (conveyor):
            e.anim++                                                     // even when covered
            if map_get(e.x, e.y) == 0:
                queue_sprite(px, py, frame("extra conveyor " + dir_name(e.dir), e.anim / 3))
        case 3 (trampoline):
            if map_get(e.x, e.y) == 0:
                seq = "extra trampoline"
                if e.anim != 0:                                          // only while triggered
                    e.anim++
                    if e.anim > nstates(seq): e.anim = 0                 // 12
                queue_sprite(px, py, frame(seq, e.anim))
        default: debug "Unhandled extra type: %u"

frame(seq, s) = ani_seqno_to_frameno(ani_find_seq(seq), s)   // = seq.state[s % nstates].frame (unsigned modulo)
```

### 6.2 Warp knock-out details

- Done on the first frame of the game (not at load time), by the server or the local machine; clients get the cell
  changes over the network.
- The warp's own cell and **one** random orthogonal neighbour (rand() % 4, retried until inside the grid) become
  blank through plain `map_set`. The neighbour's content is not tested: it may already be blank (then the warp may
  stay enclosed by bricks), and a solid would be removed too (impossible with the shipped warps at even/even cells in
  the standard pattern).
- Power-ups hidden under these bricks are not relocated; `power_update_draw` deletes a hidden power-up whose cell is no
  longer a brick on the same frame (flames doc §3.5).

### 6.3 Graphics and draw layer

- Sequences (EXTRAS.ANI, CONVEYOR.ANI; 'dur=30' is irrelevant, the counters above drive them):
  - `extra arrow north|east|south|west`: 1 state each (frames 0..3).
  - `extra warp 1`: 1 state (frame 4).
  - `extra trampoline`: 12 states, frames `5 8 7 6 7 8 6 7 5 6 7 8`; state 0 (frame 5) is the idle look.
  - `extra conveyor west|east`: 5 states; `extra conveyor north|south`: 4 states.
  - No other file is involved: MISC.ANI (safe, scan, ring, goldman, xxx, cursor1, teamring0/1) and TRIGANIM.ANI
    (trigger bombs) have nothing to do with extras. The warp spin of a player uses WALK.ANI `spin` (§7.3).
- Conveyors advance one state every 3 rendered frames; all conveyors share the same phase (all counters start at 0
  and advance every frame). Animations are per rendered frame, not time-scaled.
- Trampoline animation after a trigger (counter set to 1 by the player code, which runs later in the same frame):
  following frames show states 2, 3, ..., 11, then 0 (counter 12), then the counter resets to 0 → 10 rendered frames
  of motion. State 1 is never shown.
- `queue_sprite` (0x415920) appends a type-0 entry (x, y, frame) to the frame's sprite list, drawn later in insertion
  order with the frame hotspot at (x, y) (graphics doc). Extras are queued first, so they are **under** bombs,
  power-ups, flames, players, aliens and carried bombs, and above the background (floor + tiles).
- Arrows, conveyors and trampolines are invisible while their cell is not blank (brick, solid, hurry block); warps
  are drawn regardless of the cell.

---------------------------------------------------------------------------------------------------------------------

## 7. What each extra does

### 7.1 Who is affected (summary)

| | arrow | warp hole | conveyor | trampoline |
|---|---|---|---|---|
| human & AI players | nothing | teleport | pushed when standing; speed ± when walking along/against | bounce to a nearby cell |
| network-remote players | – (simulated on their own machine) | | | |
| resting bomb | nothing | – (can't be there) | carried along the belt | nothing |
| kicked (sliding) bomb | redirected at the cell centre | blocks (bomb stops in front) | nothing while sliding | nothing |
| bomb carried by a belt | redirected at the cell centre | blocks | carried | nothing |
| punched / thrown (flying) bomb | nothing | can't land there (bounces on) | lands, then carried | lands normally |
| bomb dropping by a player | allowed | **not allowed** (sound S40) | allowed | allowed |
| flames | pass | pass | pass | pass |
| ghosts / rovers (campaign) | nothing | nothing | nothing | nothing |

The AI path finder does not know about extras (search.c never calls `extra_at`); only the AI helper 0x423188
("bomb may rest at cell": no bomb, no warp, blank) treats warps as blocked (AI doc).

### 7.2 Arrows (type 0)

Only bombs that move through the sliding-step loop of `maybe_bomb_update` (0x42331c, bombs doc) are affected: kicked
bombs (motion state +0x2e = 1) and resting bombs carried by a conveyor (§7.4). Inside that loop, for every 1-pixel
step:

```
nx = b.x + dx[b.dir]; ny = b.y + dy[b.dir]                   // candidate position
if map_offset_in_cell_x(nx) == 0 and map_offset_in_cell_y(ny) == 0:     // exactly at a cell centre
    e = extra_at(map_px_to_cx(nx), map_py_to_cy(ny))
    if e and e.type == 0: b.dir = e.dir; b.blocked(+0x39) = 0
then the blocking test uses the next cell in the (possibly new) direction ...
```

- The redirect happens when the bomb reaches the arrow cell's centre; the bomb then continues (or stops, if the next
  cell in the new direction is blocked: it stops on the arrow cell's centre with the usual stop sound).
- Because the sliding loop re-examines the bomb's current position as its first candidate each frame (bombs doc), a
  bomb resting on an arrow and kicked takes the **arrow's** direction immediately.
- Arrows never act on players or flying bombs. Arrows are not drawn while covered but still redirect (a sliding
  bomb cannot reach a covered cell anyway).

### 7.3 Warp holes (type 1)

Trigger, in `player_move_step` (0x41ec84) for every 1-pixel step of a player that has a movement direction (input,
or a conveyor push):

```
p.dir = p.godir
along = map_offset_in_cell_x(p.x) * dx[p.dir] + map_offset_in_cell_y(p.y) * dy[p.dir]
if along == -1:                                   // one pixel before the centre line, approaching it
    e = extra_at(map_px_to_cx(p.x), map_py_to_cy(p.y))
    if e and e.type == 1:
        p.special = 6; p.sp_frame = 0
        warp_find_dest(e, &tx, &ty)
        p.dest_x(+0x14) = map_cell_center_x(tx); p.dest_y(+0x18) = map_cell_feet_y(ty)
        sound_play_group(1330)                    // random one of S1330 warp1, S1331 transin, S1332 transout
    if e and e.type == 3: (trampoline, §7.5)
... the step itself continues (kick test, cornering, 1 px move — player doc)
```

- The rest of this frame's pixel budget is still walked, so the player may pass the centre by a few pixels before the
  spin starts. The perpendicular offset does not matter for the trigger.
- From the next frame, in `player_update` (0x41f29b): input is not read while `p.special` is 5, 6 or 7, so
  `p.godir` stays -1 and the player does not walk.

```
special 6:  frame = frame("spin", p.sp_frame)    // WALK.ANI 'spin', 4 states; chosen before advancing
            advance p.sp_frame per reference frame
            if p.sp_frame > 8: p.special = 7; p.sp_frame = 0; p.x = p.dest_x; p.y = p.dest_y   // teleport
special 7:  same frame choice and advance
            if p.sp_frame > 8: p.special = 0; p.sp_frame = 0
drawn the normal way: shadow at (x,y), remapped player sprite at (x,y)
```

  Each phase lasts until 9 reference-frame ticks have accumulated (≥ 450 ms; `p.sp_time` keeps its remainder),
  about 0.9 s in total. The facing direction (`p.dir`) is unchanged afterwards.
- While `p.special` is 5, 6 or 7, `player_net_death` (0x41de63) refuses to kill the player: immune to flames, falling
  hurry blocks and campaign aliens.
- Destination: deterministic (`warp_find_dest`, §5.1). The player lands exactly on the destination warp's centre
  (offset 0), so leaving it does not trigger it. There is **no cooldown**: stepping out by a pixel and back towards the
  centre (`along == -1` again) warps again. A warp without a partner sends the player back to its own centre after
  the two spins.
- Only players warp. Bombs cannot enter warp cells (`bomb_slide_cell_free` 0x4230a5 returns false for a warp cell, so
  sliding bombs stop in the previous cell); flying bombs do not land on them (they bounce on to the next cell);
  players cannot drop a bomb on a warp (`player_update` @0x420be0: sound S40 "enrt", silent when the drop was forced
  by the poops disease, player+0x87 or +0x89). Aliens ignore warps.
- Warps disappear when the enclosement starts (§5.5).

### 7.4 Conveyors (type 2)

Speed: `conv = V(190 + g_opt_conveyor_speed)` (option `conveyor_speed` = `DAT_00464930`, default 1, clamped to
`0..V189-1` = 0..2; settings shows M295+n "Low/Medium/High") → 250 / 350 / 450 (1/100 px per reference frame).

**Players** (`player_update`, not for network-remote players, type 4). The cell is the one containing the feet
point:

```
if p.godir == -1:                                  // no movement this frame (no input, or input blocked)
    e = extra_at(cell of p)
    if e and e.type == 2:
        p.godir = e.dir; saved = p.dir
        p.move_acc(+0x74) += (conv * dt) / 50
        if player_move_step(p): → death handling
        p.godir = -1; p.dir = saved                // facing unchanged; the stand animation is shown
else:
    speed = p.speed(+0x70) + skates(+0x5a)*V90 - clogs(+0x63)*V91
    if molasses(+0x84): speed /= 3
    if +0x85 or +0x89: speed = speed*3/2
    speed = (speed * dt) / 50
    e = extra_at(cell of p)
    if e and e.type == 2:
        if e.dir == p.godir:             speed += (conv * dt) / 50
        if e.dir == (p.godir + 2) & 3:   speed -= (conv * dt) / 50
    p.move_acc += speed
    if player_move_step(p): → death handling
```

- Standing players move at exactly the belt speed, using the normal movement step (walls, bombs and the cornering
  slide apply; warps/trampolines on the way would trigger). Walking across a belt (perpendicular) gives no drift.
- Belt transitions: the belt under the player's current cell decides each frame. At a corner of the EXTRA10 loop the
  player enters the next belt cell near its edge and the cornering logic of `player_move_step` slides it to the new
  lane (player doc).
- The special states (bounce, warp spin, stun) do not stop the push: the player has `godir == -1` then.

**Bombs** (`maybe_bomb_update` case motion 0 = resting, only for locally simulated bombs, bomb+0x10 == 9):

```
e = extra_at(cell of b)
if e and e.type == 2:
    b.dir = e.dir
    b.move_acc(+0x74) += (conv * dt) / 50
    repeat 2 times:                                // re-centre on the cross axis, 2 px per rendered frame max
        if (b.dir & 1) == 0: o = map_offset_in_cell_x(b.x); if o < 0: b.x++; if o > 0: b.x--
        else:                o = map_offset_in_cell_y(b.y); if o < 0: b.y++; if o > 0: b.y--
    run the sliding-step loop (as for kicked bombs; arrows apply)
```

- The bomb keeps motion state 0, so its fuse keeps running and it can still be kicked or picked up. A kicked bomb
  (motion 1) is not affected while it slides; once it stops on a belt, the belt takes it.
- When the next cell is blocked (bomb, player, brick/solid, warp, ...) the bomb snaps to its cell centre, the
  accumulator is cleared, and nothing is played (motion was 0); the next frame it tries again. A jelly bomb gets its
  direction reversed but the belt resets it every frame.
- A bomb carried off the end of a belt stops wherever the last step left it (not re-centred). EXTRA10 is a closed
  loop, so this does not happen with the shipped data.

### 7.5 Trampolines (type 3)

Trigger: same place and condition as the warp (`along == -1` in `player_move_step`): `e.anim = 1` (starts the
trampoline animation), `p.special = 5`, `p.sp_frame = 0`, `sound_play_group(350)` (one of S350..S353).

Bounce, in `player_update` (`V680 = 30`, `V681 = 35`):

```
special 5:
    advance p.sp_frame per reference frame
    if p.sp_frame >= V680: p.special = 0; p.sp_frame = 0               // landed
    name = "stand <dir>" (or "standbomb <dir>" when holding a bomb), frame index p.anim(+0x30) / 3
    if p.sp_frame == V680 / 2:                                          // 15, apex: move to a new cell
        cx = map_px_to_cx(p.x); cy = map_py_to_cy(p.y)
        for t in 0..99:
            nx = rand() % 5 + cx - 2
            ny = rand() % 5 + cy - 2
            if nx == cx or ny == cy: continue         // never the same row or column
            if map_get(nx, ny) != 0: continue         // must be blank and inside the grid
            if bomb_at_cell(nx, ny): continue
            p.x = map_cell_center_x(nx); p.y = map_cell_feet_y(ny); break
        p.sp_frame++                                  // 15 → 16 (so the apex test cannot repeat)
    h = (p.sp_frame < V680/2) ? p.sp_frame * V681 : (V680 - p.sp_frame) * V681
    queue_sprite_remap(p.x, p.y - h, frame, p.color(+0x3c))    // no shadow, no 'kface' marker
```

- The bounce lasts 30 reference frames (1.5 s nominal). The sprite rises 35 px per tick (up to 525 px, far off the
  top of the screen) and comes down at the new cell. Possible destinations are the 16 cells at (±1,±1), (±1,±2),
  (±2,±1), (±2,±2). Flames, players, power-ups and extras at the destination are not tested. A visible power-up
  there is picked up on the next frame, while the player is still in the air (the per-frame pickup test of
  `player_update` uses the ground position); a flame there kills only after the landing (immunity, §7.3). If no cell
  qualifies in 100 tries the player comes back down on the trampoline.
- The player cannot steer, drop bombs or act while bouncing (input is not read), and cannot be killed (§7.3).
  The ground position (p.x, p.y) is what all other code sees.
- The relocation happens only on a frame where the counter equals exactly 15. If a long frame advances it from 14 to
  16 or beyond, the jump is skipped and the player lands back on the trampoline.
- Bombs, flames and aliens ignore trampolines. A player arriving at a trampoline's centre from a bounce (offset 0)
  does not trigger it.
- Hidden ('H') trampolines are simply randomly placed ones (§5.2). They are usually under bricks, invisible and
  unreachable until the brick is destroyed — in effect "hidden", but they are ordinary trampolines.
- Trampolines disappear when the enclosement starts (§5.5) and do not exist in network games (§5.4).

---------------------------------------------------------------------------------------------------------------------

## 8. Level-specific rules besides extras

### 8.1 Ice / control delay (V450+L; only the Hockey Rink has 250 ms)

In `player_update`, for every player except AI (type 1), after input has been read (and after the facing direction
`p.dir` has been set from the raw input):

```
hist = g_input_hist[player]          // 30 entries {int age_ms, int dir}; reset to {0,-1} at game start (0x4214bc)
for k in 0..29: hist[k].age += dt
for k = 29 down to 1: hist[k] = hist[k-1]
hist[0] = {0, p.godir}
for k in 0..29:
    p.godir = hist[k].dir
    if hist[k].age >= V(450 + g_level): break        // newest entry at least `delay` ms old (else the oldest)
```

With delay 0 this is the current input. With 250 ms the player starts, stops and turns 250 ms late (it keeps sliding
for 250 ms after release); the sprite already faces the new input direction. AI players are not affected.

### 8.2 Regenerating bricks (V340+L; only the Haunted House, every 4 s)

`map_regen_tick` (0x426704), see flames-map-powerups.md §5: server/local only; every V(340+L) seconds, up to 100
random cells (`x = rand()%15, y = rand()%11`); the first one that is blank, has no power-up, no bomb, and no player
slot within Manhattan distance V695 = 4 becomes a brick (without a power-up). Extras are not tested.

---------------------------------------------------------------------------------------------------------------------

## 9. Cross-reference of the player / bomb fields used here

| field | meaning |
|---|---|
| player+0x10 | type (0 off, 1 AI, 2 key, 3 joy, 4 net) |
| player+0x14 / +0x18 | spawn pixel position; **reused as warp destination** |
| player+0x1c / +0x20 | pixel position (centre x, feet y) |
| player+0x2c / +0x2e | facing / wanted direction (`godir`, -1 = none) |
| player+0x30 | walk/stand animation counter |
| player+0x3c (byte) | colour remap |
| player+0x4e / +0x50 / +0x52 | special animation state / frame / time (5 trampoline, 6 warp out, 7 warp in) |
| player+0x54 (byte) | team (from the scheme) |
| player+0x70 / +0x74 | base speed / movement accumulator |
| bomb+0x2c / +0x2e | direction / motion (0 resting, 1 sliding, 2 flying, 3 held) |
| bomb+0x39 | "blocked" flag of the sliding loop |
| bomb+0x74 | movement accumulator |

---------------------------------------------------------------------------------------------------------------------

## 10. Campaign data (.CAM) and aliens (short)

Campaign mode is a secondary mode with ghosts and rovers (match-flow doc covers the flow).

**Reaching it.** On the player-setup screen of match setup (0x410f81), when `net_mode == 0`, pressing `C`/`c` 5
times (the counter is never reset by other keys) opens "Please select a campaign file:" (M1250) listing
`data/res/*.cam` (CROUTON.CAM, GHOSTS.CAM, SIMPLE.CAM; M1215 wrongly says CAMP*.RES). After a choice:
`campaign_load`, "Campaign Mode Activated!" (M1210), `g_campaign_mode` (`DAT_0046489c`) = 1.

**File format** (`campaign_load` 0x401085, two passes: count, then fill an array of 0x70-byte stages): lines read
with `fgets(99)`, cut at `'\n'` and at every `,` (up to 40); a stage line starts with `-` followed by `C` (any case)
and must contain exactly 9 commas:

```
-C, name, levelno, scheme, rovers, rover_speed, ghosts, ghost_speed, AIs, AI_difficulty
```

| stage offset | field |
|---|---|
| +0x00 | name (strncpy 50) |
| +0x34 | level number (atoi) |
| +0x38 | scheme name (strncpy 30; ".sch" is appended by `scheme_parse`) |
| +0x58 / +0x5c | number of rovers / rover speed (1/100 px per reference frame) |
| +0x60 / +0x64 | number of ghosts / ghost speed |
| +0x68 | number of AI players |
| +0x6c | AI difficulty (read, unused) |

**Stage start** (`campaign_next_stage` 0x40133f, called first in `level_start`; match setup set the stage to -1
via `campaign_restart` 0x401312): `valuelst_load()`, stage++; if
stages remain: `g_scheme_filename` = stage scheme, `g_opt_levelno` = stage level, `scheme_parse`, message "Prepare to
begin Campaign!" / "(name)", and if `random_start`: 200 random swaps of the start positions. Otherwise
"Congratulations! You made it through the whole campaign!" and the game state becomes 10.
After the level is set up, `campaign_stage_setup` (0x40151b) turns every AI slot OFF (0x42288c), then for each of
the stage's `AIs` picks a random OFF slot (`rand() % 10`, up to 100 tries, 0x422928) and makes it an AI; then it
clears the aliens and spawns `ghosts` ghosts (type 2) and `rovers` rovers (type 1) with their speeds.

**Aliens** (aliens.c, 100 OBJ slots at 0x45e020, updated by `campaign_update` 0x4016da from `game_frame`):
- Spawn (0x4019c2): up to 200 tries of `x = rand()%15, y = rand()%11`, cell not solid and no player slot within
  Manhattan distance 3; position = cell anchor.
- Rovers on their first update clear their spawn area like players (`map_clear_start_area`).
- Movement (`alien_update` 0x401b5c): accumulator `+= speed*dt/50 + 100`, 1-pixel steps along `dir`. At each cell
  centre (along-axis offset 0): if the next cell is not enterable → stop for this frame and turn; else turn with
  chance 1/V1200 (3). A turn is `dir ± 1` (rand()%2), after which a blocked next cell stops it for the frame.
  Enterable (0x4017fa): no bomb, and blank for rovers / anything but solid for ghosts (ghosts pass through bricks).
  V1205 is not used.
- A flame in the alien's cell kills it (removed on the next update) and gives its owner V1310 = 15 (rover) or
  V1320 = 25 (ghost) points. An alien kills (via `player_net_death`) every non-AI player in its cell; AI players are
  immune.
- Drawn as `"ghost <dir>"` / `"rover <dir>"` (ALIENS1.ANI) at the position.
- Aliens never look at extras.

---------------------------------------------------------------------------------------------------------------------

## 11. Function and global reference

| address | proposed name | notes |
|---|---|---|
| 0x404d16 | extra_init | alloc 100 x 0x98, register deinit |
| 0x404d53 | extras_reset | |
| 0x404db8 | extra_parse_dir | n/e/s/w → 0..3, else -1 |
| 0x404e3c | extra_alloc | |
| 0x404e99 | extra_load_res | §5.2 |
| 0x40551f | extras_level_load | §5.4 |
| 0x405654 | extra_at | (bomb doc uses the same name) |
| 0x4056ca | extras_update_draw | was `extra_create_objects`; called from `game_frame` 0x42a229 |
| 0x405a81 | warp_find_dest | |
| 0x405b3a | extra_net_set | client side, from net handler 0x40d905/0x40d99c |
| 0x405bba | extras_net_send | server side |
| 0x405ced | extras_net_send_done | |
| 0x405d0c | extras_remove_for_hurry | |
| 0x405d7e | extras_net_clear_from | |
| 0x403b73 | scheme_init | |
| 0x403c16 | scheme_save | not in the decompilation (called from the editor at 0x40310f) |
| 0x403eee | scheme_parse | |
| 0x4046cc | scheme_load | once per match |
| 0x404833 | scheme_parse_current | `scheme_parse(g_scheme_filename)` (campaign) |
| 0x404852 | scheme_cell | |
| 0x4048eb | scheme_set_cell | |
| 0x4049c0 | scheme_reset_defaults | was `scheme_basic_grid` |
| 0x404be9 | scheme_read_name | for the chooser; keeps commas in the name |
| 0x410b6e | level_start | was `maybe_level_load` |
| 0x4165fc | graf_load_field_bitmap | |
| 0x41ec84 | player_move_step | warp/trampoline trigger |
| 0x41f29b | player_update | ice, conveyors, special states 5/6/7 |
| 0x4028d2 | editor_edit_scheme | was `team_ring_draw` (draws "teamring%u" around starts) |
| 0x402206 | editor_tile_frame | was `tiles_load_level_seqs`; editor only |
| 0x401085.. | campaign/aliens | see names file |

Globals: `g_extras` 0x45e0a8, `g_extras_loaded` 0x45e0ac, `g_extras_count` 0x45e0b0, `g_level` 0x46499c,
`g_opt_levelno` 0x464998, `g_opt_conveyor_speed` 0x464930, `g_scheme_filename` 0x4648c4, scheme globals in §4.5.

---------------------------------------------------------------------------------------------------------------------

## 12. Uncertain

1. Tile frames are assumed to be exactly 40x36 (the blit uses w 40, h 36, source pitch 40; the brief says tile frames
   are 40x36). The ANI frame format itself is in the graphics doc.
2. The clock value compared with V101−5 (warp/trampoline removal) is `time_remaining_s` (0x410578) per the flames
   doc; the exact clock behaviour is in the match-flow doc.
3. The meaning of bomb+0x10 == 9 (the only bombs that conveyors move) is "locally simulated bomb" by assumption
   (bombs/network docs).
4. What a network client sees of a remote player's warp spin or bounce is a network-doc question (the special state
   is not part of the per-frame player message 0x40ef4e). Trampolines never exist in network games anyway.
5. A bomb held (grabbed) by a bouncing player is positioned by the bomb code from the holder's ground position
   (`maybe_bomb_update` motion 3: holder x/y + 10 px in the facing direction, 40 px up), so it should stay near the
   ground while the holder's sprite flies; not tested in the game.

## 13. Bugs and quirks (replicate unless noted)

1. **No trampolines in network games** ('T' lines are skipped when `net_mode != 0`), so level 9 differs online.
2. **Trampoline apex test is `== 15`**: a frame-time spike that skips the value 15 cancels the jump (the player lands
   on the trampoline again).
3. Trampoline destinations exclude the same row and column and do not check flames, players, power-ups or extras.
4. No cooldown on warps; stepping 1 px out of the destination and back re-triggers. A warp whose link id does not
   exist teleports the player onto itself.
5. Warp knock-out picks one random neighbour without checking it: it may already be blank (no new exit) or solid
   (removed). Hidden power-ups in knocked-out bricks are deleted.
6. Warps and trampolines are removed at 55 s remaining even with enclosement depth "None"; arrows and conveyors stay.
7. Conveyor pushes on players add to the movement accumulator. Walking against a belt with a speed lower than the
   belt speed (e.g. molasses) gives a negative frame speed: the player does not move backwards, the accumulator goes
   negative and builds a "debt" that must be repaid before the player moves again.
8. Ice delay ignores AI players; the facing turns immediately while the movement is delayed.
9. A bomb carried off the end of a belt stops off-centre (not on shipped data).
10. `-S` clamps with `>` (x = 15, y = 11 accepted); harmless because spawning clamps again with `>=`.
11. `-R` lines repeat the "wrong version" warning for each row if they come before `-V,2`; a `-V` or `-N` line without a
    comma makes `atoi`/`strcpy` read a NULL token (crash). Names containing commas are truncated by `scheme_parse`
    but not by `scheme_read_name`.
12. `bornwith` of 0 cannot remove default starting bombs/flames (only values > 0 are written to VALUELST).
13. More than 100 extras lines are silently ignored; malformed extras lines crash the game (fatal 0x69).
14. Random "Each Game" level selection gives up after 200 rolls and keeps an ineligible level (cannot happen with the
    shipped VALUELST). Attract mode ignores eligibility.
15. Campaign aliens never kill AI players; M1215 mentions CAMP*.RES but the files are *.CAM.

## 14. Notes for other docs

- flames-map-powerups.md §3.3 says "VALUELST and the scheme are reloaded every level (FUN_0040133f)". That reload
  only happens in **campaign mode**. In combat mode the scheme is parsed once per match (`scheme_load` from match
  setup 0x410f81) and VALUELST is reloaded by the main menu before each new match (§4.3).
- Player doc: `player_net_death` refuses players in special states 5/6/7 (bounce, warp spin), see §7.3.
- Bomb doc: arrows act inside the sliding loop on the candidate position (§7.2); conveyors act on resting bombs
  (§7.4); `bomb_slide_cell_free` and the landing test treat warps as blocked.
