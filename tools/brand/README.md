# Boom Buds artwork rebrand

Edited copies of the original 1997 pictures (`C:\Games\BOMBERMAN\DATA\RES\*.PCX`) with the game
name changed to **Boom Buds**. Every output is an 8-bit palettised PNG with the same size (640x480)
and exactly the same 256-colour palette as its source PCX; only pixel indices change, and only in
the areas listed below. The originals are never modified.

Each picture has its own authoring script. Regenerate with:

```
py -I <script> <source.pcx> <out.png>
py -I title_brand.py   C:\Games\BOMBERMAN\DATA\RES\TITLE.PCX    TITLE.png
py -I glue1_brand.py   C:\Games\BOMBERMAN\DATA\RES\GLUE1.PCX    GLUE1.png
py -I glue2_brand.py   C:\Games\BOMBERMAN\DATA\RES\GLUE2.PCX    GLUE2.png
py -I results_brand.py C:\Games\BOMBERMAN\DATA\RES\RESULTS.PCX  RESULTS.png
py -I field10_brand.py C:\Games\BOMBERMAN\DATA\RES\FIELD10.PCX  FIELD10.png
py -I mainmenu_brand.py C:\Games\BOMBERMAN\DATA\RES\MAINMENU.PCX MAINMENU.png
```

Requirements: Python 3.10 with Pillow, numpy, scipy and scikit-image (GLUE2 only); Windows fonts
`SHOWG.TTF` (TITLE, shape of the S), `COOPBL.TTF` (GLUE2, shape of the S), `ARLRDBD.TTF` (FIELD10).
All scripts are deterministic (fixed random seeds).

## Outputs

| File | Source | What changed |
|---|---|---|
| `TITLE.png` | TITLE.PCX | "ATOMIC BOMBERMAN" logo replaced by a two-line **BOOM / BUDS** logo in the same 3D letter style. Row 1 reuses the original "B"+bomb (from BOMBERMAN) and bomb+"M" (from ATOMIC), so both O's are the original fused bombs; row 2 keeps the original second B in place (the antenna still overlaps it) and adds U, D, S drawn to the B's metrics and shaded with the B's exact face colours, dither, rims and outline. The orange glow was refitted and re-centred behind the shorter logo, the area under the old letters re-starred; TM moved next to the new logo. Character, match flame and the rest of the scene untouched. |
| `GLUE2.png` | GLUE2.PCX | Brick wall "ATOMIC / BOMBER / MAN" replaced by **BOOM / BUDS** in the same painted lettering (translucent yellow fill with the bricks/mortar showing through, dithered blue outline of the same width). B, O, O, M, B are the original letter shapes; U built from the O, D from the B, S matched to the stroke weight. The wall under the old letters was rebuilt from the picture's own bricks (256 px horizontal repeat, 4-row bond), so every seam lies on mortar. |
| `GLUE1.png` | GLUE1.PCX | Tiled "A.B." emblem changed to **B.B.** in every tile: the A is removed (bomb/diamond plate restored by exemplar inpainting within the tile) and the tile's own B is copied into its place with the same spacing and translucency. |
| `RESULTS.png` | RESULTS.PCX | Header "BOMBERMAN RESULTS" changed to **BOOM BUDS RESULTS** along the same wave, using the picture's own letters (B, O, M from BOMBERMAN; U, S from RESULTS; D = left half of the B + right half of the O). Nebula/starfield behind the old word rebuilt by patch inpainting; the hanging bomb and RESULTS untouched. |
| `FIELD10.png` | FIELD10.PCX | Manhole cover lettering "Atomic" / "BomberMan" replaced by raised **Boom** (top) / **Buds** (bottom) in dark channels along the recess wall, like the original relief (light letters with a dark rim on the shadow side). The waffle grid and wall under the old words were restored from the cover's own grid rows; bolt holes and central bar untouched. |
| `MAINMENU.png` | MAINMENU.PCX | (done earlier) "About Bomberman" / "Exit Bomberman" menu items changed to "About Boom Buds" / "Exit Boom Buds" using glyphs cut from the menu itself. |

## Notes

- File numbering: the brick wall picture is **GLUE2.PCX** and the "A.B." tile pattern is
  **GLUE1.PCX** (GLUE3.PCX is a plain bomb pattern without text), so the outputs are named after
  their real sources.
- All other `DATA\RES\*.PCX` files were checked: none shows the game name. GLUE4's "BOMBFLAKES"
  cereal box is a parody brand (its tiny labels are illegible fine print), IPLOGO/HSLOGO/QALOGO
  are publisher/QA logos and out of scope.
