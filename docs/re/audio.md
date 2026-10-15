# Audio: sound engine, music, SFX and voice triggers (tunes.c + sound.c)

Source: BM95.EXE (Watcom, unoptimized). Addresses refer to the decompilation in
`out5/decomp_annotated.c`. I checked every call argument below against the disassembly, because the
decompiler drops most Watcom register arguments in this module. Proposed names are in
`docs/re/names/audio.txt`. When this document cites "V*n*", it means VALUELST.RES resource *n*. "Group *g*"
means the SOUNDLST.RES ids that `sound_play_group(g)` selects from.

---------------------------------------------------------------------------------------------------

## 0. Summary for the remake

* **Format.** Every `.RSS` file is raw PCM with no header: **22050 Hz, 16‑bit signed little‑endian,
  2 channels interleaved L,R**. Duration = bytes / 88200. The code fixes this format for **every** file
  (§2.1); nothing in a file can change it. Most SFX and voice files are dual‑mono stereo (L==R, or equal up
  to ±1 LSB), some are true stereo, and the music is true stereo. About 31 referenced files hold
  mono‑looking data (see §1.1), but the game still plays them as stereo. Decode everything the same way.
* **Mixing.** No volume control, no panning, no pitch or frequency change, no fades, no ducking.
  Everything plays at full scale, centred.
  `soundSetVolume/Pan/Fade` exist in the library, but the game never calls them (§2.6).
* **Three playback paths** (§2.3):
  1. **Cached one‑shot SFX** (`sound_play_group`, `sound_play_id`). This path is used for all gameplay
     sounds *and* for most voices (taunts, hurry, AWESOME, diseases, "fire in the hole"). These sounds share
     a **6‑voice limit**. When 6 are already playing, a new request is **dropped**; nothing is stolen.
  2. **Streamed one‑shot voices** (`voice_stream_play_group`). Only 2800 (intro), 1700 (draw), 2000 (match
     winner) and 2600 (quit) use this path. They are unlimited and do not count toward the 6.
  3. **Music.** One streamed tune at a time, looped forever (65535 loops), sample‑seamless.
     Starting a tune always stops the previous one abruptly and restarts from sample 0, **even if it is
     the same tune**.
* **Selection.** Each SOUNDLST "series" is randomly **culled** at load time to a few files
  (for example only 3 of the 20 explosion sounds), and **re‑culled every 30 min**. Within a group, the game
  plays a random file among the **least‑played** ones (§3).
* **Music per screen:** title 1000, main menu 1010 (restarted every time the menu is (re)entered),
  match setup/roulette 1020 "win", network lobby 1040, in‑game 1100+level, end of every round 1130 "draw".
  1030 "lose" is never used. If `disable_game_music=1`, no music plays during rounds (§5).
* **The selection consumes rand() from the shared game RNG** (§3.3). Many voices are also gated by
  `rand() % N` (§6).

---------------------------------------------------------------------------------------------------

## 1. Files and data

### 1.1 RSS sound files (`DATA/SOUND/*.RSS`, 2027 files)
- Raw sample data, no header: 22050 Hz, 16‑bit signed LE, stereo interleaved, 4 bytes per sample frame.
- File names on disk are UPPER‑CASE. SOUNDLST uses mixed case (`Bomb_01`), so lookups must be case‑insensitive.
- Missing files referenced by SOUNDLST: `xxx` (1099), `0` (2900, dummy) and `ZAHPU111` (3070, a crack‑disease
  voice). If one of these is ever chosen, nothing plays (§3.5).
- **Content check** (my analysis of the data, not from code):
  - 58 files are exact dual mono.
  - Most others are dual mono to within ±1 LSB, or true stereo.
  - 31 referenced files look like *mono* sample streams: corr(L[n],R[n]) ≈ corr(R[n],L[n+1]) ≫
    corr(L[n],L[n+1]). They are bmbstop1/2 (131‑132), kicker10 (123), bmbthrw1/3 (172‑173), bombboun (135),
    bombhit1‑4 (360‑363), trampo (353), warp1/transin/transout (1330‑1332), the pu* files (pu1‑8, 10‑12,
    14‑17, 19, i.e. ids 468‑484 except pu13 = 472; pu1‑3 are also 1400‑1402) and playprop (1431).
  - The game makes no exception for them: one stereo frame holds two consecutive source samples. If they
    were authored as 44.1 kHz mono they play at the correct pitch; if they were 22.05 kHz mono they play
    2× fast.
  - Either way, a faithful remake decodes them as 22050 Hz interleaved stereo like every other file. Do not
    "fix" them.
- 17 referenced files have a byte size that is not a multiple of 4: bmbthrw1/4/5, bombboun, bombhit2/3,
  pu1/3/4/5/6/8/11/13/14/16 and transout. The odd size goes straight to `CreateSoundBuffer`, as described
  in §11.

### 1.2 SOUNDLST.RES parser (`soundlst_load` @0042814b)
The file is read **twice** with `fgets(line, 255)`:
1. Strip at the first `'\n'`. Skip the line unless `isdigit(line[0])`, so leading spaces are not allowed.
2. `id = atoi(line)`. `p = strchr(line, ',')`. Skip the line if there is no comma. `name = p+1`.
3. Pass 1 only tracks `maxId`. Then `g_snd_nids = maxId+1` (3551 for the stock file), and three `calloc`ed
   arrays are allocated: `g_snd_names[]` (char*), `g_snd_playcount[]` (int) and `g_snd_lastframe[]` (int).
4. Pass 2 truncates `name` at the first `'.'`, then the first `'\t'`, then `' '`, then `';'`. It stores
   `strdup(name + ".snd")`. A duplicate id prints a warning, and the new name replaces the old one.
5. In KWD developer mode only, it writes `unrefsnd.lst` (a `del` list of unreferenced files).
6. Finally it runs the 16 `sound_cull_series` calls (§3.1): 7 fixed series plus the 9 disease series.

The `.snd` extension is virtual. `datafile_path` maps `NAME.snd` to `<hdhome>/data/sound/NAME.rss` if that
file can be opened, and otherwise to `<cdhome>/data/sound/NAME.rss`. `NAME.hds` always maps to the hdhome
path, and `NAME.cds` always maps to the cdhome path.

---------------------------------------------------------------------------------------------------

## 2. Sound engine

`sound.c` is Interplay's Win95 DirectSound library, the same code as Fallout 1's `sound.c`.
Its error strings are `"sound.c: No error"` … `"sound.c: unknown error"` (33 entries). `tunes.c` is the
game layer on top of it.

### 2.1 Initialisation (`sound_init` @0042896e, called from `game_init` between its two `srand(time())` calls)
```
slots  = clamp(V5, 10, 200)          -> 200   (cache entries)
budget = clamp(V6, 500000, 20000000) -> 7,000,000 bytes (cache size)
g_sound_onoff = atoi(cfg_get("soundonoff"))      // CFG.INI; 0 => soundInit never called, all audio silent
sound_lib_init(g_sound_onoff):                   // @004272dd
    soundSetMemoryProcs(tunes_mem_malloc, tunes_mem_realloc, tunes_mem_free)
    a1 = sound_ini_parse("sound.ini")            // opens it, splits lines at '=', ignores them, returns -1
    soundInit(a1, numBuffers=16, flags=0x8000, dataSize=0x8000, rate=22050)
g_sndcache = calloc(slots, 0x70); time(&g_snd_last_flush)
soundlst_load()                                   // parse + cull (§1.2, §3.1)
GNW background ticker += soundUpdate              // @0041b961 = soundContinueAll
deinit hook += sound_shutdown                     // @00427ebc: delete tune, flush cache, soundClose
if (V4) sndcache_precache_all()                   // stock 0
if (V3) sndcache_precache_selective()             // stock 0 (forced 1 in the small-memory model)
```
`soundInit` @00418ff7 does the following:
- `DirectSoundCreate(NULL)`, then `SetCooperativeLevel(hwnd, DSSCL_EXCLUSIVE=3)`.
- It creates the primary buffer (`DSBCAPS_PRIMARYBUFFER`) and calls `SetFormat`: PCM, **22050 Hz**, 16‑bit if
  `DSCAPS_PRIMARY16BIT`, stereo if `DSCAPS_PRIMARYSTEREO`.
- It records `gSampleRate=22050`, `gNumBuffers=16` and `gDataSize=32768`, and sets the master volume to
  0x7fff (maximum).

Every secondary buffer is created by `soundAllocate(type, flags)` @004195bc:
- The WAVEFORMATEX starts as mono, 22050 Hz, 16‑bit if `flags & 8`.
- All game call sites then call `soundSetChannels(snd, 3)`, which sets **nChannels=2**, nBlockAlign=4 and
  88200 B/s.
- DSBUFFERDESC flags are `0x100e0` (GETCURRENTPOSITION2 | CTRLVOLUME | CTRLPAN | CTRLFREQUENCY). Memory sounds
  also get `DSBCAPS_STATIC`.

Library type bits: 1=MEMORY, 2=STREAMING, 4=FIRE_AND_FORGET (auto‑delete when done).
Library flag bits: 8=16‑bit, 0x20=LOOPING, 0x100=stream "stop at EOF", 0x80/0x200=done and EOF state.

### 2.2 Sound object life cycle
- **Nothing is reused.** Every play allocates a new `Sound` (0x94 bytes) and a new DirectSound buffer.
  `DuplicateSoundBuffer` is not used.
- `soundContinue(snd)` @0041a024 runs for every live sound whenever `soundContinueAll` runs:
  - While the buffer plays, streaming sounds get `refreshSoundBuffers`. It refills the 32 KiB chunks
    behind the play cursor. At EOF it either loops (seek to file offset 0, `loops--`) or pads with silence.
  - When `GetStatus` reports that the buffer stopped, it calls `callback(userData, 1)` once. A
    FIRE_AND_FORGET sound is then deleted (buffer released).
- `soundContinueAll` runs:
  - at the start of every `sndcache_get`, that is, on every SFX play request that passes the 6‑voice test;
  - **twice per game frame** inside `game_frame` @0042a191, once after the bomb and power‑up updates and
    once just before the page flip;
  - from the GNW ticker list (`FUN_0043a6a4`), which is processed on every input poll (`FUN_0043a508`) and
    every 100 ms inside `FUN_00413cb0(ms)` delays. The list runs newest first. During a match `game_frame`
    is itself a ticker added after `soundUpdate`, so each loop runs `game_frame` (2 services) and then
    `soundUpdate` (a 3rd).

### 2.3 The three playback paths
**A. Cached one‑shot SFX: `sfx_play_file(path)` @00427859**
```
if (value_get(8) < g_sfx_playing) return;   // V8 = 5 -> plays while count <= 5: max 6 simultaneous
e = sndcache_get(path);  if (!e) return;    // §4; also runs soundContinueAll (after the limit test!)
e->lastUsed = g_sndcache_clock;
s = soundAllocate(5 /*MEMORY|FIRE_AND_FORGET*/, 8 /*16-bit*/);
soundSetChannels(s, 3);                      // stereo
soundSetData(s, e->data, e->size);           // CreateSoundBuffer(size) + Lock/memcpy/Unlock (copy: cache may evict later)
soundSetCallback(s, sfx_done_callback, 0);   // @00427374: if (event==1 && g_sfx_playing>0) g_sfx_playing--
g_sfx_playing++;
soundPlay(s);                                // Play(0,0,0): not looping, volume 0x7fff (0 dB)
```
- **Overflow:** a 7th request is silently dropped. No playing sound is stolen. The caller has already
  consumed rand() and incremented the play count (§3.3).
- A slot is freed only when `soundContinueAll` notices the finished buffer, so at frame granularity.
  The limit test reads the count *before* `sndcache_get` services finished sounds, so a sound that ended
  since the last service still occupies a slot for that one test.

**B. Streamed voices: `voice_stream_play_file(path)` @00427b36**
```
s = soundAllocate(6 /*STREAMING|FIRE_AND_FORGET*/, 8); soundSetChannels(s,3);
soundLoad(s, path);       // keeps the file open; preloads min(fileSize rounded up to 32 KiB, 16*32 KiB = 524,288) bytes
soundSetLooping(s, 0);    // clears the LOOPING flag -> Play() without DSBPLAY_LOOPING
soundPlay(s);
```
- No limit, no counter, no cache.
- The DirectSound buffer is not looping, so playback ends at the end of the 524,288‑byte buffer.
  As a result, `gump1` (1700, 6.80 s) is cut after **5.94 s** (see Quirks).

**C. Music: `tunes_play(path)` @004273a4**
```
debug "ACTUALLY PLAYING TUNE '%s'"
tunes_stop();                                // soundDelete(g_tune): immediate stop, no fade
g_tune = soundAllocate(2 /*STREAMING*/, 0x28 /*16-bit|LOOPING*/); soundSetChannels(g_tune, 3);
soundLoad(g_tune, path);                     // synchronous 512 KiB preload
soundSetLooping(g_tune, 0xffff);             // 65535 loops (~forever)
soundPlay(g_tune);                           // DSBPLAY_LOOPING over a 16 x 32 KiB ring
```
At EOF the stream seeks to byte 0 and keeps filling the same chunk, so the loop is seamless with no gap.
The whole file is the loop; there are no loop points.

### 2.4 Volume, panning, frequency
- `soundSetVolume` is reached only through `soundPlay(snd)`, which uses `snd->volume = 0x7fff`, and through
  `soundSetMasterVolume(0x7fff)` in `soundInit`. The DirectSound attenuation is therefore always 0
  (`-1000·log2(32767/vol)` → 0).
- `soundSetPan` @0041a729 has no caller, so every sound is centred. Panning by object x does **not** exist.
- No frequency function is called. Every buffer plays at 22050 Hz.
- **No volume option.** The "Adjust Audio" settings entry (msg 268) points to row 18 of a menu whose cursor
  only covers rows 0..17 (`local_1c = 0x12`), so it is unreachable. If it were reached, it would show
  `"PLACEHOLDER!"` / `"Audio Adjustment screen will be here..."` (msg 94/320, `audio_adjust_placeholder`
  @00407542). `sound.ini` is parsed and ignored.

### 2.5 Looping sounds
Only the music loops. No SFX loops; conveyors, fuses, footsteps and similar have no ambient or loop sound.

### 2.6 Unused library features
Fades (`soundFade`/`soundInternalFade`, a 40 ms `timeSetEvent` timer), pause/unpause, `soundPauseAll`,
`soundPauseFadeAll`, positions and pan are all unused. In particular, no music transition ever fades.

---------------------------------------------------------------------------------------------------

## 3. Ids, groups, culling and selection

### 3.1 Culling (`sound_cull_series(base, last, keep)` @00427f1b, called at the end of `soundlst_load`)
Step 1, **compaction.** Inside `[base, last]`, defined names are moved down so they occupy consecutive ids
starting at `base`. Order is preserved.
```
w = r = base;
do { if (names[w] && names[r])      { w++; r++; }
     else if (names[r]) { if (w!=r) swap(names[w], names[r]); w++; r++; }
     else r++;
} while (w <= last && r <= last);
```
Step 2, **random cull.** n = number of consecutive defined ids from `base`. While `n > keep`:
```
k = base + rand() % n;  free(names[k]);
shift names[k+1 .. base+n-1] down by one;  names[base+n-1] = NULL;
```
| series (base..last) | defined | keep, Enhanced model (default) | keep, Normal/smallmemory |
|---|---|---|---|
| 200..299 explosions | 20 | **3** | 1 |
| 400..499 power‑up get | 84 (gap at 451) | **7** | 1 |
| 700..999 post‑death taunts | 282 (701..982; compaction moves them to 700..) | **7** | 1 |
| 1200..1299 "many bombs" | 80 | **2** | 1 |
| 1400..1699 AWESOME | 144 (gaps at 1405, 1412) | **7** | 1 |
| 2300..2599 generic disease | 88 | **8** | 1 |
| 2700..2799 hurry | 39 | **5** | 1 |
| 3000+50k .. 3049+50k, k=0..8 (disease k) | 3,36,4,17,8,6,7,7,11 | **4** | 1 |

- `keep` comes from the `g_smallmemory ? 1 : N` literals in `soundlst_load`.
- Uncull groups always contain all their files: 10, 20, 40, 100, 120, 130, 135, 150, 160, 170, 300, 350,
  550, 1300, 1310, 1320, 1330, 1700, 2000, 2600, 2800.
- **Compaction matters.** Without it, group 700 would be empty (id 700 is undefined in SOUNDLST), group 400
  would stop at 450, and group 1400 at 1404.
- **Re‑cull.** `sound_periodic_flush` @00428aef runs when `V7 != 0 && time() > g_snd_last_flush + V7`
  (V7 = 1800 s, or V9 = 100 s in the small‑memory model). It shows "Flushing audio cache..." (msg 205),
  flushes the cache, re‑runs `soundlst_load` (new random subsets), and **resets all play counts to 0**
  (arrays re‑`calloc`ed). It is checked only:
  - when the match‑setup screen opens (`FUN_00410f81` entry);
  - at every round start in non‑network games (`maybe_level_load`).

### 3.2 Group play: `sound_play_group(base)` @00427961 (cached one‑shot)
```
if (base < 0 || base >= g_snd_nids || !names[base]) return;
n = count of consecutive non-NULL names starting at base;
minc = min(playcount[base .. base+n-1]);
for (i = 0; i < 200; i++) { pick = base + rand() % n; if (playcount[pick] == minc) break; }
// after 200 misses the last random pick is used anyway
sfx_play_file(datafile_path(names[pick]));    // may be dropped (limit / missing file)
playcount[pick]++;                            // incremented even when dropped
```
- `voice_stream_play_group(base)` @00427bfb is identical, but plays through path B.
- `sound_play_id(id)` @004278f2 plays exactly `names[id]` if it is defined. It then sets
  `playcount[id] = g_frame_counter`, overwriting the count with the frame number (quirk, §10).
- `sound_play_group_ratelimited(id)` @00427abb plays only if `g_frame_counter < lastframe[id] ||
  g_frame_counter >= lastframe[id] + 3`, and then sets `lastframe[id] = g_frame_counter`. It is used only
  for 135, the jelly bounce. `g_frame_counter` (DAT_00464994) increments once per game frame and is forced
  to 0x40 whenever a full‑screen picture is shown (`FUN_00429ff1`), which explains the `<` clause.

### 3.3 RNG
`rand()` is the Watcom LCG: `seed = seed*1103515245 + 12345; return (seed>>16) & 0x7fff`. It is the **same
generator gameplay uses**.
- Each group play consumes between 1 and 200 `rand()` calls. It stops at the first pick whose count equals
  the minimum, so a 1‑file group still costs exactly 1 call.
- The probability gates (taunt, many‑bombs, disease 1/3) cost 1 call each.
- The re‑cull every 30 minutes also consumes `rand()`. The initial cull runs before the second
  `srand(time())` in `game_init`, so it does not affect the game stream.
- A remake that wants an identical random sequence has to reproduce these calls in the same order (§7).

### 3.4 Music ids
`tunes_play_id(id)` @0042741e plays `names[id]` as `.snd` (HD first, then CD). `tunes_play_id_hds(id)`
@004274ab plays the HD copy. Neither function uses play counts or randomness. Music never uses groups:
`tunes_play_random_in_group` @00427538 has no callers.

### 3.5 Failure behaviour
If a file cannot be opened, `sndcache_get` returns NULL and nothing plays. The play count is still
incremented. With `soundonoff=0`, sound objects are allocated but never play or finish, so `g_sfx_playing`
climbs to 6 and later requests stop before allocating. rand() and play counts are still consumed exactly as
with sound on.

---------------------------------------------------------------------------------------------------

## 4. Sound cache (V3–V9). Not needed for a web build, documented for completeness

`g_sndcache[slots]` holds 0x70‑byte entries: `char path[100]; void* data@0x64; int size@0x68; int lastUsed@0x6c`.
`sndcache_get(path)` @004276bc:
```
soundContinueAll(); g_sndcache_clock++;
if an entry has strcmp(path)==0: hitlog(1), return it;
while (g_sndcache_bytes >= g_sndcache_budget) sndcache_evict_lru(1);   // the budget may be exceeded by one file
repeat up to 10 times:
   for each free entry (path[0]==0): strcpy path; f=fopen(path,"rb"); if !f {path[0]=0; return NULL}
        size=filelength; data=malloc(size); g_sndcache_bytes+=size; hitlog(0); fread; fclose; return entry
   sndcache_evict_lru(1)          // no free slot: evict the oldest and retry
return NULL
```
- `sndcache_evict_lru(n)` @004275e3 frees the used entry with the smallest `lastUsed` that is strictly less
  than the clock, n times.
- Cache hits and misses go into a 100‑entry ring that feeds the debug screen ("Audio cache hits: %u%%",
  msg 420). That screen also shows "Total mem / Audio mem" (msg 405).
- V3 (selective precache of groups 200, 400, 700, 1400, 2300) and V4 (precache every file < 300000 bytes)
  are both 0 in the stock data. The small‑memory model forces V3=1.
- **Music staging (minimum install), `tunes_sound_stageup` @00428ce3:**
  - It copies `<cdhome>/data/sound/X.rss` to `<hdhome>/data/sound/X.rss` in 16 KiB blocks, showing a
    "Loading sound..." progress bar.
  - It tracks staged files in `g_stageup_table` (100 × {used, name[20], time, size}). On the first call it
    registers wave tunes already present on HD.
  - Total staged bytes are kept ≤ **27,000,000**. Oldest‑time entries are deleted first. "generic" gets +1000 s
    on its timestamp, so it is effectively protected.
  - None of this applies to a full install, which the remake represents.

---------------------------------------------------------------------------------------------------

## 5. Music

### 5.1 Tunes (SOUNDLST ids)
| id | file | length | used |
|---|---|---|---|
| 1000 | title | 32.2 s | title sequence |
| 1010 | menu | 30.7 s | main menu |
| 1020 | win | 13.0 s | match setup ("music for input selection"): roulette, player/input select, level/wins select |
| 1030 | lose | 14.4 s | **never referenced** |
| 1040 | network | 13.5 s | network join / start screens |
| 1099 | xxx | (missing) | never referenced |
| 1100+w | grnacres, generic, hockey, pyramid, mineshft, battle, gieger, haunted, ocean, swamp, sewer | 110–148 s | in‑game, wave w = 0..10 |
| 1120 | generic | 145.8 s | in‑game fallback (§5.3) |
| 1130 | draw | 14.1 s | end of every round |

Waves (VALUELST 450‑460): 0 new‑traditionalist green acres → grnacres, 1 classic green acres → **generic**,
2 hockey rink → hockey, 3 ancient egypt → pyramid, 4 coal mine → mineshft, 5 beach → battle,
6 aliens → gieger, 7 haunted house → haunted, 8 under the ocean → ocean, 9 deep forest green → swamp,
10 inner city trash → sewer.

### 5.2 Which tune plays when (all are hard cuts that restart the new tune at sample 0)
1. **Title** (`title_screens` @0042b060):
   - 1000 starts.
   - Show `iplogo` and then `hslogo`. Each waits for a key or V12 = 7 s. Both are skipped if env `KWD` is
     set.
   - Then voice 2800 plays (streamed group, "ATOMIC BOMBERMAN!").
   - Then `title` shows (key or 7 s).
2. **Main menu** (`main_menu` @0042b9ce):
   - After the first menu frame is drawn, `tunes_play_id(1010)` runs.
   - This happens **every time control returns to the menu loop**: after a match, network screens,
     options, credits, help, attract mode or a cancelled quit. So the menu tune restarts from its beginning
     each time.
3. **Match** (`match_loop` = `results_screen` @0042a3f6):
   - On entry: 1020. It plays through the Goldman roulette (local games only, Goldman option on, a previous
     match winner exists, not attract mode), the player/input selection and the level/wins screen.
   - **Every round start** (`maybe_level_load`): if `g_disable_game_music == 0`, `tunes_play_wave_tune()`;
     otherwise `tunes_stop()`, so the round is silent. The tune restarts at every round. With a random level
     setting, a new level (and tune) is picked each round.
   - **End of every round** (not in campaign or attract mode): 1130 "draw" starts **before** the round
     result is evaluated, so it plays on the draw picture, the score screen and the victory picture alike.
   - Campaign: there is no 1130 between levels. The next level's tune starts in `maybe_level_load`.
4. **Network lobby** (`FUN_0042b0ce` host/start a net game, `FUN_0042b47d` join a net game): 1040 plays once the protocol/connection set‑up succeeds.
5. **Quit** (`quit_game` @00412987):
   - After "Are you sure you want to exit?" is confirmed: `tunes_stop()`, then (unless KWD is set) voice
     2600 streamed.
   - Then `Sleep(4000)` and exit. The process exits after 4 s, so `ZAI09B` (4.31 s) is clipped.
- Attract (demo) mode uses the same match loop: 1020, then the wave tune. Any key returns to the menu,
  which restarts 1010.
- `disable_game_music` (options.ini, settings item msg 263) only takes effect at the next round start.

### 5.3 `tunes_play_wave_tune()` @004293e5 (wave w = DAT_0046499c)
```
name = names[1100 + w];
if (!name) { tunes_play_id_hds(1120); return; }
if (strcmp(datafile_path(name /*.snd*/), datafile_path(base+".hds")) == 0)   // the tune is on the hard disk
     tunes_play(datafile_path(base+".hds"));                                  // full install: always this path
else if (net_role() == 0 && levelno_setting != -1)                            // local game, fixed level
     { tunes_sound_stageup(name); tunes_play_id_hds(1100 + w); }
else tunes_play_id_hds(1120);         // network game or random level on a minimum install -> "generic"
```
Remake (full install): always play 1100+w. Fall back to 1120 only if SOUNDLST has no entry.

---------------------------------------------------------------------------------------------------

## 6. Complete trigger table

Unless noted, "group" means `sound_play_group` (path A: cached, limited to 6, least‑played).
"id" means `sound_play_id` (exact file, path A). "stream" means `voice_stream_play_group` (path B).
The site column gives the caller address. This is the complete list of call sites: a raw scan of every
`call` into the tunes.c play functions found exactly these.

### 6.1 Gameplay (all inside `game_frame`)
| event | sound | conditions / probability | site |
|---|---|---|---|
| bomb dropped by the player | group **100** (bmdrop2/3) | Drop button pressed and allowed: `bombsInPlay < maxBombs`, cell free (`FUN_0041e5c3`), no extra of type 1 (warp hole) on the cell, not constipated (disease flag +0x86) | player_update_anim 0x420cc1 |
| bomb forced out by the poops / crack‑poops disease (+0x87 / +0x89) | group **550** (poops1‑5) **instead of** 100 | Same as above (the disease forces the button) | 0x420cb5 |
| "many bombs" voice (clear, fire in the hole …) | group **1200** | Played *before* the drop sound when `maxBombs >= V651 (4)` **and** `maxBombs-1 == bombsInPlay` (this drop uses the last available bomb) **and** `rand() % max(V650,1) == 0` (1/4). Both sounds play | 0x420ca5 |
| cannot drop (bomb button on a warp hole) | group **40** (enrt1/2) | Only if not poops/crack‑poops diseased | 0x420c2b |
| spooge line of bombs | none | The spooge path drops bombs without any sound | — |
| kick a bomb | group **120** | `bomb_kick(bomb,dir)`: plays unless the bomb is already sliding in the same direction. Runs on the machine that owns the bomb (network: `FUN_0042475f`) | bomb_kick 0x42467b |
| sliding bomb stops against an obstacle or flame | group **130** | Bomb motion state +0x2e != 0, so bombs pushed by a conveyor (state 0) are silent; non‑jelly bombs only | maybe_bomb_update 0x423791 |
| sliding **jelly** bomb hits an obstacle (reverses) | group **135** (bombboun,1017,1036) through `sound_play_group_ratelimited` | State != 0; at most once per 3 game frames (shared across all jelly bombs) | 0x42377b |
| punched or thrown bomb lands on a cell (each bounce) | group **160** (bmdrop3) | Flying state (+0x2e == 2). Plays at a cell centre once the bomb has flown more than 2 cells (+0x48 > 2): at the end of the first arc and again at every re‑bounce (see the bombs doc for the arc logic). Sound order: a jelly bomb's 1/V667 direction change is rolled *before* the sound. A head hit (`FUN_00421f7e`) is silent | 0x423a52 |
| punch | group **150** | `player_punch`: only if a bomb is in the cell in front. Punching air is silent | 0x424ad6 |
| grab a bomb (blue glove) | group **170** (grab1/2, bmbthrw1‑5) | On pick‑up. The throw itself is silent; the landing gives 160 | 0x424b34 |
| bomb explodes | group **200** (3 surviving files) | Every explosion, including chain reactions and trigger bombs. Each bomb plays once; the 6‑voice cap drops the excess. Bombs destroyed (not detonated) by the closing wall (`stomped_bombs_detonate=0`) are silent | 0x423f79 |
| power‑up collected: bomb, flame, kick, skate, punch, grab, spooge, goldflame, trigger (types 0,1,3‑9) | group **400** | Not for remote network players (controller type 4) | player_pickup_powerup 0x41e549 |
| power‑up collected: jelly (type 10) | group **135** (the jelly‑bounce group) | Not rate‑limited here | 0x41e549 |
| AWESOME | group **1400** replaces 400/135 | Per‑player byte +0x65, reset to 0 at round start. It is incremented on every non‑disease pickup (not type 2 or 11; random type 12 is resolved first). AWESOME when `cnt >= 7 && (cnt-7) % 5 == 0`, i.e. the **7th, 12th, 17th, …** pickup (SOUNDLST says "every 3rd"; the code uses 5). If `cnt > 50` after the check, it resets to 7 | 0x41e549 |
| disease collected (type 2) | 1/3: group **3000+50·k**; 2/3: group **2300** | `player_give_disease(p, 1)`. k = `rand()%9`, re‑rolled up to 200× while k==7 (swap) in network games. Then `rand()%3==0` picks the specific group. k: 0 molasses, 1 crack, 2 constipation, 3 poops, 4 short flame, 5 crack poops, 6 short fuze, 7 swap, 8 reversed. Groups 3450/3500/3550 (leprosy, invisible, duds) are unreachable | player_give_disease 0x41e03b / 0x41e047 |
| super‑bad disease (type 11) | as above, **once** | Three diseases are given; only the first plays a sound (EDX=1,0,0). No AWESOME count | 0x41e429 |
| random power‑up (type 12) | sound of the resolved type | The type is re‑rolled (`rand()%12` until not excluded) and then handled as that type | — |
| step into a warp hole (extra type 1) | group **1330** (warp1, transin, transout) | When the walking player reaches the cell centre (offset −1 along the move direction) | player_move_step 0x41ee1e |
| step onto a trampoline (extra type 3) | group **350** (1017,1036,1045,trampo) | Same moment; the player enters the bounce state | 0x41ee4c |
| player dies | group **300** (scream1, die1), **then** id **340+deathAnim** | `player_kill` acts only if the player is not already dying (+0x08 == 0) and its protection timer +0x66 == 0; otherwise nothing happens, sounds included. deathAnim = `rand()%V105+1` (1..24; always 1 in the small‑memory model) or the value from the network packet. Only these ids exist: 341 burnedup (anim 1), **350‑353** (anims 10‑13: trampoline sounds), **360‑363** (anims 20‑23: bomb‑hit sounds). Other anims have no extra sound | player_kill 0x41ddd4 / 0x41dde4 |
| post‑death taunt | group **700** | Checked in the dying player's update when the death‑anim frame counter (+0x30) **== 25**, then `rand() % max(V95,1) == 0` (1/5). Frame 25 is 25 reference frames = **1.25 s after death**. It cannot happen for death anims with fewer than 25 states, because the dead player is removed when the counter reaches the state count: die 5 (17), 7 (14), 8 (12), 20 (20). For die 9 (the rising angel) it happens only if the angel has not already left the top of the screen (y < −20) | player_update_anim 0x41f532 |
| closing‑in wall tile slams | id **140+v**, with v = `rand()%3` chosen **once per round** when the close‑in starts (remaining ≤ 55 s) | Every slammed tile of that round plays the same file: clikplat, sqrdrop2 or sqrdrop4. 143‑146 are never used (hard‑coded `%3`, as the SOUNDLST comment says). One slam per 250 ms | map_closein_update 0x426a55 |
| HURRY | group **2700** | Once per round: the first frame with `V101-5 < secondsLeft < V101`, i.e. 55 < s < 60, with `secondsLeft = (playtime*1000 - elapsedMs) / 1000`. Flag `g_hurry_played` is reset in `maybe_level_load`. The "hurry" sprite blinks at screen centre while `(frame & 4)` in the same window. No hurry voice or sprite if `playtime ≤ 55` s or time is infinite (code 1001); with 56–59 s it fires at round start | game_frame 0x42a2a6 |
| bomb lands on a head (stun, power loss) | **none** | Group 360 ("stunned by a bomb landing on your head") is never played for this event | — |

### 6.2 Round end, match end, title, quit
| event | sound | conditions | site |
|---|---|---|---|
| round ended in a draw | stream **1700** | `FUN_004219b0` returns −1. The "draw" picture is shown without waiting, then the voice plays. Music 1130 is already playing | match_loop 0x42a721 |
| match won | stream **2000** | On the score screen right after the scores are printed. Then `FUN_00413cb0(1500)` (1.5 s; the GNW tickers keep running). Then "X WINS THE MATCH!" is printed. Then the screen waits for a key. After that the `victory%u` / `team%u` picture is shown with no wait, followed by a 3 s delay. If the round did not decide the match, no voice plays | 0x42acbe |
| intro "Atomic Bomberman!" | stream **2800** | After the logos, before the title picture | title_screens 0x42b0a4 |
| exit program | stream **2600** | After the confirmation; skipped if KWD is set. Music stopped first; 4 s later the process exits | quit_game 0x4129dc |
| Goldman roulette tick | group **1300** | Every time the marker position becomes a multiple of V1004 (70) while it moves (a slot boundary), both before and after Enter. The marker moves `max(remaining,6)` steps per drawn frame, so the rate depends on frame rate | goldman_roulette 0x403697 |
| roulette result | group **1320** (buzzer) if the result is power 13 (speed brake / clogs); otherwise group **1310** (clapping) | Once, when the wheel stops | 0x4039c3 / 0x4039cf |

### 6.3 Menus and UI (generic rule)
Every menu, dialog and wait screen uses the same pattern:
- **Any input event** returned by the menu key reader (any value other than −1 "none" and −2 "mouse
  state") plays group **20** (letter1/letter2 click).
- **Confirm or leave** plays group **10** (menuexit) *in addition*:
  - main menu selection: Enter, Space, Esc, F1, item hotkeys;
  - player setup accept or Esc;
  - level/wins accept;
  - score‑screen continue;
  - picture wait screens: Enter, Esc, Space, **or timeout**. A timeout is converted to Enter, so it plays
    both 20 and 10 (`show_picture_wait` @0042a088).
- **Disallowed action** plays group **40** (enrt1/2). Examples: a network client (role 1) changing
  server‑owned settings, levels or wins; changing a remote (type 4) player's input; F1/help or the debug key
  on a client; trying to continue a screen as a client.

Call sites:
- `editor_main_menu` 0x40328d (20).
- `goldman_roulette` 0x4039f9 (20), 0x403a7d (40).
- level/wins screen `FUN_00406dde`: 0x407099 (20); 0x4071a5, 0x4071d6, 0x407209, 0x40725e, 0x4072b3,
  0x407355, 0x4073f4, 0x407490, 0x4074ad (40); 0x407429 (10).
- settings `FUN_004080dc` 0x4089a2 (20).
- `maybe_level_load` network wait loops 0x410db7, 0x410e5b (20).
- player setup `FUN_00410f81`: 0x411724 (20); 0x41191b, 0x411993, 0x4119ec, 0x411a7d, 0x411a96, 0x411b1a,
  0x411b3a, 0x411b5a (40); 0x411ad7, 0x411c6e (10).
- message box `FUN_00414340` 0x414532 (20); yes/no `FUN_0041456c` 0x4147b0 (20).
- `show_picture_wait` 0x42a131 (20), 0x42a155 (10).
- `match_loop`: 0x42a75a, 0x42ae04 (20); 0x42a811, 0x42aec0 (40); 0x42a846, 0x42aef5 (10).
- net host `FUN_0042b0ce`: 0x42b35b (20), 0x42b404 (10).
- net join `FUN_0042b47d`: 0x42b6ca (20), 0x42b735 (10).
- `main_menu`: 0x42bb33 (20); 0x42bcf4, 0x42bd0e, 0x42bd28, 0x42bd55, 0x42bd6b (10).

### 6.4 Contents of the groups that are not culled (file, seconds)
A group ends at the first undefined id. For example, 130 = {130,131,132} and 135 = {135,136,137},
separated by the undefined ids 133/134.

| group | files |
|---|---|
| 10 | menuexit 0.29 |
| 20 | letter1 0.10, letter2 0.13 |
| 40 | enrt1 0.25, enrt2 0.20 |
| 100 | bmdrop2 0.38, bmdrop3 0.16 |
| 120 | kbomb1 0.40, kbomb2 0.34, kicker3 0.41, kicker10 0.30 |
| 130 | bombstop 0.45, bmbstop1 0.41, bmbstop2 0.46 |
| 135 | bombboun 0.17, 1017 0.37, 1036 0.33 |
| 140..142 (ids) | clikplat 0.61, sqrdrop2 0.71, sqrdrop4 0.71 |
| 150 | kbomb1, kbomb2 |
| 160 | bmdrop3 |
| 170 | grab1 0.12, grab2 0.15, bmbthrw1 0.30, bmbthrw3 0.26, bmbthrw4 0.20, bmbthrw5 0.30 |
| 300 | scream1 1.22, die1 2.73 |
| 341 (id) | burnedup 2.90 |
| 350 | 1017 0.37, 1036 0.33, 1045 0.76, trampo 0.30 |
| 550 | poops1‑5 (0.51–1.71) |
| 1300 / 1310 / 1320 | 1041 0.04 (tick) / 1000 2.56 (clap) / 1049 1.10 (buzzer) |
| 1330 | warp1 0.20, transin 0.57, transout 0.66 |
| 1700 | 37 files (gump1 … ZAI06C), max 6.80 s |
| 2000 | 37 files (proud … ZAFP12C), max 2.63 s |
| 2600 | 49 files (quitgame … ZAI09C), max 4.31 s |
| 2800 | 11 files (GEN8A … ZAI08G), max 4.02 s |

The culled series (200, 400, 700, 1200, 1400, 2300, 2700, 3000+50k) keep a random subset of their files
(§3.1). Explosion files last 1.05–3.03 s.

### 6.5 SOUNDLST groups that are never played
- 320 (proud/theman/youwin1; 2000 is used instead)
- 360‑363 (only through the death‑anim quirk)
- 143‑146
- 3450, 3500, 3550
- 1030, 1099, 2900
- the unused functions `tunes_play_random_in_group` and `voice_stream_play_id`

---------------------------------------------------------------------------------------------------

## 7. Timing and order of operations

- **Order within one game frame** (`game_frame` @0042a191). Audio‑relevant steps only; see the engine doc
  for the full list:
  1. elapsed time (clamped to V31)
  2. network receive
  3. `g_frame_counter++`
  4. HUD/timer
  5. extras
  6. **bombs** (130, 135, 160, 200)
  7. power‑ups
  8. **soundContinueAll #1**
  9. flames (no sounds; flames do not kill here)
  10. **close‑in slams** (140+v; crushed players die → 300 + 340+n)
  11. **players** (pick‑ups, drops, punch/grab/kick, warp/trampoline, taunt; a player standing in a flame
      dies here → 300 + 340+n)
  12. aliens (campaign; alien contact kills → 300 + 340+n)
  13. second bomb pass
  14. **hurry check** (2700)
  15. palette
  16. **soundContinueAll #2**
  17. flip

  Sounds triggered in one frame start in that order. The 6‑voice cap is evaluated per request in that order,
  so earlier events win slots.
- **Taunt timing.** The death‑anim counter advances by `floor(accumulated elapsed ms / 50)` per drawn frame.
  The `== 25` test runs once per *drawn* frame:
  - at the nominal 20 fps it is evaluated exactly once (1/5);
  - above 20 fps it can be evaluated (and won) on several consecutive frames;
  - below 20 fps it can be skipped.
- **Voice ordering and delays.** Nothing is delayed except the taunt (frame 25) and the 1.5 s pause after the
  match‑winner voice, which delays the *text*. There is **no voice channel and no exclusivity**: scream,
  death‑anim sound, explosions and a taunt may all overlap. The only limit is the 6‑voice pool for path A.
  Long explosions (1.05–3.03 s) often fill that pool during chain reactions, which drops later voices.
- **Music changes** happen at the moments listed in §5.2 with no fade. `tunes_play` loads 512 KiB
  synchronously before playback starts.

---------------------------------------------------------------------------------------------------

## 8. Settings that affect audio
| setting | effect |
|---|---|
| CFG.INI `soundonoff=0` | DirectSound is never initialised and all audio is silent; game logic still runs and consumes rand() |
| options.ini `disable_game_music=1` (msg 263 "Disable music during gameplay") | `tunes_stop()` instead of the wave tune at every round start; other music unaffected |
| options.ini `smallmemory=1` ("Normal (Less than 32mb of RAM)") | Cull keep=1 for every series; V7 := V9 (re‑cull every 100 s); V105 := 1 (death anim always 1, so 341 always plays); V3 := 1 (selective precache); V4 := 0 |
| VALUELST 3/4/5/6/7/9 | cache and precache, §4 |
| VALUELST 8 = 5 | concurrency: up to **6** path‑A sounds |
| VALUELST 95 = 5 | taunt 1/5 |
| VALUELST 650 = 4 / 651 = 4 | many‑bombs 1/4 when ≥4 capacity and the last bomb is dropped |
| VALUELST 101 = 60 | hurry window 55 < s < 60 |
| env `KWD` | skips the logos and the quit voice; writes unrefsnd.lst |
| sound.ini | read and ignored |

---------------------------------------------------------------------------------------------------

## 9. Data structures

- **Library `Sound` (0x94 bytes, Fallout layout):**
  - +0x00..0x1b: file‑IO procs (open, close, read, write, seek, tell, filelength)
  - +0x1c fd
  - +0x20 stream chunk buffer
  - +0x24 IDirectSoundBuffer*
  - +0x28 DSBUFFERDESC
  - +0x38 WAVEFORMATEX*
  - +0x3c soundFlags
  - +0x40 state (1 done, 2 playing, 4 fading, 8 paused)
  - +0x44 type
  - +0x48 pausePos
  - +0x4c volume
  - +0x50 loops
  - +0x54 loopStart
  - +0x58 loopEnd
  - +0x5c minReadBuffer
  - +0x60 fileSize
  - +0x64 bytesPlayed
  - +0x6c readLimit (=16·32 KiB)
  - +0x70 lastChunk
  - +0x74 lastPos
  - +0x78 numBuffers
  - +0x7c dataSize
  - +0x84 userData
  - +0x88 callback
  - +0x8c next
  - +0x90 prev
- **Cache entry:** 0x70 bytes (§4).
- **Stage table entry:** 0x20 bytes (§4).
- **Player fields read by the audio code** (player struct, stride 0x98):
  - +0x04 death anim number
  - +0x08 dying flag
  - +0x10 controller type (4 = remote network player)
  - +0x30 anim frame counter (short)
  - +0x32 frame‑time accumulator
  - +0x56.. power‑up counts (index = power type)
  - +0x65 AWESOME counter
  - +0x84+k disease k active
- **Bomb fields read by the audio code:**
  - +0x04 type (0 normal, 1 trigger, 2 jelly)
  - +0x2a direction (high word)
  - +0x2e motion (0 idle/conveyor, 1 sliding, 2 flying, 3 carried)
  - +0x48 cells flown
- **Globals:** see `docs/re/names/audio.txt`.

---------------------------------------------------------------------------------------------------

## 10. Bugs and quirks (replicate unless noted)

1. **AWESOME interval.** SOUNDLST says "7th powerup and 3rd thereafter", but the code uses
   `(cnt-7) % 5 == 0` (7, 12, 17, …). Above 50 the counter is set back to 7, so after the 47th pickup the
   next AWESOME comes 9 pickups later, at the next 12.
2. **Death‑anim id overlap.** `340+anim` collides with the trampoline group (350‑353 → anims 10‑13) and the
   bomb‑hit group (360‑363 → anims 20‑23). Probably accidental. Only anim 1 has a sound meant for it.
3. `sound_play_id` stores the **frame counter** into `playcount[id]` (ids 341, 350‑353, 360‑363, 140‑142).
   This makes that file look heavily played, so group 350 then avoids it.
4. The **bomb‑on‑head stun** has no sound. Group 360 is only reachable through quirk 2.
5. **Play count increments even when the sound was dropped** (6‑voice cap) or its file is missing (3070
   ZAHPU111).
6. **Least‑played pick can fail.** After 200 failed draws a random non‑least file is played (relevant for
   large uncull groups such as 2600: 49 files).
7. **Truncated voices.** Streamed voices longer than 524,288 bytes are cut (gump1, 1700: 6.80 s → 5.94 s).
   The quit voice is cut by the 4 s exit (ZAI09B 4.31 s). It is reasonable to fix both.
8. **Menu tune restarts** on every return to the main menu. Wave tunes restart every round, even on the same
   level.
9. **Picture‑screen timeout** plays both the click (20) and menuexit (10).
10. **Taunt test per drawn frame**; probability depends on frame rate (§7).
11. **Stale slot count.** The concurrency test runs before finished sounds are serviced in the same call
    (§2.3).
12. **Spooge lines are silent.** Jelly power‑up pickup plays the jelly‑bounce group, not 400.
13. Library quirks: `soundSetCallback` and `soundSetChannels` return error 0x16 on success (ignored);
    DSBCAPS "extra" bits OR already‑set flags; `sound.ini` is opened and ignored.
14. Disease voice groups for leprosy, invisible and duds exist but are unreachable (`rand()%9`).
15. The "Adjust Audio" menu row is unreachable and would only show a placeholder.

---------------------------------------------------------------------------------------------------

## 11. Uncertain

- **gump1 truncation (quirk 7).** It follows from the code: the buffer is not looping, so a refilled chunk is
  never reached. I have not verified it on real DirectSound. Hypothesis: the original really cuts it.
- **Buffer sizes not a multiple of 4.** For the 17 files listed in §1.1, the buffer size is not a multiple of
  `nBlockAlign` (4). Hypothesis: DirectSound accepts it and rounds the size (Wine rounds up to a whole block).
  The sound plays normally, and the last 2 bytes are inaudible. If CreateSoundBuffer actually failed, these
  sounds would be silent in the original; nothing in the code checks for that. Remake: ignore the trailing
  2 bytes.
- **Mono‑looking files** (§1.1). Whether the authors meant 44.1 kHz mono is unknown. The original's
  behaviour (play as 22050 Hz stereo) is certain from the code.
- **Taunt evaluation count.** Exactly once per death only if the engine renders at exactly 20 fps and the
  frame‑time accumulator never skips. The engine doc's frame‑pacing analysis decides this. Recommended:
  evaluate once when the counter first reaches 25.
- **Hurry window.** The exact first frame depends on the HUD timer's pause handling (`DAT_004601b4`); see
  engine/HUD doc. The voice plays on the first frame where the integer seconds‑left drops below 60.
- **Network games.** Sounds are produced by each machine's own simulation path. Power‑up and disease sounds
  are skipped for controller type 4 (remote) players, while death sounds also arrive through the network
  death path (`FUN_0041de04` → `player_kill`). Whether every SFX fires on every client depends on what the
  net layer replicates (see net/match‑flow docs). Each sound call also consumes rand() locally.

---------------------------------------------------------------------------------------------------

## 12. Cross‑module notes

- `player_net_death` @0041de63 picks the death anim and calls `player_kill` @0041dcb2, which plays the
  sounds. It is called from `player_move_step` @0041ec84, `player_update_anim` @0041f29b (flame at the
  player's cell, found via `FUN_0042708d`), the close‑in (`FUN_00426818`) and `aliens_create`. A remote
  death packet goes through `FUN_0041de04` → `player_kill`.
- `player_pickup_powerup` @0041e21e is called from `player_move_step` 0x41f252 and `player_update_anim`
  0x41f64c. It also contains the disease‑cure roll (V124/V125), which runs before the sound.
- Bomb sounds live in `maybe_bomb_update` @0042331c, `bomb_kick` @0042464b, `player_punch` @00424a50 and
  `bomb_grab` @00424af4.
- `game_frame` @0042a191 is registered as a GNW ticker during a match (`FUN_0043a6fc(0x42a191)` in
  `match_loop`). Elapsed time goes to DAT_00464958 (clamped to V31). The frame counter is DAT_00464994.
- `show_picture_wait` (named `pcx_load_plt` in names.txt) is the generic "show NAME.plt, optionally wait
  for a key or V12 seconds" screen.
