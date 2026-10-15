# Bombs (bombs.c) — reverse-engineered specification

Source: BM95.EXE (Watcom, unoptimised). Module `bombs.c` = 0x422b3b–0x424d36, plus the bomb-related parts of
`you.c` (player actions), `map.c` (coordinate helpers, enclosement "stomp"), `power.c`/`flame.c` (hand-offs).
Every statement below was checked against the disassembly unless it is listed under **Uncertain**.
Proposed names: `docs/re/names/bombs.txt`. Function names below use those proposed names, with addresses.

Notation: `V<n>` = VALUELST.RES value n. "ref frame" = 50 ms (`g_ref_frame_ms` = 1000 / V30). `dt` =
`g_frame_dt` (0x464958) = real ms elapsed this rendered frame, capped at V31 = 150 (no lower bound).
Directions: 0 = up, 1 = right, 2 = down, 3 = left; `DX = {0,1,0,-1}` (0x45becc), `DY = {-1,0,1,0}` (0x45bedc).
`W` = 15 columns, `H` = 11 rows, cell = 40 × 36 px. Integer division is C truncation toward zero.
`rand()` = Watcom LCG: `seed = seed*1103515245 + 12345; return (seed >> 16) & 0x7fff`.

---------------------------------------------------------------------------------------------------------

## 1. Coordinates (map.c helpers — every bomb rule depends on them)

Field origin: `X0 = (640-600)/2 = 20`, `Y0 = 480-412 = 68`. A bomb's (x, y) is its "feet" point: x is the
cell's centre column, y is the **bottom pixel row** of the cell when it is centred.

| function | addr | formula |
|---|---|---|
| `cell_to_px_x(cx)` | 0x426524 | `X0 + 20 + 40*cx` = `40 + 40*cx` |
| `cell_to_px_y(cy)` | 0x42655f | `Y0 + 36 - 1 + 36*cy` = `103 + 36*cy` |
| `px_offset_x(x)` | 0x426599 | `while (x < 20) x += 40; return (x-20) % 40 - 20;` → range [-20, 19], 0 at centre |
| `px_offset_y(y)` | 0x4265eb | `while (y-85 < 0) y += 36; return (y-85) % 36 - 18;` → range [-18, 17], 0 at centre |
| `px_to_cell_x(x)` | 0x42665c | `if (x < 20) x -= 20; return (x-20)/40;` (trunc) |
| `px_to_cell_y(y)` | 0x4266a3 | `if (y-85 < 0) y -= 67; return (y-85)/36;` (trunc) |
| `map_get(cx,cy)` | 0x425fb9 | 0 empty, 1 solid, 2 brick; **returns 1 when out of bounds** |

So a pixel belongs to cell `cx` when `x ∈ [cx*40+20, cx*40+59]` and to row `cy` when `y ∈ [85+36cy, 120+36cy]`
(for non-negative cells). For x < 20 / y < 85 the "floor" emulation is wrong (it subtracts 20 / 67 instead of
39 / 35): `px_to_cell_x(1..19) = 0`, `px_to_cell_x(0) = -1`, `px_to_cell_x(-40) = -2`;
`px_to_cell_y(67) = -2` (should be -1), `px_to_cell_y(31) = -3`. This matters only for the punch wrap-around
(§9.4) — replicate it.

---------------------------------------------------------------------------------------------------------

## 2. The bomb object and storage

All game objects (players, bombs, flame cells, powerup cells, extras) share one 0x98-byte "OBJ" layout
(`debug_printf("sizeof(OBJ) = %u", 0x98)` in init). Bombs live in `g_bombs` (0x46220c): **100 slots** of 0x98
bytes, allocated once in `bombs_init` (0x422c7a, called from game init), cleared by `bombs_reset` (0x422d3b,
called at every level load: memset every slot, clear explode list and ghost list).

`bomb_alloc` (0x422ddd) returns the **lowest-index** slot with `active == 0`, memset to 0; NULL if all 100 are
used (bomb creation then silently fails). Update, explosion and drawing iterate slots 0..99 in index order.

| off | type | name | meaning |
|---|---|---|---|
| 0x00 | i32 | `active` | 0 free, 1 live, **2 dud** (live, fuse frozen, dud animation) |
| 0x04 | i32 | `type` | 0 regular, 1 trigger, 2 jelly |
| 0x0c | i32 | `id` | network bomb id (0 in local games) |
| 0x10 | u8 | `ctrl` | 9 = simulated on this machine (always in local games), 4 = remote copy |
| 0x14 | i32 | `start_x` | pixel x where the current flight started (only used in the buggy bounce test §9.3) |
| 0x18 | i32 | `start_y` | pixel y idem |
| 0x1c | i32 | `x` | pixel position (see §1) |
| 0x20 | i32 | `y` | |
| 0x2c | i16 | `dir` | movement direction (0..3) |
| 0x2e | i16 | `state` | **0 REST, 1 SLIDING (kicked), 2 FLYING (punched/thrown), 3 HELD** |
| 0x30 | u16 | `anim` | animation step counter |
| 0x32 | i16 | `anim_acc` | ms accumulator for `anim` |
| 0x38 | u8 | `skip_dir` | 0 = none; 1..4 = (direction+1) in which this bomb will not spawn flames; 0xFF = none |
| 0x39 | u8 | `stop` | stop request for a sliding bomb (also set internally when blocked) |
| 0x3c | u8 | `colour` | remap colour index, copied from the dropping player's +0x3c |
| 0x3e | i16 | `owner` | player index (may be overwritten by a chain reaction, §7) |
| 0x40 | i32 | `born` | `g_frame_counter` at creation (trigger order) |
| 0x44 | i16 | `fuse_elapsed` | ms; starts at `-delay*50` |
| 0x46 | i16 | `step` | pixels flown since punch start / last landing attempt (arc phase) |
| 0x48 | i16 | `bounce` | cell centres reached during the current flight |
| 0x4a | i16 | `fuse_len` | ms = fuse_frames × 50 |
| 0x4c | u8 | `flame_len` | cells per arm, copied at drop time |
| 0x70 | i32 | `speed` | 1/100 px per ref frame (V300 when kicked, V301 when flying) |
| 0x74 | i32 | `accum` | movement accumulator, 1/100 px (residual kept between frames, ≤ 0) |
| 0x94 | ptr | `holder` | player OBJ holding the bomb (the player's +0x94 points back) |

All other bytes are 0 (memset at allocation). Other bombs.c globals:

| addr | name | |
|---|---|---|
| 0x4621f8 / 0x4621fc / 0x462200 | explode list | `OBJ* bomb[100]`, `int dir[100]`, count — deferred detonations (§7) |
| 0x462210 | `g_bombs_last_frame` | frame number whose start-of-frame work has been done |
| 0x4621f4 | `g_danger_map` | `int[W*H]` AI danger map, cleared every frame by the bomb update (§5.8) |
| 0x462208 | ghost list | 10 × 0x18 pending network explosions (net only, §15) |
| 0x464af4 | `g_next_dud_time` | wall-clock `time()` seconds (§4.4) |

---------------------------------------------------------------------------------------------------------

## 3. Place in the game frame

Main game frame (code at 0x42a191, not decompiled by Ghidra), in order:

1. `dt = now - last; last = now; if (dt > V31) dt = V31;` (`g_frame_dt`), net service, `g_frame_counter++`
2. HUD, lock, cliprect, extras update/draw (0x4056ca)
3. **`bombs_update_free`** (0x4245b9) = `bombs_update(0)` for bombs **without** holder, then `ghosts_age()`
4. powerups update/draw (0x424f89), sound service, **flames update/draw** (0x426d06),
   map / enclosement update (0x426818, contains the bomb "stomp", §13)
5. **players update** (0x420f07; all bomb *actions* of players happen here, §14)
6. campaign aliens (only in campaign)
7. **`bombs_update_held`** (0x42459a) = `bombs_update(1)` for bombs **with** a holder
8. hurry message, flip (executes the display list in submission order), net send

Consequences: a bomb dropped/kicked/punched/grabbed during the players update is first moved in the *next*
frame; held bombs are positioned after their holder moved and are drawn after the players.

---------------------------------------------------------------------------------------------------------

## 4. Creation

### 4.1 When a player drops a bomb (player side, `player_update` 0x41f29b, block at 0x42099f)

Executed once per player update, after movement/animation and after the throw/action-2 handling (full order in
§14). `btn1`/`btn2` = player +0x38/+0x39 (key currently down), `btn1_prev`/`btn2_prev` = +0x36/+0x37 (previous
frame). `cell = (px_to_cell_x(p.x), px_to_cell_y(p.y))`.

```
if (btn1 && !btn1_prev && !p.disease[2] /*constipation, +0x86*/) {
    if (p.grab /*+0x5c*/) {                                    // 1. blue glove: pick up own bomb at feet
        b = bomb_at(cell)
        if (b && b.owner == p.index) { bomb_grab(b, p); p.anim = 4 /*pickup*/; p.anim_frame = 0; return }
    }
    if (p.spooge /*+0x5d*/ && !poop) {                           // 2. spooge (§12)
        b = bomb_at(cell)
        if (b && b.owner == p.index) { spooge(p); return }
    }
    n = bombs_count_owned(p.index)                             // 3. normal drop
    if (p.bombs /*+0x56*/ > n && cell_free_for_bomb(cell)) {   // no bomb (rest/slide/dud) there and map_get == 0
        e = extra_at(cell)
        if (e && e.type == 1 /*warp hole*/) {
            if (!poop) sound_play_group(40)                      // "can't do that" (enrt1/enrt2)
            return
        }
        if (p.bombs >= V651 /*4*/ && p.bombs - 1 == n)         // this drop uses the last available bomb
            if (rand() % max(V650,1) /*4*/ == 0) sound_play_group(1200)   // "Clear!", "Fire in the hole"...
        sound_play_group(poop ? 550 : 100)                       // poops1..5 / bmdrop2,bmdrop3
        player_drop_bomb(p, cell.x, cell.y, delay = 0)
    }
}
```
- `bombs_count_owned` (0x4245da) counts every active bomb (incl. duds, flying and held) with `owner == p.index`.
- Dropping is **not** blocked by players, powerups, flames, arrows, conveyors or trampolines in the cell — only by
  a bomb, a non-empty map cell, or a warp hole. (Powerups in the player's cell were already collected.)
- "poop" = disease 3 (poops, +0x87) or 5 (crack poops, +0x89): every frame `btn1 = 1, btn1_prev = 0`, i.e. a drop
  attempt every frame (§14).
- A full bomb array (100) makes the drop silently fail **after** the sound was played.

### 4.2 `player_drop_bomb(p, cx, cy, delay)` — 0x41eb13

```
type = REGULAR
if (p.jelly /*+0x60*/) type = JELLY
if (p.trigger /*+0x5f*/ && p.triggers_used /*+0x55*/ < p.bombs /*+0x56*/) { type = TRIGGER; p.triggers_used++ }
flame = p.flame /*+0x57*/
fuse  = p.fuse_frames /*+0x4a, = V41 = 40 at round start*/
if (p.disease[4] /*short flame, +0x88*/) flame = 1
if (p.goldflame /*+0x5e*/)               flame = max(W, H) = 15      // checked after short flame -> wins
if (p.disease[6] /*short fuze, +0x8a*/)  fuse = fuse / 3            // 40 -> 13 (650 ms)
id = 0
if (net_mode) { id = p.bomb_seq /*+0x0c*/ + p.index*25; p.bomb_seq = (p.bomb_seq+1) % 25 }
bomb_create(cx, cy, type, p.colour /*+0x3c*/, p.index, flame, fuse, delay, id, is_net = 0)
net_send_bomb_create(...)                                         // only does something in net games
```
- Flame length and fuse are **copied at drop time**; later powerups/diseases do not affect a placed bomb.
- `triggers_used` (+0x55) is never decremented; it is reset to 0 at round start and when a trigger powerup is
  collected. So each trigger pickup gives "bomb capacity" trigger bombs in total (capacity compared live), after
  which bombs are regular (or jelly).

### 4.3 `bomb_create(cx, cy, type, colour, owner, flame, fuse_frames, delay_frames, id, is_net)` — 0x422ede

```
if (is_net) for each active bomb: if (b.id == id) return             // duplicate network create ignored
stat_bombs_dropped++                                                  // 0x4642ac
b = bomb_alloc(); if (!b) return
b.active = 1
if (net_mode == 0 && type == REGULAR && time() >= g_next_dud_time) {  // dud roll (§4.4)
    n = V322 (3); bomb_dud_schedule_next(); if (n == 0) n = 1
    if (rand() % n == 0) b.active = 2                                  // DUD
}
b.type = type; b.owner = owner
b.x = cell_to_px_x(cx); b.y = cell_to_px_y(cy)                        // always snapped to the cell centre
b.colour = colour; b.flame_len = flame
b.fuse_len = fuse_frames * 50; b.fuse_elapsed = -delay_frames * 50   // (16-bit shorts)
b.born = g_frame_counter; b.id = id
b.ctrl = is_net ? 4 : 9
if (is_net) { g = ghost_find(id); if (g && g.active == 1) { bomb_net_explode(g.id, g.x, g.y, g.dir); stat_ghost_found++ } }
```
Everything else is 0: `state = REST`, `dir = 0 (up)`, `anim = 0`, `skip_dir = 0`, `stop = 0`, `holder = NULL`.

### 4.4 Duds (V320–V323)

- `bomb_dud_schedule_next` (0x422c13): `g_next_dud_time = time(NULL) + V320 + rand() % max(V321,1)` →
  180..359 **wall-clock seconds** after scheduling. Scheduled once at program start (`bombs_init`) and after each
  roll; **not** reset per round or per match.
- When due, the **next regular bomb created in a local (non-network) game** rolls `rand() % V322 == 0`
  (1 in 3) and the timer is rescheduled whether or not it became a dud. Trigger/jelly bombs never roll.
- A dud (`active == 2`): its fuse does not advance, it uses sequence `"bomb regular green dud"`; it can be kicked,
  punched, grabbed, and it is detonated normally by flames/chain reactions. In the bomb update, when
  `anim > V323` (120, i.e. after 121 animation steps ≈ 6.05 s) it becomes a normal bomb: `active = 1`,
  `anim = 0`, and its fuse then runs from wherever it was (normally 0 → explodes 2 s later).
- V324 ("random additional dud wait") is **not used** anywhere.

---------------------------------------------------------------------------------------------------------

## 5. Per-frame update: `bombs_update(heldPass)` — 0x42331c

```
bombs_update(heldPass):
  if (g_bombs_last_frame != g_frame_counter) {          // first call of this frame (the "free" pass)
      g_bombs_last_frame = g_frame_counter
      memset(g_danger_map, 0, W*H*4)
      for i in 0 .. explode_count-1:                    // apply deferred detonations (§7)
          b = explode_bomb[i]
          if (b && b.active) { b.fuse_elapsed = b.fuse_len; b.skip_dir = (u8)explode_dir[i] }
          explode_bomb[i] = NULL
      explode_count = 0
  for slot in 0..99:
      b = g_bombs[slot]
      if (!b.active) continue
      if ((b.holder != NULL) != heldPass) continue      // pass 0: no holder; pass 1: held bombs
      x0 = b.x; y0 = b.y                                 // (only for the network position message)
      // 5.1 animation clock
      b.anim_acc += dt
      while (b.anim_acc > 0) { b.anim++; b.anim_acc -= 50 }
      // 5.2-5.5 movement, only for locally simulated bombs (ctrl == 9)
      if (b.ctrl == 9) switch (b.state) { REST: §5.2; SLIDING: §5.3; FLYING: §5.4; HELD: §5.5 }
      // 5.6 sequence
      name = "bomb " + bomb_type_name(b.type) + " green"     // regular / trigger / jelly
      if (b.type == REGULAR && b.active == 2) {
          if (b.anim > V323) { b.active = 1; b.anim = 0 } else name += " dud"
      }
      frame = frame of state (b.anim % state_count) of sequence `name`
      // 5.7 fuse and explosion
      if (players_alive_count() > 1) {
          if (b.active != 2 && b.state != FLYING && b.state != HELD && b.type != TRIGGER && b.ctrl == 9)
              b.fuse_elapsed += dt
          if (b.fuse_elapsed >= b.fuse_len) explode(b)      // §6 (signed 16-bit compare)
      }
      if (b.active) { danger (§5.8); draw (§5.9) }
```

Notes
- **Fuse is dt-based** (ms), the animation is dt-based (1 step per 50 ms), movement is dt-based (§5.3/5.4).
  Only the throttled sound (3 frames), the player stun (16 updates) and the drawing are per rendered frame.
- `players_alive_count()` (0x421969) is the value computed by the *previous* players update: number of players
  still alive, counting a dying player until his death animation reaches step V25 (20); in team mode the number
  of teams alive; always 2 in campaign. **While ≤ 1, no bomb ticks or explodes** (even bombs in the explode list);
  they keep animating and moving.
- The fuse does not advance while FLYING or HELD, for trigger bombs, for duds. It does advance while SLIDING
  and while moved by a conveyor.
- Fuse start: 2000 ms (V41 = 40 ref frames); short fuze: 650 ms. The fuse starts ticking in the frame after the
  drop (the bomb is created during the players update).

### 5.2 State 0 REST — conveyors

```
e = extra_at(px_to_cell_x(b.x), px_to_cell_y(b.y))
if (e && e.type == 2 /*conveyor*/) {
    b.dir = e.dir                                                 // extra +0x2c
    b.accum += (u32)(V[190 + g_conveyor_speed] * dt) / 50         // 250 / 350 / 450 (option conveyor_speed 0..2, default 1)
    repeat 2 times:                                               // pull the perpendicular axis 1 px toward the centre
        if (b.dir & 1) { o = px_offset_y(b.y); if (o < 0) b.y++; if (o > 0) b.y-- }   // moving horizontally
        else           { o = px_offset_x(b.x); if (o < 0) b.x++; if (o > 0) b.x-- }   // moving vertically
    goto SLIDE_STEPS (§5.3, with state still 0)
}
```
A resting bomb on a conveyor therefore moves with the same step loop as a kicked bomb (arrows, flames, obstacles
all apply), but stays in state 0 (no kick/stop sounds, owner cannot stop it, it counts as "resting" for
kick/punch/grab). It stops being carried as soon as its cell (by `px_to_cell`) is no longer a conveyor — which
can leave it up to 20 px off-centre (quirk Q3).

### 5.3 State 1 SLIDING (kick) — the step loop

```
b.accum += (u32)(b.speed * dt) / 50                 // speed = V300 = 1000 -> 10 px per 50 ms (200 px/s)
SLIDE_STEPS:
b.accum += 100
b.x -= DX[b.dir]; b.y -= DY[b.dir]                  // step back 1 px so the 1st iteration re-examines the current position
while (b.accum > 0) {
    nx = b.x + DX[b.dir]; ny = b.y + DY[b.dir]
    ox = px_offset_x(nx); oy = px_offset_y(ny)
    along = ox*DX[b.dir] + oy*DY[b.dir]             // >= 0: at or past the centre of the cell being entered
    cx = px_to_cell_x(nx); cy = px_to_cell_y(ny)
    if (ox == 0 && oy == 0) {                        // exactly on a cell centre
        e = extra_at(cx, cy)
        if (e && e.type == 0 /*arrow*/) { b.dir = e.dir; b.stop = 0 }   // redirect, cancels a stop request
    }
    ahead = (cx + DX[b.dir], cy + DY[b.dir])          // uses the possibly new dir
    f = flame_at(cx, cy)
    if (f) {
        if (f.kind != 9 /*burning brick*/) { bomb_explode_list_add(b, 0); net_send_bomb_explode(b.id, b.x, b.y, 0) }
        goto STOP
    }
    if (!bomb_slide_cell_passable(ahead)) b.stop = 1
    if (b.stop && along >= 0) goto STOP
    goto ADVANCE
STOP:
    b.stop = 0
    nx = cell_to_px_x(cx); ny = cell_to_px_y(cy)     // snap to the centre of the cell being entered
    b.accum = 0
    if (b.type == JELLY) {
        b.dir = (b.dir + 2) & 3                       // bounce back, stays SLIDING
        if (b.state != 0) sound_play_group_throttled(135)   // bombboun/1017/1036, max once per 3 frames
    } else {
        if (b.state != 0) sound_play_group(130)       // bombstop/bmbstop1/bmbstop2
        b.state = REST
    }
ADVANCE:
    b.x = nx; b.y = ny
    b.accum -= 100
}
```
- Net movement per frame = (number of iterations − 1) px; the residual `accum` (−99..0) carries over. After a
  STOP the residual is −100 (so the first frame of the next kick moves 1 px less).
- `bomb_slide_cell_passable(cx,cy)` (0x4230a5), in this order:
  1. `bomb_at(cx,cy)` (resting/sliding/dud bomb) → **blocked**;
  2. `player_at(cx,cy)` (alive, not dying, by cell membership) → **blocked**;
  3. visible powerup (state 2) → **the powerup is destroyed** (`powerup_remove`; if it was a disease and the
     option *diseases_destroyable* is 0, a new disease is placed at random: `powerup_spawn_random(2)`) and the
     check continues (not blocking);
  4. warp hole (extra type 1) → **blocked**;
  5. otherwise passable iff `map_get == 0` (solid, brick — including a brick that is burning — and out-of-field
     block).
- Because "ahead" is evaluated at every pixel step, a sliding bomb destroys a powerup as soon as the powerup's
  cell is the next cell, and it **stops at the centre of the cell before** any blocker. A blocker that appears in
  the cell the bomb is already entering does not stop it (only the cell *ahead* is tested).
- A flame in the cell being entered stops the bomb at that cell's centre and detonates it next frame (§7),
  except a burning-brick flame (kind 9), which only stops it.
- Stopping on request (`stop` flag) also stops at the first position whose `along >= 0`: if the flag is set while
  the bomb is past the centre of its cell, it **snaps back** to that centre (up to 19 px horizontally, 17/18 px
  vertically).
- Arrows act only when the step lands *exactly* on the centre, i.e. on the bomb's axis (always true for bombs
  that were centred; an off-centre bomb ignores arrows).
- Jelly bombs never come to rest by obstacles: they reverse forever (between two blockers they reverse every frame;
  the sound is throttled) until they explode. They cannot be stopped by the owner (§8.3).

### 5.4 State 2 FLYING (punch/throw)

```
b.accum += (u32)(b.speed * dt) / 50                 // speed = V301 = 1300 -> 13 px per 50 ms (260 px/s)
while (b.accum > 0) {
    nx = b.x + DX[b.dir]; ny = b.y + DY[b.dir]
    ox = px_offset_x(nx); oy = px_offset_y(ny)
    cx = px_to_cell_x(nx); cy = px_to_cell_y(ny)      // computed BEFORE the wrap below
    if (ox == 0 && oy == 0) {                          // reached a cell centre
        // wrap-around (field is W+3 = 18 columns / H+3 = 14 rows "around")
        if (cx >= W+2 /*17*/) nx -= 18*40;   if (cx <= -2) nx += 18*40
        if (cy >= H+2 /*13*/) ny -= 14*36;   if (cy <= -2) ny += 14*36
        if (px_to_cell_x(b.x) != b.start_x && px_to_cell_y(b.y) != b.start_y)   // BUG: cell vs pixel -> always true
            b.bounce++
        if (b.bounce >= 3) {                           // landing attempt
            if (b.type == JELLY && 0 <= cx < W && 0 <= cy < H) {
                n = (V667 > 1) ? V667 : 1                // 3
                if (rand() % n == 0) b.dir = (b.dir + (rand() % 2)*2 - 1) & 3   // turn 90° left or right
            }
            sound_play_group(160)                       // bmdrop3, at EVERY landing attempt
            b.step = 0
            if (map_get(cx,cy) == 0 && !bomb_at(cx,cy) && !powerup_at(cx,cy) /*any state*/) {
                p = player_at(cx,cy)
                if (p) player_bomb_hit_head(p)          // stun (§9.6), bomb keeps flying
                else if (!(extra_at(cx,cy) && extra.type == 1 /*warp*/)) {
                    // LAND
                    b.accum = 0; b.state = REST; b.x = nx; b.y = ny
                    if (flame_at(px_to_cell_x(b.x), px_to_cell_y(b.y))) {
                        bomb_explode_list_add(b, 0); net_send_bomb_explode(b.id, b.x, b.y, 0)
                    }
                    continue                            // loop test fails (accum == 0)
                }
            }
        }
    }
    b.x = nx; b.y = ny
    b.accum -= 100
    b.step++
}
```
See §9 for the resulting behaviour (distance, bounces, wrap).

### 5.5 State 3 HELD

```
h = b.holder
if (h == NULL) { b.accum = 0; b.state = REST; break }   // (computes a snapped position into locals and DISCARDS it — Q5)
h.walk_counter /*player +0x30*/ = 0                     // side effect on the player (Q11)
if (h.anim == 4 /*pickup*/) {
    k = clamp(h.anim_frame /*+0x50*/ - 1, 0, 3)
    b.x = h.x + DX[h.dir]*10 + DX[h.dir]*V[500 + 2k]
    b.y = h.y + DY[h.dir]*10 - V[501 + 2k]
} else {
    b.x = h.x + DX[h.dir]*10
    b.y = h.y + DY[h.dir]*10 - 40
}
```
Pickup curve V500..V507 (pairs "forward, up"): k=0 (12,10), k=1 (25,20), k=2 (25,30), k=3 (12,40); i.e. forward
offset 22/35/35/22 px and height 10/20/30/40 px, then (10 forward, 40 up) once the pickup animation is over.
`h.dir` is the holder's facing (+0x2c).

### 5.8 Danger map (for the AI)

After a surviving bomb's fuse check:
```
v = b.fuse_elapsed + 100                       // grows from 100 to ~2100 as the fuse burns; trigger bombs stay ~100
c = (px_to_cell_x(b.x), px_to_cell_y(b.y)); danger_set_max(c, v)
for d in 0..3:
    for i in 1..b.flame_len:
        c += (DX[d], DY[d])
        if (map_get(c) != 0 || bomb_at(c)) break
        danger_set_max(c, v)
        if (powerup_at(c)) break
```
`danger_set_max` (0x424dfe) keeps the maximum; `danger_get` (0x424d37) reads (0 outside the field). Flames write
1000 into their cells (flame code). The map is cleared at the start of every frame (§5). Held and flying bombs
also write (at the cell of their ground position).

### 5.9 Drawing

```
dx = b.x; dy = b.y
if (b.state == FLYING) {
    size = (b.dir == 0 || b.dir == 2) ? 36 : 40
    if (b.bounce < 3) dy = trunc(b.y - sin(b.step * 3.14159 / (size * 3.0)) * V660)   // 65 px, 3-cell arc
    else              dy = trunc(b.y - sin(b.step * 3.14159 / size)         * V661)   // 20 px, 1-cell hop
}
if (b.ctrl != 9) { dx = b.x; dy = b.y }                 // remote copies: the sender already sends the arc'd y
graf_queue_sprite_remap(dx, dy, frame, b.colour)        // 0x415a9f; colour clamped to 0..9 -> remap table
```
- Math in x87 double; the constant is literally `3.14159` (0x45a2c9/0x45a2d9), `trunc` = round toward zero
  (`__CHP` 0x433b38).
- The sprite is drawn with the frame image's own hotspot at (dx, dy) (hotspots are bottom-centre, §16). The
  per-state x/y offsets stored in the ANI sequence are **not** applied to bombs (bombs.c never calls
  `ani_seqno_stateno_get_offsets`).
- **No shadow** is drawn for flying bombs (only players use "shadow").
- The display list is executed in submission order (no y-sort): extras → bombs (free pass, slot order) →
  powerups → flames → players → held bombs. Hence flames are drawn over bombs, players over resting/flying bombs,
  and held bombs over players.
- Colour: `b.colour` = the dropping player's +0x3c: the player index in normal games, 0 (team A) / 2 (team B) in
  team games. The base art is green ("… green") and is remapped (graphics doc).

---------------------------------------------------------------------------------------------------------

## 6. Explosion (`explode`, inline in bombs_update at 0x423f49) and hand-off to flames

```
explode(b):
  b.active = 0                                                   // freed immediately, not drawn this frame
  if (b.ctrl == 9) net_send_bomb_explode(b.id, b.x, b.y, 0)
  sound_play_group(200)                                          // least-played of 200..219 (expl6 ... Bomb_24)
  for d in 0..3:
      if (b.skip_dir != 0 && d + 1 == b.skip_dir) continue       // skips this whole direction (centre spawn included)
      cx = px_to_cell_x(b.x); cy = px_to_cell_y(b.y)
      flame_spawn(cx, cy, 8 /*centre*/, b.colour, b.owner)       // spawned once per processed direction (up to 4x)
      pw = powerup_at(cx, cy)
      if (pw && pw.state == 2) { t = pw.type; powerup_remove(pw); if (t == 2 && !g_diseases_destroyable) powerup_spawn_random(2) }
      for i in 0 .. b.flame_len-1:
          cx += DX[d]; cy += DY[d]
          o = bomb_at(cx, cy)                                    // resting/sliding/dud; NOT flying/held
          if (o) {                                               // chain reaction (§7) — no flame on that cell
              o.owner = b.owner
              back = ((d + 2) & 3) + 1                           // direction pointing back to b, +1
              bomb_explode_list_add(o, back); net_send_bomb_explode(o.id, o.x, o.y, back)
              break
          }
          pw = powerup_at(cx, cy)
          if (pw && pw.state == 2) {                             // visible powerup: destroyed, arm stops, no flame there
              t = pw.type; powerup_remove(pw); if (t == 2 && !g_diseases_destroyable) powerup_spawn_random(2)
              break
          }
          m = map_get(cx, cy)
          if (m == 1) break                                      // solid or outside the field
          if (m == 2) {                                          // brick
              flame_spawn(cx, cy, 9 /*burning brick*/, b.colour, -1)
              stat_bricks_destroyed++
              map_redraw_as(cx, cy, 0)                           // erases the brick from the background only;
                                                                 // the cell stays 2 until the burn ends (flames doc)
              powerup_reveal(cx, cy)                             // hidden powerup -> visible (power.c)
              break
          }
          flame_spawn(cx, cy, (i == b.flame_len - 1) ? d /*tip*/ : d + 4 /*middle*/, b.colour, b.owner)
```
- `flame_spawn` (0x426fcc) overwrites the flame cell (memset, timer/anim restart), does nothing outside the field,
  and writes danger 1000. Flame kinds: 0–3 arm tip pointing in direction d, 4–7 arm middle (direction kind−4),
  8 centre, 9 burning brick (owner −1). Lifetimes/propagation visuals are in the flames doc.
- An arm that is stopped early (wall, brick, bomb, powerup) never gets a tip sprite: its last flame cell is a
  "middle" piece. Only an arm that reaches its full length ends with a tip.
- Flames do **not** stop at players or extras. Players die from the flame cell during their own update
  (player doc); kill credit comes from the flame's `owner`.
- A brick that is still burning (map value still 2) stops later arms again and gets a fresh burn flame (restarting
  its 500 ms) — and the powerup revealed by the first hit, now visible on that cell, is destroyed by the second
  arm (`powerup_at` is checked before the map).
- A bomb's flame length and colour are its own (copied at drop). Owner = `b.owner`.

---------------------------------------------------------------------------------------------------------

## 7. Chain reactions, deferred detonation, order inside a frame

- `bomb_explode_list_add(b, dir)` (0x423209) appends `(b, dir)` if fewer than 100 entries (duplicates allowed).
- Sources: explosion arms (dir = back-direction + 1), kicked bomb entering a flame (0), flying bomb landing on a
  flame (0), trigger (0), enclosement stomp (−1 → stored byte 0xFF = no skip), network.
- The list is applied **only at the start of the next frame's first `bombs_update` call** (§5): for each entry
  `fuse_elapsed = fuse_len`, `skip_dir = dir` (last entry wins for duplicates). The bomb then explodes in that
  pass when the slot loop reaches it — after its movement for that frame (a sliding bomb moves first) and only if
  `players_alive_count() > 1`.
- Hence **every link of a chain takes exactly one rendered frame** (not a fixed time). Within one frame, bombs whose
  fuse ran out explode in **slot order**; all their flames appear in that frame; bombs they hit explode next frame.
- The chained bomb skips flames in the direction of the bomb that triggered it, and takes over that bomb's
  `owner` (kill credit; also counts against the new owner's capacity for that one frame).
- Bombs in the list that are punched or grabbed before the next frame still explode next frame — mid-air or in
  the holder's hands, at their current cell (Q7).

---------------------------------------------------------------------------------------------------------

## 8. Kick

### 8.1 Start (player side, inside `player_move_step` 0x41ec84)
In every 1-pixel movement step of a player (also when carried by a conveyor), with `dir` = the player's movement
direction and `along` = player's offset from its cell centre along `dir`:
```
if (along == 0 && p.kicker /*+0x59*/) {
    b = bomb_at(player_cell + dir)                       // adjacent cell; resting, sliding or dud bomb, any owner
    if (b && cell_free_for_bomb(player_cell + 2*dir)) {  // cell beyond: no bomb and map_get == 0
        bomb_kick_request(b, dir)
        if (p.anim != 1) { p.anim = 1 /*"kick %s"*/; p.anim_frame = 0 }
    }
}
```
The cell beyond is not tested for players, powerups or warps. A live player or a warp hole there: the bomb is
kicked, then stops in its first slide step without moving (kick + stop sounds; a jelly bomb reverses and slides
back toward the kicker). A visible powerup there: destroyed by the slide check, the bomb slides on (§5.3).

### 8.2 `bomb_kick_request` (0x424708) / `bomb_kick(b, dir)` (0x42464b)
Only if `b.state` is REST or SLIDING (remote bombs: network request). Then:
```
if (b.dir != dir || b.state == REST) sound_play_group(120)       // kbomb1, kbomb2, kicker3, kicker10
if (b.state != REST && b.dir != dir) {                            // re-kick of a moving bomb in a new direction
    b.x = cell_to_px_x(px_to_cell_x(b.x)); b.y = cell_to_px_y(px_to_cell_y(b.y)); b.state = REST; b.accum = 0
}
b.dir = dir; b.state = SLIDING; b.speed = V300 (1000)
```
`b.stop` is not cleared (Q15). Kicking a bomb that already slides in the same direction does nothing audible.

### 8.3 Stopping by the player
On a fresh press of action 2 (`btn2 && !btn2_prev`) by a player who has a kicker: `bombs_stop_kicked(p.index)`
(0x4247c5) sets `stop = 1` on every bomb with `owner == p.index`, `type != JELLY`, `state == SLIDING`.
Only the owner can stop his bombs, jelly bombs can't be stopped, conveyor-carried bombs (state 0) can't be
stopped. The bomb stops at the centre of the cell it is in/entering per §5.3 (possibly snapping back), stop sound
130. An arrow reached before the stop executes cancels the request.

### 8.4 What ends a slide
Obstacle in the cell ahead (bomb, live player, warp hole, solid, brick incl. burning brick, field edge) → stop
centred in front of it; flame in the cell being entered → stop there (+ detonation next frame unless burning-brick
flame); owner stop request; jelly bombs reverse instead of stopping. Powerups in the path are destroyed.
Arrows redirect at their centre; trampolines and conveyors have no effect on a sliding bomb (a conveyor takes
over once it is at rest on it).

---------------------------------------------------------------------------------------------------------

## 9. Punch (red glove) and flight

### 9.1 Start (player side)
On a fresh press of action 2, if the player has punch (+0x5b) **and action 1 is not held** (`btn1 == 0`):
`player_punch_bomb(p)` (0x424a50): `b = bomb_at(player_cell + p.dir)` (facing direction +0x2c; adjacent cell;
any owner; resting/sliding/dud). If found: `bomb_punch_request(b, p.dir)` and `sound_play_group(150)`
(kbomb1/kbomb2). The function always returns 1, so the player's punch animation (`p.anim = 2`, "punch %s",
frame 0) plays even when there is no bomb.

### 9.2 `bomb_punch_request` (0x424987) / `bomb_punch(b, dir)` (0x4248c6)
Accepted when `state` is REST, SLIDING or HELD. `bomb_punch`:
```
b.x = cell_to_px_x(px_to_cell_x(b.x)); b.y = cell_to_px_y(px_to_cell_y(b.y))   // snap to its cell centre
b.state = REST; b.accum = 0
b.dir = dir; b.state = FLYING; b.speed = V301 (1300)
b.stop = 0; b.bounce = 0; b.step = 0
b.start_x = b.x; b.start_y = b.y            // pixel coordinates (see 9.3)
b.holder = NULL
```
No sound inside (the punch sound comes from `player_punch_bomb`; a throw is silent).

### 9.3 Distance, arc, bounces
- `bounce` increments at every cell centre reached (the test meant "not in the start cell" compares cell indices
  with pixel coordinates and is always true). The bomb starts on a centre, so the 1st centre reached is 1 cell
  away: **the first landing attempt is 3 cells from the start cell** (120 px horizontally / 108 px vertically,
  ≈ 462 / 415 ms).
- Arc while `bounce < 3`: height `sin(step·π/(3·size))·V660` (65 px peak at 1.5 cells), size 40 (horizontal) or
  36 (vertical); `step` = pixels flown.
- Landing attempt (each cell centre once `bounce >= 3`): plays 160, resets `step = 0`, and lands iff the cell is
  inside the field with `map_get == 0`, no resting/sliding bomb, **no powerup** (hidden or visible), no live player
  and no warp hole. A player there is hit on the head (§9.6). Otherwise the bomb continues one more cell with a
  small hop `sin(step·π/size)·V661` (20 px) and tries again at the next centre — repeating until it lands.
  (Because `step` is incremented after the failed attempt, the hop height while sitting on a centre is
  `sin(π/size)·20` ≈ 1.6 px.)
- On landing: `state = REST`, no stop sound; if a flame is on the landing cell it explodes next frame.
- The fuse does not advance in the air (and is not reset by a punch): a bomb punched with 100 ms left explodes
  ~100 ms after landing.
- Flames/explosions ignore flying bombs (`bomb_at` excludes them); a flying bomb never lands on a warp hole,
  so bombs never warp. Trampolines are ordinary floor for bombs.

### 9.4 Wrap-around at the field edges
Off-field cells read as solid (no landing), the bomb keeps hopping, and when a centre is reached at column ≥ 17,
column ≤ −2, row ≥ 13 or row ≤ −2 (as computed by the buggy `px_to_cell`, §1) it is moved by 18 columns
(720 px) / 14 rows (504 px). Resulting paths (every listed centre is a failed landing attempt unless in-field):

| leaving | centres visited |
|---|---|
| right edge | col 15 (x 640), 16 (680), 17 (720 → jumps to x 0 = col −1), then col 0 (x 40) |
| left edge | col −1 (x 0), −2 (x −40 → jumps to x 680 = col 16), then 15, 14 |
| bottom edge | row 11 (y 499), 12 (535), 13 (571 → jumps to y 67), then row 0 (y 103) |
| top edge | y 67 (computed as row −2 because of the floor bug → jumps to y 571 = row 13), then 12, 11, 10 |

In every direction there are 3 off-field landing attempts before the first in-field cell on the opposite side
(the top case only because of the `px_to_cell_y` bug). The bomb is drawn at those off-screen coordinates (clip is a
graphics matter).

### 9.5 Jelly bombs in flight
At each landing attempt inside the field (`0 <= cx < 15`, `0 <= cy < 11`, before wrap), with probability
1/V667 (1/3) the bomb turns 90° (`rand()%2` → left (−1) or right (+1)). The turn is decided before the landing
test of that cell, so it only matters when the bomb has to keep hopping.

### 9.6 Landing on a player (coordinate with player doc)
`player_bomb_hit_head(p)` (0x421f7e) — **only in local games** (`net_mode == 0`; in network games nothing happens
but the bomb still bounces over the player):
```
p.stun /*+0x3a*/ = 16           // decremented once per player update (rendered frame); input ignored while > 0
p.anim = 3; p.anim_frame = 0    // stunned animation; anim reset to 0 when stun reaches 0
lose = V670 + rand() % max(V671,1)                  // 1 + (0..2)
repeat lose times:
    for try in 0..199:
        i = rand() % 15
        if (p.count[i] /*+0x56+i*/ > V[50+i] /*starting amount*/) { powerup_eject(p, i); p.count[i]--; break }
```
No sound is played here; SOUNDLST group 360 ("bombhit1..4") is never referenced by the code.

---------------------------------------------------------------------------------------------------------

## 10. Grab / hold / throw (blue glove)

- **Grab** (§4.1, priority over spooge and drop): fresh press of action 1, not constipated, player has grab
  (+0x5c), a bomb is in the player's own cell (`bomb_at`, i.e. resting/sliding/dud) and `b.owner == p.index`
  (**own bombs only**). `bomb_grab(b, p)` (0x424af4): `b.holder = p; p.held = b; b.state = HELD; b.stop = 0;
  sound_play_group(170)` (grab1, grab2, bmbthrw1, bmbthrw3, bmbthrw4, bmbthrw5). Player: `anim = 4` ("pickup %s",
  11 states), `anim_frame = 0`.
- **Pause** (player update, before input): while `p.anim == 4 && p.anim_frame <= V665 (2)` the player's input is
  not read (no movement) and `btn1` is forced to 1 — so a quick tap cannot throw the bomb during the first
  ~3 ref frames of the pickup.
- **Hold**: the bomb follows the holder (§5.5), is updated/drawn in the held pass (after players, drawn on top),
  its fuse is frozen, it still counts against the owner's capacity, flames can't hit it (`bomb_at` excludes it).
  While holding, action 1 is held, so the player cannot punch or drop.
- **Throw** (player update, every frame): `if (p.held && (poop || !btn1))`:
  ```
  b = p.held
  b.x = p.x; b.y = p.y; b.fuse_elapsed = 0          // FULL FUSE AGAIN after the throw
  bomb_punch_request(b, p.dir)                      // snaps to the thrower's cell centre, flies like a punch (§9)
  p.held = NULL; b.holder = NULL
  ```
  So a thrown bomb lands 3 cells (or further) from the thrower's cell, then burns a fresh 2 s fuse. The throw is
  silent. A pooping player throws a held bomb the frame after grabbing it.
- **Holder dies**: `player_death_start` (0x41dcb2) sets the held bomb's `active = 0` — the bomb **vanishes without
  exploding** (network message 0x3c); `p.held` is not cleared (Q8).

---------------------------------------------------------------------------------------------------------

## 11. Trigger bombs

- Type chosen at drop (§4.2); sequence "bomb trigger green". Their fuse never advances.
- Detonation: fresh press of action 2 by a player with trigger (+0x5f): `bombs_trigger_oldest(p.index)` (0x424b41)
  picks, among active bombs with `owner == p.index`, `type == TRIGGER`, `state` not FLYING/HELD, the one with the
  smallest `born` that is **strictly less than the current frame counter** (ties → lowest slot), and calls
  `bomb_explode_list_add(b, 0)` → it explodes at the start of the next frame. **One bomb per press.** Flying or
  held trigger bombs are skipped.
- Also detonated by flames (chain), by sliding into a flame, landing on a flame, or a stomp.
- `bombs_untrigger(owner)` (0x424c47): every active trigger bomb of `owner` becomes REGULAR with
  `fuse_elapsed = 0` (full fuse from now). Called (a) when the owner's death animation finishes
  (`player_update` 0x41f4d6) — trigger bombs sit inert during the death animation, then burn a fresh 2 s fuse —
  and (b) from `player_drop_exclusive_power` when the trigger powerup is lost because punch or jelly was collected
  (mutual exclusion: trigger ↔ punch, trigger ↔ jelly).
- Regular and jelly bombs of a player who dies are not touched (they keep their fuse and owner); only a bomb he
  is holding disappears (§10).

---------------------------------------------------------------------------------------------------------

## 12. Spooge (line of bombs)

Fresh press of action 1 (not constipated, grab check failed), player has spooge (+0x5d), **not in poop mode**, and
the player stands on one of **his own** bombs (`bomb_at(player cell).owner == p.index`):
```
c = player cell; n = 0
loop {
    c += (DX[p.dir], DY[p.dir])                       // facing direction
    if (player_at(c)) break                           // live player
    if (powerup_at(c)) break                          // any powerup (hidden or visible)
    if (!cell_free_for_bomb(c)) break                 // bomb or non-empty map (incl. outside the field)
    if (bombs_count_owned(p.index) >= p.bombs) break
    n++
    player_drop_bomb(p, c.x, c.y, delay = n)          // fuse_elapsed = -n*50 ms
}
```
- Lays bombs until the line is blocked or the capacity is used up. Warp holes are **not** checked (a spooged bomb
  can sit on a warp). Flames in cells are not checked.
- Bomb n gets an extra delay of n ref frames (50 ms each) → the line explodes outward in sequence (in practice the
  first explosion chain-detonates the next one frame later anyway).
- Type/flame/fuse per §4.2 (trigger allowance consumed per bomb). **No sound at all** (neither drop nor voice).
- If the player is not on his own bomb, the press is a normal drop (§4.1), so: 1st press drops, 2nd press
  spooges.

---------------------------------------------------------------------------------------------------------

## 13. Enclosement "stomp" (map.c 0x426818)

When a closing-in block lands on a cell (after killing players and removing powerups there):
- option *stomped_bombs_detonate* (`g_stomped_bombs_detonate`, default V46 = 1) **= 1**: the first bomb found by
  `bomb_at` (resting/sliding/dud) is added to the explode list with dir −1 (no skipped direction). It explodes at
  the start of the next frame, **centred on the now-solid cell**, flames go out in all 4 directions. (Flames
  already on that cell are removed by the stomp.)
- **= 0**: every such bomb is removed (`bomb_destroy`, `active = 0`): no explosion, no sound.
Flying and held bombs are not stomped (a flying bomb then cannot land on the solid cell and hops on).

---------------------------------------------------------------------------------------------------------

## 14. Order of bomb-related actions inside `player_update` (0x41f29b)

For each player (slot order 0..9), alive and not dying:
1. If stunned (`+0x3a > 0`) or in pickup pause (§10), input is not read.
2. Input/AI sets `btn1`, `btn2`, desired direction; movement via `player_move_step` (kick, §8.1).
3. Animations, drawing of the player.
4. Poop disease: `btn1 = 1, btn1_prev = 0, poop = 1`.
5. Throw held bomb if `poop || !btn1` (§10).
6. If `btn2 && !btn2_prev`: (a) kicker → `bombs_stop_kicked`; (b) punch && `!btn1` → `player_punch_bomb` + punch
   anim; (c) trigger → `bombs_trigger_oldest`. All three can happen on one press.
7. If `btn1 && !btn1_prev` and not constipated: grab / spooge / drop (§4.1).

Dead players (death animation) skip all of this.

---------------------------------------------------------------------------------------------------------

## 15. Network-only parts (for completeness; not needed for a local remake)

Remote bombs (`ctrl == 4`) are not simulated: their position/state come from messages (`bomb_net_set_pos`
0x424cbe), kicks/punches are requested from the owner machine (msgs 0x37/0x36 → `bomb_net_kick` 0x42475f /
`bomb_net_punch` 0x4249ea), explosions arrive as `bomb_net_explode(id,x,y,dir)` (0x42325d); if the bomb id is
unknown yet, the event is kept in a 10-entry "ghost" list for up to 100 ms (`ghosts_age` 0x422a25, discarded when
age > 2×50) and replayed when the bomb is created. Each simulated bomb sends its drawn position when it moved
(msg 8). Bomb ids: `player.bomb_seq + 25*player.index`. Duds and the head-hit stun are disabled in network games.

---------------------------------------------------------------------------------------------------------

## 16. Animations, sprites, sizes

Sequences (MASTER.ALI loads TRIGANIM.ANI, BOMBS.ANI, DUDS.ANI; BOMANIM2/BOMBANIM/TRIGBOMB are not loaded).
State index = `anim % state_count`; `anim` +1 every 50 ms of game time (first increment in the first update,
since the accumulator starts at 0 and the test is `> 0`).

| sequence | file | states | loop | frames (state → frame) | frame size / hotspot |
|---|---|---|---|---|---|
| `bomb regular green` | BOMBS.ANI | 18 | 900 ms | 0,1,…,9,8,…,1 (pulse) | f0 36×37 hot(18,36) … f9 22×22 hot(11,21) (shrinking) |
| `bomb jelly green` | BOMBS.ANI | 12 | 600 ms | 10,…,16,15,…,11 | 40×36 hot(20,35) |
| `bomb trigger green` | TRIGANIM.ANI | 19 | 950 ms | 0,…,9,8,…,0 | 40×40 hot(20,39) |
| `bomb regular green dud` | DUDS.ANI | 10 | 500 ms | 0×5, 1×5 | 40×40 hot(20,37) |

Regular frame sizes: f0 36×37 (18,36), f1 35×35 (17,34), f2 34×33 (17,32), f3 32×32 (16,31), f4 30×30 (15,29),
f5 28×28 (14,27), f6 26×26 (13,25), f7 25×25 (12,24), f8 24×23 (12,22), f9 22×22 (11,21). All bomb frames are
15-bit (type 4) images, green base colour remapped with the bomb's colour (§5.9). Hotspot = bottom centre, drawn
at the bomb's (x, y) → the sprite stands on the cell's bottom line.

Player sequences tied to bombs (player doc): "kick %s", "punch %s", "pickup %s" (11 states), "walkbomb %s",
"standbomb %s".

---------------------------------------------------------------------------------------------------------

## 17. Sounds (SOUNDLST groups; `sound_play_group` = least-played random member of consecutive ids)

| event | id / group | where |
|---|---|---|
| drop | 100 (bmdrop2, bmdrop3) | §4.1 |
| drop while pooping | 550–554 (poops1..5) | §4.1 |
| drop refused on warp hole | 40 (enrt1, enrt2), not when pooping | §4.1 |
| last available bomb dropped (capacity ≥ V651=4), chance 1/V650=1/4 | 1200–1228 ("clear", "fireinh", …) | §4.1 |
| kick (new kick or new direction) | 120–123 (kbomb1, kbomb2, kicker3, kicker10) | §8.2 |
| sliding bomb stops (non-jelly, state ≠ 0) | 130–132 (bombstop, bmbstop1, bmbstop2) | §5.3 |
| jelly bounce (state ≠ 0), throttled: not if played in last 3 frames | 135–137 (bombboun, 1017, 1036) | §5.3 |
| punch (bomb found) | 150–151 (kbomb1, kbomb2) | §9.1 |
| every landing attempt of a flying bomb | 160 (bmdrop3) | §5.4 |
| grab | 170–175 (grab1, grab2, bmbthrw1/3/4/5) | §10 |
| explosion | 200–219 | §6 |
| spooge, throw, landing on a head | none | |

---------------------------------------------------------------------------------------------------------

## 18. Constants used

| const | value | use |
|---|---|---|
| 100 | bomb slots; explode list size | hardcoded |
| V41 | 40 ref frames = 2000 ms | player fuse (player +0x4a at round start) |
| short fuze | fuse/3 (integer) = 13 frames = 650 ms | disease 6 |
| short flame | 1 | disease 4 |
| goldflame | max(15, 11) = 15 | |
| V300 | 1000 → 10 px / 50 ms | kick speed |
| V301 | 1300 → 13 px / 50 ms | punch/throw speed |
| V190–V192 | 250/350/450 | conveyor (option conveyor_speed 0–2, default 1) |
| 3 | cells to first landing attempt | hardcoded (`bounce >= 3`) |
| V660 / V661 | 65 / 20 px | arc heights |
| 3.14159, 3.0 | | arc formula |
| W+2=17 / −2 / H+2=13 / −2; 18×40, 14×36 | | wrap |
| V667 | 3 | jelly turn chance 1/3 |
| V500–V507 | (12,10)(25,20)(25,30)(12,40) | pickup curve |
| 10, 40 | px | held bomb offset (forward, up) |
| V665 | 2 | pickup pause (anim frames 0..2) |
| V320/V321/V322/V323 | 180 s / +rand 180 s / 1 in 3 / 120 anim steps | duds (V324 unused) |
| V46 | 1 | stomped bombs detonate (default) |
| V650/V651 | 4 / 4 | "clear" voice |
| V670/V671 | 1 / 3 | powerups lost on head hit |
| 16 | player updates | head-hit stun |
| 100 | | danger value offset (`fuse_elapsed + 100`) |
| 3 frames | | jelly sound throttle |
| 2×50 ms | | ghost (net) lifetime |

---------------------------------------------------------------------------------------------------------

## 19. Cross-module interactions (for the other docs)

- **player**: `player_move_step` kicks (§8.1); `player_update` does throw/stop/punch/trigger/grab/spooge/drop
  (§14); `player_bomb_hit_head` (stun, lose powerups); player movement treats a cell with a resting/sliding/dud
  bomb as blocked (`cell_free_for_bomb`, 0x41e5c3); the bomb held pass zeroes the holder's +0x30 every frame;
  `player_death_start` deletes the held bomb; end of death animation → `bombs_untrigger`.
- **flames**: bombs spawn flames via `flame_spawn` (kinds 0–9); bombs read `flame_at` when sliding/landing;
  flames themselves never detonate bombs — only explosions (arms), slides and landings do.
- **powerups**: arms and sliding bombs `powerup_remove` visible powerups (disease relocation if
  *diseases_destroyable* = 0); `powerup_reveal` on brick hit; flying bombs never land on any powerup;
  `powerup_eject` on head hit; mutual exclusion → `bombs_untrigger`.
- **map/enclosement**: stomp (§13); `map_redraw_as` on brick hit; coordinate helpers (§1).
- **extras**: arrows redirect sliding bombs; conveyors carry resting bombs; warp holes block drops/slides/landings;
  trampolines no effect.
- **AI**: danger map (§5.8), `bomb_at`, `bomb_cell_free_ai` (0x423188: no bomb, no warp, empty map).
- **match flow**: bombs freeze when ≤ 1 player/team is alive (§5); `bombs_reset` at level load.
- **stats**: bombs dropped (914), bricks destroyed (917), ghost found/lost (927/928).

---------------------------------------------------------------------------------------------------------

## 20. Uncertain

1. **Draw order of flying bombs** — the display list (graf.c) appears to be executed in submission order without
   sorting, which puts flying bombs under flames and players. Hypothesis: correct; the graphics doc should
   confirm that nothing sorts the list.
2. **Remap draw path** — `graf_queue_sprite_remap` (0x415a9f) queues entry type 3; the executor's case 3 handler
   as decompiled (0x4158cf) clamps the colour to 0..9 and uses remap table `DAT_00460564[colour]`. Hypothesis: the
   bomb is drawn with the owner's colour remap; exact remap semantics belong to the graphics doc.
3. **Walk animation while carrying** — the held pass zeroes the holder's +0x30 each frame, and the player's walk
   frame is `(+0x30 / 3) % 15`; so "walkbomb" would show only frames 0..3 depending on per-frame movement.
   Hypothesis: that is really what the original shows (frame-rate dependent); the player doc should confirm the
   walk-frame formula.
4. **Sound group 360 (bombhit1..4)** — no code reference found (searched all `mov reg, 0x168`). Hypothesis:
   unused in this build.
5. **V324** — unused (no `value_get(324)` / computed id found).
6. The exact semantic name of the player fields (+0x55 trigger counter, diseases at +0x84+i) comes from code
   usage plus SOUNDLST disease comments (0 molasses, 1 crack, 2 constipation, 3 poops, 4 short flame,
   5 crack poops, 6 short fuze, 7 swap, 8 reversed controls); the player doc owns them.

---------------------------------------------------------------------------------------------------------

## 21. Bugs & quirks (replicate unless noted)

- **Q1 bounce test** (0x42395b): `if (px_to_cell_x(x) != start_x && px_to_cell_y(y) != start_y) bounce++` compares
  cell indices with pixel coordinates → always increments. Net effect is the intended 3-cell punch, but write it
  as "increment at every centre".
- **Q2 negative floor** in `px_to_cell_x/y` (§1) → asymmetric top-edge wrap (§9.4).
- **Q3 conveyor exit**: a bomb carried off the last conveyor cell rests where its cell membership changed
  (≈20 px off-centre) — no snapping.
- **Q4 sliding bombs destroy powerups** one cell ahead of them (even if they then stop before that cell).
- **Q5 HELD state without holder** (practically unreachable locally): becomes REST, the snapped position is computed
  into stale locals and discarded (bomb stays off-centre).
- **Q6 grab/throw frame**: a bomb grabbed during the players update is processed and drawn twice that frame
  (free pass at its old spot, held pass in hand; its animation may advance twice); a bomb thrown during the
  players update is processed in neither pass that frame (not drawn for one frame).
- **Q7 hit-then-moved**: a bomb added to the explode list and punched/grabbed in the same frame explodes next frame
  in the air / in the hands, centred on its current cell (a held bomb is 40 px up → usually the cell above the
  holder, whose flames then kill the holder).
- **Q8 stale held pointer**: when a held bomb explodes (Q7) or the holder dies, the player's +0x94 is not cleared;
  if the slot is reused by a new bomb, a later "throw" or death of that player acts on the new bomb.
- **Q9 bombs freeze** (no fuse, no explosions, not even queued chains) while ≤ 1 player/team is alive.
- **Q10 thrown bombs get a full fresh fuse** (`fuse_elapsed = 0` on throw); punched bombs keep their fuse.
- **Q11** held pass zeroes the holder's walk counter (+0x30) every frame (see Uncertain 3).
- **Q12** centre flame spawned once per processed direction (up to 4 times, each restarting the flame cell).
- **Q13** arms stopped early have no tip sprite.
- **Q14** chained bomb's owner is overwritten by the detonating bomb's owner (kill credit + capacity for 1 frame).
- **Q15** `bomb_kick` does not clear a pending `stop` flag: re-kicking a bomb whose stop was requested before it
  reached a centre stops it immediately.
- **Q16** after any STOP the movement accumulator keeps −100 → next kick moves 1 px less in its first frame.
- **Q17** the drop sound (and "clear" voice) is played before `bomb_create`, even if all 100 slots are used.
- **Q18** spooge is silent; spooge ignores warp holes and flames.
- **Q19** duds use the wall clock (`time()`), are never reset between rounds/matches, local games only; V324 unused.
- **Q20** `danger_get/set` bound-check the cell index against the map size in *bytes* (W*4*H) — harmless because x/y
  are range-checked first.
- **Q21** the punch animation plays even if there is no bomb to punch (`player_punch_bomb` always returns 1).
- **Q22** in network games a bomb landing on a player does nothing (no stun) but still bounces.
- **Q23** trigger allowance (`+0x55`) is never given back: N trigger bombs per trigger pickup, N = bomb capacity at
  drop time.
- **Q24** the old Ghidra names are swapped: 0x424d37 is the getter (`"GET (%u,%u)"`), 0x424dfe the max-setter;
  0x426d06 is the flames per-frame update (not "flame_create").
