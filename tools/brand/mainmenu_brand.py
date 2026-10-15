"""Rebrand MAINMENU.PCX: "About Bomberman" -> "About Boom Buds", "Exit Bomberman" -> "Exit Boom Buds".
Glyphs are cut from the menu text itself (same font, colors and shading); 'd' is a mirrored 'b'.
Writes an indexed PNG (same palette) of the whole screen."""
import sys
import numpy as np
from PIL import Image

src = sys.argv[1]
out = sys.argv[2]
im = Image.open(src)
pal_flat = im.getpalette()[:768]
a = np.array(im).copy()
pal = np.array(pal_flat).reshape(256, 3)
rgb = pal[a].astype(int)
score = (rgb[:, :, 0] + rgb[:, :, 1]) // 2 - rgb[:, :, 2]
TEXT = score > 40          # solid text pixels
EDGE = score > 12          # anti-aliased fringe included when copying glyphs

LINES = {  # name: (y0, y1) inclusive rows of the line (with a little margin)
    'start': (110, 140), 'options': (221, 257), 'about': (257, 288), 'online': (294, 325), 'exit': (332, 362),
}

def segments(line):
    y0, y1 = LINES[line]
    cols = TEXT[y0:y1 + 1, 340:640].sum(axis=0)
    segs, inside = [], False
    for x, c in enumerate(cols):
        if c and not inside:
            s, inside = x, True
        elif not c and inside:
            segs.append((s + 340, x - 1 + 340)); inside = False
    if inside:
        segs.append((s + 340, len(cols) - 1 + 340))
    return segs

def glyph(line, idx, mirror=False):
    """Return (mask, pixels, baseline_offset) for glyph idx of a line; includes 1px fringe."""
    y0, y1 = LINES[line]
    x0, x1 = segments(line)[idx]
    x0 -= 1; x1 += 1
    m = EDGE[y0:y1 + 1, x0:x1 + 1].copy()
    p = a[y0:y1 + 1, x0:x1 + 1].copy()
    rows = np.where(TEXT[y0:y1 + 1, x0:x1 + 1].any(axis=1))[0]
    top, bottom = rows.min(), rows.max()
    if mirror:
        m = m[:, ::-1]; p = p[:, ::-1]
    return m, p, top, bottom

def baseline(line):
    """Most common bottom row (relative to the line's y0) among the line's glyphs."""
    from collections import Counter
    y0, y1 = LINES[line]
    c = Counter()
    for (x0, x1) in segments(line):
        rows = np.where(TEXT[y0:y1 + 1, x0:x1 + 1].any(axis=1))[0]
        c[rows.max()] += 1
    return c.most_common(1)[0][0]

def clean_patch(w, h):
    """Find a starfield patch without text or bright sparkles to erase old words."""
    best = None
    for (y0, y1) in [(LINES['start'][0], LINES['start'][1])]:
        for x in range(500, 640 - w + 1):
            region = rgb[y0:y0 + h, x:x + w]
            bright = region.max()
            if best is None or bright < best[0]:
                best = (bright, x, y0)
    _, x, y = best
    return a[y:y + h, x:x + w].copy()

def rebrand(line, word_first_idx, glyph_src):
    y0, y1 = LINES[line]
    segs = segments(line)
    wx0 = segs[word_first_idx][0] - 2
    wx1 = segs[-1][1] + 2
    h = y1 - y0 + 1
    # erase old word: tile clean starfield patches
    x = wx0
    while x <= wx1:
        w = min(40, wx1 - x + 1)
        a[y0:y1 + 1, x:x + w] = clean_patch(w, h)[:, :w]
        x += w
    base_bottom = baseline(line)
    cx = segs[word_first_idx][0] - 1
    for item in glyph_src:
        if item == ' ':
            cx += 14
            continue
        gline, gidx, mirror = item
        m, p, top, bottom = glyph(gline, gidx, mirror)
        gy0 = LINES[gline][0]
        # align source line baseline with this line's baseline (glyphs keep their own vertical offsets)
        dy = (y0 + base_bottom) - (gy0 + baseline(gline))
        hh, ww = m.shape
        for yy in range(hh):
            for xx in range(ww):
                if m[yy, xx]:
                    ty = gy0 + yy + dy
                    tx = cx + xx
                    if 0 <= ty < 480 and 0 <= tx < 640:
                        a[ty, tx] = p[yy, xx]
        cx += ww - 2 + 4  # glyph width (without fringe) + gap

# About line glyph indices: A0 b1 o2 u3 t4 | B5 o6 m7 b8 e9 r10 m11 a12 n13
# Exit line:  E0 x1 i2 t3 | B4 o5 m6 b7 e8 r9 m10 a11 n12
# Options line: O0 p1 t2 i3 o4 n5 s6
about_word = [('about', 5, False), ('about', 6, False), ('about', 6, False), ('about', 7, False), ' ',
              ('about', 5, False), ('about', 3, False), ('about', 8, True), ('options', 6, False)]
exit_word = [('exit', 4, False), ('exit', 5, False), ('exit', 5, False), ('exit', 6, False), ' ',
             ('exit', 4, False), ('about', 3, False), ('exit', 7, True), ('options', 6, False)]
print('about segs', segments('about'))
print('exit segs', segments('exit'))
print('options segs', segments('options'))
# glyphs must be read before modifications: snapshot source arrays
orig_a = a.copy()
def glyph_from_orig(*args, **kw):
    global a
    cur = a
    a = orig_a
    try:
        return _glyph(*args, **kw)
    finally:
        a = cur
_glyph = glyph
glyph = glyph_from_orig
rebrand('about', 5, about_word)
rebrand('exit', 4, exit_word)
outim = Image.fromarray(a.astype('uint8'), 'P')
outim.putpalette(pal_flat)
outim.save(out)
rgbout = Image.fromarray(pal[a].astype('uint8'))
rgbout.crop((330, 250, 640, 370)).resize((310 * 3, 120 * 3), Image.NEAREST).save(out.replace('.png', '_zoom.png'))
print('saved', out)
