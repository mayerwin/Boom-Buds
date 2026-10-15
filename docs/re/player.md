# Player (you.c) — reverse-engineered specification

Source: BM95.EXE (Watcom C, unoptimised). Module `you.c` = 0x41dbfe–0x422b3a (the decompiler header guesses
"ani.c" for the first three functions; they are player code). Every statement was checked against the
disassembly unless it is listed under **Uncertain**. Proposed names: `docs/re/names/player.txt`; names used
below follow that file (aliases chosen by other agents are given where they differ).

Notation: `V<n>` = VALUELST.RES value n (multi-value lines store their values at consecutive ids, e.g.
`500,12,10` → V500 = 12, V501 = 10). `dt` = `g_frame_dt` (0x464958) = real milliseconds elapsed this rendered
frame, capped at V31 = 150 (no lower bound). `REF` = `g_ref_frame_ms` (0x46494c) = 1000 / V30 = **50 ms**.
Directions: 0 = north/up, 1 = east/right, 2 = south/down, 3 = west/left; `DX = {0,1,0,-1}` (0x45becc),
`DY = {-1,0,1,0}` (0x45bedc); names `{"north","east","south","west"}` (0x45bcc4, `dir_name(d & 3)` 0x413aed).
C integer division truncates toward zero. `rand()` = Watcom LCG (see bombs.md). Map: 15 × 11 cells of 40 × 36 px.
"per frame" = once per rendered game frame (once per call of `players_update_all`), **not** time-scaled.

Related docs: bombs.md (bomb physics; the bomb side of kick/punch/grab/trigger/spooge), flames-map-powerups.md
(flame cells, powerup grid, start-area clearing, scatter), extras (warps/trampolines/conveyors objects), engine
(frame loop, input devices, HUD), match flow (round end, scores), AI.

---------------------------------------------------------------------------------------------------------

## 1. Coordinates

The playfield origin is `X0 = (640-600)/2 = 20`, `Y0 = 480-412 = 68`. A player position `(x, y)` (OBJ +0x1c,
+0x20) is an integer **screen pixel** "anchor": x = the column through the cell centre, y = the **bottom pixel
row** of the cell ("feet"). There are no sub-pixel positions (speed is accumulated separately, §6.2).

| helper | addr | formula |
|---|---|---|
| `cell_to_px_x(cx)` | 0x426524 | `40 + 40*cx` |
| `cell_to_px_y(cy)` | 0x42655f | `103 + 36*cy` |
| `px_offset_x(x)` | 0x426599 | `(x-20) mod 40 - 20` → ox ∈ [-20, 19], 0 when centred |
| `px_offset_y(y)` | 0x4265eb | `(y-85) mod 36 - 18` → oy ∈ [-18, 17], 0 when on the feet row |
| `px_to_cell_x(x)` | 0x42665c | `(x-20) / 40` (buggy floor for x < 20, never reached by players) |
| `px_to_cell_y(y)` | 0x4266a3 | `(y-85) / 36` |
| `map_get(cx,cy)` | 0x425fb9 | 0 empty, 1 solid, 2 brick, …; **1 when out of bounds** |

`cell(p)` below = `(px_to_cell_x(p.x), px_to_cell_y(p.y))`: the cell whose 40 × 36 box **centred on the anchor
grid** contains the anchor — i.e. the player belongs to cell (cx,cy) while `ox ∈ [-20,19]` and `oy ∈ [-18,17]`
relative to that cell's anchor `(40+40cx, 103+36cy)`. Every player rule (walls, bombs, flames, powerups,
extras, other players' cells) uses only this anchor cell; **there is no collision box** (the ANI "CBOX" data is
never used by player code). A player standing still at a cell anchor is "aligned".

---------------------------------------------------------------------------------------------------------

## 2. The player object (OBJ, 0x98 bytes)

All game objects share one 0x98-byte OBJ layout (`game_init` prints `sizeof(OBJ) = 152`). Players are
`g_players[10]` at **0x461bc4** (stride 0x98; index = slot = player number 0..9). The array is static (zero at
program start) and never memset; fields are initialised piecemeal (§4).

| off | type | name | meaning |
|---|---|---|---|
| 0x00 | i32 | `alive` | 1 = in play (alive **or** dying), 0 = not on the field (not spawned yet / death finished) |
| 0x04 | i32 | `death_anim` | 1..24, chosen at death; 0 after (re)spawn |
| 0x08 | i32 | `dying` | 1 while the death animation plays |
| 0x0c | i32 | `bomb_seq` | 0..24 rolling counter for network bomb ids (`bomb_seq + 25*index`) |
| 0x10 | u8 | `ctrl` | controller: 0 off, 1 AI, 2 keyboard, 3 joystick, 4 network-remote |
| 0x11 | u8 | `ctrl_sub` | keyboard layout (0/1) or joystick number |
| 0x14 | i32 | `home_x` | spawn anchor x; **also overwritten with the warp destination** (§6.8) |
| 0x18 | i32 | `home_y` | spawn anchor y (idem) |
| 0x1c | i32 | `x` | anchor pixel x (§1) |
| 0x20 | i32 | `y` | anchor pixel y |
| 0x24 | i32 | `step_dx` | x delta of the last 1-pixel step (up to ±20 on a snap-back, §6.2) |
| 0x28 | i32 | `step_dy` | y delta of the last step |
| 0x2c | i16 | `dir` | facing direction 0..3 (sprite direction; bombs are kicked/punched/thrown with it) |
| 0x2e | i16 | `want_dir` | requested movement direction this frame, −1 = none (reset every frame) |
| 0x30 | u16 | `walk` | animation counter: +1 per movement step while a direction is requested, +1 per frame while standing; death-animation state while dying; zeroed every frame while holding a bomb (bombs.md §5.5) |
| 0x32 | i16 | `death_ms` | ms accumulator of the death animation (never reset, leftover ∈ (−50, 0]) |
| 0x36 | u8 | `btn1_prev` | drop button state of the previous frame |
| 0x37 | u8 | `btn2_prev` | action button state of the previous frame |
| 0x38 | u8 | `btn1` | drop button ("action 1") down this frame |
| 0x39 | u8 | `btn2` | action button ("action 2") down this frame |
| 0x3a | i16 | `stun` | head-hit stun, frames remaining (per frame, §11) |
| 0x3c | u8 | `colour` | remap colour index: player index; in team play 0 (team 0) or 2 (team 1) |
| 0x3e | i16 | `id` | player index (owner id stamped on bombs and flames) |
| 0x4a | i16 | `fuse` | bomb fuse in ref frames (V41 = 40) |
| 0x4e | i16 | `anim` | special state: 0 normal, 1 kick, 2 punch, 3 stunned, 4 pickup, 5 trampoline, 6 warp-out, 7 warp-in, 20..32 cornerhead (20 + n); anything else is a fatal error |
| 0x50 | i16 | `anim_frame` | state index of the special animation |
| 0x52 | i16 | `anim_ms` | ms accumulator of the special animation (never reset) |
| 0x54 | u8 | `team` | 0/1 (default `index & 1`, set in `you_init`) |
| 0x55 | u8 | `trigger_used` | trigger bombs dropped since the last trigger pickup / round start (§7.4) |
| 0x56+t | u8[15] | `count[t]` | powerup counts, t = 0 bombs, 1 flame, 2 (disease, unused), 3 kicker, 4 skate, 5 punch, 6 grab, 7 spooge, 8 goldflame, 9 trigger, 10 jelly, 11 (super-bad disease, unused), 12 (random, unused), 13 clogs (slow, roulette only), 14 unused |
| 0x65 | u8 | `awesome` | non-disease pickups this round (AWESOME voice, §13) |
| 0x66 | i16 | `invuln_ms` | invulnerability, ms (campaign respawn only, §9.3) |
| 0x68 | u8 | `lives` | spawns remaining (1 at round start) |
| 0x6a | i16 | `score` | wins / points ("S:" on the HUD) |
| 0x6c | i16 | `kills` | kills ("K:" on the HUD) |
| 0x70 | i32 | `speed` | base speed, 1/100 px per ref frame (V42 = 923) |
| 0x74 | i32 | `accum` | movement accumulator, 1/100 px (also used by the angel death) |
| 0x78 | i32 | `disease_ms` | ms since infection (starts at 1); **0 = healthy** |
| 0x7c | i32 | `disease_len` | disease duration, ms |
| 0x80 | i32 | `disease_fresh` | frames before this player can pass its disease on (per frame) |
| 0x84+i | u8[14] | `disease[i]` | disease flags (§10) |
| 0x92 | u8 | `start_cleared` | 0 → clear the start area on the next update (§4) |
| 0x94 | ptr | `held` | bomb OBJ being carried (the bomb's +0x94 points back) |

Offsets not listed (0x12, 0x34, 0x3d, 0x40–0x49, 0x4c, 0x69, 0x6e, 0x93) are not used for players.

Fields used by other modules: bombs.c reads `x, y, dir, anim, anim_frame, held` and writes `walk = 0`
(held pass) and the head-hit fields; the AI writes `want_dir, btn1, btn2` and reads `disease[2]` etc.;
net code reads/writes most fields of remote players.

Other you.c globals:

| addr | name | meaning |
|---|---|---|
| 0x4621c8 | `g_input_history` | 10 pointers → 30 entries `{i32 age_ms, i32 dir}` per player (ice delay, §5.4) |
| 0x4621cc | `g_sparkles` | 100 × 16 bytes `{active, x, y, state}` goldman sparkles (§8.6) |
| 0x4621e0 | `g_round_freeze_ms` | input disabled while > 0; = V30 × REF = 1000 ms at round start |
| 0x4621e8 | `g_true_colours_ms` | = V32 × REF = 2000 ms at round start; players drawn in own colour while > 0 |
| 0x4621e4 / 0x4621d8 | present count | accumulated during the loop / latched after it (players, or teams in team play) |
| 0x4621d0 / 0x4621d4 | alive count | accumulated / latched (players) |
| 0x4621b4[2], 0x4621bc[2], 0x4621dc | team flags | team present, team alive counters, latched number of teams alive (0..2) |
| 0x45be3c | `g_kface_player` | player index wearing the "kface" overlay, −1 = none (§8.5) |
| 0x45be40 / 0x4621ec / 0x4621f0 | goldman | sequence number, state count, last frame counter processed |
| 0x46460c / 0x46465c | `g_start_x[10]`, `g_start_y[10]` | start cells (V600.., scheme, shuffled per match) |

---------------------------------------------------------------------------------------------------------

## 3. Place in the frame and per-player update order

Game frame (0x42a191, see bombs.md §3): `dt` computed → extras → bombs pass 0 (not held) → powerups →
flames → map/enclosement → **`players_update_all` (0x420f07)** → campaign aliens → bombs pass 1 (held bombs)
→ hurry, display list flush. The display list is executed in submission order (no sorting), so players are
drawn over everything submitted before them, held bombs over players, and **players are drawn in slot order
0..9** (each one's shadow, sprite and kface together; a higher slot's shadow covers a lower slot's sprite).

```
players_update_all():                                   // 0x420f07
  if g_round_freeze_ms > 0: g_round_freeze_ms -= dt; if < 0 → 0
  if g_true_colours_ms > 0: g_true_colours_ms -= dt; if < 0 → 0
  present_acc = alive_acc = 0; team_present[0..1] = team_alive[0..1] = 0
  joystick poll (0x429790)
  for i in 0..9:
      player_update(&g_players[i])
      if !g_attract_mode && g_goldman_enabled:          // gold bomberman sparkles, §8.6
          side = team_mode ? (players[i].team ? 2 : 0) : i
          if side == g_goldman_winner && players[i].alive: goldman_sparkle_spawn(&players[i])
      if players[i].ctrl != 0: HUD "S:%d K:%d" (score, kills) at (V115+i/2, V113+(i&1)); if !alive: draw "xxx" there
  present_latched = present_acc; alive_latched = alive_acc
  teams_alive_latched = (team_alive[0] != 0) + (team_alive[1] != 0)
  goldman_sparkles_draw()
```
`players_alive_count()` (0x421969) returns 2 in campaign mode, `teams_alive_latched` in team play, else
`alive_latched` — always the value of the **previous** frame's loop for everything that runs before the players.

### 3.1 `player_update(p)` (0x41f29b) — top level

```
player_update(p):
  if p.ctrl == 0: return                                   // slot off: not updated, not drawn
  if !p.start_cleared:                                     // first update of the round (or campaign respawn)
      p.start_cleared = 1
      map_clear_start_area(px_to_cell_x(p.home_x), px_to_cell_y(p.home_y), 0)   // flames-map-powerups.md §1.5
  if !p.alive:                                             // (re)spawn
      if p.lives == 0: return                              // finished players are neither updated nor drawn
      p.lives--; p.death_anim = 0; p.alive = 1; p.dying = 0
      p.x = p.home_x; p.y = p.home_y
      if campaign && p.ctrl != AI && time_remaining_s() >= V101 (60):
          p.lives = 1; p.invuln_ms = 20*REF (1000); p.start_cleared = 0
  if !team_mode: present_acc++
  else if !team_present[p.team]: team_present[p.team] = 1; present_acc++
  if p.dying: goto DYING                                   // §9.4
  alive_acc++; if team_mode: team_alive[p.team]++
  if p.invuln_ms > 0: p.invuln_ms -= dt; if < 0 → 0        // 16-bit
  if !p.dying:                                             // always true here
      f = flame_at(cell(p)); if f && player_kill_attempt(p, f.owner): goto DYING
  pw = power_at(cell(p)); if pw && pw.state == 2: player_pickup_power(p, pw); power_destroy(pw)
  if p.disease_fresh: p.disease_fresh--                    // per frame
  disease timer & expiry, then transmission              // §10.3, §10.4
  p.btn1_prev = p.btn1; p.btn2_prev = p.btn2; p.btn1 = p.btn2 = 0; p.want_dir = -1
  can_input = 1
  if p.stun > 0: can_input = 0; p.stun--; if p.stun == 0 && p.anim == 3: p.anim = 0; p.anim_frame = 0
  cornerhead check                                         // §8.3
  if p.anim in {5,6,7}: can_input = 0                      // trampoline / warp
  if p.anim == 4 && p.anim_frame <= V665 (2): can_input = 0; p.btn1 = 1   // pickup pause, button forced held
  if can_input && g_round_freeze_ms == 0:
      if p.ctrl == AI: campaign_hook(); ai_think(index, p) // sets want_dir, btn1, btn2
      else: you_getinput(p)                                // §5
  direction post-processing, ice delay                     // §5.3, §5.4
  movement (not for network players)                       // §6; may goto DYING
  animation selection + drawing                            // §8
  bomb actions                                             // §7
  if net game && p.ctrl != NET: send (index, alive, x, y, dir, walk)
  return
```

---------------------------------------------------------------------------------------------------------

## 4. Round start, spawning, match start

`players_round_start` (0x4214bc, called from level load):
```
for each player: input history = 30 × {age 0, dir -1}
for i in 0..9 (p = players[i]):
  p.alive = 0
  sx = g_start_x[i]; sy = g_start_y[i]
  while sx < 0: sx += 15;  while sy < 0: sy += 11;  sx = min(sx, 14); sy = min(sy, 10)
  p.home_x = cell_to_px_x(sx); p.home_y = cell_to_px_y(sy)
  p.start_cleared = 0; p.trigger_used = 0; p.anim = 0; p.anim_frame = 0
  p.dir = 2 (south); p.invuln_ms = 0; p.lives = 1
  p.colour = team_mode ? (p.team ? 2 : 0) : i;  p.id = i
  p.fuse = V41 (40); p.speed = V42 (923)
  for t in 0..14: p.count[t] = V(50+t)          // scheme "born with" values were written into V50.. (scheme doc)
  p.awesome = 0
  if g_goldman_enabled && 0 <= (t = roulette_prize()) < 15:            // 0x403a9c
      if (team_mode ? (p.team ? 2 : 0) : i) == g_goldman_winner: p.count[t]++   // not clamped by limits
  player_cure_diseases(p)
g_round_freeze_ms = V30 * REF  (= 1000 ms)
g_true_colours_ms = V32 * REF  (= 2000 ms)
```
Not reset at round start: `x, y` (set at the first update), `dying` (reset by the spawn), `stun`, `accum`,
`walk`, `death_ms`, `anim_ms`, `disease_fresh`, `btn*`, **`held`** (see Bugs Q2).

Spawning happens in the first `player_update` (§3.1): the start area is cleared (start cell + non-solid
orthogonal neighbours become empty, hidden powerups moved), then `lives` 1 → 0, the player appears at
`home`. In normal games a player therefore has exactly **one life per round**. For the first 1000 ms of the
round no input or AI is processed (players stand still; bombs cannot be dropped).

`players_match_start` (0x421793): `g_kface_player = -1`; every `score = kills = 0`; if *random start*
(option, default V40 = 1) 200 times `i = rand()%10, j = rand()%10`, if `i != j` swap `g_start_x/y[i]` with
`[j]`.

Campaign respawn: as long as `time_remaining_s() >= 60` (or infinite time) a human player's `lives` is set
back to 1 at each spawn, with 1000 ms of `invuln_ms` and a new start-area clearing; AI players never respawn.
The respawn point is `home`, which a warp may have changed (Q5).

---------------------------------------------------------------------------------------------------------

## 5. Input

### 5.1 `you_getinput(p)` (0x41e61e)
```
pressed[0..3] = 0
switch p.ctrl:
  0: return 0
  1: break                                              // AI: input comes from ai_think
  2: keys = (p.ctrl_sub == 0) ? 0x4645bc : 0x4645e4     // {up, right, down, left, drop, action} scancodes
     for d: pressed[d] = key_down[keys[d]]              // key_down = 0x4a2ba0
     if key_down[keys[4]]: p.btn1 = 1;  if key_down[keys[5]]: p.btn2 = 1
  3: joy_read(p.ctrl_sub, &jx, &jy, &buttons)           // axes 0..100 (engine doc)
     if jy < 30:                                         // easter egg, see §8.5
         if buttons == 0x4a: g_kface_player = index (+net msg)
         if buttons == 0x8a: g_kface_player = -1 (+net msg)
     pressed[0] = jy < 30; pressed[3] = jx < 30; pressed[2] = jy > 70; pressed[1] = jx > 70
     if buttons & 1: p.btn1 = 1;  if buttons & 2: p.btn2 = 1
  4: net_get_player(index, &alive, &x, &y, &dir, &walk)
     if (x, y) != (p.x, p.y): p.want_dir = dir           // only so that the walk animation plays
     p.x = x; p.y = y; p.dir = dir; p.walk = walk
     if map_get(cell(p)) == 2: map_set(cell(p), 0)        // a remote player cannot stand in a brick
  default: fatal "you_getinput(): unknown input type"
if count(pressed) > 1:
     if any pressed d has cell_free_for_bomb(cell(p) + DIR[d]):
          clear every pressed d whose neighbour cell is not free
for d in 0..3: if pressed[d]: last = d                    // highest index wins: left > down > right > up
if last exists: p.want_dir = last
return 1
```
`cell_free_for_bomb(cx,cy)` (0x41e5c3) = `bomb_at(cx,cy) == NULL && map_get(cx,cy) == 0` (`bomb_at` ignores
flying and held bombs; out of bounds counts as solid). So with two directions held, a direction that leads
into a wall/brick/bomb is dropped as long as another held direction is open; otherwise the priority
left > down > right > up decides.

### 5.2 Buttons
`btn1` (drop) / `btn2` (action) are levels; actions trigger on the **press edge** (`btn && !btn_prev`), except
the held-bomb throw which triggers on `!btn1` (§7.2). Disease 3/5 (poops) forces `btn1 = 1, btn1_prev = 0`
every frame after drawing (§7.1).

### 5.3 Direction post-processing (every frame, after input/AI)
```
if p.want_dir != -1:
    if p.want_dir < 0 || p.want_dir > 3: fatal "player %u, godir is invalid (%d)!"
    if p.disease[8] && p.ctrl != AI: p.want_dir = (p.want_dir + 2) & 3      // reversed controls
    if p.dir != p.want_dir && p.anim in {1 kick, 2 punch}: p.anim = 0; p.anim_frame = 0
    p.dir = p.want_dir                                   // facing follows the RAW request immediately
```

### 5.4 Control delay (ice), non-AI players only
```
h = g_input_history[index]                               // 30 entries, [0] newest
for k in 0..29: h[k].age += dt
for k in 29..1: h[k] = h[k-1]
h[0] = {age 0, dir p.want_dir}
for k in 0..29:
    p.want_dir = h[k].dir
    if h[k].age >= V(450 + level): break                 // V450..V460, ms; only level 2 (hockey rink) = 250
```
The movement uses the input from ≥ delay ms ago (the newest such entry); if no entry is old enough, the oldest
(k = 29) is used, so at > ~120 fps the delay is capped at 29 frames. Facing (§5.3) uses the raw input, so on
ice the player turns at once (standing sprite) but starts/stops walking 250 ms later. The ring also records
−1 while input is disabled. V449 = 0 is a guard value for an invalid level index.

---------------------------------------------------------------------------------------------------------

## 6. Movement

### 6.1 Per-frame driver (inside `player_update`, skipped for `ctrl == NET`)
```
if p.want_dir == -1:                                      // standing
    e = extra_at(cell(p))
    if e && e.type == CONVEYOR:
        p.want_dir = e.dir; saved = p.dir
        p.accum += (u32)(V(190 + g_conveyor_speed) * dt) / 50      // 250 / 350 / 450; option, default medium
        if player_move_step(p): goto DYING
        p.want_dir = -1; p.dir = saved                    // stays a standing player (stand anim, facing kept)
else:                                                     // walking
    spd = p.speed + p.count[4 skate]*V90 - p.count[13 clogs]*V91      // 923 + 150*skates - 150*clogs
    if p.disease[0] molasses: spd = spd / 3
    if p.disease[1] crack || p.disease[5] crack-poops: spd = (spd * 3) / 2
    spd = (u32)(spd * dt) / 50                            // unsigned division (Q9)
    e = extra_at(cell(p))
    if e && e.type == CONVEYOR:
        c = (u32)(V(190 + g_conveyor_speed) * dt) / 50
        if e.dir == p.want_dir:      spd += c             // walking with the belt
        if e.dir == (p.dir + 2) & 3: spd -= c             // walking against it; perpendicular: no effect
    p.accum += spd
    if player_move_step(p): goto DYING
```
Speeds are 1/100 px per 50 ms: base 923 = 9.23 px/ref frame = 184.6 px/s; each skate +150 (max V554 = 4
skates → 1523 = 304.6 px/s); molasses ÷3; crack ×1.5. The accumulator is **not** cleared when the player
stops; leftovers carry over (also into the angel death, §9.4). A negative net speed (against a fast belt) makes
the accumulator go negative and stay so while walking (Q8).

### 6.2 `player_move_step(p)` (0x41ec84) — the pixel-step loop
One iteration = one pixel step and −100 accumulator units; the loop runs **while `accum > 0`**, so a frame
moves `ceil(accum/100)` steps and leaves `accum ∈ (-100, 0]`.
```
player_move_step(p):                                      // returns 1 if the player died
  while p.accum > 0:
    p.step_dx = p.step_dy = 0
    if p.want_dir != -1:
      d = p.want_dir; p.dir = d
      ox = px_offset_x(p.x); oy = px_offset_y(p.y)
      along = ox*DX[d] + oy*DY[d]          // <0: before the cell centre in the movement direction, >0: past it
      perp  = oy*DX[d] - ox*DY[d]          // sideways misalignment (sign: see below)
      (cx, cy) = cell(p); (nx, ny) = (cx + DX[d], cy + DY[d])
      if along == -1:                                     // one pixel before the centre: extras (§6.8, §6.9)
          e = extra_at(cx, cy)
          if e && e.type == WARP:
              p.anim = 6; p.anim_frame = 0
              (wx, wy) = warp_destination(e)              // 0x405a81 (extras doc)
              p.home_x = cell_to_px_x(wx); p.home_y = cell_to_px_y(wy)
              sound_play_group(1330)                      // warp1 / transin / transout
          if e && e.type == TRAMPOLINE:
              e.bounce(+0x30) = 1; p.anim = 5; p.anim_frame = 0
              sound_play_group(350)                       // 1017 / 1036 / 1045 / trampo
      if along == 0 && p.count[3 kicker]:                 // kick (bombs.md §8)
          b = bomb_at(nx, ny)
          if b && cell_free_for_bomb(nx + DX[d], ny + DY[d]):
              bomb_kick_request(b, d)                     // 0x424708
              if p.anim != 1: p.anim = 1; p.anim_frame = 0
      if along < 0 || cell_free_for_bomb(nx, ny):         // (A) free: step forward, align sideways
          p.step_dx = DX[d]; p.step_dy = DY[d]
          if perp != 0:
              nd = (perp < 0) ? (d + 1) & 3 : (d - 1) & 3 // toward the lane centre
              p.step_dx += DX[nd]; p.step_dy += DY[nd]    // diagonal step
              p.dir = nd                                  // facing = correction direction for this step
      else if perp < 0:                                   // (B) blocked ahead, off-centre: corner assist
          s = (d - 1) & 3
          if cell_free_for_bomb(cx+DX[s], cy+DY[s]) && cell_free_for_bomb(cx+DX[s]+DX[d], cy+DY[s]+DY[d]):
              p.step_dx = DX[s]; p.step_dy = DY[s]        // slide 1 px sideways, away from the centre
      else if perp > 0:
          s = (d + 1) & 3
          (same test and slide with s)
      else if along > 0:                                  // (C) blocked ahead, centred, past the centre
          p.step_dx = DX[(d+2)&3] * along; p.step_dy = DY[(d+2)&3] * along   // snap back to the centre
      // (D) blocked, centred, along == 0: no movement
      p.x += p.step_dx; p.y += p.step_dy
      if !p.dying:
          f = flame_at(cell(p)); if f && player_kill_attempt(p, f.owner): return 1
      pw = power_at(cell(p)); if pw && pw.state == 2: player_pickup_power(p, pw); power_destroy(pw)
      p.walk++                                            // even when the step was (D) "no movement"
    g_stat_steps++                                        // 0x4642bc
    p.accum -= 100
  return 0
```
Sign conventions: for d = east, `perp = oy` (negative = above the row line, `nd` = south, corner-assist side =
north); for d = north, `perp = ox` (negative = left of the column, `nd` = east, assist side = west). In words:
- **Lane alignment**: whenever the player may advance, each step also moves 1 px toward the lane centre
  (diagonal motion, up to 20 px / 18 px of correction) and the sprite shows the correction direction for that
  step (the last step of the frame determines the drawn facing).
- **Corner assist**: pushing into a blocked cell while off-centre, the player slides 1 px per step toward the
  side he is offset to, provided the side cell **and** the cell diagonally ahead on that side are free
  (no bomb, empty map). Once his anchor crosses into the side cell, case (A) takes over (forward + align). If
  the side path is blocked he does not move at all (he is not pulled back to centre).
- **Snap-back**: centred on the lane but past the cell centre with the next cell blocked → he is moved back to
  the centre in **one** step (`along` pixels at once). This happens e.g. when trying to walk back onto a bomb
  just left behind (`along` = 20 or 18) or when a bomb/brick appears in front of a player past the centre.
- **Blocking** (`cell_free_for_bomb`): resting / sliding / dud bombs, any non-zero map cell (solid, brick,
  including a burning brick), outside the field. Not blocking: players, powerups, flames, warps, trampolines,
  conveyors, arrows, flying or held bombs.
- **Own cell is never tested**: a player can always walk inside and out of the cell he stands in (e.g. off the
  bomb he just dropped); he cannot re-enter it once his anchor has left it (case C).
- **Field edge**: outside cells count as solid, so the anchor stops at the edge cell's centre:
  x ∈ [40, 600], y ∈ [103, 463].
- **Walking in place**: while a direction is requested the walk counter advances every step even when blocked,
  so the walk animation plays against walls.
- Every step re-tests flames and powerups at the new anchor cell; the movement stops immediately on death.

### 6.3 dt scaling summary
Movement is time-scaled (accumulated `speed × dt / 50`); the pixel path does not depend on the frame rate
(except where an extra/kick test looks at an exact `along` value, which every pixel step visits).

### 6.4 Conveyors (player side)
Standing (no direction requested after the ice delay) on a conveyor cell: carried in the belt direction at
the conveyor speed through the same `player_move_step` (lane alignment, corner assist, kicks, warps,
trampolines, flames and pickups all apply); facing is restored afterwards and the standing animation is kept.
Walking: the belt speed is added when the (delayed) requested direction equals the belt direction, and
subtracted when the belt points opposite to the player's **facing** (`p.dir`, which follows the raw input);
a perpendicular belt has no effect (the player is not drifted sideways). Stunned / pickup-paused players
count as standing and are carried.

### 6.5 Map edges, players
Players never collide with each other: no movement test looks at other players. Any number of players can
share a cell or pixel (§12).

### 6.6 Kick (player side)
Requires a kicker, the anchor exactly on the cell centre along the movement direction (`along == 0`), a
resting/sliding/dud bomb in the next cell and a free cell beyond it (bomb or non-empty map blocks; players,
powerups, warps do not). Tested in every step of the loop (also conveyor steps, also while blocked at the
centre: a pushed bomb is re-kicked every step until it leaves). Starts the kick animation (state 1) unless it
is already playing. Bomb physics: bombs.md §8.

### 6.7 Diseases affecting movement
Molasses (÷3), crack / crack-poops (×1.5), reversed controls (§5.3). See §10.

### 6.8 Warps (player side)
Triggered in a movement step when the anchor is 1 px before the centre of a warp cell (`along == -1`) —
so only by walking (or being carried) **toward** the centre, never when leaving it. Effect: `anim = 6`
(input disabled, invulnerable), destination stored in `home_x/home_y` (the first other warp whose link id
matches, else the same warp — extras doc), sound 1330. The rest of the frame's movement continues (the
player may pass the centre by a few pixels). Then (§8.2): "spin" for 9 anim frames (450 ms) at the entry, then
`x,y = home` (destination cell anchor), `anim = 7`, "spin" 9 frames (450 ms), `anim = 0`. The destination
anchor is a centre, so leaving it cannot retrigger; walking back onto a warp warps again. A carried bomb is
thrown at the first warp frame (input disabled → `btn1 = 0`, §7.2).

### 6.9 Trampolines (player side)
Same trigger (`along == -1` on a trampoline cell). Effect: the trampoline's +0x30 = 1 (its own animation,
extras doc), `anim = 5`, sound 350; input disabled and immune for the whole bounce (`player_kill_attempt`
refuses state 5). Bounce timing (§8.2): `anim_frame` +1 per 50 ms; drawn `h` px higher, `h = f × V681` for
`f < V680/2`, else `(V680 − f) × V681` (V680 = 30, V681 = 35 → up to 15 × 35 = 525 px, i.e. off the top of the
screen); no shadow. When `anim_frame == V680/2` (15) the player is moved:
```
(cx, cy) = cell(p)
for try in 0..99:
    tx = rand() % 5 + cx - 2;  ty = rand() % 5 + cy - 2
    if tx == cx || ty == cy: continue          // never the same row or column (16 candidate cells)
    if map_get(tx, ty) != 0: continue          // also rejects outside the field
    if bomb_at(tx, ty): continue
    p.x = cell_to_px_x(tx); p.y = cell_to_px_y(ty); break
p.anim_frame++                                  // extra increment so the move happens once
```
(if all 100 tries fail he lands where he started). At `anim_frame >= V680` (1500 ms) `anim = 0`. Powerups
at the landing cell are collected while still in the air (the per-frame pickup test is not gated); flames at
the landing cell kill only after the bounce ends. If a frame advances `anim_frame` past 15 (dt > 50 ms
crossing it), the move is skipped and he lands on the trampoline again (Q6).

---------------------------------------------------------------------------------------------------------

## 7. Bomb-related actions (player side; bomb side in bombs.md)

Executed after movement and drawing, in this order (`player_update` 0x420870..0x420cec):

### 7.1 Poops
```
poop = 0
if p.disease[3] poops || p.disease[5] crack-poops: p.btn1 = 1; p.btn1_prev = 0; poop = 1
```

### 7.2 Throw the carried bomb
```
if p.held && (poop || !p.btn1):
    b = p.held; b.x = p.x; b.y = p.y; b.fuse_elapsed = 0     // full fuse again (bombs.md Q10)
    bomb_punch_request(b, p.dir)                              // 0x424987: flies like a punched bomb, facing dir
    p.held = NULL; b.holder = NULL
```
Releasing the drop button throws. Any frame with input disabled (stun, warp, trampoline, round start) also
throws, except the pickup pause, which forces `btn1 = 1`.

### 7.3 Action button press (`btn2 && !btn2_prev`) — all applicable effects in one press
```
if p.count[3 kicker]:  bombs_stop_kicked(p.id)                // 0x4247c5: stops own sliding non-jelly bombs
if p.count[5 punch] && !p.btn1 && player_punch_bomb(p):       // 0x424a50: bomb_at(cell + DIR[p.dir]) punched,
    p.anim = 2; p.anim_frame = 0                              //   sound 150; ALWAYS returns 1 → punch anim
if p.count[9 trigger]: bombs_trigger_oldest(p.id)             // 0x424b41: oldest own trigger bomb, one per press
```

### 7.4 Drop button press (`btn1 && !btn1_prev`) and not constipated (`!p.disease[2]`)
```
(cx, cy) = cell(p)
if p.count[6 grab]:
    b = bomb_at(cx, cy)
    if b && b.owner == p.id:                                  // own resting/sliding/dud bomb under the player
        bomb_grab(b, p)                                       // 0x424af4: held, sound 170
        p.anim = 4; p.anim_frame = 0; return-to-net-send
if p.count[7 spooge] && !poop:
    b = bomb_at(cx, cy)
    if b && b.owner == p.id:                                  // standing on an own bomb → spooge line
        n = 0
        loop: cx += DX[p.dir]; cy += DY[p.dir]
              if player_at_cell(cx, cy) || power_at(cx, cy) || !cell_free_for_bomb(cx, cy): break
              if bombs_count_owned(p.id) >= p.count[0]: break
              n++; player_drop_bomb(p, cx, cy, n)             // fuse delayed by n ref frames, silent
        return-to-net-send
active = bombs_count_owned(p.id)                              // every own bomb incl. flying/held/dud
if p.count[0] > active && cell_free_for_bomb(cx, cy):
    e = extra_at(cx, cy)
    if e && e.type == WARP: if !poop: sound_play_group(40); return-to-net-send   // "can't drop here"
    if p.count[0] >= V651 (4) && p.count[0] - 1 == active:    // dropping the last available bomb
        if rand() % max(V650,1) == 0: sound_play_group(1200)  // "clear" / "fire in the hole" (1 in 4)
    sound_play_group(poop ? 550 : 100)                        // poops / bmdrop
    player_drop_bomb(p, cx, cy, 0)
```
`player_drop_bomb(p, cx, cy, n)` (0x41eb13):
```
type = 0
if p.count[10 jelly]: type = 2
if p.count[9 trigger] && p.trigger_used < p.count[0]: type = 1; p.trigger_used++    // N triggers per pickup
flame = p.count[1]; if p.disease[4] short-flame: flame = 1; if p.count[8 goldflame]: flame = max(15, 11) = 15
fuse = p.fuse (40); if p.disease[6] short-fuze: fuse = fuse / 3 (13)
netid = 0; if net game: netid = p.bomb_seq + 25*index; p.bomb_seq = (p.bomb_seq + 1 > 24) ? 0 : p.bomb_seq + 1
bomb_create(cx, cy, type, p.colour, p.id, flame, fuse, n, netid, 0)   // bombs.md §4.3
net message
```
Summary of button semantics: **drop** = drop a bomb; on an own bomb with grab = pick it up (hold the button to
carry, release to throw); on an own bomb with spooge = lay a line of bombs in the facing direction.
**Action** = stop own kicked bombs (kicker), punch the bomb in front (punch, only if drop is not held),
detonate the oldest trigger bomb (trigger). Kick needs no button (§6.6).

Animations started: kick → state 1 "kick %s" (8 frames, 400 ms); punch → state 2 "punch %s" (ends after
11 × 50 ms); grab → state 4 "pickup %s" (ends after 11 × 50 ms; first 3 frames = input pause). Changing direction
cancels kick and punch (§5.3). Walking continues during kick/punch/pickup animations (except the pause).

Pickup pause: while `anim == 4 && anim_frame <= V665 (2)` (≈ 150 ms) input is ignored and `btn1` is forced
to 1, so the bomb cannot be thrown by a quick tap; the held bomb is positioned over the player's head along the
VALUELST 500–507 curve meanwhile (bombs.md §5.5).

---------------------------------------------------------------------------------------------------------

## 8. Animation and drawing (`player_update`, 0x41ff2f..0x420870)

### 8.1 Base sequence
```
if p.want_dir != -1:  name = (p.held ? "walkbomb %s" : "walk %s") % dir_name(p.dir)
else:
    p.walk++                                              // +1 per frame while standing (u16)
    d = (p.stun != 0) ? (p.anim_frame & 3) : p.dir        // stunned: spin through N,E,S,W
    name = (p.held ? "standbomb %s" : "stand %s") % dir_name(d)
```
`p.want_dir` here is the value after the ice delay and after the conveyor branch (which resets it to −1).

Player sequences and their (loaded) files: "walk <dir>" (15 states) and "spin" (4) — WALK.ANI; "stand <dir>"
(1) — STAND.ANI; "walkbomb <dir>" (15) / "standbomb <dir>" (1) — BWALK1–4.ANI; "kick <dir>" (8) — KICK.ANI;
"punch <dir>" (10) — PUNBOMB1–4.ANI; "pickup <dir>" (10) — PUP1–4.ANI; "die green 1".."die green 24" —
XPLODE1–17.ANI; "cornerhead 0".."cornerhead 12" (50 each) — CORNER0–7.ANI; "kface <dir>" (1) — KFACE.ANI;
"shadow" (1) — SHADOW.ANI; "goldman" (13), "xxx" (1) — MISC.ANI. `<dir>` = north/east/south/west. The ANI
per-state duration field ("dur=30") is ignored: the code times every animation itself.

### 8.2 Per state (`p.anim`)
`advance` = `p.anim_ms += dt; while p.anim_ms > 0: p.anim_frame++; p.anim_ms -= 50` (one frame per 50 ms).
`frame(seq, s)` = `ani_seqno_to_frameno(seq, s % nstates(seq))`.

| anim | sequence | frame drawn | timing / end |
|---|---|---|---|
| 0 normal | base name | `frame(base, walk / 3)` | — |
| 1 kick | "kick <dir>" (8) | `frame(kick, anim_frame)` (before advance) | advance; `anim_frame >= 8` → 0 |
| 2 punch | "punch <dir>" (10) | `frame(punch, anim_frame)` | advance; `anim_frame > 10` → 0 |
| 3 stunned | base name ("stand <spin dir>") | `frame(base, walk / 3)` | advance (drives the spin); ends when `stun` reaches 0 (§11) |
| 4 pickup | "pickup <dir>" (10) | **`frame(pickup, walk / 3)`** (Q3) | advance; `anim_frame > 10` → 0 |
| 5 trampoline | base name | `frame(base, walk / 3)` drawn at `(x, y − h)` with `colour`, no shadow/kface/flash | advance; `>= V680` → 0; move at V680/2 (§6.9) |
| 6 warp-out | "spin" (4) | `frame(spin, anim_frame)` | advance; `anim_frame > 8` → anim 7, frame 0, `x,y = home` |
| 7 warp-in | "spin" | `frame(spin, anim_frame)` | advance; `anim_frame > 8` → 0 |
| 20..32 cornerhead | "cornerhead %u" (anim − 20; 50 frames each) | `frame(ch, anim_frame)` | advance; `anim_frame >= 50` → 0 |

Ending a state sets `anim = 0, anim_frame = 0`. Walk frames: "walk <dir>" has 15 states → one state per 3
pixels of movement steps, a full cycle per 45 steps; "stand/standbomb" have 1 state; "walkbomb" 15 states,
but the held pass zeroes `walk` every frame, so it shows state `steps_this_frame / 3` (Q4).

### 8.3 Cornerhead (trapped player), before input every frame
```
blocked = number of d in 0..3 with !cell_free_for_bomb(cell(p) + DIR[d])
if blocked < 4:  if 20 <= p.anim < 40: p.anim = 0          // freed: stop at once (anim_frame not reset)
else if p.anim == 0: p.anim = 20 + rand() % max(V330,1); p.anim_frame = 0
```
A player boxed in on all four sides (walls, bricks, bombs — e.g. by his own bombs) plays a random one of the
13 cornerhead animations (2.5 s each, re-rolled while still trapped). Input stays enabled (he can still drop a
bomb, walk inside his cell). In the "Normal" memory model V330 is forced to 1 (only "cornerhead 0").

### 8.4 Common drawing (all states except trampoline and dying)
```
draw("shadow" state 0, p.x, p.y)                               // plain sprite, under the player
if p.disease_ms & 8:            colour = rand() % 10            // disease flicker, new random colour each frame
else if g_true_colours_ms != 0: colour = index                   // first 2 s of a round: own colour
else:                           colour = p.colour                // team colour in team play
draw_remap(frame, p.x, p.y, colour)
if index == g_kface_player: draw_remap(frame("kface <dir_name(p.dir)>", 0), p.x - 4, p.y - 34, 0)
```
All sprites are drawn with their hotspot at the anchor (graphics doc). The dying sprite uses `p.colour`.
Invulnerability has no visual indicator.

### 8.5 kface
Easter egg overlay (KFACE.ANI, one frame per direction) drawn 4 px left / 34 px above the anchor on the player
`g_kface_player`. Toggled only by a joystick player holding up with button mask exactly 0x4a (on, that player)
or 0x8a (off), or by a network message; reset at match start.

### 8.6 Gold bomberman sparkles
`goldman_sparkle_spawn(p)` (0x420d4e), called each frame for the alive goldman winner(s) (§3): take the first
free slot of 100; if `V1010 != 0 && elapsed_round_s() >= V1010 (5)` → nothing; if `rand() % 6 == 0` → nothing;
else `{active, x = p.x + rand()%40 − 20, y = p.y + rand()%50 − 48, state 0}`. `goldman_sparkles_draw`
(0x420e39): each active sparkle draws "goldman" state `state % 13` with colour 0, then (once per frame) `state++`,
freed when `state > 13`.

---------------------------------------------------------------------------------------------------------

## 9. Death

### 9.1 What kills
| cause | where | killer credited |
|---|---|---|
| any active flame cell (any flame type, incl. burning brick) in the player's **anchor cell** | once per frame before input (§3.1) and after every movement step (§6.2) | `flame.owner` (bomb owner; chain reactions re-own bombs, bombs.md Q14) |
| enclosement block landing on the cell | map.c 0x426818, every living non-network player in that cell | −1 (nobody) |
| campaign alien touching a non-AI player | aliens 0x401eae | −1 |

There is no partial-overlap rule: only the cell containing the anchor (feet point) matters. Since players update
after flames, a flame kills from its creation frame.

### 9.2 `player_kill_attempt(p, killer)` (0x41de63, old name `player_net_death`)
```
if p.ctrl == NET: debug "Ignoring a network player's supposed death."; return 0   // remote machine decides
if p.anim == 5 (trampoline) || p.anim == 6 || p.anim == 7 (warp): return 0         // immune
n = V105; if n < 2: n = 1                         // 24 death animations; 1 in the "Normal" memory model
p.death_anim = rand() % n + 1
player_death_start(p, killer)
net message (index, death_anim, killer)
return 1                                          // NOTE: also when player_death_start did nothing (Q1)
```
`player_death_start(p, killer)` (0x41dcb2, alias `player_kill`):
```
if p.invuln_ms != 0 || p.dying: return
stat_deaths++; if p.ctrl == AI: stat_ai_deaths++
if 0 <= killer < 10:
    if killer == index: if !g_win_by_kills: players[killer].kills--      // suicide
    else: players[killer].kills++                                         // also for team-mates
          if campaign && p.ctrl == AI: player_add_score(killer, V1300 (250))
    net stats message
if p.held: p.held.active = 0 (+net msg)        // the carried bomb vanishes; p.held is NOT cleared (Q2)
sound_play_group(300)                          // scream1 / die1
sound_play_id(340 + p.death_anim)              // only 341 "burnedup" exists (death anim 1)
p.dying = 1; p.walk = 0
```
Network players' deaths arrive as `player_kill_from_net(index, anim, killer)` (0x41de04): sets `death_anim`
(1 in the Normal memory model) and calls `player_death_start`.

### 9.3 Invulnerability windows
- trampoline (state 5, whole bounce) and warp (states 6, 7): `player_kill_attempt` refuses;
- network players: never killed locally;
- `invuln_ms` (only campaign respawns, 1000 ms): `player_death_start` refuses, but `player_kill_attempt`
  still returns 1 and the caller jumps into the dying code with `dying == 0` (Q1) — in practice flames are
  **not** survived;
- nothing else (no spawn protection in normal games; the 1 s start freeze only blocks input).

### 9.4 Dying (label DYING in `player_update`)
```
seq = ani_find_seq(sprintf("die green %d", p.death_anim))
draw_remap(frame(seq, p.walk), p.x, p.y, p.colour)          // no shadow
if p.death_anim == 9:                                        // the angel flies up
    p.accum += dt
    while p.accum > 0: p.y -= V106 (4); p.accum -= 50        // 4 px per 50 ms = 80 px/s
    if p.y < -20: goto FINISH                                // (jumps into the loop below)
p.death_ms += dt
while p.death_ms > 0:
    p.walk++
    if p.walk >= nstates(seq):
FINISH: player_drop_all_powers(p)                            // 0x41dbfe, §9.5
        p.alive = 0; p.dying = 0
        bombs_untrigger(p.id)                                // own trigger bombs become timed (full fuse)
    p.death_ms -= 50
if p.walk == 25 && rand() % max(V95,1) == 0: sound_play_group(700)    // post-death taunt (Q7)
if p.walk < V25 (20): alive_acc++; if team_mode: team_alive[p.team]++
return                                                       // no input, movement, bombs while dying
```
The death animation advances one state per 50 ms; durations (states × 50 ms) for "die green 1..24":
83, 62, 63, 93, 17, 79, 14, 12, 28, 77, 36, 63, 75, 36, 35, 69, 63, 85, 48, 20, 59, 54, 41, 75 states.
The angel (9, 28 states) normally ends by state count (it rises 112 px), the `y < -20` exit is a safety net.
A dying player keeps counting as **alive for the first 20 states (1 s)** — two players dying within 1 s of
each other both count as alive meanwhile (match flow: draw). Also counted while alive on the kill frame itself
(counted twice that frame). After FINISH the player is gone (`alive = 0`, `lives == 0`) and is not drawn;
the HUD shows "xxx".

### 9.5 Powerups on death
`player_drop_all_powers(p)` (0x41dbfe, skipped for network players): for t in 0..14, every count above the
starting amount `V(50+t)` is returned to the board via `power_spawn_random_blank(t)` (0x4255b2,
flames-map-powerups.md §3.8): exclusive types (punch, grab, spooge, trigger, jelly) once, others once per extra
unit; clogs are discarded; diseases are not returned. Happens when the death animation **ends**, not at the
moment of death. Trigger bombs are converted at the same time.

---------------------------------------------------------------------------------------------------------

## 10. Diseases

### 10.1 Types (index i, flag `disease[i]` at +0x84+i; order = SOUNDLST 3000+50i comments)
| i | name | effect (where) | duration |
|---|---|---|---|
| 0 | molasses | speed ÷ 3 (§6.1) | V130 × 50 = 15 s |
| 1 | crack | speed × 3/2 (§6.1) | V131 |
| 2 | constipation | drop button does nothing (no drop, grab, spooge) (§7.4); AI checks it | V132 |
| 3 | poops | drops a bomb whenever possible: `btn1` forced every frame, poop drop sound, no spooge, held bomb thrown at once (§7.1) | V133 |
| 4 | short flame | flame length 1 (§7.4) | V134 |
| 5 | crack poops | crack + poops | V135 |
| 6 | short fuze | fuse ÷ 3 = 13 ref frames (650 ms) (§7.4) | V136 |
| 7 | swap | immediate position swap, no lasting flag (§10.2) | — (V137 unused) |
| 8 | reversed controls | requested direction reversed, humans only (§5.3) | V138 |
| 9 | leprosy | **not implemented**, never given | — |
| 10 | invisible | **not implemented**, never given | — |
| 11 | duds | **not implemented** as a disease (duds are random, bombs.md §4.4) | — |
| 12, 13 | — | unused flags | — |

Visual indicator: random-colour flicker while `disease_ms & 8` (§8.4). There are no per-disease visuals.

### 10.2 Getting a disease — `player_give_disease(p, sound)` (0x41dfb6)
Called by the disease powerup (sound = 1) and three times by the super-bad disease powerup (POWEBOLA, type 11:
sound 1, 0, 0 → up to three diseases at once).
```
if p.ctrl == NET: return
for try in 0..199:
    r = rand(); d = r % 9                                 // 0..8 only
    if !net_game || d != 7: break                         // swap re-rolled in network games
if sound:
    if rand() % 3 == 0: sound_play_group(3000 + 50*d) else sound_play_group(2300)
if d == 7:                                                // swap 2 players
    for try in 0..199:
        q = players[rand() % 10]
        if q != p && q.ctrl != 0 && (q.lives > 0 || q.alive) && !q.dying:
            swap(p.x, q.x); swap(p.y, q.y); break         // positions only (not home, not state)
    return
p.disease[d] = 1                                          // earlier flags are NOT cleared: diseases stack
p.disease_ms = 1                                          // restarts the timer for all stacked diseases
p.disease_len = V(130 + d) * REF
p.disease_fresh = V129 (10)
```

### 10.3 Duration and cure
Every frame (§3.1): `if p.disease_ms: p.disease_ms += dt; if p.disease_ms > p.disease_len:
player_cure_diseases(p)`. V121 ("time limited") is never read — diseases always expire.
`player_cure_diseases` (0x41df4c): `disease_ms = disease_len = 0`, all 14 flags cleared (V122 "recycle" is
tested but the branch is empty). Cure on pickup (`player_pickup_power`, first thing, for every powerup
including diseases, also for network players): `if V124 && rand() % max(V125,1) == 0: cure` (1 in 10); the new
powerup is applied afterwards. Round start also cures.

### 10.4 Transmission by contact (every frame, after the timer, before input)
```
if p.disease_ms != 0 && p.disease_fresh == 0:
    for q in players[0..9] (slot order):
        if q == p || !q.alive || q.dying || q.disease_ms != 0: continue
        if abs(q.x - p.x) > 40 - 10 || abs(q.y - p.y) > 36 - 10: continue    // |dx| <= 30 && |dy| <= 26
        q.disease_fresh = V129 (10 frames)
        q.disease_ms = p.disease_ms; q.disease_len = p.disease_len           // same remaining time
        for i in 0..13: q.disease[i] = p.disease[i]; if !V123: p.disease[i] = 0
        if !V123: p.disease_ms = p.disease_len = 0; break                     // hand-off mode
```
Default V123 = 1 (multiply): the carrier keeps the disease and infects every healthy player in contact.
A diseased player cannot be re-infected by contact. `disease_fresh` (V129 = 10, decremented once per frame)
prevents a freshly infected player from passing the disease on immediately.

---------------------------------------------------------------------------------------------------------

## 11. Hit on the head by a punched/thrown bomb

bombs.c calls `player_bomb_hit_head(p)` (0x421f7e, alias `player_head_hit`) each time a flying bomb tries to
land on a cell where `player_at_cell` finds a living player (lowest slot); the bomb then bounces on
(bombs.md §9.6). In network games the function does nothing.
```
p.stun = 16; p.anim = 3; p.anim_frame = 0
n = V670 + rand() % max(V671,1)                           // 1..3 powerups lost
repeat n times:
    for try in 0..199:
        t = rand() % 15
        if p.count[t] > V(50+t): power_spawn_random_blank(t); p.count[t]--; break
```
Stun: input ignored for 16 **frames** (`stun` decremented once per `player_update`), the player spins
(standing sprite cycling N→E→S→W every 50 ms), a carried bomb is thrown on the first stunned frame, conveyors
still carry him; at 0 `anim` returns to 0. The lost powerups reappear at random blank cells (not next to the
player). Losing the trigger this way does **not** convert placed trigger bombs (Q10). No sound is played by the
player code (SOUNDLST 360 "bombhit" is unused). Each additional bounce on him repeats the whole effect.

---------------------------------------------------------------------------------------------------------

## 12. Player-to-player interactions

- No collision, no pushing: players walk through each other and can overlap completely.
- Disease contact (§10.4): anchors within 30 px horizontally and 26 px vertically.
- Swap disease (§10.2).
- Spooge lines stop at a cell containing a living player (§7.4); kicked bombs stop in front of players and
  flying bombs bounce on them (bombs.md).
- Bombs can be dropped in a cell occupied by another player; both can walk off it.
- Start-area clearing, tile regeneration (`no_player_within`, which scans all 10 slots even if unused) and
  powerup spawning avoid player cells (other docs).

---------------------------------------------------------------------------------------------------------

## 13. Powerup collection (player side)

Pickup test: anchor cell holds a powerup with `state == 2` → `player_pickup_power(p, pw)` (0x41e21e) then
`power_destroy(pw)`; done once per frame and after every movement step. Full pseudo-code is in
flames-map-powerups.md §3.6; summary: cure roll (§10.3); network players stop there; type effects
(0 bombs++, 1 flame++, 2 disease, 3 kicker++, 4 skate++, 5 punch++ & lose trigger, 6 grab++ & lose spooge,
7 spooge++ & lose grab, 8 goldflame++, 9 `trigger_used = 0`, trigger++ & lose punch & jelly, 10 jelly++ & lose
trigger, 11 three diseases, 12 random: re-dispatch as `rand() % 12` types not forbidden by the scheme);
clamp to `V(550+t)` if non-zero (bombs 8, flame 8, kicker/punch/grab/spooge/goldflame/trigger/jelly 1,
skates 4); `awesome++` for non-disease pickups with sound group 1400 on the 7th, 12th, 17th… (counter wraps
50 → 7); else sound 400 (135 for jelly). "Lose X" = `player_drop_excess(p, X)` (0x41e16a): counts above the
starting amount go back to random blank cells; losing the last trigger converts the player's trigger bombs to
timed bombs (`bombs_untrigger`).

---------------------------------------------------------------------------------------------------------

## 14. Other you.c functions (API used by menus, match flow, AI, net)

| addr | name | behaviour |
|---|---|---|
| 0x421198 | `players_clear_ctrl` | all `ctrl = ctrl_sub = 0` |
| 0x4211e7 | `players_clear_net_ctrl` | `ctrl == 4` → 0 |
| 0x42123f | `players_assign_default_ctrl` | for each off slot k-th: joystick k if present (ctrl 3), else first one gets keyboard 0 if V14 "assign keyboard player", else slot 1 gets AI |
| 0x4213e0 | `you_init` | alloc input history (10 × 30 × 8 bytes) and sparkles (100 × 16), `team = index & 1`, default ctrl |
| 0x421319 | `you_free` | atexit: frees those blocks |
| 0x4218e7 | `players_count_active` | slots with `ctrl != 0` |
| 0x421947 | `players_present_count` | latched present count |
| 0x421969 | `players_alive_count` | §3 |
| 0x4219b0 | `players_get_winner(buf)` | first slot with `ctrl != 0`, `(lives > 0 || alive)`, `!dying` → its index (team in team play) and "Player %u"/"Team %u"; else −1, "undetermined" |
| 0x421ac8 / 0x421b0f | `player_get_score` / `player_get_kills` | |
| 0x421b56 | `player_award_points(pts)` | winner (as above) `score += pts`; team play copies the score to team-mates |
| 0x421c71 | `player_add_score(i, pts)` | |
| 0x421cb5 | `player_at_cell(cx,cy)` | first slot with `alive && !dying` whose anchor cell matches (any ctrl) |
| 0x421d3f | `player_at_cell_local(cx,cy)` | same, excluding network players |
| 0x421dd2 / 0x421e33 | `player_get_ctrl` / `player_set_ctrl` | |
| 0x421e80 | `player_cycle_ctrl(i)` | controller-setup cycling off → AI → key 0 → key 1 → joysticks → off (AI skipped for net clients / campaign) |
| 0x422085 / 0x422154 | `players_count_ctrl_conflicts` / `players_remove_ctrl_conflicts` | duplicate human controllers |
| 0x42223e | `players_count_sides` | active players, or active teams in team play |
| 0x4222e8 | `player_net_lost(i)` | lost net player → AI (option) or removed |
| 0x422351 | `no_player_within(cx,cy,r)` | 0 if any of the 10 slots (even unused) has Manhattan cell distance ≤ r |
| 0x4223e7 / 0x422437 | `player_get_team` / `player_set_team` | |
| 0x42247a | `players_all_ai_or_off` | |
| 0x4224e2 / 0x422552 | `players_save_ctrl` / `players_restore_ctrl` | around attract mode |
| 0x4225be / 0x422602 | `player_set_score` / `player_set_kills` | net sync |
| 0x422646 | `player_set_counts(i, src)` | copies 15 powerup counts (net) |
| 0x422693 | `player_set_disease_state(i, ms, len, flags)` | net |
| 0x4226f6 | `kface_set_player(i)` | net |
| 0x422718 | `player_pick_random_enemy(p)` | AI target: random alive non-AI enemy first, else any alive enemy (other team) |
| 0x42288c / 0x4228c4 / 0x422928 | campaign helpers | remove AI / is active / add AI in a random free slot |
| 0x422991..0x422a9f | ghost list | network pending bomb actions (bombs.md §15) |
| 0x422b0f | `bomb_type_name(t)` | "regular", "trigger", "jelly" |

---------------------------------------------------------------------------------------------------------

## 15. Timing basis summary

| quantity | basis |
|---|---|
| movement, conveyor push | `speed × dt / 50`, 1 px per 100 units |
| walk animation | 1 state per 3 movement steps (also blocked steps) |
| stand animation counter | +1 per frame (stand sequences have 1 state) |
| special anims (kick, punch, pickup, stun spin, trampoline, warp, cornerhead), death anim, angel rise | 1 state per 50 ms of `dt` (accumulators) |
| disease duration, invulnerability, round freeze (1000 ms), true colours (2000 ms), ice delay | ms (`dt`) |
| head-hit stun (16), disease freshness (V129 = 10), goldman sparkle states, taunt test at death state 25 | **per frame** |
| input history ring | 30 entries per frame, ages in ms |

The per-frame items depend on the real frame rate of the original (engine doc). At the nominal 20 fps they equal
reference frames (stun 800 ms, freshness 500 ms).

---------------------------------------------------------------------------------------------------------

## 16. Uncertain

1. **Real frame rate** of the original game loop (GNW background process, no explicit limiter found here):
   determines the per-frame quantities of §15. Hypothesis: the engine doc decides; a remake should run the
   per-frame counters at 20 Hz reference frames unless the engine doc finds a fixed display rate.
2. **Hotspot placement** of player frames (offsets listed in ani_seqs.txt) and remap semantics of
   `draw_remap(…, colour)` — graphics doc. Hypothesis: frame hotspot at the anchor.
3. **Joystick axis range** (0..100 with 30/70 thresholds assumed) — engine/input doc.
4. **Warp destination when no linked warp exists** — `warp_destination` returns the same warp's cell, so the
   player spins and reappears on the same warp (extras doc).
5. `g_attract_mode` (0x464938) gating the sparkles is assumed to be the attract/demo flag (set by the main menu
   idle timer, inputs saved/restored around it). `elapsed_round_s()` (0x4105b0, returns 0x4601bc) is assumed to
   be the seconds elapsed in the round (matches the V1010 comment).
7. Sequence lengths: the loaded sequences (MASTER.ALI; `ani_find_seq` is an exact-name binary search) are
   "pickup <dir>" from PUP1–4.ANI and "punch <dir>" from PUNBOMB1–4.ANI, 10 states each. BPICKUP.ANI
   ("pickup … green", 11 states), PUNCH.ANI and BOMBWALK.ANI are **not loaded**. (bombs.md quotes 11 states
   for "pickup %s"; the loaded one has 10.)
6. The net stats message in `player_death_start` sends the **victim's** score/kills, not the killer's
   (network only, ignored).

---------------------------------------------------------------------------------------------------------

## 17. Bugs & quirks (replicate unless noted)

- **Q1 invulnerable death path**: `player_kill_attempt` returns 1 even when `player_death_start` refused (campaign
  respawn invulnerability). The caller then runs the dying code with `dying == 0` and the un-reset `walk`
  counter: the death sprite is drawn, and if `walk >= nstates` (usual after walking) the death "finishes" at
  once — powerups dropped, `alive = 0` — without kill credit or scream; in campaign the player respawns next
  frame. The same happens for every enclosement/alien kill of such a player; the enclosement loop calls
  `player_kill_attempt` 100 times on a refused (trampolining/warping/invulnerable) player, and that player
  survives inside the new wall.
- **Q2 stale held pointer**: `held` is not cleared when the holder dies (the bomb is deleted) nor at round start;
  on the next update after (re)spawning, §7.2 "throws" whatever occupies that bomb slot (harmless at round start
  — slots are cleared, the remote-throw request is a no-op locally; in campaign respawns a reused slot's live
  bomb would be teleported to the player and thrown). Also bombs.md Q8. A remake may clear `held` on death.
- **Q3 pickup animation**: the pickup state draws `pickup[(walk / 3) % 10]` (the code falls through into the
  normal-state frame lookup), and `walk` is zeroed every frame while holding → standing pickers show frame 0;
  the intended `anim_frame` is only used for timing.
- **Q4 walkbomb animation**: shows state `steps_this_frame / 3` (frame-rate dependent) because the held pass
  zeroes `walk` every frame.
- **Q5 warp overwrites home**: the warp destination is stored in `home_x/home_y`, so a campaign respawn after
  using a warp happens at the last warp destination, and the respawn's start-area clearing clears around it.
- **Q6 trampoline skip**: the landing move only happens when `anim_frame == 15` exactly; a slow frame (> 50 ms)
  that jumps over 15 skips it and the player lands back on the trampoline. Each pass of `along == -1` (e.g.
  conveyor) re-triggers and restarts the bounce.
- **Q7 taunt rolls**: the 1-in-V95 taunt is rolled every frame while the death state equals 25 (several rolls at
  high frame rates).
- **Q8 negative accumulator**: walking against a belt faster than the player (e.g. molasses 307 vs 450) drives
  `accum` negative without bound; after stopping on the belt the player is not carried until the debt is
  repaid. The accumulator also leaks leftovers across stops, deaths (angel) and rounds.
- **Q9 unsigned speed scaling**: `(u32)(spd*dt)/50`; with ≥ 7 clogs (only via repeated roulette prizes) `spd`
  is negative and becomes a huge positive step count.
- **Q10 trigger lost by head hit**: `player_bomb_hit_head` decrements the trigger count without
  `bombs_untrigger`, so already placed trigger bombs never tick and cannot be detonated (no trigger) until a
  flame hits them, the owner picks up a trigger again, or dies.
- **Q11 facing during alignment**: during lane correction the facing (and sprite) is the sideways correction
  direction (last step of the frame).
- **Q12 punch animation without bomb** (bombs.md Q21); **spooge silent** (bombs.md Q18).
- **Q13 trigger allowance**: `trigger_used` is never given back → exactly N trigger bombs per trigger pickup
  (N = bomb capacity at drop time); after that bombs are timed (bombs.md Q23).
- **Q14 double alive count** on the frame a player is killed (counted before the flame test and again by the
  dying code).
- **Q15 ice ring cap**: at frame rates above ~120 fps the 250 ms delay is truncated to 29 frames.
- **Q16 kick re-test**: the kick is attempted in every pixel step while centred against the bomb, i.e. a bomb is
  re-kicked as long as it is still in the adjacent cell.
- **Q17 invalid state**: `anim` values 8..19 or ≥ 40 are a fatal error ("invalid special_animno"); only the
  states listed in §8.2 are ever set.
- **Q18 V121 / V122 / V137** have no effect (time limit always on, recycle branch empty, swap has no duration).
- **Q19 diseases 9–11** (leprosy, invisible, duds) exist only as sound/message ids; they are never given and have
  no code.
- **Q20 suicide**: costs a kill unless "win matches by kill total" is on (then free) — note the inversion.
- **Q21 start area**: the start cell is cleared even if it is solid; the 4 neighbours only if not solid.
- **Q22 head hit overrides any special state**: `anim = 3` replaces a running warp (6/7 — the teleport never
  happens, but `home` already holds the destination), trampoline bounce (5 — the player drops back instantly,
  no landing move), pickup pause, kick/punch/cornerhead. The player is then no longer immune.
