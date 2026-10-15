"""Rebrand TITLE.PCX: "ATOMIC BOMBERMAN" logo -> "BOOM BUDS" logo.

Usage: py -I title_brand.py <TITLE.PCX> <out.png>

How it works (all pixels stay in the picture's own 256-colour palette):
  1. The old logo (letters, outlines, extrusions, both bombs, TM) is masked out and the background
     behind it is rebuilt: the orange glow is refitted as an elliptical two-component radial profile
     and re-centred / narrowed (RESHAPE) to sit behind the shorter new logo; the original stars of the
     glow area are kept, the area under the old logo gets star sprites cut from the picture itself,
     and everything is Floyd-Steinberg dithered into the glow's own colours. The match flame and the
     character are never touched.
  2. Original artwork is reused pixel-for-pixel wherever possible:
        row 1  "B" + bomb (the "BO" of BOMBERMAN)  and  bomb + "M" (the "OM" of ATOMIC)
        row 2  "B" (the second B of BOMBERMAN, left in place so the antenna still overlaps it)
     Outline/edge pixels of moved pieces get the old glow behind them swapped for the new glow;
     bomb rims are re-antialiased against their new surroundings.
  3. The missing letters U, D, S are drawn as shapes matching the B's metrics (stem/bar widths,
     counters) and shaded like the row-2 letters: exact face colours/dither of the B per screen row,
     rims and 2px outline from direction-dependent multipliers measured on the original letters.
  4. The character (green) is kept in front, the TM is moved next to the new logo.
"""
import sys
from collections import Counter

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage as ndi
from scipy.optimize import least_squares
from scipy.sparse import csr_matrix
from scipy.sparse.linalg import spsolve

SHOWCARD = 'C:/Windows/Fonts/SHOWG.TTF'  # only used for the shape of the S
RESHAPE = (331, 0.72)  # re-centre the glow on the new logo and narrow it (None keeps the old glow)


# ----------------------------------------------------------------------------- basics
def lum(c):
    return c[..., 0] * 0.3 + c[..., 1] * 0.59 + c[..., 2] * 0.11


def letterness(rgb):
    R, G, B = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    magenta = (R > 120) & (B > 0.45 * R) & (G < 0.6 * R)
    pink = (R > 150) & (B > 0.25 * R) & (G < 0.75 * R)
    yellow = (R > 120) & (G > 0.8 * R) & (B < 0.4 * R)
    orange = (R > 200) & (G > 0.55 * R) & (B > 0.1 * R)
    return magenta | pink | yellow | orange


def glowlike(rgb):
    R, G, B = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    return (R >= 40) & (R <= 200) & (B < 0.27 * R + 2) & (G >= 0.45 * R) & (G <= 0.84 * R)


def nearest_idx(cols, idxs, P):
    """Map RGB rows to the nearest palette index among idxs."""
    idxs = np.asarray(idxs)
    Q = P[idxs]
    out = np.empty(len(cols), int)
    for s in range(0, len(cols), 4096):
        c = cols[s:s + 4096]
        out[s:s + 4096] = idxs[((c[:, None, :] - Q[None]) ** 2).sum(-1).argmin(1)]
    return out


def norm_conv(img, known, sigma):
    w = ndi.gaussian_filter(known.astype(float), sigma)
    out = np.stack([ndi.gaussian_filter(img[..., c] * known, sigma) for c in range(img.shape[2])], -1)
    return out / np.maximum(w, 1e-6)[..., None], w


def screened_fill(vals, unknown, k2):
    """Solve (-Laplace + k2) u = 0 on `unknown`, Dirichlet u = vals elsewhere."""
    H, W = unknown.shape
    idx = -np.ones((H, W), int)
    ys, xs = np.nonzero(unknown)
    idx[ys, xs] = np.arange(len(ys))
    n = len(ys)
    rows, cols, data = [], [], []
    rhs = np.zeros((n, vals.shape[2]))
    deg = np.zeros(n)
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        yy, xx = ys + dy, xs + dx
        inb = (yy >= 0) & (yy < H) & (xx >= 0) & (xx < W)
        deg += inb
        k = np.nonzero(inb)[0]
        j = idx[yy[k], xx[k]]
        unk = j >= 0
        rows += list(k[unk]); cols += list(j[unk]); data += [-1.0] * int(unk.sum())
        kk = k[~unk]
        np.add.at(rhs, kk, vals[yy[kk], xx[kk]])
    rows += list(range(n)); cols += list(range(n)); data += list(deg + k2)
    A = csr_matrix((data, (rows, cols)), shape=(n, n)).tocsc()
    out = vals.copy()
    for c in range(vals.shape[2]):
        out[ys, xs, c] = spsolve(A, rhs[:, c])
    return out


def rho(cx, cy, ax, by, x, y):
    return np.sqrt(((x - cx) / ax) ** 2 + ((y - cy) / by) ** 2)


# ----------------------------------------------------------------------------- masks
def flood_face(rgb, seed, box, block=None, thr=55, max_hole=14):
    """Face (front surface incl. rim) of one letter: flood over non-dark, non-glow pixels."""
    x0, y0, x1, y1 = box
    L = lum(rgb)
    ok = (L >= thr) & ~glowlike(rgb)
    if block is not None:
        ok &= ~block
    sub = np.zeros(L.shape, bool)
    sub[y0:y1, x0:x1] = ok[y0:y1, x0:x1]
    lab, _ = ndi.label(sub)
    m = lab == lab[seed[1], seed[0]]
    m = ndi.binary_closing(m, np.ones((3, 3)))
    boxm = np.zeros(L.shape, bool); boxm[y0:y1, x0:x1] = True
    m &= boxm
    holes = ndi.binary_fill_holes(m) & ~m
    hl, hn = ndi.label(holes)
    if hn:
        sizes = ndi.sum(holes, hl, range(1, hn + 1))
        for i, s in enumerate(sizes):
            if s <= max_hole:
                m[hl == i + 1] = True
    # dithered orange band pixels look like glow: add pixels sandwiched between face rows
    dark = L < thr
    for _ in range(2):
        up = np.zeros_like(m); dn = np.zeros_like(m)
        for direction, out in ((1, up), (-1, dn)):
            blocked = np.zeros_like(m)
            for k in range(1, 7):
                sh = np.zeros_like(m); shd = np.zeros_like(m)
                if direction == 1:
                    sh[k:] = m[:-k]; shd[k:] = dark[:-k]
                else:
                    sh[:-k] = m[k:]; shd[:-k] = dark[k:]
                out |= sh & ~blocked
                blocked |= shd
        m = m | (~dark & ~m & up & dn & boxm)
    if block is not None:
        m &= ~block
    return m


# ----------------------------------------------------------------------------- glow
def rebuild_background(a, pal, rgb, logo, char, rng, extra_region=None, reshape=None):
    """Return new index image with the logo region replaced by synthetic glow + stars."""
    H, W = a.shape
    P = pal.astype(float)
    yy, xx = np.mgrid[0:H, 0:W]
    R, G, B = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    L = lum(rgb)
    glowcol = ((R >= G - 4) & (G >= B - 4) & (B <= 0.28 * R + 6) & (G <= 0.88 * R + 6)) | (L < 22)
    med = np.stack([ndi.median_filter(rgb[..., c], size=5) for c in range(3)], -1)
    star = ndi.binary_dilation((L - lum(med)) > 10, np.ones((3, 3)))
    face = ndi.binary_closing(letterness(rgb) & (yy < 200) & (xx > 80) & (xx < 600), np.ones((3, 3)))
    bombs = logo_bombs(rgb, char)
    known = ~ndi.binary_dilation(logo, np.ones((3, 3))) & ~char & ~star & glowcol & (yy < 300)
    gap = glowcol & ~char & ~star & (ndi.distance_transform_edt(~(face | bombs)) >= 2) & logo & (L > 30)
    K = known | gap
    sm, w = norm_conv(rgb, K, 1.0)
    ys, xs = np.nonzero(K & (w > 0.2))
    vals = sm[ys, xs]
    wts = np.where(gap[ys, xs], 4.0, 1.0)

    def prof(q, x, y):
        cx, cy, ax, by, s1, p1, s2, A0, A1, A2, C0, C1, C2 = q
        rr = rho(cx, cy, ax, by, x, y)
        g1 = np.exp(-(rr / s1) ** p1)
        g2 = np.exp(-(rr / s2) ** 2)
        return np.stack([A0 * g1 + C0 * g2, A1 * g1 + C1 * g2, A2 * g1 + C2 * g2], -1)

    q0 = [317, 110, 372, 116, 0.7, 6.0, 0.35, 100, 65, 2, 40, 40, 10]
    res = least_squares(lambda q: ((prof(q, xs, ys) - vals) * wts[:, None]).ravel(), q0,
                        x_scale=[10, 10, 20, 10, 0.05, 0.5, 0.05, 10, 10, 5, 10, 10, 5],
                        loss='soft_l1', f_scale=10)
    q = res.x
    Gm = prof(q, xx, yy)
    rr = rho(q[0], q[1], q[2], q[3], xx, yy)
    # region rebuilt: inner glow + old logo, never the character
    below = np.zeros_like(logo)
    for k in range(1, 13):
        below[k:] |= logo[:-k]
    Rg = ((rr < 0.55) | ndi.binary_dilation(logo | below, np.ones((5, 5)))) & ~char & (yy < 240)
    if extra_region is not None:
        Rg |= extra_region & ~char
    clean = K & (w > 0.25) & ~Rg & ~ndi.binary_dilation(logo, np.ones((7, 7)))
    resid = np.where(clean[..., None], sm - Gm, 0)
    unknown = ~clean & (yy < 300)
    Gf = Gm + screened_fill(resid, unknown, 1.0 / 10.0 ** 2)
    # star sprites cut from the untouched glow ring
    res_all = rgb - Gf
    ring = ~Rg & ~char & (rr > 0.45) & (rr < 1.0) & (yy < 240) & ~ndi.binary_dilation(logo, np.ones((9, 9)))
    starpix = (lum(res_all) > 9) & ring
    lab, n = ndi.label(starpix, structure=np.ones((3, 3)))
    sprites = []
    for i, sl in enumerate(ndi.find_objects(lab)):
        m = lab[sl] == i + 1
        if m.sum() > 6 or L[sl][m].max() > 170:
            continue
        sprites.append((m, res_all[sl] * m[..., None]))
    density = len(sprites) / max(ring.sum(), 1)
    S = np.zeros_like(Gf)
    occ = np.zeros((H, W), bool)
    ry, rx = np.nonzero(Rg)
    for _ in range(rng.poisson(density * Rg.sum())):
        j = rng.integers(len(ry)); y0, x0 = ry[j], rx[j]
        m, val = sprites[rng.integers(len(sprites))]
        h, w_ = m.shape
        if y0 + h >= H or x0 + w_ >= W or occ[max(y0 - 1, 0):y0 + h + 1, max(x0 - 1, 0):x0 + w_ + 1].any():
            continue
        S[y0:y0 + h, x0:x0 + w_] += val
        occ[y0:y0 + h, x0:x0 + w_] |= m
    target = Gf + S
    if reshape is not None:
        # re-centre / narrow the glow around the new logo: whole old glow area = new glow + original stars
        new_cx, xscale = reshape
        qn = q.copy(); qn[0] = new_cx; qn[2] = q[2] * xscale
        Gn = prof(qn, xx, yy)
        fbox = (xx >= 366) & (xx <= 398) & (yy >= 172)
        flame = fbox & (((R > 150) & (G > 130)) | (L > 140) | ((B > R) & (L > 60)))
        flame = ndi.binary_dilation(flame, np.ones((3, 3))) & fbox
        allr = ((rr < 1.05) | Rg) & ~char & ~flame & (yy < 260)
        stars = np.where(star[..., None], rgb - sm, 0)
        stars = np.where((lum(stars) > 4)[..., None], stars, 0)
        target = np.where(Rg[..., None], Gn + S, Gn + stars)
        Rg = allr
    # Floyd-Steinberg into the colours the glow area already uses
    used = np.unique(a[(yy < 240) & ~logo & ~char & ~face])
    Pu = P[used]
    pinkish = (Pu[:, 2] > 0.3 * Pu[:, 0] + 8) & (Pu[:, 0] > 90) & (Pu[:, 0] > Pu[:, 1] + 30)
    used, Pu = used[~pinkish], Pu[~pinkish]
    out = a.copy()
    work = target.copy()
    rows_ = np.nonzero(Rg.any(1))[0]
    for y in rows_:
        for x in np.nonzero(Rg[y])[0]:
            c = work[y, x]
            k = ((Pu - c) ** 2).sum(1).argmin()
            out[y, x] = used[k]
            e = (c - Pu[k]) * 0.85
            if x + 1 < W and Rg[y, x + 1]:
                work[y, x + 1] += e * 7 / 16
            if y + 1 < H:
                if x > 0 and Rg[y + 1, x - 1]:
                    work[y + 1, x - 1] += e * 3 / 16
                if Rg[y + 1, x]:
                    work[y + 1, x] += e * 5 / 16
                if x + 1 < W and Rg[y + 1, x + 1]:
                    work[y + 1, x + 1] += e * 1 / 16
    return out, Gf, (Gn if reshape is not None else Gf), Rg


def logo_bombs(rgb, char):
    H, W = rgb.shape[:2]
    yy, xx = np.mgrid[0:H, 0:W]
    roi = (xx >= 80) & (xx < 600) & (yy >= 8) & (yy < 200)
    L = lum(rgb)
    mx = rgb.max(-1); mn = rgb.min(-1)
    grey = (mx - mn < 24) & (L > 12) & (L < 150) & roi & ~char
    lab, n = ndi.label(ndi.binary_closing(grey, np.ones((3, 3))))
    sizes = ndi.sum(np.ones_like(grey), lab, range(1, n + 1))
    keep = np.zeros(n + 1, bool); keep[1:] = sizes >= 600
    bombs = keep[lab]
    return ndi.binary_fill_holes(ndi.binary_closing(bombs, np.ones((5, 5))))


# ----------------------------------------------------------------------------- letter shader
SS = 4


def grid(box):
    x0, y0, x1, y1 = box
    xs = x0 + (np.arange((x1 - x0) * SS) + 0.5) / SS
    ys = y0 + (np.arange((y1 - y0) * SS) + 0.5) / SS
    return np.meshgrid(xs, ys)


def sd_roundbox(X, Y, x0, y0, x1, y1, r):
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    hx, hy = (x1 - x0) / 2, (y1 - y0) / 2
    px, py = X - cx, Y - cy
    tl, tr, br, bl = r
    rr = np.where(px < 0, np.where(py < 0, tl, bl), np.where(py < 0, tr, br))
    qx = np.abs(px) - hx + rr
    qy = np.abs(py) - hy + rr
    return np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) + np.minimum(np.maximum(qx, qy), 0) - rr


def rotate(X, Y, cx, cy, deg):
    t = np.radians(deg)
    c, s = np.cos(t), np.sin(t)
    return cx + (X - cx) * c + (Y - cy) * s, cy - (X - cx) * s + (Y - cy) * c


def font_mask(ch, box, top, bottom, left, width, deg=0.0, weight=0.0):
    fnt = ImageFont.truetype(SHOWCARD, 400)
    l, t, r, b = fnt.getbbox(ch)
    im = Image.new('L', (r - l + 40, b - t + 40), 0)
    ImageDraw.Draw(im).text((20 - l, 20 - t), ch, fill=255, font=fnt)
    g = np.array(im).astype(float) / 255
    gy, gx = np.nonzero(g > 0.5)
    gx0, gx1, gy0, gy1 = gx.min(), gx.max() + 1, gy.min(), gy.max() + 1
    X, Y = grid(box)
    Xr, Yr = rotate(X, Y, left + width / 2, (top + bottom) / 2, deg)
    u = gx0 + (Xr - left) / width * (gx1 - gx0)
    v = gy0 + (Yr - top) / (bottom - top) * (gy1 - gy0)
    m = ndi.map_coordinates(g, [v - 0.5, u - 0.5], order=1, cval=0) > 0.5
    if weight:
        sdf = (ndi.distance_transform_edt(~m) - ndi.distance_transform_edt(m)) / SS
        m = sdf < weight
    return m


# brightness multipliers of the row's face colour, by edge direction and pixel step k=floor(signed dist)
OUTER = {
    'R':  {-4: 1.03, -3: 1.08, -2: 1.13, -1: 0.86, 0: 0.43, 1: 0.18},
    'TR': {-4: 1.02, -3: 1.06, -2: 1.12, -1: 0.95, 0: 0.43, 1: 0.18},
    'T':  {-4: 1.0, -3: 1.04, -2: 1.10, -1: 1.13, 0: 0.50, 1: 0.70},
    'TL': {-4: 1.0, -3: 1.0, -2: 1.04, -1: 0.95, 0: 0.43, 1: 0.55},
    'L':  {-4: 1.0, -3: 1.0, -2: 1.0, -1: 0.70, 0: 0.43, 1: 0.45},
    'BL': {-4: 1.0, -3: 1.0, -2: 1.02, -1: 0.95, 0: 0.20, 1: 0.25},
    'B':  {-4: 1.0, -3: 1.0, -2: 1.04, -1: 1.12, 0: 0.04, 1: 0.10},
    'BR': {-4: 1.0, -3: 0.97, -2: 0.92, -1: 0.86, 0: 0.38, 1: 0.18},
}
INNER = {
    'R':  {-4: 1.0, -3: 0.97, -2: 0.92, -1: 0.88, 0: 0.43, 1: 0.12},
    'TR': {-4: 1.0, -3: 0.97, -2: 0.92, -1: 0.88, 0: 0.40, 1: 0.12},
    'T':  {-4: 1.0, -3: 1.0, -2: 1.04, -1: 1.10, 0: 0.43, 1: 0.20},
    'TL': {-4: 1.0, -3: 1.02, -2: 1.06, -1: 1.06, 0: 0.40, 1: 0.15},
    'L':  {-4: 1.0, -3: 1.0, -2: 1.04, -1: 1.10, 0: 0.38, 1: 0.12},
    'BL': {-4: 1.0, -3: 1.0, -2: 1.0, -1: 0.95, 0: 0.30, 1: 0.10},
    'B':  {-4: 1.0, -3: 0.97, -2: 0.92, -1: 0.82, 0: 0.25, 1: 0.10},
    'BR': {-4: 1.0, -3: 0.97, -2: 0.92, -1: 0.85, 0: 0.30, 1: 0.10},
}
ANG = {'R': 0, 'BR': 45, 'B': 90, 'BL': 135, 'L': 180, 'TL': -135, 'T': -90, 'TR': -45}


def mult(table, k, phi):
    out = np.zeros_like(phi)
    for n, ang in ANG.items():
        dlt = np.abs((phi - ang + 180) % 360 - 180)
        out += np.clip(1 - dlt / 45.0, 0, 1) * table[n][k]
    return out


def face_table(a, x0, x1, rows):
    t = {}
    for y in rows:
        for par in (0, 1):
            xs = [x for x in range(x0, x1) if (x + y) % 2 == par]
            t[(y, par)] = Counter(a[y, xs].tolist()).most_common(1)[0][0]
    return t


def render_letter(mhi, box, P, bg_rgb, ftab, letter_pal, inner_hi=None, hole_dark=0.85):
    """Shade a hi-res face mask. Returns (index image, coverage, hole-background mask) over box."""
    x0, y0, x1, y1 = box
    sdf = (ndi.distance_transform_edt(~mhi) - ndi.distance_transform_edt(mhi)) / SS
    gy, gx = np.gradient(ndi.gaussian_filter(sdf, SS * 0.6))
    c = SS // 2
    d = sdf[c::SS, c::SS]
    phi = np.degrees(np.arctan2(gy[c::SS, c::SS], gx[c::SS, c::SS]))
    H, W = d.shape
    Y, X = np.mgrid[y0:y1, x0:x1]
    holes_hi = ndi.binary_fill_holes(mhi) & ~mhi
    if inner_hi is not None:
        holes_hi |= inner_hi & ~mhi
    holes = holes_hi[c::SS, c::SS]
    near_hole = (ndi.distance_transform_edt(~holes) <= 4.5).astype(float)
    ymin = min(k[0] for k in ftab); ymax = max(k[0] for k in ftab)
    ys = np.clip(Y, ymin, ymax)
    par = (X + Y) % 2
    f0 = np.vectorize(lambda yy: ftab[(yy, 0)])(ys)
    f1 = np.vectorize(lambda yy: ftab[(yy, 1)])(ys)
    fidx = np.where(par == 0, f0, f1)
    favg = (P[f0] + P[f1]) / 2
    k = np.floor(d).astype(int)
    out = np.full((H, W), -1, int)
    deep = d < -4
    out[deep] = fidx[deep]
    edge = (d >= -4) & (d < 2)
    rgb = np.zeros((H, W, 3))
    for kk in range(-4, 2):
        sel = edge & (k == kk)
        if not sel.any():
            continue
        w_in = near_hole[sel]
        s = mult(OUTER, kk, phi[sel]) * (1 - w_in) + mult(INNER, kk, phi[sel]) * w_in
        col = favg[sel] * s[:, None]
        if kk == 1:
            aa = 0.45 * (1 - w_in) + 0.25 * w_in
            bgc = bg_rgb[y0:y1, x0:x1][sel] * np.where(holes[sel], hole_dark, 1.0)[:, None]
            col = col * (1 - aa[:, None]) + bgc * aa[:, None]
        rgb[sel] = col
    out[edge] = nearest_idx(rgb[edge], letter_pal, P)
    cover = out >= 0
    return out, cover, holes & ~cover


# ----------------------------------------------------------------------------- bombs
def fit_circle(mask, exclude=None):
    edge = mask & ~ndi.binary_erosion(mask)
    if exclude is not None:
        edge &= ~exclude
    ys, xs = np.nonzero(edge)
    ys = ys + 0.5; xs = xs + 0.5
    A = np.stack([2 * xs, 2 * ys, np.ones_like(xs)], 1)
    b = xs ** 2 + ys ** 2
    (cx, cy, c), *_ = np.linalg.lstsq(A, b, rcond=None)
    return cx, cy, np.sqrt(c + cx ** 2 + cy ** 2)


def paste_bomb(out, a, P, body, extra, circ, dx, dy, pal_sub):
    """Copy a bomb (disc + cap/fuse) shifted by (dx,dy); disc edge pixels re-antialiased vs current out."""
    cx, cy, r = circ
    H, W = a.shape
    yy, xx = np.mgrid[0:H, 0:W]
    dist = np.hypot(xx + 0.5 - cx, yy + 0.5 - cy)
    cov = np.clip(r - dist + 0.5, 0, 1)
    Pa = P[a]
    bomblike = ((Pa.max(-1) - Pa.min(-1)) < 30) & (lum(Pa) < 150)
    inside = (cov >= 0.999) & (bomblike | (dist < r - 3))
    rim = (cov > 0.02) & ~inside
    cov = np.where((cov >= 0.999) & ~inside, 0.75, cov)
    # edge colour: average of the interior ring 1-2px inside the edge
    ring_in = inside & (dist > r - 3)
    edge_rgb = P[a[ring_in]].mean(0)
    ext = extra & ~inside
    # copy interior + extras
    src = inside | ext
    ys, xs = np.nonzero(src)
    ty, tx = ys + dy, xs + dx
    ok = (ty >= 0) & (ty < H) & (tx >= 0) & (tx < W)
    out[ty[ok], tx[ok]] = a[ys[ok], xs[ok]]
    # re-antialias the rim against what is under it now
    ys, xs = np.nonzero(rim & ~ext)
    ty, tx = ys + dy, xs + dx
    ok = (ty >= 0) & (ty < H) & (tx >= 0) & (tx < W)
    ys, xs, ty, tx = ys[ok], xs[ok], ty[ok], tx[ok]
    al = cov[ys, xs][:, None]
    col = al * edge_rgb + (1 - al) * P[out[ty, tx]]
    out[ty, tx] = nearest_idx(col, pal_sub, P)


# ----------------------------------------------------------------------------- main
def main(src, dst):
    im = Image.open(src)
    pal_flat = im.getpalette()[:768]
    pal = np.array(pal_flat).reshape(256, 3)
    P = pal.astype(float)
    a = np.array(im).astype(int)
    rgb = P[a]
    H, W = a.shape
    yy, xx = np.mgrid[0:H, 0:W]
    R, G, B = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    L = lum(rgb)
    rng = np.random.default_rng(1997)

    # --- character (kept in front) ---
    green = (G > R + 12) & (G > B + 4) & (yy > 130)
    lab, n = ndi.label(green)
    sizes = ndi.sum(green, lab, range(1, n + 1))
    keep = np.zeros(n + 1, bool); keep[1:] = sizes >= 30
    char = ndi.binary_fill_holes(ndi.binary_closing(keep[lab], np.ones((3, 3))))
    flame = (xx >= 368) & (xx <= 395) & (yy >= 170)

    # --- old logo mask ---
    roi = (xx >= 80) & (xx < 600) & (yy >= 8) & (yy < 200)
    face = ndi.binary_closing(letterness(rgb) & roi, np.ones((3, 3)))
    lab, n = ndi.label(face)
    sizes = ndi.sum(face, lab, range(1, n + 1))
    keep = np.zeros(n + 1, bool); keep[1:] = sizes >= 40
    face = keep[lab]
    bombs = logo_bombs(rgb, char)
    dface = ndi.distance_transform_edt(~face)
    olive = (G >= 0.84 * R) & (R >= 30) & (R <= 205) & (B < 0.45 * R + 10)
    tm = (xx >= 546) & (xx <= 577) & (yy >= 77) & (yy <= 97)
    fuse2 = (xx >= 288) & (xx <= 322) & (yy >= 40) & (yy <= 58) & ~glowlike(rgb) & (L > 20)
    logo = (face | ((dface <= 4) & ((L < 62) | ~glowlike(rgb))) | (olive & (dface <= 9)) |
            ndi.binary_dilation(bombs, np.ones((5, 5))) | tm | ndi.binary_dilation(fuse2, np.ones((3, 3)))) & roi
    logo = ndi.binary_dilation(ndi.binary_closing(logo, np.ones((3, 3))), np.ones((3, 3)))
    holes = ndi.binary_fill_holes(logo) & ~logo
    hl, hn = ndi.label(holes)
    for i, s in enumerate(ndi.sum(holes, hl, range(1, hn + 1))):
        if s < 60:
            logo[hl == i + 1] = True
    logo &= ~char & ~flame

    # --- background without the logo ---
    # the glow is locally brighter around the old bombs: rebuild a halo around them too
    halo = np.zeros_like(logo)
    lab, n = ndi.label(bombs)
    for i in range(1, n + 1):
        halo |= ndi.distance_transform_edt(lab != i) < 16
    out, Gold, Gnew, Rg = rebuild_background(a, pal, rgb, logo, char, rng, extra_region=halo & roi, reshape=RESHAPE)
    bg_rgb = P[out].astype(float)
    glowL = lum(Gold)

    # --- pieces of original artwork ---
    blockc = char | bombs
    fB1 = flood_face(rgb, (110, 130), (90, 96, 152, 190), block=blockc)
    fB2 = flood_face(rgb, (250, 120), (246, 95, 300, 190), block=blockc)
    fM = flood_face(rgb, (350, 45), (314, 20, 402, 108), block=blockc)

    def silhouette(f, ring_px, extra_block=None):
        ring = ndi.binary_dilation(f, np.ones((2 * ring_px + 1, 2 * ring_px + 1))) & ~f
        darkish = (L < 0.62 * np.maximum(glowL, 40)) | (L < 40)
        others = (face | bombs) & ~ndi.binary_dilation(f, np.ones((3, 3)))
        ring &= ndi.distance_transform_edt(~f) <= ndi.distance_transform_edt(~others)
        s = f | (ring & darkish)
        if extra_block is not None:
            s &= ~extra_block
        return s & ~char

    # bombs: disc fits (exclude the cap/fuse side from the fit)
    lab, n = ndi.label(bombs)
    b1 = lab == lab[146, 170]
    b2 = lab == lab[77, 291]
    c1 = fit_circle(b1, exclude=(yy < 128) & (xx < 166))
    c2 = fit_circle(b2, exclude=(yy < 54))
    disc1 = np.hypot(xx + 0.5 - c1[0], yy + 0.5 - c1[1]) <= c1[2] + 1.5
    disc2 = np.hypot(xx + 0.5 - c2[0], yy + 0.5 - c2[1]) <= c2[2] + 1.5
    cap1 = b1 & ~disc1 & (yy < 130)
    cap2 = (b2 | fuse2) & ~disc2 & (yy < 56)
    lab2, _ = ndi.label(cap2 | ndi.binary_dilation(b2, np.ones((3, 3))))
    cap2 &= lab2 == lab2[77, 291]

    sB1 = silhouette(fB1, 3, extra_block=disc1 & ~fB1)
    # the bomb's fuse crosses the B's top-right corner (diagonal band (144,105)-(154,120))
    fl = 144 + (yy - 105) * 4.0 / 15.0
    fr = 149 + (yy - 104) * 5.0 / 16.0
    fuse1 = (yy >= 104) & (yy <= 121) & (xx >= np.floor(fl)) & (xx <= np.ceil(fr)) & ~disc1
    sB1 |= fuse1
    sB2 = silhouette(fB2, 2, extra_block=bombs | disc2)
    sM = silhouette(fM, 6, extra_block=bombs | disc2)

    # palette subsets
    letter_pal = sorted(set(np.unique(a[logo & ~bombs]).tolist()))
    bomb_pal = sorted(set(np.unique(a[logo]).tolist()) | set(np.unique(out[Rg]).tolist()))
    swap_pal = bomb_pal

    # --- layout ---
    D1 = (120, -81)   # B + bomb  (BOMBERMAN's "BO")  -> top row, left half
    D2 = (50, -2)      # bomb + M  (ATOMIC's "OM")    -> top row, right half
    TMD = (-94, -2)    # TM next to the new top row

    def paste(mask, dx, dy, core=None):
        """Copy pixels; outline/edge pixels outside `core` get their glow share swapped for the new glow."""
        ys, xs = np.nonzero(mask)
        out[ys + dy, xs + dx] = a[ys, xs]
        if core is None:
            return
        ys, xs = np.nonzero(mask & ~core)
        ty, tx = ys + dy, xs + dx
        gs = Gold[ys, xs]; gd = Gnew[ty, tx]
        alpha = np.clip(1 - L[ys, xs] / np.maximum(lum(gs), 30), 0, 1)[:, None]
        col = rgb[ys, xs] + (1 - alpha) * (gd - gs)
        out[ty, tx] = nearest_idx(col, swap_pal, P)

    # row 2: B (in place) + rendered U, D, S
    paste(sB2, 0, 0, core=fB2)
    ftab = face_table(a, 250, 260, range(101, 162))
    bg_rgb = P[out].astype(float)

    def place(mhi, box, inner_hi=None):
        idx, cover, hole_bg = render_letter(mhi, box, P, bg_rgb, ftab, letter_pal, inner_hi)
        x0, y0, x1, y1 = box
        sub = out[y0:y1, x0:x1]
        if hole_bg.any():
            sub[hole_bg] = nearest_idx(bg_rgb[y0:y1, x0:x1][hole_bg] * 0.85, bomb_pal, P)
        sub[cover] = idx[cover]

    # U
    ux = 291
    box = (ux - 8, 92, ux + 50, 172)
    X, Y = grid(box)
    outer = sd_roundbox(X, Y, ux, 102, ux + 40, 162, (2.5, 2.5, 17, 17))
    slot = sd_roundbox(X, Y, ux + 15, 80, ux + 25, 149, (0, 0, 5, 5))
    place((outer < 0) & ~(slot < 0), box, inner_hi=(slot < 0) & (Y > 102))
    # D (metrics of the B: stem 15, top bar 12, bottom bar 11, counter 9 wide)
    dx_ = 335
    box = (dx_ - 8, 92, dx_ + 50, 172)
    X, Y = grid(box)
    outer = sd_roundbox(X, Y, dx_, 101.5, dx_ + 39, 162, (3, 17, 17, 2))
    cnt = sd_roundbox(X, Y, dx_ + 15, 114, dx_ + 24, 151.5, (0.5, 5, 5, 0.5))
    place((outer < 0) & ~(cnt < 0), box)
    # S (Showcard Gothic S, condensed and lightened to the B's stroke weight)
    sx = 378
    box = (sx - 8, 92, sx + 48, 172)
    place(font_mask('S', box, 101.5, 162.5, sx, 38, weight=-0.8), box)

    # row 1: bomb + M, then B + bomb
    paste(sM, *D2, core=fM)
    paste_bomb(out, a, P, b2, cap2, c2, D2[0], D2[1], bomb_pal)
    paste(sB1 & ~b1, *D1, core=fB1 | fuse1)
    paste_bomb(out, a, P, b1, cap1, c1, D1[0], D1[1], bomb_pal)
    # TM
    tmm = tm & (B > 0.3 * R) & (R > 45)
    paste(tmm, *TMD, core=tm & (B > 0.6 * R) & (R > 120))

    # character always in front
    out[char] = a[char]
    oim = Image.fromarray(out.astype(np.uint8), 'P')
    oim.putpalette(pal_flat)
    oim.save(dst)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
