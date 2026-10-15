"""Rebrand FIELD10.PCX: manhole cover lettering "Atomic" / "BomberMan" -> "Boom" / "Buds".

Usage: py -I field10_brand.py <FIELD10.PCX> <out.png>

The cover is seen in slight perspective, so all geometry uses elliptical polar coordinates
(rho, theta) fitted to the recess wall.
  1. Plain cover: the old words, their dark channel and the shadow blobs they cast on the grid
     are removed. The waffle grid is restored by copying whole grid rows (same columns, so the
     perspective of the grid is kept) from clean rows of the same half of the cover, avoiding the
     shadowed row under the central bar and the four bolt holes; the narrow wall zone is carried
     over from the clean angles on either side of each word.
  2. New words, made like the original: raised letters in a dark channel along the wall that hugs
     the letters, top word upright with its letters pointing outwards, bottom word upright with its
     letters pointing inwards. Letter shapes: Arial Rounded MT Bold, emboldened and with the
     original's large x-height; material and dither taken from the original letters; a light rim on
     the lit (upper-right) side and a dark rim on the shadow side, like the original relief.
SET_TEXT = False gives a plain cover. Palette untouched; pixels outside the edited areas untouched.
"""
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage as ndi
from scipy.optimize import least_squares

FONT = 'C:/Windows/Fonts/ARLRDBD.TTF'
SET_TEXT = True
WORDS = {'top': ('Boom', 90.0), 'bottom': ('Buds', 270.0)}
OLD_SECT = {'top': (42.0, 144.0), 'bottom': (204.0, 348.0)}
WALL = {'top': 0.968, 'bottom': 0.945}
OUTER = {'top': 1.004, 'bottom': 1.035}       # outer limit of the old lettering (the wall)
PITCH = {'top': 16, 'bottom': 17}
HALF_Y = {'top': (0, 248), 'bottom': (324, 479)}
BOLTS = [(281.0, 233.0), (351.4, 233.1), (282.5, 344.4), (354.5, 345.0)]
# lettering (rho units of the recess ellipse)
BASE = {'top': 0.872, 'bottom': 0.958}   # baseline radius
XH, CAP = 0.112, 0.138                    # x-height, cap height
TRACK = 1.4                               # px between letters
BOLD = 0.9                                # px added to the stroke
WIDE = 1.22                               # the original face is extended (letters ~1.3x wider)
LIGHT_DIR = np.array([0.7, -0.7])         # screen-space direction towards the light (x right, y down)


# ----------------------------------------------------------------------------- geometry
def fit_ellipse(L):
    cx0, cy0 = 319.0, 287.0
    pts = []
    for ang in np.arange(0, 360, 3):
        t = np.radians(ang)
        rs = np.arange(135, 80, -0.25)
        xs = cx0 + rs * np.cos(t); ys = cy0 - rs * np.sin(t)
        prof = ndi.map_coordinates(L, [ys, xs], order=1)
        i_ring = np.argmax(prof > 95)
        rest = prof[i_ring:]
        j = np.argmax(rest < 75)
        if rest[j] < 75:
            pts.append((xs[i_ring + j], ys[i_ring + j]))
    pts = np.array(pts)

    def res(p):
        cx, cy, ax, by, phi = p
        c, s = np.cos(phi), np.sin(phi)
        dx, dy = pts[:, 0] - cx, pts[:, 1] - cy
        u = dx * c + dy * s; v = -dx * s + dy * c
        return (np.sqrt((u / ax) ** 2 + (v / by) ** 2) - 1) * 100
    return least_squares(res, [cx0, cy0, 105, 110, 0.0], loss='soft_l1', f_scale=1.0).x


def to_ell(x, y, e):
    cx, cy, ax, by, phi = e
    c, s = np.cos(phi), np.sin(phi)
    dx, dy = x - cx, y - cy
    u = dx * c + dy * s; v = -dx * s + dy * c
    return np.sqrt((u / ax) ** 2 + (v / by) ** 2), np.degrees(np.arctan2(-v / by, u / ax)) % 360


def from_ell(rho, th, e):
    cx, cy, ax, by, phi = e
    t = np.radians(th)
    u = rho * ax * np.cos(t); v = -rho * by * np.sin(t)
    c, s = np.cos(phi), np.sin(phi)
    return cx + u * c - v * s, cy + u * s + v * c


def nearest_idx(cols, idxs, P):
    idxs = np.asarray(idxs)
    Q = P[idxs]
    out = np.empty(len(cols), int)
    for s in range(0, len(cols), 4096):
        c = cols[s:s + 4096]
        out[s:s + 4096] = idxs[((c[:, None, :] - Q[None]) ** 2).sum(-1).argmin(1)]
    return out


# ----------------------------------------------------------------------------- 1. plain cover
def plain_cover(a, P, e, rng):
    H, W = a.shape
    rgb = P[a]
    yy, xx = np.mgrid[0:H, 0:W]
    rho, th = to_ell(xx + 0.5, yy + 0.5, e)
    smooth = np.stack([ndi.gaussian_filter(rgb[..., c], 0.9) for c in range(3)], -1)
    noise = rgb - smooth
    used = np.unique(a[rho < 1.25])
    L = rgb @ np.array([0.3, 0.59, 0.11])
    holes = np.zeros((H, W), bool)
    for bx, by in BOLTS:
        holes |= np.hypot(xx + 0.5 - bx, yy + 0.5 - by) <= 8.5
    out = a.copy()
    region = {}
    for k, (t0, t1) in OLD_SECT.items():
        rmax = OUTER[k]
        reg = (th >= t0) & (th <= t1) & (rho >= 0.72) & (rho <= rmax)
        sec = (th >= t0) & (th <= t1) & (rho >= 0.55) & (rho <= rmax)
        blobs = ndi.binary_opening(sec & (L < 58), np.ones((3, 3)))
        lab, n = ndi.label(blobs | reg)
        keep = np.zeros(n + 1, bool); keep[np.unique(lab[reg])] = True; keep[0] = False
        region[k] = ndi.binary_dilation(keep[lab], np.ones((5, 5))) & sec
    region['top'] &= yy <= 248
    region['bottom'] &= yy >= 324
    for k in region:
        region[k] &= ~holes
    allr = region['top'] | region['bottom']
    for k, (t0, t1) in OLD_SECT.items():
        reg = region[k]
        wr = WALL[k]
        y0h, y1h = HALF_Y[k]
        sign = 1 if k == 'top' else -1
        gz = reg & (rho < wr + 0.012)
        ys, xs = np.nonzero(gz)
        done = np.zeros(len(ys), bool)
        for shift in (0, 17, -17, 34, -34, 51, -51, 68, -68, 85, -85):
            for n in (1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 7, 8):
                sy, sx = ys + sign * PITCH[k] * n, xs + shift
                ok = ~done & (sy >= y0h) & (sy <= y1h) & (sx >= 0) & (sx < W)
                ok2 = ok.copy()
                ok2[ok] = ~allr[sy[ok], sx[ok]] & ~holes[sy[ok], sx[ok]] & (rho[sy[ok], sx[ok]] < 0.85)
                out[ys[ok2], xs[ok2]] = a[sy[ok2], sx[ok2]]
                done |= ok2
        # wall zone (and anything the grid copy could not reach): radial profile from the clean
        # angles on either side, blended across the word
        notdone = reg.copy(); notdone[ys[done], xs[done]] = False
        wz = reg & ((rho >= wr - 0.02) | notdone)
        ys, xs = np.nonzero(wz)
        rr, tt = rho[ys, xs], th[ys, xs]
        ta, tb = t0 - 3, t1 + 3
        w = np.clip((tt - ta) / (tb - ta), 0, 1)

        def samp(theta):
            px, py = from_ell(rr, np.full_like(rr, theta), e)
            return np.stack([ndi.map_coordinates(smooth[..., c], [py - 0.5, px - 0.5], order=1) for c in range(3)], -1)
        col = (1 - w)[:, None] * samp(ta) + w[:, None] * samp(tb)
        ny, nx = np.nonzero(~allr & (rho > wr - 0.01) & (rho < OUTER[k] + 0.006))
        pick = rng.integers(0, len(ny), len(ys))
        col = col + noise[ny[pick], nx[pick]]
        t = np.clip((rr - (wr - 0.02)) / 0.03, 0, 1)
        b = t * t * (3 - 2 * t)
        b = np.where(np.isin(ys * W + xs, (np.nonzero(gz.ravel())[0])[done]), b, 1.0)
        col = (1 - b)[:, None] * P[out[ys, xs]] + b[:, None] * col
        out[ys, xs] = nearest_idx(col, used, P)
    return out, allr


# ----------------------------------------------------------------------------- 2. lettering
def word_canvas(word, xh_px, cap_px, ss):
    fnt = ImageFont.truetype(FONT, 200)
    _, tB, _, bB = fnt.getbbox('B')
    _, tx, _, bx = fnt.getbbox('x')
    cap0, xh0 = bB - tB, bx - tx
    glyphs = []
    for ch in word:
        l, t, r, b = fnt.getbbox(ch)
        im = Image.new('L', (r - l + 20, 300), 0)
        ImageDraw.Draw(im).text((10 - l, 50), ch, fill=255, font=fnt)
        g = np.array(im).astype(float) / 255
        sy = (cap_px if ch.isupper() else xh_px) * ss / (cap0 if ch.isupper() else xh0)
        sx = cap_px * ss / cap0 * WIDE
        h2 = max(1, int(round(g.shape[0] * sy))); w2 = max(1, int(round(g.shape[1] * sx)))
        g2 = np.array(Image.fromarray((g * 255).astype(np.uint8)).resize((w2, h2), Image.LANCZOS)).astype(float) / 255
        cols = np.nonzero(g2.max(0) > 0.3)[0]
        glyphs.append((g2[:, cols.min():cols.max() + 1], (50 + bB) * sy))
    top_base = max(b for _, b in glyphs) + 6 * ss
    Hc = int(max(g.shape[0] for g, _ in glyphs) + top_base + 12 * ss)
    Wc = int(sum(g.shape[1] for g, _ in glyphs) + (len(glyphs) + 4) * (3 + TRACK) * ss)
    canvas = np.zeros((Hc, Wc))
    x = int(3 * ss)
    for g, b in glyphs:
        oy = int(round(top_base - b))
        canvas[oy:oy + g.shape[0], x:x + g.shape[1]] = np.maximum(canvas[oy:oy + g.shape[0], x:x + g.shape[1]], g)
        x += g.shape[1] + int(round((1.0 + TRACK + 2 * BOLD) * ss))
    m = canvas > 0.5
    sdf = (ndi.distance_transform_edt(~m) - ndi.distance_transform_edt(m)) / ss   # px, >0 outside
    sdf -= BOLD
    cols = np.nonzero((sdf < 0).any(0))[0]
    return sdf, top_base, cols.min(), cols.max()


def word_sdf(k, word, centre, e, H, W, ss=4):
    """Signed distance (px, >0 outside) of the warped word, sampled at pixel centres."""
    rad = e[3]
    sdf, base_row, c0, c1 = word_canvas(word, XH * rad, CAP * rad, ss)
    width = (c1 - c0) / ss
    arc = BASE[k] * e[2] * np.pi / 180
    yy, xx = np.mgrid[0:H, 0:W]
    rho, th = to_ell(xx + 0.5, yy + 0.5, e)
    dth = ((th - centre + 180) % 360) - 180
    if k == 'top':
        cx = -dth * arc + width / 2
        cy = (BASE[k] - rho) * rad
    else:
        cx = dth * arc + width / 2
        cy = (rho - BASE[k]) * rad
    span = np.abs(dth) < (width / arc / 2 + 12)
    out = np.full((H, W), 99.0)
    ys, xs = np.nonzero(span & (rho > 0.6) & (rho < 1.05))
    out[ys, xs] = ndi.map_coordinates(sdf, [base_row + cy[ys, xs] * ss, c0 + cx[ys, xs] * ss], order=1, cval=99.0)
    return out, width / arc / 2.0


def main(src, dst):
    im = Image.open(src)
    pal_flat = im.getpalette()[:768]
    P = np.array(pal_flat, float).reshape(256, 3)
    a = np.array(im).astype(int)
    rgb = P[a]
    H, W = a.shape
    Lum = rgb @ np.array([0.3, 0.59, 0.11])
    e = fit_ellipse(ndi.gaussian_filter(Lum, 0.8))
    rng = np.random.default_rng(10)
    out, oldregion = plain_cover(a, P, e, rng)
    if SET_TEXT:
        yy, xx = np.mgrid[0:H, 0:W]
        rho, th = to_ell(xx + 0.5, yy + 0.5, e)
        used = np.unique(a[rho < 1.25])
        smooth = np.stack([ndi.gaussian_filter(rgb[..., c], 0.9) for c in range(3)], -1)
        noise = rgb - smooth
        # material samples from the original lettering band
        band = np.zeros((H, W), bool)
        for k, (t0, t1) in OLD_SECT.items():
            band |= (th >= t0 + 8) & (th <= t1 - 8) & (rho >= 0.86) & (rho <= 0.97)
        Ls = ndi.gaussian_filter(Lum, 0.7)
        letter_px = band & (Ls > 92) & ndi.binary_erosion(band & (Ls > 85), np.ones((3, 3)))
        ground_px = band & (Ls < 50)
        ly, lx = np.nonzero(letter_px); gy, gx = np.nonzero(ground_px)
        letter_base = rgb[letter_px].mean(0)
        ground_base = rgb[ground_px].mean(0)
        for k, (word, centre) in WORDS.items():
            d, half_span = word_sdf(k, word, centre, e, H, W)
            inside = d < 0.5
            # channel: hugging the letters, closed between letters and out to the wall
            hug = d < 2.4
            r_in = (BASE[k] - 0.012) if k == 'top' else (BASE[k] - CAP - 0.016)
            dth = np.abs(((th - centre + 180) % 360) - 180)
            t = np.clip((dth - (half_span - 3.0)) / 9.0, 0, 1)
            r_edge = r_in + (1.0 - r_in) * t * t
            strip = (rho >= r_edge) & (rho <= 1.0) & (dth <= half_span + 6.0)
            chan = ndi.binary_closing(hug | strip, np.ones((3, 3))) & (rho <= 1.0)
            # 1) dark channel floor
            cy_, cx_ = np.nonzero(chan & ~inside)
            pick = rng.integers(0, len(gy), len(cy_))
            col = ground_base + noise[gy[pick], gx[pick]]
            out[cy_, cx_] = nearest_idx(col, used, P)
            # soft edge of the channel
            edge = ndi.binary_dilation(chan, np.ones((3, 3))) & ~chan & (rho < 1.0)
            ey, ex = np.nonzero(edge)
            out[ey, ex] = nearest_idx(0.55 * P[out[ey, ex]] + 0.45 * ground_base, used, P)
            # 2) raised letters with rims (normal from the sdf gradient)
            gyd, gxd = np.gradient(ndi.gaussian_filter(np.minimum(d, 6.0), 0.6))
            nrm = np.hypot(gxd, gyd) + 1e-6
            lit = (gxd * LIGHT_DIR[0] + gyd * LIGHT_DIR[1]) / nrm      # >0: edge faces the light
            ly_, lx_ = np.nonzero(d < 0.9)
            pick = rng.integers(0, len(ly), len(ly_))
            col = letter_base + noise[ly[pick], lx[pick]]
            dd = d[ly_, lx_]
            rim = np.clip(1.0 - (-dd) / 1.4, 0, 1)                      # 1 at the edge, 0 inside
            shade = 1.0 + rim * np.where(lit[ly_, lx_] > 0, 0.08 * lit[ly_, lx_], 0.45 * lit[ly_, lx_])
            col = col * shade[:, None]
            cov = np.clip(0.5 - dd, 0, 1)[:, None]
            under = P[out[ly_, lx_]]
            out[ly_, lx_] = nearest_idx(cov * col + (1 - cov) * under, used, P)
    o = Image.fromarray(out.astype(np.uint8), 'P')
    o.putpalette(pal_flat)
    o.save(dst)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
