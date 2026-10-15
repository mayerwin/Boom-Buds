"""Rebrand GLUE2.PCX: "ATOMIC / BOMBER / MAN" painted on a brick wall -> "BOOM / BUDS".

Usage: py -I glue2_brand.py <GLUE2.PCX> <out.png>

How it works (output keeps the picture's own 256-colour palette):
  1. The painted letters are removed and the wall is rebuilt. The wall picture repeats every
     256 px horizontally, so most pixels are copied from the same brick one or two tiles away.
     Where every copy is painted over, whole brick cells are copied from 4/8/12 brick rows
     away (the bond repeats every 4 rows with a 97 px shift), so every seam lies on mortar.
  2. New letters are painted with the original technique measured from the picture:
     yellow fill = 0.66 * yellow + 0.34 * wall underneath (mortar shows through),
     opaque blue outline (dithered between the two blues), ~9.5 px wide, anti-aliased edges.
     Letter shapes: B, O, O, M, B are the original letter shapes (BOMBER's B, O, M, B and
     ATOMIC's O); U is built from the O, D from the B, S from Cooper Black matched in weight.
     The two lines are set 1.18x the size of the original letters (two short words now fill the
     wall like the original three lines did), centred, with a slight stagger echoing the
     original diagonal layout.
"""
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage as ndi
from skimage.morphology import convex_hull_image

SS = 4
COOPER = 'C:/Windows/Fonts/COOPBL.TTF'   # shape of the S only
YELLOW = np.array([248.0, 250.0, 0.0])
FILL_ALPHA = 0.66
BLUE = np.array([58.0, 54.0, 218.0])
OUTLINE_R = 9.6
SCALE = 1.18          # letter size relative to the original BOMBER letters (fills the wall like the original)
LINE_SHIFT = (-14, 14)  # horizontal stagger of the two lines (echoes the original diagonal layout)


# ----------------------------------------------------------------------------- wall
def detect_paint(rgb):
    R, G, B = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    blue = (B > R + 60) & (B > G + 40)
    blue_c = ndi.binary_closing(blue, np.ones((3, 3)))
    lab, n = ndi.label(blue_c)
    sizes = ndi.sum(blue_c, lab, range(1, n + 1))
    keep = np.zeros(n + 1, bool); keep[1:] = sizes > 500
    outline = keep[lab]
    paint = ndi.binary_dilation(ndi.binary_fill_holes(outline), np.ones((5, 5)))
    return paint, outline, blue


def mortar_rows(L, clean):
    H = L.shape[0]
    rowm = np.array([L[y][clean[y]].mean() if clean[y].sum() > 50 else np.nan for y in range(H)])
    return [y for y in range(1, H - 1) if rowm[y] >= np.nanmax(rowm[max(0, y - 12):y + 13])]


def joints_for_bases(L, clean, rows, shift):
    W = L.shape[1]
    out = {}
    for base in range(4):
        acc = np.zeros(256); cnt = np.zeros(256)
        for k in range(base, len(rows) - 1, 4):
            n = (k - base) // 4
            y0, y1 = rows[k] + 6, rows[k + 1] - 6
            a_ = np.zeros(256); c_ = np.zeros(256)
            for x in range(W):
                ok = clean[y0:y1, x]
                if ok.sum() >= (y1 - y0) * 0.8:
                    a_[x % 256] += L[y0:y1, x][ok].mean(); c_[x % 256] += 1
            p = np.where(c_ > 0, a_ / np.maximum(c_, 1), np.nan)
            p = np.roll(p, shift * n)
            ok = ~np.isnan(p)
            acc[ok] += p[ok]; cnt[ok] += 1
        prof = acc / np.maximum(cnt, 1)
        hp = prof - ndi.uniform_filter1d(prof, 15, mode='wrap')
        cand = []
        for x in np.argsort(-hp):
            if all(min(abs(x - c), 256 - abs(x - c)) >= 50 for c in cand):
                cand.append(int(x))
            if len(cand) == 3:
                break
        out[base] = sorted(cand)
    return out


def rebuild_wall(a, paint, rows, joints, shift):
    H, W = a.shape
    out = a.copy()
    filled = ~paint
    ys, xs = np.nonzero(paint)
    done = np.zeros(len(ys), bool)
    for dx in (256, -256, 512, -512):          # same brick, neighbouring tile
        x2 = xs + dx
        ok = ~done & (x2 >= 0) & (x2 < W)
        ok[ok] = ~paint[ys[ok], x2[ok]]
        out[ys[ok], xs[ok]] = a[ys[ok], x2[ok]]
        done |= ok
    filled[ys[done], xs[done]] = True
    allrows = [rows[0] - 33] + rows + [rows[-1] + 32]
    nb = len(allrows) - 1
    for pas in range(2):
        srcimg = a if pas == 0 else out.copy()
        srcok = ~paint if pas == 0 else filled.copy()
        for kk in range(nb):
            k = kk - 1
            base = k % 4
            n = (k - base) // 4
            jabs = sorted(set(((j - shift * n) % 256) + 256 * m for j in joints[base] for m in range(-1, 4)))
            ya, yb = max(allrows[kk], 0), min(allrows[kk + 1], H)
            if yb <= ya:
                continue
            for i in range(len(jabs) - 1):
                xa, xb = max(jabs[i], 0), min(jabs[i + 1], W)
                if xb <= xa or filled[ya:yb, xa:xb].all():
                    continue
                best = None
                for dn in (1, -1, 2, -2, 3, -3):
                    kk2 = kk + 4 * dn
                    if not (0 <= kk2 < nb):
                        continue
                    dy = allrows[kk2] - allrows[kk]
                    for m in range(-3, 4):
                        dx = -shift * dn + 256 * m
                        sy0, sy1, sx0, sx1 = ya + dy, yb + dy, xa + dx, xb + dx
                        if sy0 < 0 or sy1 > H or sx0 < 0 or sx1 > W:
                            continue
                        bad = (~srcok[sy0:sy1, sx0:sx1]).sum()
                        score = (bad, abs(dn), abs(m))
                        if best is None or score < best[0]:
                            best = (score, dy, dx)
                if best is None:
                    continue
                (bad, _, _), dy, dx = best
                src = srcimg[ya + dy:yb + dy, xa + dx:xb + dx]
                ok = srcok[ya + dy:yb + dy, xa + dx:xb + dx]
                sub = out[ya:yb, xa:xb]
                if bad == 0:
                    sub[:, :] = src
                    filled[ya:yb, xa:xb] = True
                else:
                    sub[ok] = src[ok]
                    filled[ya:yb, xa:xb] |= ok
    # anything left (tiny): nearest filled neighbour
    if (~filled).any():
        idx = ndi.distance_transform_edt(~filled, return_distances=False, return_indices=True)
        out = out[idx[0], idx[1]]
    return out


# ----------------------------------------------------------------------------- letter shapes
def letter_fills(rgb, outline, blue):
    R, G, B = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    inside = ndi.binary_fill_holes(outline) & ~outline
    yel = (R > 130) & (G > 0.62 * R) & (B < 0.45 * G + 10)
    fill = ndi.binary_closing(yel & ~blue, np.ones((3, 3))) & ndi.binary_dilation(inside, np.ones((3, 3)))
    lab, n = ndi.label(fill)
    sizes = ndi.sum(fill, lab, range(1, n + 1))
    keep = np.zeros(n + 1, bool); keep[1:] = sizes > 1000
    return keep[lab]


def hires(m):
    return ndi.zoom(ndi.gaussian_filter(m.astype(float), 0.7), SS, order=1) > 0.5


def crop_letter(fill, box):
    x0, y0, x1, y1 = box
    m = fill[y0:y1, x0:x1].copy()
    lab, n = ndi.label(m)
    if n > 1:
        m = lab == (np.argmax(ndi.sum(m, lab, range(1, n + 1))) + 1)
    return hires(m)


def make_U(O):
    outer = ndi.binary_fill_holes(O)
    ys, xs = np.nonzero(outer)
    ytop, ybot = ys.min(), ys.max()
    ymid = int(np.argmax(outer.sum(1)[ytop:ybot + 1])) + ytop
    row = np.nonzero(outer[ymid])[0]
    xl, xr = row.min(), row.max()
    U = outer.copy()
    U[ytop:ymid] = False
    U[ytop:ymid, xl:xr + 1] = True
    cnt = outer & ~O
    cy, cx = np.nonzero(cnt)
    ws = float(np.ptp(cx) + 1)
    xc = (xl + xr) / 2.0
    r = ws / 2
    ysb = cy.max()
    Y, X = np.mgrid[0:O.shape[0], 0:O.shape[1]]
    slot = ((np.abs(X - xc) <= r) & (Y <= ysb - r)) | ((X - xc) ** 2 + (Y - (ysb - r)) ** 2 <= r * r)
    return ndi.binary_opening(U & ~slot, iterations=SS)


def make_D(B):
    outer = ndi.binary_fill_holes(B)
    ys, xs = np.nonzero(outer)
    right = outer.copy(); right[:, :(xs.min() + xs.max()) // 2] = False
    Dout = outer | convex_hull_image(right)
    cnt = outer & ~B
    Dcnt = convex_hull_image(cnt)
    return Dout & ~Dcnt


def font_S(h, w, weight=0.0):
    fnt = ImageFont.truetype(COOPER, 400)
    l, t, r, b = fnt.getbbox('S')
    im = Image.new('L', (r - l + 40, b - t + 40), 0)
    ImageDraw.Draw(im).text((20 - l, 20 - t), 'S', fill=255, font=fnt)
    g = np.array(im) > 127
    ys, xs = np.nonzero(g)
    g = g[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    m = np.array(Image.fromarray((g * 255).astype(np.uint8)).resize((int(w * SS), int(h * SS)), Image.LANCZOS)) > 127
    if weight:
        sdf = (ndi.distance_transform_edt(~m) - ndi.distance_transform_edt(m)) / SS
        m = sdf < weight
    return np.pad(m, SS * 2)


# ----------------------------------------------------------------------------- painting
def nearest_idx(cols, idxs, P):
    idxs = np.asarray(idxs)
    Q = P[idxs]
    out = np.empty(len(cols), int)
    for s in range(0, len(cols), 4096):
        c = cols[s:s + 4096]
        out[s:s + 4096] = idxs[((c[:, None, :] - Q[None]) ** 2).sum(-1).argmin(1)]
    return out


def paint_letters(wall, P, fill_hi, used, blue_idx):
    H, W = wall.shape
    disk = np.hypot(*np.mgrid[-40:41, -40:41]) <= OUTLINE_R * SS
    out_hi = ndi.binary_dilation(fill_hi, structure=disk) & ~fill_hi
    cf = fill_hi.reshape(H, SS, W, SS).mean((1, 3))
    co = out_hi.reshape(H, SS, W, SS).mean((1, 3))
    cw = 1 - cf - co
    wall_rgb = P[wall]
    fill_rgb = FILL_ALPHA * YELLOW + (1 - FILL_ALPHA) * wall_rgb
    res = wall.copy()
    # solid fill
    sf = cf > 0.999
    yel_pal = [i for i in used if P[i][0] > 120 and P[i][1] > 0.6 * P[i][0] and P[i][2] < 0.5 * P[i][1] + 10]
    res[sf] = nearest_idx(fill_rgb[sf], yel_pal, P)
    # solid outline: Floyd-Steinberg of a constant blue into the outline blues
    so = co > 0.999
    Pb = P[blue_idx]
    err = np.zeros((H + 1, W + 2, 3))
    for y in np.nonzero(so.any(1))[0]:
        for x in np.nonzero(so[y])[0]:
            c = BLUE + err[y, x + 1]
            k = ((Pb - c) ** 2).sum(1).argmin()
            res[y, x] = blue_idx[k]
            e = (c - Pb[k])
            err[y, x + 2] += e * 7 / 16
            err[y + 1, x] += e * 3 / 16
            err[y + 1, x + 1] += e * 5 / 16
            err[y + 1, x + 2] += e * 1 / 16
    # anti-aliased edges
    mix = ~sf & ~so & (cw < 0.999)
    col = cf[mix, None] * fill_rgb[mix] + co[mix, None] * BLUE + cw[mix, None] * wall_rgb[mix]
    res[mix] = nearest_idx(col, used, P)
    return res


def main(src, dst):
    im = Image.open(src)
    pal_flat = im.getpalette()[:768]
    P = np.array(pal_flat, float).reshape(256, 3)
    a = np.array(im).astype(int)
    rgb = P[a]
    H, W = a.shape
    L = rgb @ np.array([0.3, 0.59, 0.11])
    paint, outline, blue = detect_paint(rgb)
    rows = mortar_rows(L, ~paint)
    shift = 97
    joints = joints_for_bases(L, ~paint, rows, shift)
    wall = rebuild_wall(a, paint, rows, joints, shift)

    fill = letter_fills(rgb, outline, blue)
    boxes = {'B1': (14, 200, 97, 306), 'O1': (94, 198, 182, 306), 'M': (174, 200, 309, 302),
             'B2': (308, 200, 392, 306), 'O2': (238, 58, 327, 168)}
    G = {k: crop_letter(fill, b) for k, b in boxes.items()}
    G['U'] = make_U(G['O1'])
    G['D'] = make_D(G['B2'])
    G['S'] = font_S(92, 60)
    if SCALE != 1:
        G = {k: ndi.zoom(v.astype(float), SCALE, order=1) > 0.5 for k, v in G.items()}

    # layout: (glyph, left x of its ink, top y of its ink) in 1x pixels
    def ink(g):
        ys, xs = np.nonzero(g)
        return xs.min(), ys.min(), xs.max() + 1, ys.max() + 1

    gap = 14 * SCALE
    hgt = 92 * SCALE
    vgap = 34
    top1 = (H - (2 * hgt + vgap)) / 2.0 - 4
    lines = [(['B1', 'O1', 'O2', 'M'], [0, -3, -4, 0], top1, LINE_SHIFT[0]),
             (['B2', 'U', 'D', 'S'], [0, 1, -2, 0], top1 + hgt + vgap, LINE_SHIFT[1])]
    fill_hi = np.zeros((H * SS, W * SS), bool)
    for names, dys, top, xshift in lines:
        widths = [(ink(G[n])[2] - ink(G[n])[0]) / SS for n in names]
        total = sum(widths) + gap * (len(names) - 1)
        x = (W - total) / 2.0 + xshift
        for n, dyl, wdt in zip(names, dys, widths):
            dyl = dyl * SCALE
            g = G[n]
            gx0, gy0, gx1, gy1 = ink(g)
            ox = int(round((x) * SS)) - gx0
            oy = int(round((top + dyl) * SS)) - gy0
            ys, xs = np.nonzero(g)
            ty, tx = ys + oy, xs + ox
            ok = (ty >= 0) & (ty < H * SS) & (tx >= 0) & (tx < W * SS)
            fill_hi[ty[ok], tx[ok]] = True
            x += wdt + gap

    used = sorted(set(np.unique(a).tolist()))
    blue_idx = [i for i in used if P[i][2] > P[i][0] + 100 and P[i][2] > P[i][1] + 80 and P[i][2] > 170]
    res = paint_letters(wall, P, fill_hi, used, np.array(blue_idx))
    o = Image.fromarray(res.astype(np.uint8), 'P')
    o.putpalette(pal_flat)
    o.save(dst)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
