# Map, flames, power-ups, hurry/enclosement and regenerating tiles

Sources: `BM95.EXE` (Watcom C, not optimized). The modules are map.c (0x425d22-0x426c4b), power.c (0x424ee0-0x425d21) and
flame.c (0x426c60-0x42708d, plus `flame_at`/`flame_kill` at 0x42708d/0x427115, which the decompiler header wrongly put
under tunes.c). The explosion propagation is in bombs.c `maybe_bomb_update` (0x423f49-0x424287). Pickup and drop code is
in you.c. Every claim below was checked against the disassembly (`bmdisasm.py`), because the decompiler loses most
register arguments (EDX/EBX/ECX) in these modules.

Notation:
- `V<n>` = VALUELST.RES id n.
- `W=15`, `H=11` = grid size. `REF=50` = ms per reference frame (`1000/V30`, global `0x46494c`).
- `dt` = real milliseconds since the previous rendered frame, capped at `V31=150` (global `0x464958`).
- `rand()` is the Watcom LCG: `seed = seed*1103515245 + 12345; return (seed>>16) & 0x7fff`. It is always
  non-negative, so `rand()%n` is in `0..n-1`. When a cell is picked at random, the code always draws
  `x = rand()%15` first and then `y = rand()%11`.
- Directions everywhere: `0=N, 1=E, 2=S, 3=W`, with `dx={0,1,0,-1}` (0x45becc) and `dy={-1,0,1,0}` (0x45bedc).
- Proposed names are in `docs/re/names/flames-map-powerups.txt`. Several existing names were wrong:
  `flame_create` is really `flame_update_draw`, `maybe_power_create` is `power_update_draw`, `map_tile_seqs` is
  `map_draw_cell`, and `maybe_influence_set`/`maybe_influence_get` are swapped (they are `danger_get` and `danger_raise`).

---------------------------------------------------------------------------------------------------------------------

## 1. Map

### 1.1 Constants (map_init @0x42647a)

| global | value | meaning |
|---|---|---|
| `0x4648ac` | 15 | grid width (cells) |
| `0x4648b4` | 11 | grid height |
| `0x4648a4` | 40 | cell width (px) |
| `0x4648a0` | 36 | cell height (px) |
| `0x464898` | `(640-600)/2 = 20` | screen x of the grid's left edge |
| `0x4648a8` | `480-412 = 68` | screen y of the grid's top edge |

The grid covers screen pixels x 20..619 and y 68..463.

### 1.2 Cell array

`g_map` (0x46222c) is `int[165]` with index `y*15 + x`. Values:
- `0` = blank (walkable)
- `1` = solid (indestructible)
- `2` = brick (destructible)
- `-1` is used only by a network client while it waits for level data

`map_get(x,y)` (0x425fb9) returns `1` (solid) for any coordinate outside the grid. That is why flames, the plus-shape
clearing and similar code treat the outside of the board as a solid wall.

Other objects are not stored in the map. Each lives in its own structure:
- power-ups: per-cell grid `g_power_grid`
- flames: per-cell grid `g_flame_grid`
- bombs: a list of 100 objects, looked up by pixel position
- players: a list of 10
- extras: a list of 100

The power and flame grids hold one generic 0x98-byte "OBJ" per cell, again with index `y*15 + x`.

### 1.3 Pixel and cell helpers (exact formulas, C integer division truncates toward 0)

Objects store a "feet" position. `x` is the horizontal centre of the cell. `y` is the bottom pixel row of the cell
(the tile hotspot is (20,35)).

```
map_cell_center_x(cx) = 20 + 40/2 + 40*cx        = 40 + 40*cx            (0x426524)
map_cell_feet_y(cy)   = 68 + 36 - 1 + 36*cy      = 103 + 36*cy           (0x42655f)
map_px_to_cx(px):  v = px; if (v < 20) v -= 20;            return (v - 20) / 40        (0x42665c)
map_py_to_cy(py):  v = py; if (py - 68 - 17 < 0) v = py - 67; return (v - 68 - 17) / 36  (0x4266a3)
map_offset_in_cell_x(px): v = px; while (v < 20) v += 40;  return (v - 20) % 40 - 20   (range -20..19, 0 = centre)
map_offset_in_cell_y(py): v = py; while (v - 85 < 0) v += 36; return (v - 85) % 36 - 18 (range -18..17, 0 = feet line)
```

On the board, a point belongs to cell `((px-20) div 40, (py-85) div 36)`. The y boundaries are therefore offset by half a
cell: the cell whose feet line is `103+36cy` owns the y range `85+36cy .. 120+36cy`. The `<20` and `<85` special cases
are an attempt at floor division for off-board coordinates, and they are not correct (see Quirks). For example,
`px` in 1..19 gives cell 0, `px` in -39..0 gives -1, and `py` 81..84 gives -1 while `py` 45..80 gives -2.

All collision with flames, power-ups and extras (and the kill and pickup tests) uses the single cell that contains the
object's feet point, computed with these functions.

### 1.4 Scheme to map (map_generate @0x4260f5)

The scheme (scheme.c, `scheme_parse`) supplies these fields:
- `-R,row,<15 chars>` rows, where `#` = solid, `:` = brick and anything else (normally `.`) = blank.
  `scheme_cell(x,y)` (0x404852) maps them to 1, 2 and 0 (out of bounds gives 1).
- `-B,density` brick density, stored in `0x4647a0`. The default is 90 (`scheme_basic_grid`).
- `-S,player,x,y[,team]` start cells. Negative values wrap around.
- `-P,type,bornwith,has_override,override_value,forbidden[,comment]` for types 0..12 (see section 3.3).

If no scheme file has been read yet, `scheme_basic_grid` provides a default: even rows are `:::::::::::::::`, odd rows
are `:#:#:#:#:#:#:#:`, density is 90, and the start cells come from V600..V619 (team = index&1).

Generation, when not a network client:

```
for y in 0..10: for x in 0..14: map_set_raw(x,y,0)
for y in 0..10:                              // row-major, so the rand() order is y-major
  for x in 0..14:
    v = scheme_cell(x,y)
    if v == 2 and (rand() % 100) >= density: v = 0     // keep a brick with probability density/100
    map_set_raw(x,y,v)
```

`rand()` is drawn only for brick cells. Generation does not clear anything around the start positions; that happens
later (section 1.5).

Level-load order (`maybe_level_load` 0x410b6e):
1. `map_generate`
2. load the field background `field<level>`
3. `map_draw_all`
4. clear bombs, flames and power-ups
5. `FUN_004214bc` (players reset, counts = V50+t)
6. **`power_place_level`** (section 3.3)
7. extras init
8. `g_hurry_voice_played = 0`

### 1.5 Clearing the start area (map_clear_start_area @0x42583b)

This is not part of generation. It runs from `player_update_anim` (0x41f2c5) on the first update frame of each
**present** player slot (slot type byte `+0x10 != 0`; flag `+0x92` is reset to 0 at round start). Cells around unused
start positions keep their bricks. The coordinates come from the player's start position
`(map_px_to_cx(p+0x14), map_py_to_cy(p+0x18))`:

```
map_clear_start_area(x, y, v=0):
  map_clear_cell_keep_power(x, y, v)                      // the start cell itself, even if it is solid
  if map_get(x, y-1) != 1: map_clear_cell_keep_power(x, y-1, v)   // N
  if map_get(x+1, y) != 1: map_clear_cell_keep_power(x+1, y, v)   // E
  if map_get(x, y+1) != 1: map_clear_cell_keep_power(x, y+1, v)   // S
  if map_get(x-1, y) != 1: map_clear_cell_keep_power(x-1, y, v)   // W

map_clear_cell_keep_power(x, y, v):              // 0x425704
  if (x,y) out of bounds: return
  p = &power[x][y]
  if p.state != 0:                               // a power-up was hidden under this brick
    for try in 0..199:
      rx = rand()%15; ry = rand()%11
      if map_get(rx,ry) == 2 and power_at(rx,ry) == NULL:
        power[rx][ry] = *p (whole 0x98-byte copy); memset(p, 0); break
  map_set(x, y, v)                               // sets the cell and redraws it
```

The cleared area is a plus shape: the start cell plus each orthogonal neighbour that is not solid. Power-ups hidden
under cleared bricks are moved under another random brick. If 200 tries fail, the power-up stays at the now-blank cell
and is deleted by `power_update_draw` (hidden power-ups on non-brick cells are removed). In campaign mode the flag is
re-armed on respawn, so the area is cleared again.

### 1.6 Drawing cells (map_draw_cell @0x425d22, map_set @0x425e9b, map_draw_cell_as @0x425efc)

Tiles are not sprites. They are painted into the persistent background buffer:

```
map_draw_cell(x, y):
  px = 20 + 40*x; py = 68 + 36*y                          // top-left corner of the cell
  restore_background_rect(px, py, 40, 36)                  // copy from the level's field bitmap (FUN_004166bf)
  v = map_get(x, y)
  if v != 0:
    name = (v == 1) ? "tile <level> solid" : "tile <level> brick"   // <level> = g_level 0..10 (0x46499c), %u
    blit frame 0 of that sequence (raw 40x36 bitmap, no remap) at (px, py)
       // TRANSPARENT blit: palette index 0 is skipped (FUN_0041532b -> 0x4428e4 -> 0x44aed5, MMX pcmpeqb 0),
       // so index-0 pixels show the field background restored just before
```

- `map_set(x,y,v)` = `map_set_raw` + switch the draw target to the background buffer + `map_draw_cell` + restore the
  target.
- `map_draw_cell_as(x,y,v)` saves the old value, sets `v`, redraws, then restores the old value. A bomb uses it to erase
  a brick's picture while the cell stays a brick (section 2.4).
- The per-state (x,y) offsets that `ani_seqs.txt` lists for "tile N ..." are **not** used. The bitmap is blitted
  straight to the cell's top-left corner.

Tile art per level: `TILES0.ANI` .. `TILES10.ANI` hold "tile N solid" and "tile N brick". "tile 0 blank" exists but is
not used in game, since blank cells show the field background. "tile -1 blank|brick|solid" in EDIT.ANI belong to the
editor (`tiles_load_level_seqs` 0x402206). Levels, from the VALUELST 450-460 comments:
0 new green acres, 1 classic green acres, 2 hockey rink, 3 ancient egypt, 4 coal mine, 5 beach, 6 aliens,
7 haunted house, 8 under the ocean, 9 deep forest, 10 inner city.

`map_draw_all` (0x42633c) draws all 165 cells. It also sets the playfield clip rectangle `g_map_cliprect`
(0x46221c..) to `{0,0,640,480}`. `map_apply_cliprect` (0x42641f) applies that rectangle at the start of object
drawing every frame.

### 1.7 Where map, power and flame code runs in a frame (game_frame @0x42a191, not in the decompilation)

```
now = timeGetTime(); dt = min(now - last, V31); last = now
(net receive)  frame_counter++ (0x464994)
FUN_004105d2           clock: remaining/elapsed seconds, HUD timer
map_apply_cliprect
extra_create_objects   extras update+draw
FUN_004245b9           maybe_bomb_update(0): free bombs; EXPLOSIONS happen here (flame_set, power_reveal_at, ...)
power_update_draw      power-ups (0x424f89)
FUN_0041b961           (sound.c)
flame_update_draw      flames (0x426d06)
map_update             regeneration + enclosement (0x426818)
FUN_00420f07           players: movement, flame-kill test, pickups, death animation and drops
(campaign aliens)
FUN_0042459a           maybe_bomb_update(1): bombs that are held or in flight (drawn over players)
"hurry" text + voice   (section 5.1)
render display list, flip, net
```

Sprites go into a display list (max 400 entries, otherwise fatal error 10) that is rendered **in insertion order**
with no sorting. Draw order is therefore: extras → bombs on the ground → power-ups → flames (row-major, so later cells
are drawn over earlier ones) → players → carried or flying bombs → "hurry". Tiles live in the background buffer, under
everything.

---------------------------------------------------------------------------------------------------------------------

## 2. Flames

### 2.1 Flame cell (g_flame_grid 0x46224c, 165 x 0x98 bytes)

| off | type | meaning |
|---|---|---|
| +0x00 | int | state: 0 none, 1 burning, -1 (only inside the update pass) last draw of a brick flame |
| +0x04 | int | flame type (table below) |
| +0x1c/+0x20 | int | cell x/y (rewritten every frame by the update pass) |
| +0x30 | u16 | animation frame index |
| +0x32 | s16 | animation ms accumulator |
| +0x3c | u8 | colour/remap index (the bomb's `+0x3c`, i.e. the owner's colour) |
| +0x3e | s16 | owner player id (kill credit); -1 for brick flames |
| +0x44 | s16 | age in ms |

Flame types (name table at 0x45bea0):

| type | name | sprite |
|---|---|---|
| 0, 1, 2, 3 | tipnorth, tipeast, tipsouth, tipwest | "flame <name> green" |
| 4, 5, 6, 7 | midnorth, mideast, midsouth, midwest | "flame <name> green" |
| 8 | center | "flame center green" |
| 9 | brick | "flame brick <level>" (XBRICK<level>.ANI) |

`flame_set(x, y, type, color, owner)` (0x426fcc, owner is the stack argument):

```
if in bounds:
  danger_raise(x, y, 1000)           // AI danger map
  memset(cell, 0, 0x98)
  state = 1; age = 0; frame = 0; type; color; owner
```

**There is one flame per cell. Every `flame_set` overwrites whatever was there: type, owner and colour change, and the
age and animation restart.** Crossing or overlapping flames are never merged. The cell simply shows and behaves like the
most recent flame. `flame_at(x,y)` returns the cell if `state != 0`. `flame_kill(f)` sets `state = 0`.

### 2.2 Explosion propagation (bombs.c @0x423f49, inside maybe_bomb_update)

Bombs explode only while `alive_count() > 1`: two or more players are alive, or two or more teams in team play
(section 5.1). When a bomb's age reaches its fuse (`bomb+0x44 >= bomb+0x4a`), the following runs. Relevant bomb fields:
- `+0x1c/+0x20` pixel position (feet)
- `+0x38` u8 skip direction
- `+0x3c` u8 colour
- `+0x3e` s16 owner id
- `+0x4c` u8 flame length

```
bomb.state = 0
(net message if bomb +0x10 == 9)
sound_play_group(200)                                  // expl6 group 200..219
for dir in 0..3:                                       // N, E, S, W in this order
  if bomb.skip != 0 and dir+1 == bomb.skip: continue
  cx = map_px_to_cx(bomb.x); cy = map_py_to_cy(bomb.y)
  flame_set(cx, cy, 8 /*center*/, bomb.color, bomb.owner)      // repeated for each direction, which is harmless
  p = power_at(cx, cy)
  if p and p.state == 2:  t = p.type; power_destroy(p); if t == 2 and !g_opt_diseases_destroyable: power_spawn_random_blank(2)
  for i in 0 .. bomb.range-1:
    cx += dx[dir]; cy += dy[dir]
    b = bomb_at_cell(cx, cy)                           // excludes bombs that are flying or held (+0x2e == 2 or 3)
    if b:                                              // CHAIN: the cell itself gets no flame
      b.owner(+0x3e) = bomb.owner                      // kill credit propagates along the chain
      bomb_queue_detonate(b, ((dir+2)&3) + 1)          // b will not send flames back toward this bomb
      break
    p = power_at(cx, cy)
    if p and p.state == 2:                             // visible (revealed) power-up: destroyed, flame STOPS, no flame here
      t = p.type; power_destroy(p)
      if t == 2 and !g_opt_diseases_destroyable: power_spawn_random_blank(2)
      break
    v = map_get(cx, cy)
    if v == 1: break                                   // solid or off-board: no flame
    if v == 2:                                         // brick
      flame_set(cx, cy, 9 /*brick*/, bomb.color, -1)
      stats_bricks++ (0x4642b8)
      map_draw_cell_as(cx, cy, 0)                      // erase brick picture; cell stays 2 (impassable)
      power_reveal_at(cx, cy)                          // section 3.4
      break
    type = (i == bomb.range-1) ? dir /*tip*/ : dir+4 /*mid*/
    flame_set(cx, cy, type, bomb.color, bomb.owner)
```

Consequences:

- **What stops a flame:**

  | flame meets | result |
  |---|---|
  | a bomb on the ground or sliding | the bomb is chain-detonated; the cell gets no flame |
  | a visible power-up | the power-up is destroyed; the cell gets no flame |
  | a solid block or the edge of the board | the cell gets no flame |
  | a brick | the cell gets a brick flame |

  The flame does not continue past any of these. Players, extras and existing flames do not stop it.
- A tip piece appears only when a flame reaches its full length. A flame cut short ends on a **mid** piece.
- Flame length comes from the bomb's `+0x4c`. When a bomb is dropped (`FUN_0041eb13`) it is set to:
  - the player's flame count, normally;
  - 1 if the player has the short-flame disease (`+0x88`);
  - `max(15, 11) = 15` if the player has goldflame (`+0x5e != 0`). Goldflame overrides the disease and reaches across
    the whole board.
- Chain reaction (`bomb_queue_detonate` 0x423209): the bomb and its skip byte go into a 100-entry pending list. At the
  start of the **next frame's** first `maybe_bomb_update` call, each queued bomb gets `age = fuse` and its skip byte, so
  it explodes in that frame. Each link of a chain therefore costs one rendered frame, and the triggering flame leaves
  the hit bomb's cell unlit for that frame. The chained bomb keeps its own colour but takes the triggering bomb's owner
  id. That id is also what the bomb-per-player counter (`FUN_004245da`) counts, so for one frame the bomb counts
  against the other player.
- Brick hit: the brick picture is erased at once, but the cell stays **2** (blocks movement and flames) until the
  brick flame expires (section 2.4).

### 2.3 Per-frame flame update and draw (flame_update_draw @0x426d06)

```
for y in 0..10: for x in 0..14:                        // row-major draw order
  f = &flame[x][y]; f.cx = x; f.cy = y
  if f.state == 0: continue
  f.age += dt
  if f.type == 9:                                      // brick
     mode = BRICK; name = sprintf("flame %s %u", "brick", g_level)
     if f.age > V20 * REF (=500):                      // unsigned compare, strictly greater
        if map_get(x,y) == 2: map_set(x, y, 0)          // cell becomes walkable now (and is redrawn blank)
        f.state = -1                                    // draw once more, then free
  else:
     danger_raise(x, y, 1000)
     mode = NORMAL; name = sprintf("flame %s green", typename[f.type])
     if f.age > V10 * REF (=500): f.state = 0           // removed before drawing: no last draw
  if f.state != 0:
     seq = ani_find_seq(name)
     if f.type == 9 and f.frame >= nstates(seq): f.frame = nstates(seq) - 1   // brick: hold the last state
     frm = frame of state (f.frame % nstates(seq))
     if mode == NORMAL:
        (ox, oy) = per-state offsets of that state (ani_seqno_stateno_get_offsets)
        draw_remap(map_cell_center_x(x) + ox, map_cell_feet_y(y) + oy - 18, frm, f.color)
     else:
        draw_remap(map_cell_center_x(x), map_cell_feet_y(y), frm, f.color)   // brick: offsets NOT used
     if f.state == -1: f.state = 0
  f.acc += dt                                           // for every cell that was burning at entry
  while f.acc > 0: f.frame++; f.acc -= REF (50)
```

Timing:
- `V10 = 10` reference frames = 500 ms. A flame exists while its accumulated age is ≤ 500 ms.
- With steady 50 ms frames the flame is drawn on 10 frames (ages 50..500) and disappears on the 11th update.
- The animation advances one state per 50 ms of accumulated dt. The first draw shows state 0, the second shows
  state `ceil(dt1/50)`, and so on. The state shown on update k is `ceil(sum of dt before k / 50) mod nstates`.

Sprites: MASTER.ALI loads `MFLAME.ANI` (FLAME.ANI is commented out). Every flame sequence has 5 states and loops, so the
animation plays twice in 500 ms. The per-state frame(ox,oy) values from MFLAME.ANI, which are added to the draw position:

| sequence | per-state frame(ox,oy) |
|---|---|
| center | 0(3,16) 1(2,16) 2(2,16) 3(2,16) 4(2,16) |
| tipnorth | 5(-1,16) 6(-1,16) 7(-1,16) 8(-1,16) 9(-1,16) |
| tipwest | 10(3,12) 11(3,12) 12(2,9) 13(2,11) 14(2,10) |
| tipsouth | 15..19 all (2,16) |
| tipeast | 20(0,8) 21(0,11) 22(0,9) 23(0,10) 24(0,10) |
| midnorth | 25(1,16) 26..29(-1,16) |
| midsouth | 30(2,16) 31(0,16) 32(0,16) 33(1,16) 34(0,16) |
| midwest | 35(3,11) 36(2,12) 37(2,9) 38(2,11) 39(2,10) |
| mideast | 40(3,8) 41(2,11) 42(2,8) 43(2,9) 44(2,9) |

Flames are drawn with remap index = the owner's colour byte (display-list type 3). What the remap does to the "green"
art is the graphics agent's topic.

### 2.4 Brick disintegration

- On a hit, the cell gets a type-9 flame with owner -1 and the brick picture is erased from the background. The map
  value stays 2.
- The animation is "flame brick <level>" (XBRICK<level>.ANI). Levels 0, 1, 2, 3, 5 and 7 have 9 states; levels 4, 6,
  8, 9 and 10 have 10. It advances one state per 50 ms and **holds** the last state; it does not loop.
- It is drawn at (cell centre x, cell feet y) with no per-state offsets.
- On the update where age > `V20*50 = 500` ms:
  1. `map_set(x,y,0)` makes the cell walkable.
  2. The last state is drawn one final time.
  3. The flame slot is freed.
- With 50 ms frames this gives 11 draws, for example states 0..8,8,8 for a 9-state brick.
- If another explosion reaches the cell while the brick is still disintegrating, the cell still reads as a brick:
  - the brick flame is recreated, so the animation and the 500 ms restart;
  - `power_reveal_at` runs again.
  - Exception: if a power-up was already revealed there (state 2), that power-up is destroyed instead and the brick is
    not touched (the power-up test comes before the tile test).

### 2.5 Flames killing players (cross-ref: player agent)

A player is killed by any flame entry (`state != 0`, **any** type, brick included) in the cell that contains the
player's feet point `(map_px_to_cx(p+0x1c), map_py_to_cy(p+0x20))`. The test is a call to
`player_net_death(p, killer = flame.owner)`. It runs in two places:
- in the movement loop (`FUN_0041ec84` @0x41f1f2) after **every 1-pixel step**, for living players;
- once per frame in `player_update_anim` (@0x41f5e5) for living players, before the pickup test.

Per the player module, `player_net_death` ignores network players, players whose special animation is 5, 6 or 7
(trampoline or warp), and players with the invulnerability timer `+0x66` set. Because players are updated after
`flame_update_draw` in the frame, a flame kills from its creation frame up to and including its last drawn frame.

---------------------------------------------------------------------------------------------------------------------

## 3. Power-ups

### 3.1 Types

The name table at 0x45be50 gives the sprite "power <name>" (POWERS.ANI is the only power ANI that MASTER.ALI loads).
Player counts are bytes at `player + 0x56 + type`.

| t | name | start V50+t | limit V550+t (0 = none) | per level V400+t | exclusive with | pickup effect | pickup sound group |
|---|---|---|---|---|---|---|---|
| 0 | bomb | 1 | 8 | 10 | - | +1 bomb (`+0x56`) | 400 |
| 1 | flame | 2 | 8 | 10 | - | +1 flame length (`+0x57`) | 400 |
| 2 | disease | 0 | 0 | 3 | - | `player_give_disease(p, 1)` | disease sounds |
| 3 | kicker | 0 | 1 | 4 | - | `+0x59`++ | 400 |
| 4 | skate | 0 | 4 | 8 | - | `+0x5a`++ (speed +V90 each, player agent) | 400 |
| 5 | punch | 0 | 1 | 2 | trigger | `+0x5b`++ | 400 |
| 6 | grab | 0 | 1 | 2 | spooge | `+0x5c`++ | 400 |
| 7 | spooge | 0 | 1 | 1 | grab | `+0x5d`++ | 400 |
| 8 | goldflame | 0 | 1 | -2 | - | `+0x5e`++ (bombs get flame length 15) | 400 |
| 9 | trigger | 0 | 1 | -4 | punch, jelly | `+0x55=0` (trigger bombs out), `+0x5f`++ | 400 |
| 10 | jelly | 0 | 1 | 1 | trigger | `+0x60`++ | 135 (bombboun/1017/1036) |
| 11 | disease3 ("super bad disease") | 0 | 0 | -4 | - | `player_give_disease` x3 (sound only on the first) | disease sounds |
| 12 | random | 0 | 0 | -2 (0 in network games) | - | becomes a random non-forbidden type 0..11 | that type's |
| 13 | clog | 0 | 0 | - | - | roulette-only power-down (speed -V91); never placed or spawned | - |

- "exclusive" (`power_is_exclusive` 0x425c10) is true for types 5, 6, 7, 9 and 10.
- "over-powerful" (section 3.4) applies to types 5, 6 and 11.
- Count bytes 13 (clog) and 14 exist. V63/V64 are 0.

Sprites (POWERS.ANI; the listed per-state offsets are **not** applied when drawing power-ups):

| sprite | frame |
|---|---|
| bomb | 5 |
| flame | 2 |
| kicker | 1 |
| disease | 0 |
| punch | 3 |
| skate | 4 |
| jelly | 11 |
| grab | 12 |
| spooge | 6 |
| goldflame | 7 |
| disease3 | 8 |
| trigger | 9 |
| clog | 14 |
| random | 12 states: frames 0,1,2,3,4,5,11,12,6,7,8,9 |

The other POWER*.ANI and CLASSICS.ANI files are not loaded.

### 3.2 Power-up cell (g_power_grid 0x462214, 165 x 0x98)

| off | meaning |
|---|---|
| +0x00 | state: 0 none, 1 hidden under a brick, 2 revealed (drawn only while the map cell is 0) |
| +0x04 | type 0..13 (**not cleared** when the power-up is destroyed or picked up; see Quirks) |
| +0x08 | remove-pending flag (network) |
| +0x1c/+0x20 | cell x/y (rewritten each frame) |
| +0x30 | u16 animation frame, +1 per **rendered frame** while drawn (not time-scaled) |
| +0x40 | frame counter at reveal |
| +0x44 | u16 visible-frame counter (at 4, network "powerup appeared" broadcast if no player is in the cell) |

`power_at(x,y)` returns the cell if `state != 0`, hidden ones included. `power_destroy(p)` sets `state = 0` (and sends
a network message).

### 3.3 Placement at level start (power_place_level @0x4258e5)

```
memset(power grid, 0)
(network client: receive the grid instead)
for t in 0..12:
  n = value_get(400 + t)
  if g_net_mode != 0 and t == 12: n = 0              // no random power-ups in network games
  chance = (n < 0); n = abs(n)
  repeat n times:
    if chance and rand() % 10 != 0: continue         // negative = n independent 1-in-10 chances
    for try in 0..199:
      x = rand()%15; y = rand()%11
      if map_get(x,y) == 2 and power_at(x,y) == NULL:
        memset(cell,0); state = 1; type = t; break
```

- Power-ups are only ever placed **under bricks**. A placement that finds no free brick in 200 tries is lost.
- This runs before the start areas are cleared (section 1.5). Power-ups under start-area bricks are moved to another
  brick. Power-ups under bricks that a warp's first update knocks out (extras) are lost.

Scheme `-P` lines (`scheme_parse` @0x404673):
- `bornwith > 0` → `value_set(50+t, bornwith)` changes the starting count, which is also the floor for every drop rule.
- `has_override != 0` → `value_set(400+t, override_value)` changes the per-level count. 0 removes the type and a
  negative value means chances.
- `forbidden != 0` only stops the **random** power-up from turning into that type. The editor asks
  "Is '%s' forbidden from randoms?". It does not stop the type from being placed.

VALUELST and the scheme are reloaded every level (`FUN_0040133f`), so these overrides do not leak between schemes.

### 3.4 Reveal when a brick is destroyed (power_reveal_at @0x425107, called from the explosion)

```
if rand() % 30 == 0: nop_hook()                        // empty function, but the rand() is consumed
if (x,y) out of bounds: return
p = &power[x][y]
if g_net_mode == 0 and time_elapsed_s() < V102 (40):
  if p.type in {5 punch, 6 grab, 11 disease3}:         // "over-powerful"; p.state is NOT checked
    // attempt 1: swap with a hidden/visible non-over-powerful power-up under another brick
    for try in 0..199:
      rx = rand()%15; ry = rand()%11
      if map_get(rx,ry) == 2 and power_at(rx,ry) != NULL and power[rx][ry].type not in {5,6,11}:
        swap(*p, power[rx][ry]) (whole 0x98-byte structs); goto reveal
    // attempt 2: move it under a brick that has no power-up
    for try in 0..199:
      rx = rand()%15; ry = rand()%11
      if map_get(rx,ry) == 2 and power_at(rx,ry) == NULL:
        power[rx][ry] = *p; p.state = 0; return
    // both failed: it is revealed normally
reveal:
if p.state == 1: p.revealed_at = frame_counter; p.state = 2
```

`time_elapsed_s()` is `total_s - remaining_s` in whole seconds, as computed by the HUD clock each frame. That equals
`ceil(elapsed_ms / 1000)`, so the rule applies while elapsed game time is ≤ 39 000 ms.

The revealed power-up is **not drawn and cannot be picked up** until the brick flame ends and the cell becomes 0
(500 ms after the hit). Meanwhile it can still be destroyed by another flame reaching the cell (section 2.4).

### 3.5 Per-frame update and draw (power_update_draw @0x424f89)

```
for y in 0..10: for x in 0..14:
  p = &power[x][y]; p.cx = x; p.cy = y
  if p.state != 0 and p.remove_pending: p.state = 0; p.remove_pending = 0
  if p.state == 1 and map_get(x,y) != 2: p.state = 0           // hidden power-up whose brick vanished is lost
  if p.state == 2 and map_get(x,y) == 0:
     frm = frame of state (p.frame % nstates) of "power <typename>"
     p.vis++; if p.vis == 4 and player_at_cell(x,y) == NULL: net "powerup" message
     draw(map_cell_center_x(x), map_cell_feet_y(y), frm)        // no remap
     p.frame++                                                  // once per rendered frame
```

Only "power random" has more than one state. It cycles through its 12 states at the **rendered** frame rate. The
anchor is (cell centre x, feet y) and the frame's own hotspot does the alignment.

### 3.6 Pickup (player_pickup_power @0x41e21e, cross-ref player agent)

Pickup happens when a living player's feet cell holds a power-up with `state == 2`. The test runs after every 1-pixel
movement step (0x41f22x) and once per frame in `player_update_anim` (0x41f624), after the flame-kill test. The call is
`player_pickup_power(p, pw)` followed by `power_destroy(pw)`.

```
player_pickup_power(p, pw):
  nop_hook()
  snd = -1
  if g_diseases_curable (V124) and rand() % g_cure_chance (max(V125,1)) == 0:
     player_cure_diseases(p)                         // done for any pickup, diseases included
  if p.type == 4 (network player): return            // the remote machine applies it
  loop:                                              // the 'random' case re-dispatches
   switch pw.type:
    0: snd=400; p.bombs++              1: snd=400; p.flame++
    2: player_give_disease(p, 1)       3: snd=400; p.kick++         4: snd=400; p.skate++
    5: snd=400; p.punch++;  player_drop_excess(p, 9 /*trigger*/)
    6: snd=400; p.grab++;   player_drop_excess(p, 7 /*spooge*/)
    7: snd=400; p.spooge++; player_drop_excess(p, 6 /*grab*/)
    8: snd=400; p.goldflame++
    9: p.trigger_out(+0x55) = 0; snd=400; p.trigger++; player_drop_excess(p, 5); player_drop_excess(p, 10)
    10: snd=135; p.jelly++; player_drop_excess(p, 9)
    11: player_give_disease(p,1); player_give_disease(p,0); player_give_disease(p,0)
    12: for try in 0..199:
          pw.type = rand() % 12                       // 0..11: never random or clog
          if !g_scheme_forbidden[pw.type]: continue loop (apply the new type)
        // after 200 forbidden picks: falls through with the last (forbidden) type, which is NOT applied
  lim = value_get(550 + pw.type)
  if lim != 0 and count[pw.type] > lim: count[pw.type] = lim      // pickup still consumed; sound still plays
  if pw.type != 2 and pw.type != 11:
     p.awesome(+0x65)++
     if p.awesome >= 7 and (p.awesome - 7) % 5 == 0: snd = 1400   // AWESOME voice
     if p.awesome > 50: p.awesome = 7
  if snd != -1: sound_play_group(snd)
  (network messages)

player_drop_excess(p, t):                            // 0x41e16a; the dropped power-up re-appears elsewhere
  start = value_get(50 + t)
  if power_is_exclusive(t):
     if count[t] > start: power_spawn_random_blank(t); count[t] = start
  else:
     while count[t] > start: power_spawn_random_blank(t); count[t]--
  if t == 9 and count[9] == 0: bombs_untrigger(p.id)   // the player's trigger bombs become normal, fuse restarts
```

- Mutual exclusion: punch ↔ trigger, jelly ↔ trigger, grab ↔ spooge. Kicker, skate, goldflame, punch, grab and jelly
  otherwise combine freely.
- The power-up given up is **not** placed next to the player. It spawns at a random free blank cell anywhere on the
  board (section 3.8). If the scheme's starting count for that type is ≥ the current count, nothing is given up.
- The AWESOME counter is reset to 0 at round start. The voice (group 1400, "you are now AWESOME") replaces the normal
  pickup sound on the 7th, 12th, 17th, ... non-disease pickup. SOUNDLST's comment says "7th and 3rd thereafter"; the
  code says every 5th.
- Disease (`player_give_disease`, player agent):
  - disease index `d = rand()%9`; in network games it is redrawn while `d == 7`, up to 200 times.
  - With the sound flag set: a 1-in-3 chance of sound group `3000 + 50*d`, otherwise group 2300.
  - `d == 7` swaps the player's position with a random other living slot. Otherwise the disease flag is set,
    duration = `V(130+d) * 50` ms, freshness = V129.
- Starting counts: at round start `count[t] = value_get(50+t)` for t = 0..14 (`FUN_004214bc`). The goldman-roulette
  winner then gets +1 of the prize type, which the limits do not clamp.

### 3.7 Power-up destruction

A visible (state 2) power-up is destroyed by:
1. A flame propagating into its cell. The flame stops and that cell gets no flame (section 2.2). A bomb exploding on
   top of a power-up also destroys it.
2. A kicked or sliding bomb testing its next cell (`bomb_slide_cell_free` 0x4230a5). The test order is: a bomb in the
   cell → blocked; a player → blocked; otherwise any visible power-up there is destroyed, and only then do the warp
   extra (type 1) and `map_get == 0` tests decide whether the bomb may enter. So the power-up is destroyed even when the
   tile or a warp then stops the bomb.
3. A falling enclosement block (section 4.3), which also removes hidden ones.

In cases 1 and 2, if the destroyed type is **2 (disease)** and `diseases_destroyable` (options.ini, default V120=1) is
0, a new disease power-up is spawned at once at a random blank cell (`power_spawn_random_blank(2)`). Type 11
(super bad disease) is always destroyed.

There is no burn animation. The power-up just disappears.

Disease-related VALUELST values:
- V121 ("time limited", 0x464988) is read but never used.
- V122 ("recycle", 0x464a74) only feeds a comparison with no effect in `player_cure_diseases`.
- Diseases are never counted in the drop arrays (count bytes 2 and 11 stay 0), so diseases **never** come back out of a
  player as power-ups.

### 3.8 Spawning at a random free blank cell (power_spawn_random_blank @0x4255b2)

```
if type == 13 (clog): return
for outer in 0..99:
  tries = 100
  do:
    x = rand()%15; y = rand()%11
    tries--; if tries <= 0: return               // the whole spawn is abandoned
  while map_get(x,y) != 0
  if bomb_at_cell(x,y) or power_at(x,y) or player_at_cell(x,y): continue outer
  power_spawn_visible_at(x, y, type)             // state=2, frame=0, vis=0
  return
```

- Flames and extras in the target cell are not checked.
- The new power-up is visible from the next `power_update_draw`, so it usually appears on the next frame.
- There is no flight or arc animation. Drops are instant.

### 3.9 Death drop and head-hit loss

**Death** (`player_drop_all_powers` @0x41dbfe) is called from `player_update_anim` when the **death animation
finishes**: the last state is reached, or for death anim 9 (angel) when it has flown above y < -20. It is skipped for
network players.

```
for t in 0..14:
  start = value_get(50+t)
  if power_is_exclusive(t):  if count[t] > start: power_spawn_random_blank(t); count[t] = start
  else:                      while count[t] > start: power_spawn_random_blank(t); count[t]--
```

Afterwards the player is freed (`state = 0`) and `bombs_untrigger(id)` runs. Every power-up above the starting count is
returned to the board, each at its own random blank cell:
- extra bombs and flames, kickers, skates, goldflame, punch/grab/spooge/trigger/jelly;
- clogs are just discarded;
- diseases are not returned.

**Head hit** (`player_head_hit` @0x421f7e, called by bombs.c when a punched or bounced bomb lands on a player's cell).
In network games it does nothing at all. Otherwise:

```
p.+0x3a = 16; p.special_anim(+0x4e) = 3 (stunned); p.+0x50 = 0
n = rand() % max(V671, 1) + V670                 // 1..3 with defaults
repeat n times:
  for try in 0..199:
    t = rand() % 15
    if count[t] > value_get(50+t): power_spawn_random_blank(t); count[t]--; break
```

### 3.10 Power-up drawing for the roulette

`power_draw_icon(x, y, type)` (0x425c7f) draws frame 0 of "power <name>" at (x, y). It is used by the goldman roulette
screen (`FUN_004034bc`).

---------------------------------------------------------------------------------------------------------------------

## 4. Hurry and enclosement (map_update @0x426818 + game_frame)

### 4.1 Timeline

- `remaining` = `time_remaining_s()` = `floor((total_ms - elapsed_ms)/1000)`, where `total = playtime + 1` s
  (default 151). With unlimited time it returns 1001, so none of this ever happens.
- **"hurry" text and voice** (in `game_frame`):
  - Shown while `V101-5 < remaining < V101`, i.e. remaining ∈ {59, 58, 57, 56}.
  - Sound group 2700 ("hurry", "hurytuf", ...) plays once, the first time this happens in the round
    (`g_hurry_voice_played`, reset at level load).
  - Sprite: "hurry" (HURRY.ANI) at (320, 240), the screen centre (sequence offset ignored), drawn only on frames where
    `frame_counter & 4` is set: 4 frames on, 4 off.
  - It is drawn last, on top of everything.
- **Enclosement start**: on the first frame where `remaining <= V101-5 = 55`, provided `map_update` runs (alive > 1).
  That is, after more than 95 s of a 150 s round:

  ```
  g_hurry_sound = rand() % 3                  // fixed for the whole enclosement
  g_hurry_needs_reset = 1
  g_hurry_last_ms = timeGetTime()
  extras_remove_for_hurry()                   // deletes warps (type 1) and trampolines (type 3)
  ```

  While `remaining > 55`, a pending reset happens instead: `X=0, Y=0, ring=0, dir=1 (east)`, flag = 0. The flag
  starts at 1, so the first frame of every round resets. Arrows and conveyors stay.
- The **first block** falls when `now > g_hurry_last_ms + 250`, then one every **250 ms** of real time
  (`timeGetTime`, not the game clock). At most 4 blocks fall per frame; any further backlog carries over to later
  frames because `last_ms` only advances by 250 per block.

### 4.2 Spiral order

The spiral is clockwise, starts at the top-left corner (0,0) heading east, and works inward ring by ring. The number of
rings is `2 * enclosement_depth`:

| enclosement_depth (options.ini, default V27=1, clamped to 0..V28-1) | rings filled | effect |
|---|---|---|
| 0 | 0 | none |
| 1 | 2 | "2 rows" |
| 2 | 4 | "4 rows" |
| 3 | 6 | "all the way": ring 5 is the middle row x 5..9, y 5 |

Per frame, after the regeneration step:

```
if hurry_running and ring < 2*depth:
  // AI warning (V910): mark the next 15 positions the spiral will visit (section 4.4)
  n = 5
  while g_hurry_last_ms + 250 < now and --n > 0:
     g_hurry_last_ms += 250
     drop_block(X, Y)                                  // section 4.3
     nx = X + dx[dir]; ny = Y + dy[dir]
     if nx >= 15-ring or ny >= 11-ring or nx < ring or ny < ring:   // left the current ring
        dir = (dir + 1) & 3                            // turn clockwise
        if dir == 1:                                   // finished a full lap
           if 2*depth <= ring: return
           ring++; X++; Y++                            // move diagonally to the next ring's corner
        nx = X; ny = Y                                 // NOTE: no step on a turn, so the next block hits the same cell again
     X = nx; Y = ny
```

Turning does not advance the position, so each turn drops a second block on the corner that was just filled. The final
north leg also re-drops the ring's start corner. A ring of size w×h takes exactly `2w + 2h` drops (250 ms each), which is
4 more than its cell count:

| ring | size | cells | drops | time |
|---|---|---|---|---|
| 0 | 15×11 | 48 | 52 | 13.0 s |
| 1 | 13×9 | 40 | 44 | 11.0 s |
| 2 | 11×7 | 32 | 36 | 9.0 s |
| 3 | 9×5 | 24 | 28 | 7.0 s |
| 4 | 7×3 | 16 | 20 | 5.0 s |
| 5 | 5×1 | 5 | 12 | 3.0 s |

Totals:

| depth | cells | drops | ends at about remaining |
|---|---|---|---|
| 1 | 88 | 96 (24 s) | 31 s |
| 2 | 144 | 160 (40 s) | 15 s |
| 3 | 165 (all) | 192 (48 s) | 7 s |

A block is dropped even on a cell that is already solid; the sound plays and the time is spent. The exact sequence for
ring 0 is:
- (0,0)..(14,0)
- (14,0) again, then (14,1)..(14,10)
- (14,10) again, then (13,10)..(0,10)
- (0,10) again, then (0,9)..(0,0) (the last one is a repeat)

Ring 1 then starts at (1,1).

### 4.3 What a falling block does (one drop at (X,Y))

```
sound_play_id(140 + g_hurry_sound)          // exactly one of clikplat/sqrdrop2/sqrdrop4, the same all game
map_set(X, Y, 1)                            // solid; redrawn instantly as "tile <level> solid": no falling animation
repeat up to 100: p = player_at_cell_local(X,Y)      // alive, non-network player whose feet cell is (X,Y)
                  if !p: break; player_net_death(p, killer=-1)   // no kill credit
repeat up to 100: pw = power_at(X,Y); if !pw: break; power_destroy(pw)   // hidden or visible
repeat up to 100: b = bomb_at_cell(X,Y)               // excludes flying or held bombs
                  if !b: break
                  if stomped_bombs_detonate (options.ini, default V46=1):
                       bomb_queue_detonate(b, 0xFF)   // explodes next frame in all 4 directions; ONLY the first bomb
                       break
                  else bomb_remove(b)                 // silently deleted, slot freed
repeat up to 100: f = flame_at(X,Y); if !f: break; flame_kill(f)
```

A detonated stomped bomb explodes on the next frame from inside the new solid cell. Its centre flame sits on the block
and its arms spread normally. If `player_net_death` refuses a player (warp/trampoline special animation), the player
survives and the loop just repeats 100 times.

### 4.4 AI warning (V910)

Every frame while the enclosement is running, the spiral is simulated `V910 = 15` steps ahead from the current state,
using the same stepping rule (including the turns and ring changes). `danger_raise(nx, ny, value)` is called with
`value = V910*10 + 100 = 250` for the first step and 10 less for each further step (250, 240, ..., 110).

The cell the **next** block will hit (`X,Y`) is not itself marked, except when a turn makes the first step stay in
place. The danger grid is cleared at the start of each frame and raised by flames (1000) and other sources (AI agent).

---------------------------------------------------------------------------------------------------------------------

## 5. Regenerating tiles (map_regen_tick @0x426704)

Called from `map_update` each frame when all of these hold:
- `alive_count() > 1`;
- not a network client;
- `value_get(340 + level) != 0`.

Only level 7 (haunted house, "cemetary/mortuary") has a non-zero value: V347 = 4 s.

```
period = value_get(340 + level)
now = timeGetTime()
if (unsigned)(now - g_regen_last_ms) <= period*1000: return
g_regen_last_ms = now
for try in 0..99:
  x = rand()%15; y = rand()%11
  if map_get(x,y) == 0 and power_at(x,y) == NULL and bomb_at_cell(x,y) == NULL
     and no_player_within(x, y, V695 /*4*/):
       map_set_if_changed(x, y, 2)       // a brick appears instantly, with NO power-up under it
       (net message); return
```

- `no_player_within(x,y,r)` (0x422351) returns false if **any of the 10 player slots** has
  `|x - cx| + |y - cy| <= r` (Manhattan distance, cells taken from `+0x1c/+0x20`). The slot's state is not checked, so
  dead players (at their death or angel position) and stale positions of slots used in earlier rounds also block.
- Flames and extras are not checked. A brick can appear on a burning cell (the flame keeps burning on the brick) or on
  an arrow, conveyor or trampoline (extras are drawn only on blank cells).
- At most one brick per period. The 100 tries are spent at the moment of the period tick, and the timer resets even if
  every try fails.
- `g_regen_last_ms` is never initialised (0) or reset, so the first attempt happens on the first eligible frame of the
  round. After that the period is measured in real time across rounds.

### 5.1 alive_count (0x421969), used by explosions, enclosement and regeneration

| mode | value |
|---|---|
| campaign | 2 |
| team play | number of teams that have a living player |
| otherwise | number of living players |

The count comes from the previous frame's player loop. A dying player still counts as alive for the first V25 = 20
frames of the death animation (player agent). When it drops to ≤ 1, all of the following freeze:
- bombs stop exploding;
- blocks stop falling;
- regeneration stops.

Flames and power-ups keep updating.

---------------------------------------------------------------------------------------------------------------------

## 6. Cross-module interactions

| module | interaction |
|---|---|
| bombs | Explosions call `flame_set`, `power_destroy`/`power_spawn_random_blank(2)`, `map_draw_cell_as`, `power_reveal_at` and `bomb_queue_detonate`. Kicked bombs call `bomb_slide_cell_free`, which destroys power-ups. A punched bomb landing on a player calls `player_head_hit`. Bomb objects are found through `bomb_at_cell`, which ignores flying and held bombs. |
| player | Flame-kill and pickup tests in the movement loop and in `player_update_anim`. Start-area clearing on the first update. `player_drop_all_powers` at the end of the death animation. The bomb's flame length comes from flame count, short-flame disease and goldflame. |
| extras | Warps knock bricks out on their first update without moving the power-ups underneath. `extras_remove_for_hurry` deletes warps and trampolines when the enclosement starts. Arrows, conveyors and trampolines are drawn only when their cell is blank. |
| AI | `danger_raise` from `flame_set` (1000), from each normal flame every frame (1000) and from the hurry look-ahead (250..110). Brick flames do not mark danger after their creation frame. The power-up reveal frame is stored at `+0x40`. |
| audio | Sound groups 200 (explosion), 400 (pickup), 135 (jelly pickup), 1400 (AWESOME), 2300 and 3000+50d (diseases), 2700 (hurry). Specific sound ids 140..142 (block slam, `sound_play_id`). |
| network | `g_net_mode` 1 = client: the map and power grids are received; regeneration and placement are skipped. Several `0x40fxxx` message calls exist, all no-ops for a remake. Random power-ups are disabled in network games. |

---------------------------------------------------------------------------------------------------------------------

## 7. Uncertain

1. (Resolved) Tile blits are transparent: index 0 is skipped (0x44aed5), so the field background shows through.
2. **What the colour remap (`draw_remap`, display-list type 3) does to flame and brick art.** The flame colour index
   is the bomb owner's colour byte (player index, or 0/2 in team play). The "green" sequence names suggest owner-coloured
   flames. (Graphics agent.)
3. How `draw(x,y,frame)` positions a frame: presumably the frame's hotspot is placed at (x,y). The anchors used here
   are the cell centre x / feet y. For flames the per-state offsets are added explicitly, with an extra -18 in y.
4. `+0x3a=16` and `+0x50` in `player_head_hit` are player stun fields (player agent).
5. Whether the hurry also runs during a pause. The enclosement clock is real time (`timeGetTime`), so after a pause it
   would catch up at 4 blocks per frame. The game clock pause is the engine agent's topic.

---------------------------------------------------------------------------------------------------------------------

## 8. Bugs and quirks (replicate unless noted)

1. **Corner double-drops** (4.2). The spiral drops a second block on each corner and on the ring's start cell. This adds
   1 s per ring and replays the slam sound.
2. **Extra block after the last ring.** If two or more drop ticks are due in the frame where the final ring completes,
   the while loop does not re-check `ring < 2*depth`, so one more block falls at `(2*depth, 2*depth)`. This only
   happens after a frame stall longer than 250 ms.
3. **AI look-ahead skips the imminent cell** (4.4). The next block's own cell gets no danger value. Likely a genuine
   AI bug.
4. **Stale power-up type.** `power_destroy` and pickups clear only `state`. `power_reveal_at` tests `type ∈ {5,6,11}`
   without testing `state`. On level 7, a regenerated brick standing where a punch, grab or disease3 used to be,
   destroyed within the first 40 s, triggers the "over-powerful" swap. That steals a hidden power-up from another
   brick and reveals it here.
5. **Over-powerful swap with a mid-disintegration cell.** Attempt 1 can swap with a revealed (state 2) power-up under a
   brick that is still disintegrating. The over-powerful power-up then sits as state 1 on a cell that becomes blank
   500 ms later and is deleted. The swapped-in power-up stays state 2 at the original cell.
6. A revealed power-up in a disintegrating brick cell is destroyed by a second flame, and that flame does **not**
   restart the brick (2.4).
7. Super bad disease (type 11) ignores `diseases_destroyable`; only type 2 respawns. V121 and V122 have no effect.
8. Random power-up: after 200 forbidden picks, the last forbidden type is kept in `pw.type`, its count is not increased,
   and the AWESOME counter still counts it. A disease can come out of a random power-up unless forbidden.
9. `power_spawn_random_blank` gives up entirely when 99 consecutive random cells are non-blank, and does not avoid
   flames or extras.
10. `no_player_within` checks all 10 slots regardless of state (dead or unused slots block regeneration).
    `g_regen_last_ms` is never initialised or reset.
11. A regenerated brick can appear on a burning cell or on an extra.
12. Chain hits overwrite the hit bomb's owner id (`+0x3e`). This gives kill credit and the bomb-limit count to the
    triggering player.
13. A flame cut short by a wall, brick, bomb or power-up ends on a mid piece. Only full-length arms get a tip.
14. Power-up animation ("power random") advances once per rendered frame, not per 50 ms.
15. `map_px_to_cx` / `map_py_to_cy` are wrong off-board (`px` 1..19 → 0, `py` 49..84 → -1 or -2 irregularly). This
    matters only for objects that leave the grid, such as punched bombs wrapping around the edge.
16. A start cell is forced blank even if the scheme marks it solid. Its neighbours are cleared only if not solid.
17. Power-ups hidden under bricks that a warp knocks out are lost; no relocation happens for extras.
18. `player_head_hit` does nothing at all in network games, not even the stun.
19. Dead code: `map_set_plus_raw` (0x426029), `map_set_plus` (0x42608f) and `power_type_name` (0x425cdf) are never
    called. `nop_hook` (0x42be0b) is empty, but its 1-in-30 `rand()` in `power_reveal_at` still advances the RNG.
