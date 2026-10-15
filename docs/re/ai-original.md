# Original computer player (AI): ai.c / search.c, plus campaign aliens

Scope: the computer-player logic of BM95.EXE: search.c (0x40902a-0x40a0fd), ai.c (0x40a0fe-0x40be01), the danger
("influence") map it reads, campaign ghosts and rovers (aliens.c 0x4017fa-0x40200b), and the switch of a lost network
player to AI. The source file names come from the debug strings `"search.c"` (0x458b34) and `"ai.c"` (0x458b71).

Method: Ghidra hid most of ai.c. Seven of the eight strategy functions are in gaps Ghidra never turned into functions.
They are reached only through a function-pointer table, and their EDX/EBX/ECX arguments were missing. I created those
functions and set the Watcom register-argument counts (argument registers saved to the frame at entry), then
decompiled them again (scratch output `re/ai_work/out/decomp_annotated.c`). I checked every claim below against the
disassembly from `bmdisasm.py`.

Notation:
- `DX = {0, 1, 0, -1}` and `DY = {-1, 0, 1, 0}` (tables at 0x45becc / 0x45bedc). Directions: 0 = N (up), 1 = E,
  2 = S, 3 = W.
- `W = 15`, `H = 11` (grid size, 0x4648ac / 0x4648b4). `REF = 50` ms (0x46494c = 1000/V30).
- `dt` = milliseconds since the previous rendered frame, capped at V31 = 150 (0x464958).
- `rand()` = Watcom LCG (0x45190a): `s = s*1103515245 + 12345; return (s >> 16) & 0x7fff`.
  `rand() % n` always gives a value in `0..n-1`.
- `P` = the player struct (0x98 bytes, `players[i]` at 0x461bc4 + i*0x98). `A` = the AI state of that player (see §9).
- Helper names follow the other RE docs (bombs / flames-map-powerups):
  - `map_get(x,y)` (0x425fb9): 0 empty, 1 solid, 2 brick; 1 when out of bounds.
  - `bomb_at` (0x422e48): an active bomb in the cell, ignoring FLYING (2) and HELD (3) bombs.
  - `powerup_at` (0x42542d): state != 0; 1 = hidden under a brick, 2 = visible.
  - `flame_at` (0x42708d).
  - `player_at` (0x421cb5): first player slot with state != 0 and not dying.
  - `bombs_count_owned` (0x4245da): counts flying and held bombs too.
  - `danger_get` / `danger_raise` (0x424d37 / 0x424dfe). names.txt had these two swapped, as `maybe_influence_set` /
    `maybe_influence_get`.
  - `cellX(px)` / `cellY(py)` (0x42665c / 0x4266a3): pixel position to cell.

---------------------------------------------------------------------------------------------------------------------

## 1. How an AI player produces its input

### 1.1 It uses the same input fields as a human

In `player_update` (0x41f29b, named player_update_anim in names.txt), each player's input goes through the same five
fields, whatever the controller:

| field | meaning |
|---|---|
| `+0x2e` short `dir_in` | wanted direction 0..3, or -1 = no direction |
| `+0x38` byte `btn1` | action 1 (bomb) held this frame |
| `+0x39` byte `btn2` | action 2 (special) held this frame |
| `+0x36` byte `btn1_prev` | `btn1` of the previous frame (press = `btn1 && !btn1_prev`) |
| `+0x37` byte `btn2_prev` | `btn2` of the previous frame |

Order inside `player_update`, for every living player that is not dying, once per rendered frame:

```
P.btn1_prev = P.btn1; P.btn2_prev = P.btn2      // 0x41f871
P.btn1 = 0; P.btn2 = 0; P.dir_in = -1           // 0x41f889..0x41f89a
can_input = 1
if P.stun(+0x3a) > 0: can_input = 0; P.stun--       // e.g. hit on the head by a bomb
if P.anim_state(+0x4e) in {5,6,7}: can_input = 0     // trampoline / warp / similar special animations
if P.anim_state == 4 and P.anim_frame(+0x50) <= V665: can_input = 0; P.btn1 = 1   // bomb pick-up pause, button forced held
if can_input and g_round_start_freeze_ms(0x4621e0) == 0:
    if P.controller(+0x10) == 1:  campaign_ai_heartbeat(); ai_think(index, P)   // AI
    else:                         you_getinput(P)                               // 2 keyboard, 3 joystick, 4 network
... then the direction is applied (facing = dir_in), the player moves, and the button actions run
```

- `ai_think` is never called for a human, and `you_getinput` (0x41e61e) is never called for an AI.
- `you_getinput` has a `case 1:` that sets nothing, so it would be harmless for an AI.
- The AI writes `dir_in`, `btn1` and `btn2` directly, so movement, bomb dropping, punching, grabbing and so on use
  exactly the same player code as for a human. The AI never moves the player, places bombs or calls an action routine
  itself.
- The direction written by `ai_think` is applied in the same frame: `facing(+0x2c) = dir_in` happens before movement
  and before the button actions.
- `g_round_start_freeze_ms` is set to `V30 * REF = 1000` ms at round start (players round setup 0x4214bc, called
  from `maybe_level_load`) and counts down by `dt` in `players_update_all`. Nobody, human or AI, gets input during the
  first second of a round.

### 1.2 What the AI can do that a human cannot

1. **Forced fresh press.** To drop, pick up or punch, the AI also clears `btn1_prev` or `btn2_prev` (sets them to 0).
   That guarantees a press edge even if the button was "held" the previous frame. A human must release between
   presses. In practice this rarely matters, because the conditions that trigger a press are false on the next frame.
2. **The reverse-controls disease is ignored.** The direction is flipped (`dir_in = (dir_in+2)&3`, disease byte
   +0x8c) only `if controller != 1`.
3. **The ice input delay is ignored.** On levels with V450+level != 0 (V452 = 250 ms, hockey rink), human directions
   go through a 30-entry delay queue (`DAT_004621c8`) only `if controller != 1`. The AI reacts instantly.
4. Diseases still affect the AI through the player code: speed, short flame, "poops" forced dropping, constipation
   (no dropping), fast fuse, swap.

### 1.3 Decision frequency

- `ai_think` runs **once per rendered frame** (one `game_frame` step) for every AI player that can take input.
- Nothing is cached between frames apart from the AI state struct (§9). All searches are redone every frame.
- **Every probability below is a chance per frame.** The original therefore plays more aggressively at higher frame
  rates (see Bugs & quirks).
- Timers are scaled by time. The 500 ms chase limits use `dt`.
- The designers' nominal rate is V30 = 20 fps. For a faithful "classic" mode, evaluate `ai_think` at a fixed 20 Hz
  (every 50 ms of game time) and keep the timers in ms. This is my recommendation, not something the binary dictates;
  the real frame rate is the engine doc's subject.

### 1.4 Order within a frame (what the AI sees)

`game_frame` (0x42a191) calls, in this order:
1. `bombs_update_free` (`bombs_update(0)`, 0x4245b9)
2. power-ups update
3. 0x41b961
4. `flames_update` (0x426d06)
5. `map_update` (0x426818, includes the enclosement)
6. `players_update_all` (0x420f07). Players are updated in slot order 0..9, and the AI thinks inside each player's
   update.
7. campaign update (only in campaign mode)
8. `bombs_update_held` (`bombs_update(1)`, 0x42459a)

So when an AI thinks:
- The danger map holds this frame's values from free bombs, flames and the enclosement warning (§3).
- Bombs dropped earlier in the same frame by lower-numbered players are visible as bombs (`bomb_at`). The blocked grid
  may not include them (§4.1). Their danger entries only appear in the next frame.

---------------------------------------------------------------------------------------------------------------------

## 2. ai_think (0x40a1c6)

Arguments: EAX = player index (0..9), EDX = player pointer. The index is `(P - 0x461bc4) / 0x98`.

```
ai_think(i, P):
  free(malloc(rand()%1000 + 100))          // debug heap exercise, no effect (consumes 1 rand)
  ai_blocked_rebuild()                     // §4.1, at most once per frame
  if i < 0 or i >= 10: return
  A = g_ai_cur(0x45ed70) = &g_ai_states[i]        // 0x44-byte struct, §9
  A.cellX = cellX(P.x); A.cellY = cellY(P.y)      // +0x30, +0x32
  A.offX = px_offset_x(P.x); A.offY = px_offset_y(P.y)      // +0x28, +0x2a (only used by dead code)
  f = P.facing & 3
  A.along = A.offX*DX[f] + A.offY*DY[f]           // +0x2c (dead code only)
  A.perp  = A.offY*DX[f] - A.offX*DY[f]           // +0x2e (dead code only)
  if P.x < 0 or P.y < 0 or A.cellX < 0 or A.cellY < 0: fatal(0x69) "player %u offscreen at %d, %d!"
  if A.personality != 0: fatal(0x69) "unknown AI personality type: %u"
  table = g_ai_strategies_p0 (0x45ba78)
  for k = 0 ..:                            // stops at the first strategy that returns non-zero
      if table[k] == NULL: break
      if table[k](P) != 0: break
  A.cellX = cellX(P.x); A.cellY = cellY(P.y); offscreen check again (fatal)
  free(malloc(rand()%1000 + 100))          // consumes 1 more rand
```

Strategy table (personality 0), tried in priority order:

| # | function | name | returns 1 (stop thinking) when |
|---|---|---|---|
| 1 | 0x40bd44 | grab/throw | it releases a held bomb, or picks up its own bomb (50%) |
| 2 | 0x40be02 | punch | 25% roll and a bomb is next to it |
| 3 | 0x40b20f | flee | it is in danger and moving or holding still on purpose, or it is safe but has no free-and-safe neighbour |
| 4 | 0x40ad8d | blast bricks | it drops a bomb next to a brick (1/V915) |
| 5 | 0x40abed | attack | it drops a bomb next to an enemy (1/5) |
| 6 | 0x40baf5 | go for power-up | a power-up chase is active |
| 7 | 0x40b8c2 | chase player | a player chase is active |
| 8 | 0x40a81f | wander | the cell ahead is free and safe |

- In the pseudo-code below, `cx, cy` = `A.cellX, A.cellY` (the cell from the start of `ai_think`).
- If no strategy writes `dir_in`, it stays -1 and the AI stands still that frame.
- **Personalities.** `ai_round_reset` (0x40a140) runs at the start of every round (from the round setup 0x410f81). It
  zeroes all 10 states (0x2a8 bytes) and sets `A.personality = rand() % (V900 < 2 ? 1 : V900)`, which costs
  10 rand() calls. With V900 = 1 every AI has personality 0, the only one implemented. Setting V900 > 1 makes the
  game crash with "unknown AI personality type" the first time such an AI thinks.
- There are no difficulty levels. The .CAM campaign files have an "AI difficulty (0-100)" column; it is parsed into
  campaign entry +0x6c but never used ("unused at present", says the file header).

---------------------------------------------------------------------------------------------------------------------

## 3. The danger map ("influence"): what "danger" means to the AI

`g_danger` (0x4621f4) is an int array of `W*H` entries, index `x + W*y`. It is allocated in `bombs_init` with byte size
`g_danger_bytes = W*4*H` (0x462204).

```
danger_get(x,y)     = in_bounds(x,y) ? g_danger[x+W*y] : 0          // 0x424d37
danger_raise(x,y,v) : if in_bounds(x,y) and g_danger[x+W*y] < v: g_danger[x+W*y] = v   // 0x424dfe
```

The bounds check compares the index with the byte size (4x too large). Out-of-range coordinates are rejected earlier,
so this is harmless.

### 3.1 Construction, once per frame

1. **Clear.** `bombs_update(0)` zeroes the whole map when `g_frame_counter` (0x464994, +1 per `game_frame`) differs
   from the counter it saw last time (0x462210). That happens at the start of every frame.
2. **Bombs** (in `bombs_update(0)`). This covers every active bomb with no holder (`bomb+0x94 == 0`): resting,
   sliding, flying, dud and trigger bombs. Each one is marked after this frame's fuse update, unless it just
   exploded:
   ```
   v = (short)bomb.elapsed(+0x44) + 100            // elapsed starts at -delay*50, counts up by dt; explodes at fuse(+0x4a)
   bx, by = cellX(bomb.x), cellY(bomb.y)
   danger_raise(bx, by, v)
   for d in 0..3:
     x, y = bx, by
     for k in 1..bomb.flame_len(+0x4c):              // byte; goldflame bombs have max(W,H)
       x += DX[d]; y += DY[d]
       if map_get(x,y) != 0 or bomb_at(x,y): break   // walls/bricks/other bombs stop it (the brick cell is not marked)
       danger_raise(x, y, v)
       if powerup_at(x,y): break                     // the power-up cell is marked, then stop
   ```
   With the default fuse (V41 = 40 ref frames = 2000 ms), a fresh bomb is worth 100 and rises to about 2100 just
   before it explodes. A trigger bomb's timer does not run, so it stays at 100. A dud's timer is frozen.
3. **Flames.** Each frame, `flames_update` calls `danger_raise(x, y, 1000)` for every live flame entry except kind 9
   (burning brick). `flame_spawn` (0x426fcc) also raises 1000 the moment a flame is created, so flames from bombs that
   explode in this frame's bomb pass are already visible.
4. **Enclosement warning** (`map_update`, while the closing-in spiral runs, V910 = 15). The spiral is simulated V910
   steps ahead with the same stepping rule as the falling blocks. The k-th simulated position (k = 0..14) gets
   `danger_raise(.., V910*10 + 100 - 10k)`, i.e. 250, 240, ..., 110. The first simulated step is `X+dx[dir]`, so
   **the cell the next block will hit is not marked**, except when a turn keeps the first step in place. See
   flames-map-powerups.md §4.4.

The AI never sees:
- **held bombs.** They are marked in `bombs_update(1)`, after the players, and the map is cleared before the next
  players update.
- **a bomb's chain reaction.** A blast line stops before the next bomb, so the second bomb's area only gets its own,
  usually lower, timer value.
- **delayed spooge bombs.** They start at `elapsed = -50*k`, so `v = 100 - 50k` is negative for k >= 3. `danger_raise`
  never writes a value below the current 0, so those cells look safe until enough time has passed.

The AI uses the map in only three ways:
1. `danger == 0` means safe. This is used everywhere.
2. The flee search looks for the lowest value when no safe cell can be reached.
3. Flee compares the value of its current cell with the target cell's value.

Nothing compares the time left before an explosion with the time needed to walk somewhere.

---------------------------------------------------------------------------------------------------------------------

## 4. Search (search.c): the "walker" flood fill

### 4.1 Grids

| global | layout | content |
|---|---|---|
| `g_ai_blocked` 0x45e724 | `int[20][20]`, index `x*20 + y` (column stride 0x50) | 1 if `map_get(x,y) != 0` or `bomb_at(x,y)`, else 0 |
| `g_search_visited` 0x45e0e4 | same layout | copy of blocked at search start; visited cells get `first + 10` |

- `ai_blocked_rebuild` (0x4090e7) runs at the start of every `ai_think`. It rebuilds the blocked grid only when
  `g_frame_counter != g_ai_blocked_tick` (0x45ed74), so the first AI to think in a frame builds it for everyone. A bomb
  dropped later in the same frame by an earlier player slot is missing from the grid until the next frame.
- `search_visited_get(x,y)` (0x409083) returns 1 outside `[0,W) x [0,H)`.
- `search_visited_set` (0x40902a) ignores coordinates outside that range.
- The grid ignores players, flames, danger, power-ups, extras (warps, trampolines, conveyors), flying bombs and held
  bombs.

### 4.2 Walkers

Pool: `g_search_walkers` (0x45ed68), 100 entries of 24 bytes, allocated by `search_init` (0x409264):

```
struct walker { int active; int x; int y; int first; int dir; int state; }
// first = initial direction + 1 (1..4): the answer of the search
// state: 1 = new (no stale test), 2 = created later in the pool during this pass (skip once), 0 = normal
```

`search_walker_alloc` (0x4091c9) returns the first slot with `active == 0`, zeroed. Slots freed earlier in the same
pass are reused immediately.

### 4.3 Generic algorithm (identical control flow in all three searches)

```
search(sx, sy, maxIter, GOAL):
  turn = (rand()%2)*2 - 1                 // +1 or -1, order in which the two side clones are tried
  visited = copy(blocked)                 // memcpy 0x640 bytes
  [search_path only:]  if (sx,sy) == (tx,ty): return dir1=0, iters=0, maxW=0   (rand already drawn)
  all walkers.active = 0 (each slot memset)
  for d in 0..3:
    if visited(sx+DX[d], sy+DY[d]) == 0:
      w = alloc()  (NULL -> fatal(0x69) "can't make initial 4 walks!")
      *w = {1, sx+DX[d], sy+DY[d], d+1, d, 1}         // initial walkers are NOT marked visited
  iters = 0; maxW = 0
  do:
    count = 0
    for slot = 0..99:                                 // fixed slot order
      w = &walkers[slot]
      if !w.active: continue
      count++
      if w.state == 2: w.state = 1; continue
      stale = (w.state == 0) and visited(w.x, w.y) != 0
      w.state = 0
      if visited(w.x, w.y) == 0: GOAL_TEST(w.x, w.y)          // "top" test
      if !stale: visited[w.x][w.y] = w.first + 10
      for s in (-1, +1):                                       // side clones
        nd = (s*turn + w.dir) & 3; nx = w.x+DX[nd]; ny = w.y+DY[nd]
        if visited(nx,ny) == 0: GOAL_TEST(nx, ny)              // * see powerup variant
        if visited(nx,ny) == 0:
          c = alloc()  (NULL -> fatal(10) "can't clone to the side")
          count++
          *c = {1, nx, ny, w.first, nd, (c > w ? 2 : 1)}       // compares pool addresses
          visited[nx][ny] = w.first + 10
      nx = w.x+DX[w.dir]; ny = w.y+DY[w.dir]                   // forward
      if visited(nx,ny) == 0: GOAL_TEST(nx, ny)                // * see powerup variant
      if stale or visited(nx,ny) != 0: w.active = 0
      w.x = nx; w.y = ny                                       // moves even when it just died
    maxW = max(maxW, count)
    iters++
    if iters > maxIter: count = 0
  while count != 0
  -> NOT FOUND
```

- A goal found "inside" a pass returns at once. `iters` then equals the 0-based index of that pass.
- In pass k, walkers stand on cells at path distance k+1 from the start, and their sides and forward cells are at
  distance k+2.
- So `iters == 0` on success means the goal was at path distance 1 or 2 (or the start equals the target).
- With `maxIter = 20` the search covers at most 21 passes, i.e. paths of up to 22 steps.
- It is not an exact BFS. Walkers advance in lock-step, but the slot order breaks ties.
- To reproduce the original choices (which neighbour wins at equal distance), copy this algorithm exactly, including
  the slot reuse, the `state == 2` rule and the random `turn`.

### 4.4 The three goal tests

| function | args (EAX, EDX, EBX, ECX, then stack) | GOAL_TEST(x,y) | result |
|---|---|---|---|
| `search_path` 0x4092a1 | sx, sy, tx, ty, maxIter, *dir1, *iters, *maxW | `(x,y) == (tx,ty)` -> return `first` | `dir1` = first step + 1, 0 if not found |
| `search_safest` 0x40970b | sx, sy, maxIter, *dir1, *iters, *maxW, *bx, *by | `v = danger_get(x,y)`; if `v < best`: best = (x, y, first, v); if `v == 0` return `first` | if no zero cell: `dir1` = best.first (0 if nothing was ever evaluated); `(bx,by)` = best cell (start cell if none) |
| `search_powerup` 0x409c1f | sx, sy, maxIter, *dir1, *iters, *maxW, *power | `p = powerup_at(...)`; if `p` return (`first`, `p`) | `*power` = entry or NULL |

- For `search_safest`, `best` starts at value 10000, cell = start, first = 0.
- **Powerup variant bug.** In the side and forward tests (the `*` lines), `search_powerup` calls
  `powerup_at(w.x, w.y)`, the walker's own cell, instead of `(nx, ny)`. New cells are tested only when they become a
  walker's cell at the top of a later pass, and clone cells are already marked visited at that point. So a clone's
  cell is tested only if it has at least one open side or forward neighbour.
  - Result: power-ups in dead-end side pockets are never found.
  - The goal accepts any non-zero power-up state, so hidden ones count too, but those lie under bricks and are never
    reached.

---------------------------------------------------------------------------------------------------------------------

## 5. The strategies, with exact pseudo-code

Two helpers:

```
free_and_safe(x,y)  (0x40a59d) = !bomb_at(x,y) && map_get(x,y)==0 && !flame_at(x,y) && danger_get(x,y)==0
can_drop_here(x,y)  (0x423188 bomb_cell_free_ai) = !bomb_at(x,y) && !(extra_at(x,y) && extra.type==1 /*warp*/) && map_get(x,y)==0

cancel_if_flame(P)  (0x40a76e):
  if 0 <= P.dir_in <= 3 and flame_at(cx+DX[P.dir_in], cy+DY[P.dir_in]):
     A.mode = 0; A.mode_dir = -1; P.dir_in = -1
```

`can_drop_here` is the same test the player code applies when dropping. It is **not an escape check**.

### 5.1 Grab and throw (priority 1, 0x40bd44)

```
if P.grab(+0x5c) == 0: return 0
if P.held_bomb(+0x94) != NULL:              // carrying a bomb
   P.btn1 = 0; P.btn1_prev = 0; return 1    // button up -> the player code throws it along P.facing
b = bomb_at(cx, cy)
if b and b.owner(+0x3e) == P.index(+0x3e) and rand()%2 != 0:
   P.btn1 = 1; P.btn1_prev = 0; return 1    // fresh press on own bomb -> pick-up (grab wins over spooge)
return 0
```

The effect: an AI with the grab glove that is standing on the bomb it just dropped picks it up with 50% chance per
frame. After the pick-up pause (`anim_state 4`, button forced held), it throws the bomb straight away along its facing
direction, i.e. the way it was walking.

### 5.2 Punch (priority 2, 0x40be02)

```
if P.punch(+0x5b) == 0: return 0
if rand()%4 != 0: return 0
for d in 0..3:
   if bomb_at(cx+DX[d], cy+DY[d]):          // any bomb (own or enemy), any timer, not flying or held
      P.dir_in = d; P.btn2 = 1; P.btn2_prev = 0; return 1
return 0
```

- The player code punches the bomb in the facing cell. Facing equals `dir_in` in the same frame, so the AI punches
  that bomb.
- The same button-2 press also stops the player's kicked bombs if it has kick, and detonates its oldest trigger bomb
  if it has trigger. All of that is player/bomb code.
- Punch runs before flee, so a threatened AI may spend frames punching instead of running.

### 5.3 Flee from danger (priority 3, 0x40b20f), including trigger detonation

```
if danger_get(cx,cy) == 0:                               // currently safe
   if P.trigger(+0x5f) and !P.punch(+0x5b) and rand()%10 == 0:
       P.btn2 = 1                                       // detonate oldest trigger bomb (no forced edge)
   for d in 0..3:
       if free_and_safe(cx+DX[d], cy+DY[d]): A.flee = 0; return 0   // let lower strategies act
   A.flee = 0; return 1                                 // no free and safe neighbour: hold still
// in danger
if A.flee and A.flee_val == 0 and danger_get(A.flee_x, A.flee_y) != 0:
   A.flee = 0                                           // the chosen safe cell has become dangerous: re-plan
if A.flee:
   (d1, it) = search_path(cx, cy, A.flee_x, A.flee_y, 20)
   if d1 == 0: A.flee = 0; return 0
   P.dir_in = d1 - 1; cancel_if_flame(P); return P.dir_in != -1
(d1, bx, by) = search_safest(cx, cy, 20)
if d1 == 0: A.flee = 0; return 0                        // nothing reachable: fall through to the others
A.flee = 1
if danger_get(cx,cy) > danger_get(bx,by):
   A.flee_x = bx; A.flee_y = by; A.flee_val = danger_get(bx,by)
   P.dir_in = d1 - 1; cancel_if_flame(P); return P.dir_in != -1
A.flee_x = cx; A.flee_y = cy                            // flee_val is NOT updated (stale)
P.dir_in = -1; return 1                                 // the best reachable cell is no better: stand still
```

- The route to the flee target is a plain walker path. It ignores danger along the way. The only safety check is
  `cancel_if_flame` on the very next cell.
- When the flee returns 0 while in danger (no path, or a flame ahead), the lower strategies run. Blast bricks and
  attack may then even drop another bomb.
- The trigger use is smart in effect: drop a bomb, run until standing on a zero-danger cell, then detonate with 10%
  chance per frame. It is disabled when the AI owns a punch glove. With punch, the AI's button-2 presses (5.2) still
  detonate trigger bombs as a side effect.

### 5.4 Blast bricks (priority 4, 0x40ad8d)

```
if bombs_count_owned(P.index) >= P.bombs_max(+0x56):  { if A.mode == 9: A.mode = 0;  return 0 }
if P.disease_constipation(+0x86): return 0            // disease #2: cannot drop bombs
n = number of d in 0..3 with map_get(cx+DX[d], cy+DY[d]) == 2   // adjacent bricks
if n == 0: { if A.mode == 9: A.mode = 0;  return 0 }
if !can_drop_here(cx, cy): return 0
c = (V915 < 2) ? 1 : V915                              // V915 = 5
if rand() % c == 0:
   P.btn1_prev = 0; P.btn1 = 1; A.mode = 9; return 1   // drop (mode 9 is only a marker)
return 0
```

This only runs when flee returned 0, i.e. the AI's cell is safe and at least one neighbour is free and safe. That is
the whole "escape check" before dropping a bomb (§11).

### 5.5 Attack (priority 5, 0x40abed)

```
if bombs_count_owned(P.index) >= P.bombs_max: return 0
if |cx - cellX(P.home_x(+0x14))| + |cy - cellY(P.home_y(+0x18))| < 3: return 0   // not near start/warp point
for i in 0..4:                                         // offsets (-1,0) (0,-1) (0,0) (0,1) (1,0)   (0x45bab0/0x45ba9c)
   save = P.state; P.state = 0                         // hide self from player_at
   q = player_at(cx + ODX[i], cy + ODY[i])
   P.state = save
   if q:
      if team_game(0x464964) and q.team(+0x54) == P.team: return 0   // first player found is a teammate: give up
      if !can_drop_here(cx, cy): return 0
      if rand()%5 == 0: P.btn1_prev = 0; P.btn1 = 1; return 1        // 1/5 is hard-coded, not V915
      return 0
return 0
```

- `+0x14/+0x18` hold the respawn point, which is also overwritten with the exit of the last warp hole used (player
  movement code).
- Players in the AI's own cell count as targets.
- Constipation is not checked. A constipated AI still "presses" (returns 1) and therefore stands still on those frames.

### 5.6 Go for a power-up (priority 6, 0x40baf5)

```
if !A.pu_active and rand()%50 == 0:
   (d1, it, pu) = search_powerup(cx, cy, V920)        // V920 = 4 -> path distance <= 5
   if pu != NULL and it <= V920 + 1:                   // always true when found
      A.pu_active = 1; A.chase_timer(+0x0c) = 0 /* BUG: should be pu_timer +0x1c */; A.pu_target = pu
if !A.pu_active: return 0
A.pu_timer(+0x1c) += dt
if A.pu_timer >= 10*REF (500 ms): A.pu_active = 0; return 0
pu = A.pu_target
if pu == NULL or pu.state != 2: A.pu_active = 0; return 0      // gone, or no longer visible
(d1, it) = search_path(cx, cy, pu.x(+0x1c, cell), pu.y(+0x20, cell), V920 + 1)
if it == 0 and rand()%2 != 0: A.pu_active = 0           // within distance 2: 50% chance to end the chase (still moves now)
if d1 == 0: A.pu_active = 0; return 0
A.pu_dir = d1 - 1
P.dir_in = free_and_safe(cx+DX[A.pu_dir&3], cy+DY[A.pu_dir&3]) ? A.pu_dir : -1   // wait rather than enter danger
return 1
```

- The power-up type is never checked, so the AI walks into skulls (diseases) just as readily.
- Because of the timer bug (Bugs & quirks #1), deliberate power-up hunting gets 500 ms of chasing per round in total.
  After that, every new chase is dropped on the frame it starts. The AI still picks up power-ups by walking over
  them.

### 5.7 Chase a player (priority 7, 0x40b8c2)

```
if !A.chase_active and rand()%50 == 0 and (t = ai_pick_chase_target(P)) != NULL:
   A.chase_active = 1; A.chase_timer = 0; A.chase_target = t
if !A.chase_active: return 0
A.chase_timer += dt
if A.chase_timer >= 500 and rand()%50 == 0: A.chase_active = 0; return 0
t = A.chase_target
if t == NULL: A.chase_active = 0; return 0
if t.dying(+0x08) != 0 or t.state(+0x00) != 1: A.chase_active = 0; return 0
(d1, it) = search_path(cx, cy, cellX(t.x), cellY(t.y), 20)
if it == 0 and rand()%2 != 0: A.chase_active = 0        // target within path distance 2 (or same cell)
if d1 == 0: A.chase_active = 0; return 0                 // unreachable (e.g. target standing on a bomb) or same cell
A.chase_dir = d1 - 1
P.dir_in = free_and_safe(cx+DX[A.chase_dir&3], cy+DY[A.chase_dir&3]) ? A.chase_dir : -1
return 1
```

`ai_pick_chase_target` (0x422718) prefers humans and starts at a random slot. It does not look for the nearest player.

```
r = rand()%10
for k in 0..9: q = players[(r+k)%10]
   if q != P and q.controller not in {0,1} and q.state != 0 and !q.dying
      and (!team_game or q.team != P.team): return q        // keyboard, joystick or network players first
r = rand()%10                                                // second draw only if the first pass failed
for k in 0..9: q = players[(r+k)%10]
   if q != P and q.controller != 0 and q.state != 0 and !q.dying
      and (!team_game or q.team != P.team): return q        // then anyone, AIs included
return NULL
```

Typical rhythm:
- A chase starts after 50 frames on average.
- It lasts at least 500 ms, then ends with 1/50 chance per frame. Getting within path distance 2 of the target also
  gives a 50% chance per frame of ending.
- Combined with attack (enemy at most 1 cell away, 1/5 per frame), this is the AI's only offence.

### 5.8 Wander (priority 8, 0x40a81f)

```
if rand()%25 == 0:
   nd = (A.wdir + (rand()%2)*2 - 1) & 3                  // turn left or right
   if free_and_safe(cx+DX[A.wdir&3], cy+DY[A.wdir&3]):   // tests the OLD direction, not nd
       A.wdir = nd
if free_and_safe(cx+DX[A.wdir&3], cy+DY[A.wdir&3]):
   P.dir_in = A.wdir; return 1
A.wdir = rand()%4; return 0                              // blocked: new random direction next frame, stand still now
```

Wander gives straight runs with an occasional 90 degree turn (4% per frame, only while the way ahead is clear). When
blocked, the AI stands still for one frame per retry. It never steps onto a cell with danger, a bomb or a flame.

---------------------------------------------------------------------------------------------------------------------

## 6. Power-ups and situations the AI handles

| power-up | AI use |
|---|---|
| bombs (+0x56) | `bombs_count_owned < bombs_max` gates blast-bricks and attack |
| flame length | only indirectly: its own bombs' danger area is longer |
| kick (+0x59) | **never on purpose.** Path, chase and wander never point at a bomb cell. Kicks happen only by accident, mainly when the punch strategy turns the AI toward an adjacent bomb: the movement code (which runs before the button actions) kicks it if the AI is centred. A button-2 press with kick also stops its kicked bombs. |
| punch (+0x5b) | 5.2: punches any adjacent bomb (25% per frame). Also blocks the deliberate trigger use. |
| grab (+0x5c) | 5.1: picks up its own bomb from under itself (50% per frame) and throws it at once |
| spooge (+0x5d) | **never used.** The AI only presses button 1 where it can drop (no bomb in the cell), or with grab (grab has priority). |
| trigger (+0x5f) | 5.3: detonates (oldest bomb first) when standing on a safe cell, 10% per frame, only without punch |
| jelly, goldflame, skates | no special handling (goldflame just widens its danger lines) |
| diseases | it collects them like any power-up (5.6). Constipation is checked by blast-bricks only. Reverse controls and ice delay do not affect AIs. |
| extras | warps, trampolines and conveyors are ordinary passable cells to the search. The AI walks onto warps and trampolines without intending to. `can_drop_here` refuses warp cells. Conveyors are ignored. |

---------------------------------------------------------------------------------------------------------------------

## 7. All random draws (per `ai_think`, in call order)

| where | expression | effect |
|---|---|---|
| ai_think start / end | `rand()%1000` (twice) | debug malloc size, no effect |
| each search call | `rand()%2` | side-clone order `turn` |
| grab | `rand()%2 != 0` | pick up own bomb (50%) |
| punch | `rand()%4 == 0` | try to punch (25%) |
| flee (safe branch) | `rand()%10 == 0` | trigger detonation (10%), only if trigger and no punch |
| blast bricks | `rand()%max(1,V915) == 0` | drop (20%) |
| attack | `rand()%5 == 0` | drop (20%) |
| power-up | `rand()%50 == 0` | start a search (2%), only while not active |
| power-up | `rand()%2 != 0` | end the chase when the search result has `iters == 0` |
| chase | `rand()%50 == 0` | start (2%), only while not active, then `rand()%10` once or twice for the target |
| chase | `rand()%50 == 0` | end after 500 ms (2%) |
| chase | `rand()%2 != 0` | end when `iters == 0` |
| wander | `rand()%25 == 0`, then `rand()%2` | turn check (4%), left or right |
| wander | `rand()%4` | new direction when blocked |
| round start | `rand()%max(1,V900)` x 10 | personalities (always 0) |

C short-circuit order applies, so a draw happens only when its earlier conditions pass. The RNG is shared with the
rest of the game. Copying the draw order only matters for a bit-exact replay, which is not expected.

---------------------------------------------------------------------------------------------------------------------

## 8. Constants used

| value | source | use |
|---|---|---|
| V900 = 1 | VALUELST | number of personalities. Only 0 exists; values > 1 crash. |
| V910 = 15 | VALUELST | cells of enclosement look-ahead, danger 250..110 |
| V915 = 5 | VALUELST | blast-bricks chance 1/5 |
| V920 = 4 | VALUELST | power-up search passes (path distance <= 5); power-up path search limit V920+1 |
| 20 | hard-coded | `maxIter` of flee, safest-cell and chase searches |
| 100 walkers | hard-coded | search pool; overflow is fatal (code 10) |
| 1/2, 1/4, 1/5, 1/10, 1/25, 1/50 | hard-coded | see §7 |
| `10*REF` = 500 ms | hard-coded multiplier x V30 | chase and power-up time limits |
| 3 | hard-coded | attack disabled while Manhattan distance to the respawn/warp point is < 3 |
| 100 + elapsed, 1000, 250-10k | bombs / flames / map_update | danger values (§3) |

---------------------------------------------------------------------------------------------------------------------

## 9. Data structures

### 9.1 AI state, `g_ai_states` (0x45ed6c -> 10 x 0x44 bytes, index = player slot)

Allocated by `ai_init` (0x40a0fe, from `game_init`) and zeroed every round by `ai_round_reset`. `g_ai_cur` (0x45ed70)
points to the entry of the player currently thinking.

| off | type | name | used by |
|---|---|---|---|
| 0x00 | short | personality | ai_think (must be 0) |
| 0x02 | short | flee (target valid) | flee |
| 0x04 | short | flee_x | flee |
| 0x06 | short | flee_y | flee |
| 0x08 | short | flee_val (danger of the target when chosen) | flee |
| 0x0a | short | chase_active | chase |
| 0x0c | uint | chase_timer (ms) | chase; also wrongly reset by the power-up start |
| 0x10 | ptr | chase_target (player*) | chase |
| 0x14 | int | chase_dir | chase |
| 0x18 | short | pu_active | power-up |
| 0x1c | uint | pu_timer (ms), never reset during a round | power-up |
| 0x20 | ptr | pu_target (power-up grid entry*) | power-up |
| 0x24 | int | pu_dir | power-up |
| 0x28 | short | offX = px_offset_x(P.x) | dead code |
| 0x2a | short | offY | dead code |
| 0x2c | short | along (offset along facing) | dead code |
| 0x2e | short | perp | dead code |
| 0x30 | short | cellX | all |
| 0x32 | short | cellY | all |
| 0x34 | short | mode: 0 idle, 9 bricks marker; dead code also uses 1, 2, 10, 11 | blast bricks, cancel_if_flame, dead code |
| 0x36 | short | - | unused |
| 0x38 | short | - | unused |
| 0x3a | short | mode_dir (set to -1 by cancel_if_flame) | dead code |
| 0x3c | short | mode_tx | dead code |
| 0x3e | short | mode_ty | dead code |
| 0x40 | short | wdir (wander direction) | wander |
| 0x42 | short | - | padding |

### 9.2 Other globals and tables

- Walker pool: §4.2. Grids: §4.1. Danger map: §3.
- `g_ai_strategies_p0` 0x45ba78:
  `{0x40bd44, 0x40be02, 0x40b20f, 0x40ad8d, 0x40abed, 0x40baf5, 0x40b8c2, 0x40a81f, NULL}`.
- Attack offsets: `ODX` 0x45bab0 = `{-1,0,0,0,1}`, `ODY` 0x45ba9c = `{0,-1,0,1,0}`.
- Player fields read by the AI:
  - position: `state +0x00`, `dying +0x08`, `controller +0x10`, `home_x/home_y +0x14/+0x18`, `x/y +0x1c/+0x20`,
    `facing +0x2c`, `index +0x3e`, `team +0x54`
  - power-ups and status: `bombs_max +0x56`, `punch +0x5b`, `grab +0x5c`, `trigger +0x5f`,
    `constipation +0x86`, `held_bomb +0x94`
- Player fields written by the AI: `dir_in +0x2e`, `btn1_prev +0x36`, `btn2_prev +0x37`, `btn1 +0x38`, `btn2 +0x39`,
  and `state +0x00`, which attack saves, clears and restores.

---------------------------------------------------------------------------------------------------------------------

## 10. Dead code (present but never called)

Nothing references these functions. I checked by scanning the binary for calls, jumps and absolute addresses:

- 0x40a628 "random step" (mode 1). With 1/10 chance it picks a random free and safe neighbour as target and walks there.
- 0x40a994 "random run" (mode 2). It enters with 1/10 chance and runs in a random direction. Near a cell centre
  (`|along| < 8`) it turns with 1/6 chance. When blocked it turns ±1 and leaves the mode with 1/10 chance.
- 0x40b594 "dodge bombs" (modes 10/11).
  - When standing on a bomb, it runs in the "most open" direction (0x40b046). The score counts, for up to 9 cells
    along the line, +1 per empty cell and +2 per empty side cell.
  - When a bomb is in line within 9 cells (0x40af20), it moves away from it and tries to sidestep.
  - It also contains the trigger rule of 5.3.
- 0x40a542 `!bomb_at && map_get==0`, and 0x40a4f7 (a random rotation re-rolled with `time()`), both used only by the
  above.

These look like an earlier AI that the current table replaced. They are not part of the classic behaviour.

---------------------------------------------------------------------------------------------------------------------

## 11. Behaviour summary and known weaknesses (for designing the new AIs)

What the classic AI does, roughly:
- It avoids standing in or walking into any marked blast line.
- It bombs bricks it touches (20% per frame) and enemies within one cell (20% per frame).
- It occasionally heads for the nearest few power-ups (but see the timer bug) or chases a random human.
- Otherwise it wanders in straight lines.

Weaknesses:
1. **No escape planning before dropping.** The only requirement is a safe current cell and at least one free and safe
   neighbour. In corridors and dead ends the AI often traps itself, especially with long flames or when other bombs
   close the exit.
2. **Flee does not consider timing.** The target is the first zero-danger cell found by the flood, and the route may
   cross other blast lines. It stands still when the best reachable cell is not strictly better than its own cell.
3. **Chain reactions and held bombs are invisible.** Flying bombs are not obstacles in the search grid, and their
   danger moves with them.
4. **Off-by-one in the enclosement warning.** The cell about to be filled is unmarked.
5. **Weak offence.** It never lines up shots, never kicks deliberately, never uses spooge, and only bombs when the enemy
   is in its own cell or an adjacent one. The chase target is random, not the nearest player.
6. **Power-up greed is broken** after 500 ms of chasing per round. It collects diseases too. Power-ups in dead-end
   pockets are never found.
7. **Frame-rate dependent.** All chances are per frame.
8. **Free advantages:** immune to reverse controls and ice delay; button presses on consecutive frames always count.
9. **Can get stuck.** With no free and safe neighbour it holds still, and the lower strategies (blast bricks) never run.
   An AI boxed in by bricks and bombs therefore never bombs its way out.

---------------------------------------------------------------------------------------------------------------------

## 12. Campaign enemies: ghosts and rovers (aliens.c)

Data: `g_aliens` (0x45e020), 100 entries x 0x98 bytes.

| off | meaning |
|---|---|
| +0x00 | active |
| +0x04 | type: 1 = rover, 2 = ghost |
| +0x08 | dying |
| +0x14/+0x18 | spawn pixel position |
| +0x1c/+0x20 | pixel position (same convention as players) |
| +0x2c | short direction |
| +0x30 | short animation counter |
| +0x70 | speed (1/100 px per reference frame) |
| +0x74 | movement accumulator |
| +0x92 | "spawn area cleared" flag |

**Level setup** (`campaign_level_setup` 0x40151b, data from the CAM*.RES / *.CAM line):
1. Every player slot with controller 1 is cleared (`player_slot_clear_ai` 0x42288c).
2. "number of AIs" times, a random empty slot (`rand()%10`, up to 100 tries) gets controller 1
   (`campaign_add_ai_player` 0x422928).
3. `aliens_reset` (0x401994): clears all aliens, sets `g_aliens_alive = 1` and resets the idle timer.
4. `aliens_spawn_ghosts(count, speed)` (0x401b05, type 2), then `aliens_spawn_rovers(count, speed)` (0x401aae, type 1).
   Each alien is placed by `alien_spawn` (0x4019c2): up to 200 tries of `x = rand()%W, y = rand()%H`, accepting the
   cell if `map_get != 1` and no player slot (any slot, alive or not) lies within Manhattan distance 3. It is placed at
   the cell centre with `spawn = pos`. If all tries fail, no alien is spawned.

Sample data (.CAM): ghost speeds 150-400, rover speeds 200-500, 0-20 ghosts, 0-5 rovers, 0-3 AIs.

**Update** (`campaign_update` 0x4016da, called by `game_frame` after the players in campaign mode):
`aliens_update_all` (0x401f76) updates every active alien. It sets `g_alien_cur_type` before each one, removes
entries with an invalid type, and counts living aliens into `g_aliens_alive` (0x464820). Per alien,
`alien_update` (0x401b5c, named aliens_create in names.txt):

```
if type == 1 (rover) and !cleared(+0x92): cleared = 1; clear_spawn_area(cellX(spawn_x), cellY(spawn_y))  // 0x42583b: cell + 4 neighbours
if dying: active = 0; return                       // removed one frame after being hit, no death animation
acc += (dt*speed)/REF + 100                        // unsigned division
x -= DX[dir]; y -= DY[dir]                         // step back 1 px; the first loop step re-takes it
while acc > 0:
   nx = x + DX[dir]; ny = y + DY[dir]; anim++; acc -= 100
   along = px_offset_x(nx)*DX[dir] + px_offset_y(ny)*DY[dir]
   if along == 0:                                  // exactly on the cell centre along the motion axis
      if !alien_can_enter(cellX(nx)+DX[dir], cellY(ny)+DY[dir]):
          acc = 0                                  // blocked ahead: must turn
          goto TURN
      if rand() % (V1200 < 1 ? 1 : V1200) == 0:   // V1200 = 3 -> 1/3 chance to turn at a free crossing
   TURN:  dir = (rand()%2 != 0) ? dir+1 : dir-1;  dir &= 3          // never a direct U-turn
          if !alien_can_enter(cellX(nx)+DX[dir], cellY(ny)+DY[dir]): acc = 0   // turned into a wall: wait
   c = (cellX(nx), cellY(ny))
   if flame_at(c): dying = 1; award(flame.owner(+0x3e), type==1 ? V1310 (15) : V1320 (25))
   repeat up to 11 times:                          // contact kill
      p = player_at(c); if !p: break
      if p.controller != 1: player_net_death(p, -1)   // humans and network players die; AI bombermen are immune
   x = nx; y = ny
draw "ghost <dir>" / "rover <dir>" (ALIENS1.ANI, 1 frame each, no colour remap) at (x, y)
```

`alien_can_enter(x,y)` (0x4017fa) = `!bomb_at(x,y) && (ghost ? map_get(x,y) != 1 : map_get(x,y) == 0)`. Ghosts pass
through bricks, rovers do not, and bombs block both.

Notes:
- Aliens move at random. **V1205** ("chance that the direction change will NOT be towards a human") is never read
  (no `value_get(1205)` exists), so there is no homing.
- A blocked alien stops for the frame and turns ±1 at random on each later frame until it finds a free direction.
- Aliens never look at the danger map, flames or players when choosing a direction.

**Level end** (`campaign_update`):
- The level is failed (`DAT_00464894 = 2`) when remaining time < 2 s, or when no human-controlled slot is alive. In
  the second case the level index is also decremented, so the level is retried.
- It is won (`DAT_00464894 = 1`) when `g_aliens_alive == 0` and `g_campaign_idle_ms` (0x4646c0) exceeds
  `V25 * REF * 2 = 2000` ms. The timer adds `dt` per frame while no aliens live.
- The link to the AI: `campaign_ai_heartbeat` (0x40179f) resets that timer before every `ai_think`. The level therefore
  only ends 2 s after the last AI bomberman stopped thinking (died) and the last alien died.
- AI kills in campaign award V1300 = 250 points (player death code 0x41dcb2).

---------------------------------------------------------------------------------------------------------------------

## 13. Lost network player reverting to AI

- Option `lost_net_revert_ai` in options.ini goes into `g_opt_lost_net_revert_ai` (0x464928). Menu text: MESSAGES 262
  "Lost net players revert to AIs: %s". OPTIONS.BM says that with NO the players "will be dropped out of the game
  without notice".
- When the network layer removes a node, the routine at 0x40de45 (not a Ghidra function) runs. For each of the 10
  player slots owned by that node, it calls `player_net_lost(i)` (0x4222e8):

  ```
  if !g_opt_lost_net_revert_ai or players[i].controller != 4 /*network*/:
      players[i].state = 0; players[i].controller = 0          // silently removed, no death animation
  else if net_mode_get() == 2 /*server*/:
      players[i].controller = 1; players[i].sub_controller(+0x11) = 0   // becomes an AI on the server
  // a client with the option on changes nothing locally
  ```

- From then on the server runs `ai_think` for that slot. The AI state was zeroed at round start and that slot was never
  used, so the AI starts fresh with personality 0. Its position, power-ups and bombs are kept.

---------------------------------------------------------------------------------------------------------------------

## 14. What information the classic AI used, and remake notes

**Used:**
- its own cell; its spawn/warp point; its bomb count and capacity
- punch, grab and trigger power-ups and the constipation disease; whether it holds a bomb
- map cell types; the cells of resting and sliding bombs (bomb owner only for grab)
- visible power-ups by cell (any type); flame cells
- players in its own or an adjacent cell, with team membership
- for chasing: one random enemy's cell
- the danger map (bomb areas with an "elapsed time" value, flames, the enclosement look-ahead)

**Not used:**
- individual bomb timers versus travel time
- other players' power-ups, speeds or bombs (except through the danger map)
- flying or held bombs, chain reactions
- extras and conveyors; diseases on the ground (it cannot tell them apart)
- where enemies could be trapped; line of fire for kicking or punching

**Input path for the remake.** Feed the classic AI's decisions through the same per-frame input record as a human:
`dir` (or none), `btn1` and `btn2` with edge detection. For a strict "human interface" rule, replace the forced
`*_prev = 0` with a real release. The classic AI rarely needs consecutive presses (§1.2), so this changes almost
nothing. Also decide whether the classic AI keeps its immunity to reverse controls and ice delay.

---------------------------------------------------------------------------------------------------------------------

## Uncertain

1. **Real think rate.** It equals the rendered frame rate, which the engine doc covers. Recommendation: 20 Hz for
   classic mode (V30 is the designers' nominal rate).
2. **Network ownership of AI players.** In a network game, AI players run only on the machine whose slot has
   `controller == 1`. That is most likely the server, since it assigns the controllers in the round setup at 0x410f81;
   the other machines presumably see them as controller 4. I did not trace the network messages.
3. **`home_x/home_y` (+0x14/+0x18).** I believe this is the respawn point and also the last warp exit, so the attack
   gate is relative to "where the player last appeared". The player doc should confirm who else writes these fields.
4. **Attract (demo) mode** (`DAT_00464938`) plays a round without the controller-setup screen. I did not check whether
   it forces players to AI.
5. **Powerup entry `+0x1c/+0x20`.** I took them to be cell coordinates (the AI passes them to `search_path` as cells).
   This is consistent with the per-cell power-up grid, but see flames-map-powerups.md.

## Bugs & quirks

1. **Power-up chase timer is never reset.** The start code writes `A+0x0c` (the player-chase timer) instead of
   `A+0x1c`.
   - Deliberate power-up hunting is therefore limited to 500 ms of chasing in total per round. After that, every
     restart is dropped in the same frame.
   - Starting a power-up chase also resets an ongoing player chase's timer.
   - Fix candidate: reset `+0x1c`. Faithful classic mode keeps the bug.
2. **`search_powerup` tests the walker's own cell** in the side and forward checks (§4.4). Power-ups in dead-end side
   pockets are not found.
3. **The enclosement warning skips the next block's cell** (§3.1 item 4; also found by the map doc).
4. **Gaps in the danger map:** held bombs, chain-reaction timing and delayed spooge bombs (negative values) are
   invisible (§3).
5. **Behaviour depends on the frame rate** (all chances are per frame).
6. **AIs are immune to the reverse-controls disease and to ice control delay.**
7. **Attack:**
   - uses a hard-coded 1/5 instead of V915
   - ignores constipation (the AI then idles on those frames)
   - gives up when the first player found is a teammate, even if an enemy is also adjacent
8. **Grab:** an AI with the blue glove throws its freshly dropped bombs along its facing direction (it picks them up
   with 50% chance per frame while standing on them).
9. **Flee:** when the best reachable cell is not better, the AI stands still (and may die), and the stale `flee_val`
   decides whether it re-plans next frame. When no cell is reachable while in danger, the lower strategies run, and
   blast-bricks may drop another bomb.
10. **Wander** checks the old direction's cell before turning, not the new one.
11. **V900 > 1 is fatal** ("unknown AI personality type").
12. **Each `ai_think` mallocs and frees a random-size block twice** (debug code). It has no effect except using 2 rand()
    values.
13. **Search pool overflow (> 100 walkers) is fatal** (code 10, "can't clone to the side"), and so is a failed initial
    allocation (0x69, "can't make initial 4 walks!"). The blocked grid also caps maps at 20x20. Neither limit is
    reached on 15x11 maps.
14. **Aliens:**
    - An AI bomberman in the same cell as a ghost or rover shields higher-numbered humans in that cell. `player_at`
      keeps returning the immune AI for all 11 tries.
    - When a frame ends exactly on a cell centre, the next frame re-runs the centre decision at the same spot, so the
      turn chance is applied twice there.
    - V1205 is unused.
    - The spawn-distance test (0x422351) looks at all 10 player slots, including inactive ones.
15. **The blocked grid is built once per frame** by the first AI to think. Bombs dropped by later-updated players in the
    same frame are missing from it until the next frame, although `bomb_at`-based checks still see them.
