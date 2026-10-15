# Graphics subsystem (graf.c, color.c, pcx.c, ani.c, datafile.c + GNW primitives)

Reverse-engineered from BM95.EXE (Watcom, unoptimized). Addresses are virtual addresses in BM95.EXE.
All statements below were verified against the disassembly (not only the Ghidra output, which drops
register arguments of Watcom calls). Names in `code` are the proposed names (see
`docs/re/names/graphics.txt`); original Ghidra names are given in parentheses where useful.

Conventions: "idx" = 8-bit palette index. "RGB555" = 15-bit value `(r5<<10)|(g5<<5)|b5`.
"6-bit" palette values are 0..63 (VGA DAC). VALUELST ids are written `V<n>`.

---------------------------------------------------------------------------------------------------

## 0. Summary of the rendering model (read this first)

* Display: DirectDraw, **640x480x8 exclusive full-screen**, a **single primary surface** (no back
  buffer, no Flip, **no vsync wait**). A frame is presented by locking the primary surface and
  memcpy'ing the 640x480 main GNW window buffer into it.
* Everything is 8-bit paletted. One **game palette** (COLOR.PAL, 6-bit) plus a 32 KB
  **RGB555 -> idx lookup table** (`colorTable`). All sprites (ANI, RGB555) and almost all pictures
  (PCX) are converted to game-palette indices at load time through that table.
  Only full-screen "picture screens" (IPLOGO, HSLOGO, TITLE, DRAW, VICTORY0-9, TEAM0-1) switch the
  hardware palette to the PCX's own palette.
* Palette index **0 = transparent** for every sprite blit. `colorTable` never yields 0.
* Per frame (menus and in-game alike):
  1. `graf_restore_background` copies a 640x480 **background buffer** (glue picture, main-menu
     picture, or field picture + tiles) into the main window buffer.
  2. Text is printed **immediately** into the window buffer (`graf_print`), i.e. under all sprites.
  3. Sprites are **queued** (display list of max 400 entries) and drawn at present time in queue
     order, except that every "player-colour remapped" sprite is deferred to the end of the queue
     (see 5.3 - this is the actual z-order rule; there is **no y-sorting**).
  4. `graf_flip` = flush queue + `win_draw(main window)` (blit to screen).
* **No fades, no palette cycling/flashing, no screen shake, no dirty rectangles** exist in this
  build. All palette changes are instantaneous. (Fade code exists but is dead - see 2.6.)
* Fonts: GNW bitmap fonts; the game uses **FONT6.FON exclusively** (selected in `graf_init`).
  `graf_print` draws text with a 1-pixel diagonal outline. The in-game timer uses the
  **KFONT.ANI** sprite font ("numeric font"); BFONT.ANI is never loaded.

---------------------------------------------------------------------------------------------------

## 1. Display setup (GNW svga, 0x442d90-0x4439dc)

### 1.1 Initialisation chain
`game_init` -> `graf_init` (0x414df4) -> `win_init(init_mode_640_480, GNW95_reset_mode, flags=0)`
(0x43c150). `win_init` does, in order:
1. creates the font list (`GNW_text_init`, loads FONT0..FONT9 that exist, see 6.1);
2. calls `init_mode_640_480` (0x442e24) = `GNW95_init_mode_ex(640, 480, 8)` (0x442ecc):
   * `GNW95_init_window` (0x442f78) - registers class "GNW95 Class";
   * `GNW95_init_DirectDraw(640,480,8)` (0x443038):
     - `DirectDrawCreate(NULL, &dd, NULL)`
     - `SetCooperativeLevel(hwnd, DDSCL_EXCLUSIVE|DDSCL_FULLSCREEN)` (0x11)
     - `SetDisplayMode(640, 480, 8)`
     - `CreateSurface({dwFlags=DDSD_CAPS, ddsCaps=DDSCAPS_PRIMARYSURFACE})` - **primary only**
     - `CreatePalette(DDPCAPS_8BIT|DDPCAPS_ALLOW256, grey ramp i,i,i, &pal)`; `primary->SetPalette(pal)`
       (a 16-bpp code path also exists but is never selected).
   * screen rect = (0,0)-(639,479); `scr_blit = mouse_blit = GNW95_ShowRect` (0x4438f0).
3. `colorSetFileIO`, `colorSetMemoryProcs`, then `initColors` (0x42dae0, "color_load_pal"):
   gamma 1.0 (identity), loads COLOR.PAL (2.1) and calls `setSystemPalette(cmap)`.
4. input init (GNW_input_init 0x43a400: default pause key Alt-P (0x119), screendump key Alt-C (0x12e)).

Back in `graf_init` (pseudo-code, faithful order):
```
win_init(0x442e24, 0x44324c, 0)
register_pause(-1, NULL)              // 0x43a8bc: disables the GNW pause key
mouse_show(); mouse_hide()            // net effect: GNW mouse pointer hidden
winz_bmp = pcx_load_remapped(datafile_path("winz.plt"), &winz_w, &winz_h)   // 72x72 window skin
          if (!winz_bmp) fatal_error(0x1e)
graf_queue = malloc(400 * 24); graf_queue_count = 0
fp = fopen("color.pal","rb"): fread(game_palette /*0x46059c*/, 3, 256); game_palette[0..2] = 0,0,0
     fclose; memcpy(default_palette /*0x46089c*/, game_palette, 768)
screen_w = 640; screen_h = 480
main_window = win_add(0, 0, 640, 480, colorTable[0] /*idx 255*/, flags 1)
background = calloc(640, 480)         // 0x460bcc, the background buffer
target_pitch = 640; target_height = 480
graf_target_screen()                  // target = win_get_buf(main_window)
graf_clear()                          // memset(target, 0, 640*480)
clip = (0, 0, 640, 480)               // 0x46058c..0x460598 (left, top, right, bottom; right/bottom exclusive)
for i in 0..9: remap[i] = malloc(256), memset 0
remap[0][i] = i+3 for i != 0          // dead store, overwritten next line
for i in 0..9: graf_load_remap(i, V(200+5i), V(201+5i), V(202+5i), rebuild=0)   // section 4
text_font(6)                          // FONT6.FON for all text
atexit(graf_exit /*0x41495a*/)
```

### 1.2 Presenting a frame
`graf_flip` (0x415c1f, was `maybe_graf_flip`):
```
stat_frames++                         // 0x4642a4 (statistics only)
sprite_queue_flush()                  // 0x415b22, section 5
win_draw(main_window)                 // GNW_win_refresh of the whole window rect
```
GNW refresh blits every visible part of the main window (parts covered by dialog windows that sit
on top are skipped) through `GNW95_ShowRect`:
```
if (!app_active /*0x45c4e0*/) return
loop: hr = primary->Lock(NULL, &ddsd, DDLOCK_WAIT, NULL)
      if hr == DDERR_SURFACELOST: if primary->Restore() != OK return; retry
buf_to_buf(src + srcY*srcPitch + srcX, w, h, srcPitch, ddsd.lpSurface + destY*lPitch + destX, lPitch)
primary->Unlock()
```
No WaitForVerticalBlank anywhere in the binary -> presentation is immediate (tearing possible).
There is no game-level dirty-rectangle logic: the full 640x480 background is copied into the
window buffer every frame and the whole window is blitted. If the GNW mouse pointer is visible it is
redrawn on top after the refresh.

### 1.3 Buffers and draw target
| global | meaning |
|---|---|
| `main_window` 0x464ae4 | GNW window id of the 640x480 main window |
| window buffer | `win_get_buf(main_window)`; what is shown on screen |
| `background` 0x460bcc | 640x480 buffer copied into the window buffer by `graf_restore_background` |
| `graf_target` 0x460bc4 | current destination of sprite draws / picture loads |
| `target_pitch` 0x460bc8 | 640 |
| `field_bitmap` 0x460bc0 | 640x480 FIELDn picture (remapped), source for floor restoration |

`graf_target_screen` (0x415189): target = window buffer. `graf_target_background` (0x4151ad):
target = background buffer. Code that builds a background calls `graf_target_background()`, draws,
then `graf_target_screen()`.

`graf_restore_background` (0x415ca4, was `maybe_graf_lock`): `if (background) memcpy(graf_target,
background, 640*480)`. `graf_clear` (0x415ce3): `memset(graf_target, 0, 640*480)`.

---------------------------------------------------------------------------------------------------

## 2. Palettes

### 2.1 COLOR.PAL and the GNW colour tables (color.c, 0x42c3c8-0x42db80)
COLOR.PAL = 33536 bytes = 768 bytes palette (256 x R,G,B, 6-bit) + 32768 bytes `colorTable`.
`loadColorTable` (0x42c9fc, was `color_find_table`):
```
for i in 0..255: read r,g,b
    if r < 64 && g < 64 && b < 64: mappedColor[i] = 1
    else: r = g = b = 0; mappedColor[i] = 0          // entry 0 of COLOR.PAL is (255,255,255) -> black
    cmap[i] = (r,g,b)                                  // 0x45c000
read 32768 bytes -> colorTable                         // 0x495390
read 4 bytes tag; if tag == 'NEWC': read intensity/mixAdd/mixMul tables (3 x 64 KB)
else: compute them (setIntensityTables/setMixTableColor)  // COLOR.PAL has no tag -> computed
rebuildColorBlendTables()
```
Facts verified on the shipped COLOR.PAL: only entry 0 is invalid; `colorTable` contains no 0
(index 0 is never produced); `colorTable[0x0000] = 255` (black (0,0,0)).
The intensity / mix / blend tables are built but never used by the game.

`Color2RGB(idx)` (0x42c460) = `((cmap.r>>1)<<10)|((cmap.g>>1)<<5)|(cmap.b>>1)`.
`RGB2Color(c)` (0x42c44c) = `colorTable[c]`.

### 2.2 Setting the hardware palette
`setSystemPalette(pal6)` (0x42c534):
```
for i in 0..767: tmp[i] = gammaTable[pal6[i]]; systemCmap[i] = pal6[i]     // gamma table = identity (gamma 1.0)
GNW95_SetPalette(tmp)                                                       // 0x443608
```
`GNW95_SetPalette`: `PALETTEENTRY[i] = { r<<2, g<<2, b<<2, PC_NOCOLLAPSE }` (8-bit shift, so a
6-bit value v is shown as **4*v**, range 0..252), then `IDirectDrawPalette::SetEntries(0, 0, 256)`.
Remake rule: display colour of a 6-bit entry = `v*4` (NOT `v*255/63`).
`getSystemPalette()` (0x42c570) returns `systemCmap` (0x464b50).

### 2.3 Game palette vs. own palette
Two graf-level copies of the game palette:
* `game_palette` 0x46059c (6-bit, entry 0 forced to 0,0,0) - "current";
* `default_palette` 0x46089c - pristine copy.

`palette_restore_game` (0x4150bd): `memcpy(game_palette, default_palette, 768);
setSystemPalette(game_palette)`.

**Own-palette pictures** are shown by `graf_show_pcx_own_palette(path)` (0x41522d):
```
img = pcx_load_raw(path, &w, &h)                 // no remapping
memcpy(game_palette, datafile_palette, 768)      // side effect: game_palette now holds 8-bit values!
tmp = game_palette copy; tmp[i] >>= 2 for all 768 bytes
setSystemPalette(tmp)                            // displayed channel = (v8>>2)<<2 = v8 & 0xFC
if img: memcpy(graf_target, img, 640*480); free(img)   // always copies 640*480 (all such PCX are 640x480)
```
Pixel values are used raw, so PCX index 0 shows the PCX palette's colour 0.

The only caller is `show_picture_wait(name, wait)` (0x42a088, was `pcx_load_plt`):
```
graf_clear(); graf_flip()                        // present an all-index-0 screen with the CURRENT palette
graf_show_pcx_own_palette(datafile_path(sprintf("%s.plt", name)))
draw_watermark()                                 // sets frame counter 0x464994 = 0x40; string is empty -> draws nothing
graf_flip()
flush input; get key
if (wait): loop until Enter/Esc/Space or time(NULL) > start + V12 (7 s)   (keys -> sound 20, exit -> sound 10)
```
Own-palette screens (all callers): `iplogo`, `hslogo`, `title` (title_screens 0x42b060, wait=1),
`draw` (match loop 0x42a3f6 (was `results_screen`) after a drawn round, wait=0, then key or 6 s),
`victory%u` / `team%u` (match winner, wait=0, then 3000 ms delay). After each sequence the caller does `graf_clear(); graf_flip(); palette_restore_game()`.

All other pictures are converted to the game palette (2.5).

### 2.4 What ".plt" means
There are no .plt files. `datafile_path` (0x411d17) maps extension `plt` (and `but`) ->
`data/res/<name>.pcx` (other mappings: `ani`/`ali` -> `data/ani/`, `snd`/`hds`/`cds` ->
`data/sound/<name>.rss`, `res`/`cam` -> `data/res/`, `sch` -> `data/schemes/`; anything else is
used unchanged). Whether a picture keeps its own palette depends only on the loading function, not
on the extension:

| picture | loader | palette |
|---|---|---|
| IPLOGO, HSLOGO, TITLE, DRAW, VICTORY0-9, TEAM0-1 | `show_picture_wait` | own |
| GLUE0-6 (`glue%u.plt`), MAINMENU (`mainmenu.plt`), ROULETTE (`roulette.plt`) | `graf_load_pcx_to_target` into background | remapped |
| RESULTS (`results.plt`) | `graf_load_pcx_to_target` into window buffer | remapped |
| FIELD0-10 (`field%u.plt`) | `graf_load_field_bitmap` / options preview | remapped |
| WINZ (`winz.plt`) | `pcx_load_remapped` (window skin) | remapped |
| help-file images `<IMGname>` (POW*, CREDBAR, JERM, KURT, QALOGO, BOMBDUDE) | `pcx_load_remapped` | remapped |

(BONUS.PCX and KURTHEAD.PCX are not referenced by the code. The strings "@roulette.plt" /
"@font%d.fon" in strings.txt are artefacts: the code references the address after the '@'.)

### 2.5 Remapping a picture to the game palette
`pcx_load_remapped(path,&w,&h)` (0x4150f0 -> `datafile_read` 0x41be63) = `pcx_load` (8-bit
palette kept in `datafile_palette` 0x4617c4) followed by `pcx_remap_to_palette` (0x41bbbd):
```
map[0] = 0                                        // PCX index 0 ALWAYS becomes idx 0 (black), whatever its colour
for i in 1..255: map[i] = colorTable[((pal8[i].r>>3)<<10) | ((pal8[i].g>>3)<<5) | (pal8[i].b>>3)]
for every pixel: p = map[p]
```
Consequences (replicate): colours are quantised to RGB555 and then to the nearest game-palette
entry stored in COLOR.PAL's table; RESULTS.PCX (palette[0] = (74,32,98), 650 pixels use index 0)
and ROULETTE.PCX (palette[0] = (235,232,243), 706 pixels) show those pixels **black**.

`graf_load_pcx_to_target(path)` (0x4151cc): `img = pcx_load_remapped(path); if img:
memcpy(graf_target, img, 640*480); free(img)`.

### 2.6 Fades, cycling, palette stack - none in use
* GNW `fadeSystemPalette(old,new,steps)` (0x42c4a0: `pal[i] = old[i] - (old[i]-new[i])*step/steps`
  for step = 0..steps-1, then `new`) has **no caller**.
* graf.c `graf_fade_in` (0x415c49: `setSystemPalette(game_palette)`, argument ignored) and
  `graf_fade_out` (0x415c6d: set all-black palette, argument ignored) have **no caller/reference**.
* `setSystemPaletteEntries` (0x42c578), `setSystemPaletteEntry` (0x42c60c): no caller -> no cycling.
* `colorPushColorPalette` (0x42d93c, saves mappedColor+cmap+colorTable = 0x8400 bytes, max 16,
  "colorpalettestack overflow") / `colorPopColorPalette` (0x42d9f4, "underflow"): no caller.
* `colorBuildColorTable` (0x42d03c, Spencer-Thomas inverse colormap) only runs if COLOR.PAL fails
  to load.

Palette changes therefore happen only at: init (COLOR.PAL), each own-palette picture, and
`palette_restore_game`. All are instantaneous.

Transition artefact (replicate): `show_picture_wait` first presents a cleared (all index 0) screen
with the *previous* palette. After IPLOGO (own palette entry 0 = (255,255,255)) the screen is
therefore briefly **white** before HSLOGO appears; after VICTORY1 (entry 0 = (255,213,82)) the
caller's clear+flip shows a yellow frame before `palette_restore_game`. Duration = time to load the
next PCX / until the palette restore (a few ms).

---------------------------------------------------------------------------------------------------

## 3. Sprites (ani.c 0x41c0ba-0x41db41, datafile.c 0x41bb56-0x41c0b9)

### 3.1 Loading
`ani_load_master` (0x41d695): opens `data/ani/master.ali`, for every line beginning with '-'
loads that ANI (`ani_load_one` 0x41d3b5), showing the "Loading data..." progress window
(`progress_window_update`, 6.6). Low-memory mode (`DAT_00464824 != 0`) skips `corner*` files whose number is
> 0 and `xplode*` files whose number is > 1. After loading, the sequence array is `qsort`ed by name
(comparator 0x41d669) so `ani_find_seq` (0x41d957) can binary-search (names are lower-cased).
Files not listed in MASTER.ALI (e.g. BFONT, CLASSICS, BOMANIM2, FLAME, TRIGBOMB, POWERS1/SO/SO2/SOK/Z,
PUNCH, NUCKBLOW, ZEN, APPLBITE, HEADWIPE, BOMBANIM, BOMBWALK, BPICKUP) are never loaded.

ANI container: "CHFILE" then records `{char id[4]; u32 size; u16 kind; data}`; kind==1 means
leaf (skip `size` bytes), otherwise the record contains sub-records inline. Within one file all
FRAM records are read first (frames get global numbers `file_base + local_index`), then all SEQ
records.

### 3.2 Frame record (CIMG) and conversion - `ani_read_fram` (0x41c837)
CIMG data: `u16 type; u16 flags; u32 dataref; u32 palref; u16 w; u16 h; i16 hot_x; i16 hot_y;
u32 key` (24 bytes); skip `dataref-24` bytes; then `u8 enctype; u8 ?; u16 hdrsize; u32 csize;
u32 usize`; skip `hdrsize-12`; then `csize` bytes of data.
* enctype 0x00: raw (csize must equal usize); enctype 0x11: RLE16 (`ani_rle_decode16` 0x41c0ba:
  byte c: 0xFF = end; c<0x80: copy c+1 16-bit pixels; c>=0x80: repeat next 16-bit pixel (c&0x7F)+1
  times); anything else -> fatal "unsupported enctype".
* `type & 7` must be 4 (16-bit RGB555); otherwise fatal "unsupported bits per unit count". Type 11
  (8-bit + palette, enctype 0x10) exists only in CLASSICS.ANI, which is never loaded - the game
  has no 8-bit frame path.
* Conversion, per pixel p (u16): `idx = colorTable[p]; if ((flags & 4) && p == key) idx = 0`.
  (No loaded frame has bit 15 set.) Frames without flag 4 (POWERS.ANI icons, EDIT.ANI, some
  MISC/POWBOTH/TILES frames) are therefore fully opaque rectangles.
* Frame table entry (12 bytes, array `ani_frames` 0x461b6c, count 0x461b68):
  `{i16 hot_x; i16 hot_y; i16 w; i16 h; u8 *bitmap}` (w*h bytes, pitch = w).

### 3.3 Cropping ("framebytes saved by cropping")
Every frame whose size is **not exactly 40x36** is cropped (`ani_crop_frame` 0x41c299, key = 0,
realloc = 1); 40x36 frames (all tiles) are kept as-is:
```
L = number of leading columns that are entirely 0;  T = leading rows entirely 0
R = trailing columns entirely 0;                     B = trailing rows entirely 0
w' = w - (L+R); h' = h - (T+B); compact the bitmap; hot_x -= L; hot_y -= T
```
Only pixels equal to 0 count as empty. No loaded frame is entirely empty (verified), so w',h' > 0.

### 3.4 Sequences
SEQ record: `char name[42]; u16; u16; u16; u16 state_count; u16`, then `state_count` STAT
records: `u16,u16,u16` + a FRAM sub-record `{u16 n; n x {u16 frameno; i16 dx; i16 dy; u16; u16}}`.
Sequence entry (60 bytes, array 0x461b5c, count 0x461b58): name at +0, state count at +0x34,
states pointer at +0x38 (20-byte states, frame-ref pointer at +0x10, 12-byte refs
`{frameno_global, dx, dy}`).
* `ani_seqno_to_frameno(seq, state)` (0x41daa7) = first frame ref of state `state % state_count`.
  Only the first frame ref of a state is ever used.
* `ani_seqno_stateno_get_offsets(seq, state, &dx, &dy)` (0x41db41) returns that ref's dx/dy.
* `ani_seq_state_count(seq)` (0x41da5c), by name 0x41da23.
* The HEAD/"dur=30" timing fields are not used for drawing; animation speed is driven by game code.

### 3.5 How a frame is positioned
All sprite draws take an anchor (x, y) and draw the frame at
```
screen_x = x - hot_x'      screen_y = y - hot_y'        (hot' = hotspot after cropping)
```
The per-state (dx, dy) offsets from the SEQ are **ignored by every caller except flames**
(`flames_update_draw` 0x426d06 is the only caller of `ani_seqno_stateno_get_offsets`). So for players,
bombs, powerups, extras, HUD digits, cursor, goldman sparkles, hurry sign etc.:
`screen = anchor - hotspot'`. For non-brick flames: anchor = (cell_center_x + dx,
cell_feet_y + dy - 18) (see flames-map-powerups.md). Board anchors: `cell_center_x = 20 + 20 +
40*col`, `cell_feet_y = 68 + 35 + 36*row` (0x426524 / 0x42655f; field origin (20,68), cells 40x36,
from `map_init` 0x42647a: `field_x = (640-15*40)/2`, `field_y = 480 - 11*36 - 16`).

---------------------------------------------------------------------------------------------------

## 4. Remap (player colour) tables - `graf_load_remap` (0x414a65, was `graf_load_remaps`)

Ten 256-byte tables `remap[0..9]` (0x460564) plus R,G,B percentages `remap_r/g/b[10]`
(0x460bd0/0x460bda/0x460be4). Table n is used for player colour index n.

```
graf_load_remap(n, R, G, B, rebuild):            // R,G,B from VALUELST 200+5n..202+5n
    remap_r[n],remap_g[n],remap_b[n] = R,G,B
    if (!rebuild && (fp = fopen("%u.rmp" (n), "rb"))):       // current directory = game root
        fread(remap[n], 256, 1, fp)
        remap_r[n] = fgetc(fp); remap_g[n] = fgetc(fp); remap_b[n] = fgetc(fp)  // FILE VALUES WIN over VALUELST
        fclose(fp)
        for i in 0..255: if remap[n][i] == 0: remap[n][i] = i   // 0 means "unchanged"
    else:                                                     // compute from the CURRENT system palette
        pal = getSystemPalette()                              // 6-bit, entry 0 = (0,0,0)
        for i in 0..255:
            (r,g,b) = pal[i]
            if (r < g && b < g):                              // "green" entry
                gray = (b + r) / 2;  d = g - gray             // unsigned / int truncation
                nr = gray + d*R/100;  ng = gray + d*G/100;  nb = gray + d*B/100
                best = 99999; j_best = i
                for j in 0..255:                              // first strict minimum wins
                    dist = (pal[j].g-ng)^2 + (pal[j].r-nr)^2 + (pal[j].b-nb)^2
                    if dist < best: best = dist; j_best = j
                remap[n][i] = j_best
            else remap[n][i] = i
        if (fp = fopen("%u.rmp","wb")): fwrite(remap[n],256,1); fputc(R); fputc(G); fputc(B); fclose
```
The shipped N.RMP files exist, so at runtime the **tables are read from the files** and the
RGB triples of the files replace VALUELST: 0 (100,100,100) white, 1 (15,15,10) black, 2 (100,0,10)
red, 3 (0,10,85) blue, 4 (0,100,0) green, 5 (100,100,0) yellow, 6 (0,90,95) cyan, 7 (95,0,90)
magenta, 8 (100,50,0) orange, 9 (50,0,100) purple.

Verified: running the generator with COLOR.PAL and the file RGBs reproduces all ten files except
entries whose nearest colour is idx 0 (black, (0,0,0) after invalidation, wins the tie against
idx 255): those are stored as 0 and therefore become **identity** after loading (entry 118 in tables
1,3,7,9; entry 141 in table 3). The remake should load the .RMP files (or apply the same 0->identity
rule).

Remapped ("green") palette indices for COLOR.PAL: those with g > r and g > b = **100..169 and
172..174** (73 entries; 170 and 171 are not green). Sprites are authored with these greens
("walk north green", "bomb regular green", "flame ... green", ...).

The RGB percentages are also used for the player's text colour (6.4). A debug remap editor
(0x4162f0/0x415ed1, toggled by a debug key handled in the match loop 0x42a3f6 when the KWD debug level is set)
adjusts R/G/B in steps of 5 (0..100) and calls `graf_load_remap(n, R,G,B, rebuild=1)`
("Reload Default Color" does the same); not needed for the remake.

Which table a sprite uses (all through draw type 3, see 5.3):
* player body: normally `player+0x3c` (assigned at round start: team play -> team 0 => 0 (white),
  team 1 => 2 (red); otherwise = player index). While `true_color_timer_ms` (0x4621e8, set to
  V32 (40) * 50 = 2000 ms at round start, decremented by the frame's elapsed ms in the player loop)
  is > 0, the **player index** is used instead (so team players show their own colour for the
  first 2 s). If the player has a disease and bit 3 of the disease timer (`player+0x78`, ms) is
  set, the index is `rand() % 10` instead (random-colour flicker; consumes the global `rand()`).
* bombs and flames: owner's `+0x3c`; goldman sparkles and the "kface" cheat sprite: table 0.
* "teamring%u" sprites exist only in the scheme editor (0x4028d2, misnamed `team_ring_draw`); team
  colours in the game are purely remap tables 0 and 2.

Other colour tables: none are used for drawing. There is no shadow/darken/translucency table (the
shadow is a solid black sprite, 5.5); the GNW intensity/mix/blend tables are computed at start-up
but never referenced by game code.

---------------------------------------------------------------------------------------------------

## 5. Drawing sprites

### 5.1 Clip rectangle
`clip` = (left 0x46058c, top 0x460590, right 0x460594, bottom 0x460598), right/bottom exclusive.
`graf_set_cliprect(r)` (0x415dd9) clamps r to (0,0,640,480). It is set to (0,0,640,480) in
`graf_init` and every game frame (0x42641f with 0x46221c); `map_draw_all` (0x42633c) computes a
play-field rectangle (field_x, 8, field_x+600, field_y+396) and immediately overwrites it with
(0,0,640,480). **Effective clip = whole screen** (sprites may overlap the HUD area).

### 5.2 Draw primitives (executed at flush time)
`graf_draw_frame(x, y, frame)` (type 0, 0x41537f):
```
bmp = ani_get_frame_bitmap(frame, &w, &h, &hx, &hy); pitch = w
sx = x - hx; sy = y - hy
if !(sx + w > clipL && sy + h > clipT && sx < clipR && sy < clipB) return
if sx < clipL: bmp += clipL - sx; w -= clipL - sx; sx = clipL
if sy < clipT: bmp += (clipT - sy) * pitch; h -= clipT - sy; sy = clipT
if sx + w > clipR: w = clipR - sx
if sy + h > clipB: h = clipB - sy
trans_buf_to_buf(bmp, w, h, pitch, target + sy*640 + sx, 640)     // source 0 = transparent
```
`graf_draw_frame_remap(x, y, frame, table)` (type 2, 0x4156c7): same clipping, then copies the
clipped rectangle into a temporary buffer with `out = (p == 0) ? 0 : table[p]` and blits it
transparently. `graf_draw_frame_solid(x,y,frame,colour)` (type 1, 0x4154cc: every non-zero pixel ->
colour) is never queued. No translucency or brightness blending exists.

### 5.3 The display list and the real z-order rule
Queue `graf_queue` 0x460bb0, 400 entries of 24 bytes `{type, x, y, frame, colour/index, table}`,
count 0x460bbc; adding the 401st entry -> fatal_error(10) "numgrafreqs".
* `graf_queue_sprite(x, y, frame)` (0x415920) - type 0.
* `graf_queue_sprite_remap(x, y, frame, color_index)` (0x415a9f) - type 3.
* (`0x415999` type 1 and `0x415a1c` type 2 are only used internally.)

`sprite_queue_flush` (0x415b22):
```
for (i = 0; i < count; i++)             // count is re-read every iteration
    e = queue[i]; stat_sprites++
    type 0: graf_draw_frame(e.x, e.y, e.frame)
    type 1: graf_draw_frame_solid(...)
    type 2: graf_draw_frame_remap(e.x, e.y, e.frame, e.table)
    type 3: k = clamp(e.index, 0, 9); APPEND type-2 entry (e.x, e.y, e.frame, remap[k])  // 0x4158cf
count = 0
```
Therefore **all type-0 sprites are drawn first (in queue order), then all remapped sprites (in the
order their type-3 requests were queued)**. Text printed with `graf_print` during the frame is
already in the window buffer, below everything queued.

### 5.4 In-game frame (`game_frame`, 0x42a191, a GNW background process registered by the match loop
0x42a3f6 (was `results_screen`); skipped while `game_paused` 0x4646ac)
Order of operations and of queueing (q0 = type 0, q3 = type 3):
1. elapsed ms (`DAT_00464958`, clamped to V31=150), net handling, `game_frame_counter`++ (0x464994).
2. HUD timer digits (q0) - `round_timer_update_draw` (0x4105d2, was `maybe_hud_init`), see 6.5.
3. `graf_restore_background()` (field + tiles + destroyed-brick floor, see 7.1).
4. clip := full screen.
5. extras (conveyors/arrows/trampolines...) (q0) - `extras_update_draw` 0x4056ca (was `extra_create_objects`).
6. bombs pass 0 = bombs not held by a player (`bomb+0x94 == 0`), including flying ones (q3) -
   `bombs_update(0)` (0x42331c via 0x4245b9).
7. powerups (q0) - `powerups_update_draw` 0x424f89 (was `maybe_power_create`).
8. flames and brick explosions (q3) - `flames_update_draw` 0x426d06 (was `flame_create`).
9. closing walls / tile regeneration (redraws background cells only) - `map_update_enclosement` 0x426818.
10. players 0..9 in index order (`players_update_all` 0x420f07): for each player i:
    `player_update(i)` (0x41f29b, was `player_update_anim`; queues shadow q0 + body q3 + kface q3, see 5.5), then the goldman
    sparkle spawn check (5.6), then, if the player slot is in use (`+0x10 != 0`), the HUD text
    `"S:%d K:%d"` (msg 37; S = i16 at +0x6a, K = i16 at +0x6c) via `graf_print(main, s, 90,
    x = V(115 + i/2) (10,110,210,310,410), y = V(113 + (i&1)) (6 or 26), player_text_color(i),
    player_text_outline_color(i))` (immediate) and, if the player is dead (`+0 == 0`), the "xxx"
    sprite (MISC.ANI, 77x20, hot (10,3)) at the same (x, y) (q0). After the loop: goldman sparkles
    update/draw (q3).
11. aliens/ghosts in campaign mode (q0).
12. bombs pass 1 = bombs held by a player (`bomb+0x94 != 0`) (q3) - `bombs_update(1)` via 0x42459a.
13. HURRY sign: if `55 < time_left_s < V101 (60)` (`round_time_left_s` 0x410578; returns 1001 for infinite time, so never): first time play sound 2700; if
    `(game_frame_counter & 4) != 0` queue "hurry" (HURRY.ANI, 278x91, hot (111,43)) at (320, 240)
    (q0) -> blinks 4 frames on / 4 off, per rendered frame.
14. watermark (empty), debug remap-editor overlay, `graf_flip()`.

Resulting visual stacking (bottom -> top): background; HUD text; HUD timer digits; extras;
powerups; player shadows / "xxx" markers; aliens; HURRY sign; then remapped sprites: free bombs
(incl. flying), flames, player bodies (+kface) in player order, goldman sparkles, held bombs.
(Quirk: the HURRY sign is drawn *under* bombs, flames and players.)

### 5.5 Player drawing block (inside `player_update` 0x41f29b, was `player_update_anim`, at 0x42071e)
```
graf_queue_sprite(p.x /*+0x1c*/, p.y /*+0x20*/, frame("shadow", 0))        // q0
if (p.disease_timer /*+0x78*/ & 8)  idx = rand() % 10
else if (true_color_timer_ms > 0)   idx = player_index
else                                 idx = p.color /*+0x3c*/
graf_queue_sprite_remap(p.x, p.y, body_frame, idx)                          // q3
if (player_index == kface_player /*0x45be3c, normally -1*/)
    graf_queue_sprite_remap(p.x - 4, p.y - 34, frame("kface <dir>", 0), 0)  // joystick cheat
```
Dying players use "die green %d" (state +0x30) with `p.color` and no shadow.
SHADOW.ANI: one 29x17 frame, hotspot (14,16), every non-transparent pixel is idx 255 (pure black):
an opaque black ellipse (rows of widths 9,17,21,23,25,27,29,29,29,29,29,27,25,23,21,17,9 centred),
drawn with the normal transparent blit - **no translucency**. There is no "invisible" disease and
no invulnerability blinking in the drawing code; the only disease visual is the random-colour
flicker above.

### 5.6 Goldman twinkle ("gold player" sparkles)
Spawn (`goldman_spawn_sparkle` 0x420d4e) is called from `players_update_all` every frame, for each
living player (`+0 != 0`), when not in attract mode (`DAT_00464938 == 0`), the gold option is on
(`DAT_004648bc != 0`) and the player matches the gold player `DAT_0046492c` (winner of the previous
match: player index, or in team play the team colour 0/2 compared with `(player+0x54 team) ? 2 : 0`;
-1 = none; set by the match loop, see match-flow):
```
find first free slot of 100 (16 bytes {active, x, y, state}); none -> return
if V1010 (5) != 0 and round_timer_elapsed_s() /*0x4105b0*/ >= V1010: return   // first 5 s of the round
if rand() % 6 == 0: return                                                       // 5/6 spawn chance per frame
slot = {active 1, x = p.x + rand()%40 - 20, y = p.y + rand()%50 - 48, state 0}  // rand() order: %6, x, y
```
Draw/advance (`goldman_sparkles_update` 0x420e39, called after the player loop): for each active
slot queue "goldman" (MISC.ANI, 13 states) state `slot.state` with remap table 0 (q3); if the
frame counter changed since the last call: `slot.state++`, and if `state > 13` the slot is freed.
(State 13 is drawn as state 0 because of the modulo -> one extra frame. Advances once per rendered
frame, not time-scaled.)

### 5.7 Other direct (non-queued) blits
* `graf_blit_opaque(src, x, y, w, h, srcPitch)` (0x4152d7) and `graf_blit_trans(...)` (0x41532b):
  no clipping, into `graf_target` (used for tiles and the options preview).
* `graf_copy_field_rect(x, y, w, h)` (0x4166bf): opaque copy of the same rectangle from
  `field_bitmap` into `graf_target` (pitch 640).
* `graf_fill_rect(x, y, w, h, idx)` (0x4168b5): `buf_fill` into the target.

---------------------------------------------------------------------------------------------------

## 6. Text

### 6.1 FON format and loading (GNW text.c, 0x431b1c-0x4321ee)
`load_font(n)` (0x431bbc) opens `font%d.fon` (game root) for n = 0..9 (FONT0, FONT1, FONT6 exist).
```
i32 num_glyphs; i32 height; i32 spacing; i32 junk; i32 junk      // 20-byte header
num_glyphs x { i32 width; i32 offset }                            // offset into glyph data
glyph data: size = height * ((width[num-1]+7)>>3) + offset[num-1]
glyph g: height rows of ceil(width/8) bytes, MSB = leftmost pixel
```
FONT0: 128 glyphs, h 17, spacing 1. FONT1: 256 glyphs, h 16, spacing 0. FONT6: 128 glyphs,
h 16, spacing 0 (max glyph width 17). The first loaded font (FONT0) is the GNW default;
**`graf_init` selects FONT6 (`text_font(6)`) and nothing changes it afterwards** (only the unused
installer code selects font 0). Characters >= num_glyphs are skipped (no advance).

Function pointers (0x45c378..0x45c394): `text_to_buf`, `text_height`, `text_width`,
`text_char_width`, `text_mono_width`, `text_spacing`, `text_size`, `text_max`.
* `text_height()` = height (16).
* `text_width(s)` = sum over chars c < num of `width[c] + spacing` (trailing spacing included).
* `text_max()` = max(width) + spacing; `text_mono_width(s)` = text_max()*strlen(s).

`text_to_buf(buf, s, swidth, pitch, color)` (0x431f70):
```
if color & 0x10000: text_to_buf(buf + pitch + 1, s, swidth, pitch, (color & 0xFFFEFF00) | colorTable[0])  // shadow
mono = color & 0x40000 ? text_max() : 0
p = buf
for c in s:
    if c >= num: continue
    w = width[c]
    if mono: end = p + mono; p += (mono - spacing - w) / 2
    else:    end = p + w + spacing
    if end - buf > swidth: break                         // whole glyphs only
    plot rows: for y < height, for x < w: if bit set: p[y*pitch + x] = color & 0xFF
    p = end
if color & 0x20000: underline row height-1 from buf for (p - buf) pixels
```
(0x20000/0x40000 are never used. The 0x10000 drop shadow IS used: by GNW for text-button labels and
list titles, and by the game for the scheme and campaign list items (WHITE|0x10000) — see
docs/re/gnw-widgets.md §2.1. `graf_print` passes 0x2000000, which only means "no background" for GNW
`win_print` and is ignored by `text_to_buf`.)

### 6.2 `graf_print(win, str, maxw, x, y, fg, bg)` (0x41696c, Watcom: EAX,EDX,EBX,ECX + 3 stack)
```
w = min(text_width(str), maxw); pitch = w + 2; H = text_height() + 4
tmp = malloc(pitch*H); memset(tmp, 0, pitch*H)
text_to_buf(tmp,               str, w, pitch, bg)   // (0,0)
text_to_buf(tmp + 2*pitch + 2, str, w, pitch, bg)   // (2,2)
text_to_buf(tmp + 2*pitch,     str, w, pitch, bg)   // (0,2)
text_to_buf(tmp + 2,           str, w, pitch, bg)   // (2,0)
text_to_buf(tmp + pitch + 1,   str, w, pitch, fg)   // (1,1)
if x + pitch > win_width(win) || y + H > win_height(win): fatal_error(0x69) "graf_print: coords off screen"
trans_buf_to_buf(tmp, pitch, H, pitch, win_buf(win) + y*win_width + x, win_width)
```
So: text with a **1-pixel diagonal outline** (the bg colour drawn at the four diagonal offsets of
every lit pixel - orthogonal neighbours are not filled), no background fill, no clipping (off-window
text aborts the program), drawn immediately into the window buffer (ignores the sprite clip rect).
The glyph top-left is at (x+1, y+1). Text wider than `maxw` loses whole trailing glyphs.

`graf_print_centered(win, str, cx, y, fg, bg)` (0x4172ba): `W = text_width(str) + 2;
graf_print(win, str, W, cx - W/2, y, fg, bg)` (C truncating division).

### 6.3 Text colour globals (bytes of `colorTable`, i.e. nearest palette entry to an RGB555)
| global | RGB555 (r5,g5,b5) | idx | displayed RGB | typical use |
|---|---|---|---|---|
| 0x495390 | 0x0000 (0,0,0) | 255 | (0,0,0) | outline/bg colour, black |
| 0x49d38f | 0x7fff (31,31,31) | 72 | (240,248,252) | white text, team 0 |
| 0x49d37a | 0x7fea (31,31,10) | 182 | (252,248,88) | yellow (dialogs, menus, "%d%%") |
| 0x49a390 | 0x5000 (20,0,0) | 248 | (164,0,0) | dark red (dialog outline) |
| 0x497f8f | 0x2bff (10,31,31) | 97 | (96,252,252) | cyan ("Press F1 for help", winner text) |
| 0x49d0da | 0x7d4a (31,10,10) | 254 | (252,80,80) | light red, team 1 |
| 0x49a624 | 0x5294 (20,20,20) | 178 | (168,168,164) | light grey (progress bar, menus) |
| 0x497cda | 0x294a (10,10,10) | 205 | (88,84,80) | remap editor window |
| 0x497f7a | 0x2bea (10,31,10) | 133 | (100,232,72) | remap editor |
| 0x497498 | 0x2108 (8,8,8) | 142 | (60,68,56) | GNW mouse pointer outline |

### 6.4 Player text colours
`player_text_color(i)` (0x41672f): team play -> `team_text_color(team(i))` (0x4141f8: team 0 =
idx 72, team 1 = idx 254); else `colorTable[(min(R/3,31)<<10)|(min(G/3,31)<<5)|min(B/3,31)]` with the
remap table's R,G,B percentages: players 0..9 -> idx 72, 194, 242, 49, 113, 181, 94, 15, 206, 37.
`player_text_outline_color(i)` (0x416867): no team play and i == 1 (the black player) -> white
(idx 72), otherwise black (idx 255).

### 6.5 Sprite fonts
In-game timer (`round_timer_update_draw` 0x4105d2, was `maybe_hud_init`): text `"%u:%02u"` (msg 281) of the remaining seconds;
for each char c with 0 <= c-'0' <= 10 (':' = state 10) queue (q0) state `c-'0'` of sequence
**"numeric font" (KFONT.ANI)** at (x, V111=36), starting x = V110=525, then
`x += cropped_frame_width + V112 (4)`. Infinite time (setting 1001) draws "infinity" (KFONT frame
11) at (525,36). Digit hotspots are near the bottom (e.g. 18x27, hot (9,26)) and state offsets are
ignored. A red colour is computed for t <= 30 s but never used (dead code). BFONT.ANI (same
"numeric font" art) is not in MASTER.ALI.

### 6.6 Dialog / UI windows (GNW, used by menus)
* `win_add(x,y,w,h,color,flags)` (0x43c734) fills the new buffer with `color` (0x100 means
  `colorTable[0x294a]`); it also calls `rand()` twice (texture offsets) - every dialog creation
  advances the global RNG.
* `window_fill_winz(win)` (0x41726b) -> `blit_nine_slice(winz, 72, 72, buf, W, H)` (0x416b43):
  cells of 24x24; (1) centre cell tiled over the whole window, (2) top/bottom edge cells tiled
  along x at y=0 and y=H-24, (3) left/right edge cells tiled along y at x=0 and x=W-24, (4) the four
  corners; every piece clipped to the window; opaque copies.
* Loading/progress window (`progress_window_update(percent)` 0x412e33): 360 x 8h window at (150,200) (h =
  16), WINZ skin, "Completion" white at y = 1.5h centred, percentage `"%d%%"` yellow at y = 3.5h,
  white box (30, 5.5h)-(331, 6.5h), light-grey bar `percent*3` wide from (31, 5.5h+1), rest black;
  deleted at 100 %.
* `msgbox_ok` 0x414340 / `msgbox_yes_no` 0x41456c / `list_select_dialog` 0x41485a: see screens docs.
* GNW mouse pointer: built-in 8x8 arrow (data 0x45c310: 1 = idx 142, 15 = idx 72, 0 =
  transparent), hotspot (1,1); hidden except in the scheme editor, help viewer and some dialogs.

---------------------------------------------------------------------------------------------------

## 7. Backgrounds and screens

### 7.1 Play field
`round_start` (0x410b6e, was `maybe_level_load`): `graf_target_background(); map setup (0x4260f5);
graf_load_field_bitmap(datafile_path("field%u.plt" % level /*0x46499c*/)); map_draw_all();
graf_target_screen(); graf_restore_background(); graf_flip()`.
* `graf_load_field_bitmap(path)` (0x4165fc): frees the old one, `field_bitmap =
  pcx_load_remapped(path)`; fatal if missing or not 640x480.
* `map_draw_all` (0x42633c): `graf_copy_field_rect(0,0,640,480)` then `map_draw_cell(c,r)` for all
  15x11 cells (clip rect computation is dead, see 5.1).
* `map_draw_cell(col,row)` (0x425d22): `px = 20 + 40*col, py = 68 + 36*row`;
  `graf_copy_field_rect(px, py, 40, 36)` (restore floor); if cell != 0: sequence
  `"tile %u solid"` (cell == 1) or `"tile %u brick"` (any other non-zero value) with %u = level,
  state 0, and `graf_blit_trans(bitmap, px, py, 40, 36, 40)` - **tiles are drawn at the cell's
  top-left, hotspot ignored**, transparent pixels show the floor.
* Changes to the map (brick destroyed, walls closing in, editor) call 0x425e9b/0x425efc which set
  the cell and redraw it into the **background buffer** (`graf_target_background` /
  `map_draw_cell` / `graf_target_screen`). Bricks and solid blocks are never sprites.

### 7.2 Glue screens and other backgrounds
`graf_show_random_glue()` (0x4148e5):
```
n = V16 >= 2 ? V16 : 1                    // V16 = 7
k = rand() % n                            // signed modulo
graf_target_background(); graf_load_pcx_to_target(datafile_path("glue%u.plt" % k)); graf_target_screen()
```
Called once when entering: the player/input selection screen (0x410f81), the match options /
level select screen (0x406dde), the settings screen (0x4080dc), the net host / join screens
(0x42b0ce, 0x42b47d), the scheme editor (0x4028d2) and the editor menu (0x403184).
Each entry draws a new random glue. Main menu: `mainmenu.plt` into the background; roulette:
`roulette.plt` into the background; results: `results.plt` directly into the window buffer.
Menu frames then follow the pattern restore_background -> graf_print texts -> queue sprites
(menu cursor etc.) -> graf_flip.

### 7.3 Menu cursor ("cursor1") - `graf_cursor(x, y)` (0x413bd6)
Not the mouse pointer: the blinking bomber-dude marker beside menu items (MISC.ANI "cursor1",
5 states, frames 32x32, hotspot (16,31)).
```
now = time(NULL)                           // seconds (Watcom time() rounds ms >= 500 up)
if now >= next_blink /*0x46055d*/:
    blink_state /*0x460559*/ = 1
    next_blink = now + rand() % max(1, V691) + V690          // V690 = V691 = 2 -> 2 or 3 s
elif blink_state != 0:
    blink_state++; if blink_state >= state_count("cursor1") (5): blink_state = 0
graf_queue_sprite(x, y, frame("cursor1", blink_state))
```
One state per call (= per rendered menu frame). Consumes `rand()`.

### 7.4 Help viewer (0x41302d, was `graf_load_images`)
600x440 window at (20,20) with WINZ skin; text lines of a .BM file (tabs = 4 columns); `<IMGname>`
tags load `name.plt` remapped and draw it transparently inline. Details: screens/menus docs.

### 7.5 Options level preview (0x406aa3)
Into the background buffer: white (idx 72) frame rectangle, a crop of `field%u.plt` (random level if
the level setting is random: `rand() % V35`), then a 5x5 sample of tiles (`rand() % 5 != 0` ->
brick) blitted with `graf_blit_trans`. Consumes `rand()`.

### 7.6 Screenshot
GNW screendump key **Alt-C** (0x12e) is left enabled (only the pause key is disabled): writes
`scr%.5d.bmp` (first non-existing 00000..99999) in the current directory: Windows BMP, 8 bpp,
640x480 bottom-up, 256 palette entries = system palette `(b<<2, g<<2, r<<2, 0)`. Not needed for
the remake.

---------------------------------------------------------------------------------------------------

## 8. Whole-screen effects
None. The draw primitives have no global offset (no shake); no palette changes during play (no
explosion flashes); the only time-varying overlays are the HURRY sign blink (5.4), disease colour
flicker (5.5) and goldman sparkles (5.6).

---------------------------------------------------------------------------------------------------

## 9. Data structures / globals (summary)
| address | size | meaning |
|---|---|---|
| 0x45c000 | 768 | `cmap` GNW master palette (6-bit) |
| 0x464b50 | 768 | `systemCmap` palette last sent to hardware |
| 0x464e50 | 64 | gamma table (identity) |
| 0x465290 | 256 | `mappedColor` |
| 0x495390 | 32768 | `colorTable` RGB555 -> idx |
| 0x46059c / 0x46089c | 768 | graf current / default game palette (6-bit) |
| 0x4617c4 | 768 | palette (8-bit) of the last loaded PCX |
| 0x460564 | 10 x ptr | remap tables |
| 0x460bd0/da/e4 | 10 x u8 | remap R/G/B percent |
| 0x460bb0 / 0x460bbc | 400 x 24 / int | sprite queue / count |
| 0x46058c..0x460598 | 4 x int | clip rect (l,t,r,b) |
| 0x460bc4 / 0x460bc8 | ptr / int | draw target / pitch |
| 0x460bcc | ptr | background buffer 640x480 |
| 0x460bc0 | ptr | field bitmap 640x480 |
| 0x460bac, 0x460bb4, 0x460bb8 | ptr,int,int | WINZ skin bitmap, w, h |
| 0x464ae4 | int | main window id |
| 0x464a70 / 0x464a6c | int | 640 / 480 |
| 0x461b6c / 0x461b68 | ptr/int | frame table (12 bytes each) / count |
| 0x461b5c / 0x461b58 | ptr/int | sequence table (60 bytes each) / count |
| 0x464994 | int | game frame counter (HURRY blink, sparkles) |
| 0x4621e8 | int | true-colour timer (ms) |
| 0x45be3c | int | kface cheat player (-1 = none) |
| 0x4621cc | ptr | 100 goldman sparkles {active,x,y,state} |
| 0x49d810 | 10 x 20 | loaded fonts; 0x49da90 = current font |
| 0x45c4b0/b4/bc | ptr | IDirectDraw / primary surface / palette |

---------------------------------------------------------------------------------------------------

## 10. Uncertain
* Exact semantics of `player+0x78` beyond "disease elapsed-time counter in ms, 0 = healthy"
  (from 0x41f674: incremented by the frame's elapsed ms while non-zero, cured when it exceeds `+0x7c`).
  The flicker test is literally `(byte)(timer) & 8`; see the player doc for how the timer starts.
* GNW `win_add` colour argument `0x100`: filled with `colorTable[0x294a]` when the GNW texture flag
  (0x4a39ac) is 0 - irrelevant visually because the WINZ skin overwrites the whole window.
* `ani_find_seq` binary search has odd termination logic (decompiler output unclear); all lookups
  in the shipped data succeed, so a plain name->sequence map is equivalent.
* Presentation timing: since there is no vsync, the frame rate is whatever the game loop runs at
  (see engine doc); exact tearing behaviour cannot be reproduced and is irrelevant.

## 11. Bugs & quirks (replicate unless noted)
1. **Deferred remap draws**: type-3 sprites are appended to the end of the queue, so every
   player-coloured sprite (bombs, flames, players, sparkles) is drawn above every plain sprite
   (shadows, powerups, extras, HURRY sign, HUD digits) regardless of position. HURRY appears
   behind players/bombs/flames.
2. No y-sorting: players overlap strictly by index (player 9 on top), bombs/flames by slot order.
3. Per-state (dx,dy) sequence offsets are ignored for all sprites except flames.
4. PCX index 0 is forced to idx 0 (black) on remapped pictures (RESULTS, ROULETTE artefacts).
5. Remap entries whose nearest colour is idx 0 are stored as 0 in .RMP files and reload as
   identity (118 in tables 1,3,7,9; 141 in table 3). A freshly *computed* table (no file) would
   instead map them to 0 = transparent (holes in sprites) until reloaded.
6. Own-palette screens: the hardware shows `v8 & 0xFC`; `game_palette` is left holding 8-bit values
   until `palette_restore_game` (harmless because the fade-in that would use it is dead code).
7. White/yellow flash frames between picture screens (2.6).
8. `show_picture_wait` resets the game frame counter to 0x40 (watermark hack).
9. `graf_print` aborts the game (fatal error 0x69) instead of clipping when text exceeds the window.
10. Goldman sparkle shows an extra frame (state 13 == state 0); sparkles and HURRY blink advance per
    rendered frame (frame-rate dependent), unlike most game timing.
11. Cosmetic rand() consumers: disease flicker, `graf_cursor`, `win_add`, options preview, glue
    choice, sparkles - they advance the shared CRT `rand()` stream (relevant only if the remake
    reproduces the original RNG sequence).
12. Dead code: fades, palette stack, palette-entry setters, solid-colour sprite type, play-field
    clip rect, `graf_load_background` (0x415d15), unused HUD timer colour, empty watermark.
