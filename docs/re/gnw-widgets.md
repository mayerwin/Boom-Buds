# GNW widgets in BM95.EXE: pixel-exact specification

Scope: every UI element that BM95 draws through the GNW window library (the Fallout-1 "GNW" by Tim Cain),
plus the BM95 wrappers on top of it: window background, WINZ skin, text buttons, message boxes,
list selection, text input, yes/no question, progress window, `.BM` help viewer, Alt-D debug window and
the GNW mouse cursor. Everything here is **verified against the BM95 disassembly**, where BM95 differs
from fallout1-ce (see §10), **and re-rendered pixel for pixel** by a reference renderer compared with
screenshots of the original game (see §11).

Machine-readable tables (lighten table, colour indices, cursor bitmap, FONT6 widths, palette):
**`docs/re/gnw-data.json`**. Reference screenshots: scratchpad `caps/ref/*.png` (408 files, see
`caps/ref/README.md` there); reference renderer: scratchpad `gnw_ref/` (`gnw.py` primitives,
`dialogs.py` widgets, `render.py` comparison, `gen_data.py` → gnw-data.json).

Conventions
* All colours are **palette indices** of the game palette (COLOR.PAL). Display RGB = 6-bit value × 4
  (`v << 2`). colorTable = the 32768-byte RGB555 → index table that follows the palette in COLOR.PAL.
* Coordinates are **relative to the window's top-left**, unless marked "screen". The screen is 640×480.
* `fh` = font height = 16 (FONT6.FON, the only font BM95 selects). `textW(s)` = Σ glyph widths
  (spacing 0). `text_max` = widest glyph + spacing = **17** (glyph '%').
* "C division" = truncate toward zero; all operands below are non-negative, so it is floor.

---------------------------------------------------------------------------------------------------

## 1. Colours

### 1.1 GNW window colours (`GNW_wcolor`, 0x45c46c, set by `win_init`)

| name | RGB555 | index | RGB (display) | used for |
|---|---|---|---|---|
| wc0 | 0x294A (10,10,10) | **205** | (88,84,80) | window colour 0x100, list / input field background, button face before lightening |
| wc1 | 0x3DEF (15,15,15) | **60** | (108,116,128) | light bevel |
| wc2 | 0x2108 (8,8,8) | **142** | (60,68,56) | dark bevel; mouse-cursor outline |
| wc3 | 0x5294 (20,20,20) | **178** | (168,168,164) | button text, list title |
| wc4 | 0x7FEB (31,31,11) | **182** | (252,248,88) | `win_get_str` title |
| wc5 | 0x7C00 (31,0,0) | 242 | (252,0,0) | (GNW pause window text; unreachable) |
| BLACK = colorTable[0] | 0x0000 | **255** | (0,0,0) | 1-px button/window outline, text shadow |

Game text colours (screens.md §0.3): WHITE 72, BLACK 255, GREY 178, CYAN 97, DKRED 248, YELLOW 182,
TEAMRED 254, RED 242. Note BLACK is **255**, never 0 (0 is the transparent index of all blits).

### 1.2 The lighten table (`lighten_buf`)

`lighten_buf(buf, w, h)` replaces every pixel `p` of the rectangle by `lighten[p]` (0x442c28):
`lighten[p] = intensityTable[p][147]` (table at 0x475390, built at start-up by 0x42c68c because
COLOR.PAL has no precomputed 'NEWC' tables). Formula:

```
(r,g,b) = COLOR.PAL entry p (6-bit);  r5 = r>>1, g5 = g>>1, b5 = b>>1
f = 19 * 0x200 = 0x2600                                    // column 147 = 128 + 19
lighten[p] = colorTable[ ((r5 + ((31-r5)*f >> 16)) << 10) | ((g5 + ((31-g5)*f >> 16)) << 5)
                         |  (b5 + ((31-b5)*f >> 16)) ]
lighten[0] = 0                                             // entry 0 of COLOR.PAL is invalid (>63) -> row zeroed
```
(i.e. each 5-bit channel moves 14.84 % of the way to white, integer arithmetic.) The 256 values are in
`gnw-data.json` → `lighten`. Values that matter: lighten[205] = **123** (108,112,108) = button face and
list highlight on wc0; lighten[142] = 205, lighten[255] = 194, lighten[60] = 60, lighten[178] = 14.

---------------------------------------------------------------------------------------------------

## 2. Drawing primitives (all on 8-bit index buffers)

| primitive | BM95 | rule |
|---|---|---|
| `buf_fill(x,y,w,h,c)` | 0x442a5c | opaque fill; w or h = 0 draws nothing |
| `draw_line` horizontal | 0x4421a0 | `memset(p1, c, x2-x1)`: pixels x1 … **x2-1** (right end NOT drawn) |
| `draw_line` vertical | 0x4421a0 | pixels y1 … **y2 inclusive** (BM95 loops while p1 <= p2; fallout1-ce has `<` and drops the middle pixel of odd lines — BM95 does not) |
| `draw_box(l,t,r,b,c)` | 0x442384 | lines in this order: top (l..r-1,t), bottom (l..r-1,b), left (l,t..b), right (r,t..b) → a complete 1-px rectangle l..r × t..b |
| `draw_shaded_box(l,t,r,b,lt,rb)` | 0x44240c | same order: top=lt, bottom=rb, left=lt, right=rb. Corner ownership: (l,t)=lt, (r,t)=**rb**, (l,b)=**lt**, (r,b)=rb |
| `lighten_buf(x,y,w,h)` | 0x442c28 | p := lighten[p] (§1.2) |
| `buf_to_buf` / `trans_buf_to_buf` | 0x4428b4 / 0x4428e4 | opaque copy / copy skipping index 0 |

### 2.1 GNW text: `text_to_buf(buf, s, swidth, pitch, color)` (0x431f70)

```
if (color & 0x10000)                                   // drop shadow
    text_to_buf(buf + pitch + 1, s, swidth, pitch, (color & 0xFFFEFF00) | colorTable[0])   // +1,+1 in index 255, drawn FIRST
x = 0
for each byte c of s:                                  // unsigned
    if c >= 128 (glyph count of FONT6): skip (no advance)
    w = width[c]; end = x + w (+ spacing 0)
    if end > swidth: stop                              // whole glyphs only, clipping is relative to buf
    plot the 1 bits of glyph c (16 rows, MSB = leftmost) at (x, 0) in color & 0xFF
    x = end
(0x40000 mono and 0x20000 underline exist but BM95 never uses them; 0x2000000 = "no background" for win_print)
```
* The shadow is the whole string again, offset (+1,+1), colour 255, drawn before the text, so text pixels
  cover it. It is clipped with the same `swidth` (so it can extend 1 px right of / below the text box).
* Text drawn with this routine has **no outline** — used by GNW widgets, list items and the help viewer.
* Characters: FONT6 glyph 0x18 / 0x19 (used as "↑"/"↓" labels) are small 8-px-wide tick marks, not arrows.
  Space is 12 px wide.

### 2.2 BM95 outlined text: `graf_print(win, s, maxw, x, y, fg, outline)` (0x41696c)

```
w = min(textW(s), maxw); tmp = zeroed (w+2) x (fh+4)
text_to_buf(tmp+(0,0)), (2,2), (0,2), (2,0) in `outline`; text_to_buf(tmp+(1,1)) in `fg`   (swidth = w each)
if (x + w+2 > winW || y + fh+4 > winH) fatal_error(0x69)      // never clipped
trans_buf_to_buf(tmp -> win at (x,y))                          // index 0 transparent
```
Glyph pixels land at (x+1, y+1); the outline = the 4 diagonal neighbours of every lit pixel.
`graf_print_centered(win, s, cx, y, fg, outline)` (0x4172ba): `W = textW+2; graf_print(win, s, W, cx - W/2, y, ...)`.
Message boxes, the progress window and the debug window use graf_print; GNW widgets do not.

### 2.3 `win_print` / `win_text` (list rows)

`win_text(win, items, n, maxw, x, y, color)` (0x43ced4): for each item: non-empty → `win_print(win, s, maxw,
x, y, color)`, empty string → separator: `draw_line(x, y+fh/2, x+maxw-1, …, wc2)` and the same one row
lower in wc1; y += fh. `win_print` returns without drawing if `x + maxw > winW` (unless flag 0x4000000) or
`y + fh > winH`; without flag 0x2000000 it first fills `maxw × fh` with the window colour; then
`text_to_buf(…, swidth = maxw, …)`.

---------------------------------------------------------------------------------------------------

## 3. Windows

### 3.1 `win_add(x, y, w, h, color, flags)` (0x43c734)
* Fails (returns -1) if 50 windows exist or w/h exceed the screen.
* `w->tx = rand() & 0xFFFE; w->ty = rand() & 0xFFFE` — **every window creation consumes two `rand()`
  values from the game's C runtime RNG** (texture offsets, unused because no GNW texture is loaded).
* Colour 0x100 → `colorTable[wc0]` = **205** (no texture loaded); a colour with a non-zero high byte would
  index wcolor; otherwise the value is used as is. The buffer is filled with that colour.
* `win_move` places it at (x,y), clamped so the window stays on screen.
* Flags used by BM95: 0x14 = MODAL | MOVE_ON_TOP (all dialogs), 4 = MOVE_ON_TOP (progress window, help
  viewer, debug window). Dialogs are drawn over the frozen screen; nothing below animates while a
  modal loop runs. Deleting the window restores the screen below from the other windows' buffers.
* **Refresh rule**: every `win_draw` / partial refresh first re-copies all buttons' current images into
  the window buffer (`GNW_button_refresh`), so buttons are always on top of anything drawn later in
  the same window.

### 3.2 `win_border(win)` (0x43ca60) — the plain GNW frame (text input, yes/no, pause)
```
lighten (5,0) (W-10)x5;  lighten (0,0) 5xH;  lighten (W-5,0) 5xH;  lighten (5,H-5) (W-10)x5    // 5-px lighter rim
draw_box(0,0,W-1,H-1, 255)
draw_shaded_box(1,1,W-2,H-2, lt=wc1 60, rb=wc2 142)
draw_shaded_box(5,5,W-6,H-6, lt=wc2 142, rb=wc1 60)
```
On a fresh window (fill 205) the rim becomes 123, the outer bevel 60/142 at 1 px, the inner bevel 142/60 at 5 px.

### 3.3 WINZ skin: `window_fill_winz(win)` (0x41726b → 0x416b43) — BM95's own dialogs
WINZ.PCX 72×72 (remapped to the game palette: `map[0] = 0`, `map[i] = colorTable[rgb555(pal[i] >> 3)]`),
cut into 3×3 tiles of 24×24. Opaque copies, each clipped to the window:
1. centre tile (src 24,24) tiled over the whole window from (0,0) in 24-px steps;
2. for x = 0, 24, 48, …: top-middle (src 24,0) at (x,0) and bottom-middle (src 24,48) at (x, H-24);
3. for y = 0, 24, …: left-middle (src 0,24) at (0,y) and right-middle (src 48,24) at (W-24, y);
4. corners: (0,0)→(0,0), (48,0)→(W-24,0), (0,48)→(0,H-24), (48,48)→(W-24,H-24).
The last column/row of each tiling pass is clipped (W, H need not be multiples of 24).

---------------------------------------------------------------------------------------------------

## 4. GNW text button (`win_register_text_button`, 0x432298)

Size **W = textW(label) + 16, H = fh + 6 = 22**. Two images are built once, at registration:

```
normal  = fill(win->color = 205); lighten whole image (→ 123)
          text_to_buf(normal at (8,3), label, swidth=W, color = wc3 178 | SHADOW)   // shadow at (9,4) in 255
          draw_shaded_box(2,2, W-3,H-3, lt=wc1 60, rb=wc2 142)
          draw_shaded_box(1,1, W-2,H-2, lt=wc1 60, rb=wc2 142)
          draw_box(0,0, W-1,H-1, 255)
pressed = fill(205)  (NOT lightened)
          text_to_buf(pressed at (9,4), label, W, 178 | SHADOW)                       // shadow at (10,5)
          draw_shaded_box(2,2, W-3,H-3, lt=wc2 142, rb=wc1 60)
          draw_shaded_box(1,1, W-2,H-2, lt=wc2 142, rb=wc1 60)
          draw_box(0,0, W-1,H-1, 255)
```
* BM95 draws the label **with the 0x10000 drop shadow** (fallout1-ce: no shadow) and the button height is
  fh+6 (fallout1-ce: fh+7).
* The face colour is the *window colour* (205 → 123), not the WINZ skin behind it: on WINZ dialogs the
  button is an opaque grey rectangle. The image is blitted opaquely.
* Buttons registered on the **main window** (keydefs screen: 12 "Key %u, %s" + "Return to default keys";
  editor powertype screen: 13 "Modify") use the main window's colour colorTable[0] = **255**: normal face
  = lighten[255] = **194** (36,36,28), pressed face = 255.
* The normal image is shown unless the **mouse** is pressed on the button (keyboard shortcuts never
  animate a button). A button only reacts after the mouse has *entered* it (hover is tracked on every
  poll). While the left button is held inside, the pressed image is shown; releasing inside sends the
  up-code and restores the normal image; dragging off restores the normal image and sends nothing.
  Codes: msgbox / get_str / yes_no / list "Done" buttons use the **up** code; the list arrows, the help
  viewer buttons, the keydefs buttons and the editor "Modify" buttons use the **down** code: they act on
  press and **auto-repeat while held** (GNW mouse repeat; verified: holding "\x19" ~0.7 s moved the list
  highlight from row 6 to the last row, holding "Page \x19" ~1.7 s paged CREDITS.BM from the top to the end).
  The track of a list (hot-spot, no image) sends PgUp/PgDn when pressed above/below the thumb.
* Quirk: a down-code button that opens a modal dialog (editor "Modify") never receives its release (the
  dialog eats it), so it **stays drawn pressed** after the dialog closes (verified,
  `editor_powerups_after_modify.png`).
* Labels used: " Ok ", " Yes ", " No " (msgs 27/26/25, with spaces), "Done", "Cancel", "Yes", "No",
  "\x18", "\x19", "Page \x18", "Page \x19", "Key %u, %s", "Return to default keys", "Modify".

---------------------------------------------------------------------------------------------------

## 5. Mouse cursor (GNW default shape)

8×8 bitmap at 0x45c310, colourised at start-up (0x430e4c): code 1 → colorTable[0x2108] = **142**,
15 → colorTable[0x7FFF] = **72**, 0 → transparent. Hotspot (1,1). `1` = outline, `F` = white fill:
```
1 1 1 1 1 1 1 .
1 F F F F F 1 .
1 F F F F 1 1 .
1 F F F F 1 1 .
1 F F F F F 1 1
1 F 1 1 F F F 1
1 1 1 1 1 F F 1
. . . . 1 1 1 1
```
* Position: image top-left `(mouse_x, mouse_y)`, initially **(319,239)** (= 639/2, 479/2), so the hotspot
  starts at (320,240). Relative mouse motion is added; the *hotspot* is clamped to 0..639 × 0..479.
* Drawn on top of everything (after all windows), only while shown: BM95 hides it on menus and shows it
  in message boxes / lists / text inputs (callers' `mouse_show`), the keydefs screen, the help viewer
  (if a mouse exists) and the editor. The position persists while hidden (motion is not read then).
* With the mouse resting inside a list, the list's row under the hotspot gets the highlight (§6.2).

---------------------------------------------------------------------------------------------------

## 6. Dialogs

### 6.1 `msgbox_ok(l1, l2, fg, outline)` (0x414340) and `msgbox_yes_no` (0x41456c)
```
both lines: w = max(textW(l1), textW(l2)), h = 2*fh;   one line: w = textW(that line), h = fh
w = max(w, 80);  W = w + 64;  H = h + 4*fh + 64            // 144 (one line) or 160 (two lines)
win_add((640-W)/2, (480-H)/2, W, H, 0x100, 0x14);  window_fill_winz
if l1: graf_print_centered(win, l1, W/2, fh+32 (=48), fg, outline)
if l2: graf_print_centered(win, l2, W/2, 2*fh+34 (=66), fg, outline)
msgbox_ok:     button " Ok "  at (W/2-32, H-fh-38 = H-54), up-code Esc
msgbox_yes_no: button " Yes " at (W/2-80, H-54) code 'Y';  " No " at (W/2+22, H-54) code 'N'
```
Single-line boxes pass the text as l1 (y = 48); an l2-only call would print at y = 66 (not used).
Captured boxes (screen x,y,W,H): exit question (146,168,348,144); duplicate input (75,160,490,160); team
sides (92,160,456,160); need two players (112,160,415,160); keydefs "NOTE!" (167,160,306,160); memory model
(29,160,582,160); networking disabled (113,160,414,160); campaign activated (183,160,274,160); prepare
campaign (177,160,286,160); editor fill (100,160,440,160), overwrite (76,160,488,160), save (120,160,400,160),
make-current (113,168,414,144).
Keys: msgbox_ok closes on Enter, Esc, Space (and its button); yes/no returns 1 for Enter, Space, 'Y', 'y',
0 for Esc, 'N', 'n', 'Q', 'q'. Every real key plays the letter sound (snd 20). Whether the mouse cursor is
visible depends on the caller (`mouse_show`): e.g. the setup-screen and exit boxes show it, the
"Networking is disabled" box (from `net_connect`) does not.

### 6.2 List selection: `list_select_dialog(title, items, n, 0, x, y, color)` (0x41485a → 0x42db80 → `win_list_select_at` 0x42dbcc)
mouse_show before, mouse_hide after. `start` = 0 always.

**Geometry**
```
lvw = max(textW(item));  W = lvw + 16
if textW(title) > W: lvw += textW(title) - W; W = textW(title)
W += 20;  cap = 10;  H = 13*fh + 22 = 230            (if win_add fails it retries with cap 9..6, H = (cap+3)*fh+22; never happens)
lvx = 8;  lvy = fh + 16 = 32;  maxy = lvy + cap*fh = 192
draw_box(0,0,W-1,H-1, 255);  draw_shaded_box(1,1,W-2,H-2, 60,142)
buf_fill(5,5, W-11, fh+3, 205)                                         // title strip
text_to_buf(at (W/2 - textW(title)/2, 8), title, swidth W, wc3 178 | SHADOW)   // BM95 adds the shadow
draw_shaded_box(5,5, W-6, fh+8 = 24, 142,60)
buf_fill(5, lvy-2, lvw+6, cap*fh+2, 205)                               // list background
initial offset/sel: start=0 -> offset 0, sel 0
win_text(items+offset, min(n,cap), lvw, 8, lvy, color | 0x2000000)     // rows at y = 32 + 16*i
lighten(8, lvy + fh*sel, lvw, fh)                                       // highlight
draw_shaded_box(5, lvy-3, lvw+10, maxy, 142,60)                         // list frame (29..192)
button "\x18" at (W-25, lvy-3 = 29)        down-code Up
button "\x19" at (W-25, maxy-fh-5 = 171)   down-code Down
button "Done" at (W/2-32, H-8-fh-6 = 200)  up-code Esc
sbx = W-21;  thumbY = lvy+fh+7 = 55;  knob = 14
buf_fill(sbx, 55, 15, (maxy-55) - fh - 8 = 113, 205)                    // track
draw_shaded_box(W-22, 54, sbx+15, maxy-fh-9 = 167, 142,60)              // track frame
draw_shaded_box(sbx, thumbY, sbx+14, thumbY+14, 60,142);  lighten(sbx, thumbY, 14, 14)   // thumb
```
Items use `color` = WHITE 72 (help files, baud rates, protocols, memory model) or **WHITE | 0x10000
(drop shadow)** for the scheme chooser and the campaign chooser.

**Keys** (no sounds; sel = highlighted row 0..cap-1, offset = first visible item):

| key | effect |
|---|---|
| Up | sel > 0 → sel-- (row redraw, see below); else offset > 0 → offset-- (full redraw) |
| Down | sel < cap-1 and sel < n-1 → sel++; else offset+cap < n → offset++ |
| PgUp | offset > 0 → offset = max(0, offset-cap) |
| PgDn | offset < n-cap → offset = min(offset+cap, n-cap) |
| Home / End | offset := 0 / n-cap (only if it changes). **The highlighted row number is kept** |
| letter a-z/A-Z | only if n > cap: first item (from the top) whose first char matches case-insensitively → offset = min(i, n-cap), sel = i-offset |
| Enter | return offset+sel |
| Esc / Done | return -1 |

Row redraw (selection moved, -3 path): the previous row is refilled (lvw × fh, 205) and its text redrawn
with `text_to_buf(row, item, swidth = W, color)`; then the new row is lightened.
Full redraw (scrolled, -4 path): fill (8, 32, lvw, cap*fh) with 205, `win_text` all visible rows, lighten
row sel; if n > cap: fill the old thumb 15×15 with 205, `thumbY = (maxy-lvy-2*fh-31) * offset / (n-cap)
+ lvy + fh + 7` (= 113*offset/(n-cap) + 55 with FONT6), draw the thumb as above.
The thumb only moves through this formula; with n <= cap it never moves.

**Mouse** (all verified by captures): each visible row is a hot-spot (enter-code 0x200+i, down-code
0x400+i). The hotspot resting over a row that holds an item moves the highlight there via the row-redraw
path (`helplist_hover_row3/6`) — including at dialog creation, so a list that opens under the cursor's
current position starts with that row highlighted (the protocol prompt at (150,150) opens with "Serial"
highlighted when the cursor is at its initial (320,240); the editor's scheme chooser opens on row 6 and
Enter then picks ASYLUM.SCH). Pressing on a row returns that item. Pressing in the track above/below the
thumb = PgUp/PgDn. The title strip (0,0,W,fh+8) is a drag handle: the dialog follows the mouse delta
(`helplist_dragged`: +60,+40). The arrow buttons act on press and auto-repeat.
Item lists used: help files (*.BM, alphabetical), "Available Scheme Files:" ("FILE.SCH: <-N, name>",
67 items), msg 1300 memory model (msgs 1310/1311), msg 620 protocol from the settings screen (msgs
629, 631–633: "Prompt each time", IPX, Modem, Serial) and from `net_connect` (msgs 630–633: "None - cancel",
IPX, Modem, Serial), msg 647 baud rates, msg 1250 campaigns (*.CAM).

### 6.3 Text input: `win_get_str(dest, maxlen, title, x, y)` (0x42e938) + `win_input_str` (0x42ff1c)
```
tw = max(textW(title) + 12, text_max * (maxlen + 1))           // BM95: maxlen+1 (fallout1-ce: maxlen)
W = max(tw + 16, 160);  H = 5*fh + 16 = 96
win_add(x, y, W, H, 0x100, 0x14);  win_border
buf_fill(14, fh+14 = 30, W-28, fh+2 = 18, 205)                     // field
text_to_buf(at (8,8), title, swidth W, wc4 182)                    // no shadow
draw_shaded_box(14, 30, W-14, 2*fh+16 = 48, 142,60)                // sunken field frame
button "Done" at (W/2-72, H-30 = 66) up-code Enter;  "Cancel" at (W/2+8, 66) up-code Esc
win_input_str(win, dest, maxlen, x0=16, y0=fh+16 = 32, fg = wc3 178, bg = 205)
```
With FONT6: maxlen 30 → W = **543** (node name, phone, editor names), maxlen 20 → W = **373** (port, IRQ,
editor numbers). All BM95 uses are at (25,180), the editor's powerup dialogs at (25,400).

`win_input_str`: the text is shown as `dest + "_"` (a literal underscore glyph is the cursor; **no
blinking**), drawn at (16,32) with `text_to_buf`, after filling `textW(shown) × fh` with 205 — the fill
covers only the current text width, the rest of the field keeps its fill from creation.
* Typing a byte 1..255 (when `len < maxlen`): append it, redraw. At `len == maxlen` keys are ignored.
* Backspace: if it is the **first key** of the session, the whole text is erased (fill the old width,
  show "_" only); later backspaces delete one character (the old "_" position is overdrawn by a space,
  i.e. the fill uses the *previous* width).
* Enter (or Done) → returns 0 with `dest` = the typed text; Esc (or Cancel) → -1 (caller keeps the old
  value). No sounds. Keys are GNW key codes, so Shift gives upper case.

### 6.4 Yes/no question: `win_yes_no(question, x, y, color)` (0x42ede0) — level editor only
```
W = max(textW(question) + 16, 144) + 16;  H = 3*fh + 16 = 64
win_add(x, y, W, H, 0x100, 0x14);  win_border
text_to_buf(at (16,8), question, swidth W, color)                  // color = WHITE 72 in all calls
button "Yes" at (W/2-64, H-8-fh-6 = 34) up-code 'y';  "No" at (W/2+16, 34) up-code 'n'
```
Returns 1 for Enter, Space, 'y', 'Y'; 0 for Esc, 'n', 'N'. Used at (25,400).
(`win_msg` 0x42ef58 — fatal-error box: W = max(textW+16, 80)+16, H = 3*fh+16, win_border, text at (16,8),
"Done" at (W/2-32, H-30), waits for Esc.)

### 6.5 Progress window (0x412e33) — "Loading data..." and the keydefs key capture
```
first call: win = win_add(150, 200, 360, 8*fh = 128, 0x100, 4)
percent clamped to 0..100;  window_fill_winz
tw = textW(title);  graf_print(win, title, tw, (360-tw)/2, fh+fh/2 = 24, WHITE 72, BLACK 255)
draw_box(30, 88, 331, 104, WHITE 72)
s = "%d%%";  graf_print(win, s, textW(s), (360-textW(s))/2, 56, YELLOW 182, BLACK 255)
buf_fill(31, 89, percent*3, 15, GREY 178);  buf_fill(31+percent*3, 89, (100-percent)*3, 15, BLACK 255)
win_draw;  percent >= 100 → delete window (next call creates a new one)
```
Titles: msg 201 "Loading data..." (start-up, percentage of MASTER.ALI read), `"Press key for '%s'"` (keydefs,
always 0 %), msg 57 "Connecting network object..." (network, 0 %).

### 6.6 `.BM` help viewer (0x41302d)
Window (20,20,600,440) colour 0x100, flags 4. Buttons registered once (all down-codes, all at y = 388):
"\x18" x=30 (Up), "\x19" x=60 (Down), "Page \x18" x=120 (PgUp), "Page \x19" x=190 (PgDn), "Done" x=516 (Esc).
Every redraw: `window_fill_winz`, then the text (below), then `win_draw` (buttons re-blitted on top).
* File read in **text mode** (CRLF → LF, **Ctrl-Z = end of file**; the shipped files end with 0x1A),
  `fgets(255)`, '\n' removed, an empty line becomes " ", then tabs expanded with the quirky counter
  (screens.md §7.2: after a TAB the column counter is one ahead, so tab stops drift).
* 21 lines per page (`344 / fh`), line k of the page at (34, 34 + 16k), `text_to_buf` swidth 532, WHITE 72,
  **no outline, no shadow**.
* `<IMGname>` (first tag of a line, name ≤ 19 chars): `DATA\RES\NAME.PCX` remapped; drawn after the text
  segment before it: `y = y0 - (img.h - fh)/2` (C division), transparent blit (index 0), clipped to
  y 34..377 (the image is skipped entirely if `y + h < 34` or `y > 378`), width clipped to the remaining
  text width; text after the tag continues at x + img.w. Lines 16 above/below the page are scanned so that
  tall images of neighbouring lines appear.
* Keys: Up/Down ±1 line, PgUp/Left −20, PgDn/Right +20, clamped to 0..max(0, nLines−21); Enter/Esc close.

### 6.7 Alt-D debug window (0x413d45)
`win_add(100, 100, 450, 300, 0x100, 4)`, `window_fill_winz`, lines with `graf_print(win, s, 400, 20, y,
WHITE, BLACK)` at y = 20 (msg 400), 40 (401), 70 (405 "Total mem: %u, Audio mem: %u"), 90 (410), 110 (411),
130 (415 "Critical retrans rate:%6.3f"), 150 (420 "Audio cache hits: %u%%"). No buttons, no cursor; Enter/Esc
close it. The values are machine-dependent.

### 6.8 GNW pause window — unreachable
GNW's default Alt-P "Paused" window exists (0x43a7c0: W = textW("Paused")+32 = 84, H = 3*fh+16 = 64,
centred, win_border, "Paused" at (16,8) in RED 242, "Done" button) but `graf_init` calls
`register_pause(-1, NULL)` (0x414e2f), so **Alt-P does nothing in BM95** (verified: capture
`round_altp_does_nothing.png` shows the round still running). screens.md §0.5 has been corrected.

---------------------------------------------------------------------------------------------------

## 7. RNG consumption

Each GNW window creation calls `rand()` twice: every msgbox, list, text input, yes/no, help-viewer open,
debug window, and the progress window when it is (re)created (once for "Loading data...", once per
key-capture). Buttons, redraws and key handling consume nothing. Only relevant for bit-identical RNG
streams (screens.md bug 16).

## 8. Things that look like bugs but are original behaviour

1. Home/End/PgUp/PgDn in a list keep the highlighted *row*, not the item.
2. Letter jump always picks the *first* matching item, and only when the list has more than 10 items.
3. `win_get_str`: the first Backspace clears the whole field.
4. Text input field width uses `text_max × (maxlen+1)`: the node-name box is 543 px wide for 30 chars.
5. Buttons' faces ignore the WINZ skin (grey rectangles on the blue skin).
6. Alt-P pause is disabled.
7. The `\x18`/`\x19` glyphs of FONT6 are small ticks, so the "arrow" buttons show ticks.

## 9. Not GNW, but drawn by BM95 into the main window
Menu texts (`graf_print` with outline), the blinking dude cursor, the main-menu trigger bomb, the level
preview etc. are specified in screens.md / graphics.md.

## 10. Differences between BM95's GNW and fallout1-ce (`src/plib/gnw`)

| item | fallout1-ce | BM95 (ground truth) |
|---|---|---|
| vertical `draw_line` | `while (p1 < p2)` → middle pixel of odd-length lines missing | `while (p1 <= p2)` → complete |
| text button height | fh + 7 | **fh + 6** |
| text button label | no shadow | **0x10000 shadow** |
| list title | no shadow | **0x10000 shadow** |
| `win_get_str` width | `text_max * maxlen` | `text_max * (maxlen + 1)` |
| `win_get_str` return | always 0 | result of `win_input_str` (0 / -1) |
| list initial `win_text` | `items + start` (bug) | `items + offset` |
| list -4 redraw | window refresh only if n > cap | always refreshed |
| `win_yes_no` | (not in fallout1-ce) | §6.4 |

## 11. Validation

`gnw_ref/render.py` (scratchpad) re-implements §1–6 on index buffers (FONT6.FON, WINZ.PCX, COLOR.PAL
from the game copy) and renders each case over the corresponding capture, then counts differing pixels
inside the window rectangles (cursor drawn where it was during the capture).

**Result: 91 cases, 7,379,644 pixels compared, 0 differing pixels.** (The renderer also detects
deliberate errors: wrong text colour → 1015 px, cursor misplaced → 56 px, wrong button state → 1074 px;
Ctrl-Z not treated as EOF in the viewer → 14,216 px.)

| widget | cases (capture files in caps/ref) | differing px |
|---|---|---|
| msgbox_yes_no (WINZ, outlined text, " Yes "/" No ") | exit question ×2 (cursor default / parked), exit with " No " pressed (mouse), memory model (2 lines), editor fill / overwrite / save / make-current ×2 runs | 0 |
| msgbox_ok | duplicate input ×2, team sides, need two players ×2, keydefs NOTE (WHITE/BLACK), networking disabled ×2, campaign activated, prepare campaign | 0 |
| list_select_dialog | help list: initial, Down×2, End, Down×5, hover row 3, hover row 6, arrow pressed (auto-repeat) / released, dragged; protocol (settings); protocol prompt ×3 (incl. hover-at-creation); baud list; scheme list ×8 (shadow text, Down, PgDn, End, letter T, Home, Up×11 scrolling, thumb movement); editor scheme list ×2 (hover); memory model ×2; campaign list (shadow); help list over the editor ×2 | 0 |
| win_get_str + win_input_str | node name ×5 (initial ×2, cleared by first Backspace, "abc", Shift "ABC"), port, IRQ, phone, editor rename, density, density typed "50", bornwith (maxlen 20 at 25,400) | 0 |
| win_yes_no | "Is 'Bomb' forbidden from randoms?", "Does 'Bomb' have an override?" (25,400) | 0 |
| progress window | "Loading data..." at 12, 14, 20, 35, 52, 60, 70, 76, 84, 90, 97 %; keydefs "Press key for 'Key 0, Move Up'" 0 % | 0 |
| help viewer (WINZ, text, inline images, 5 buttons) | CREDITS.BM top 0 / 120 / last page, "Page \x19" pressed / released; MANUAL.BM top 0 / 20 / 21 / 281 (power-up icons); HIGHMEM.BM (first run) | 0 |
| text buttons on the main window | keydefs screen 13 buttons ×2; editor "Modify" ×13 (normal) and after a Modify dialog (first one stuck pressed) | 0 |
| Alt-D debug window | in a round, on the main menu (values read from the capture) | 0 |
| mouse cursor | drawn inside the windows above wherever it was during the capture (initial position 319,239 and moved positions) | 0 |

Not re-rendered: the GNW pause window (unreachable), `win_msg` (only on fatal errors).
Capture-side caveat: cnc-ddraw occasionally presents the last GNW refresh up to ~1 s late (a moved list
highlight or the final cursor blit); three shots affected by this were recaptured with a longer wait.
