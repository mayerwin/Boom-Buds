"""Rebrand RESULTS.PCX: header "BOMBERMAN RESULTS" -> "BOOM BUDS RESULTS".

Usage: py -I results_brand.py <RESULTS.PCX> <out.png>

The header letters sit on a wave. The nine BOMBERMAN letters are removed and the nebula /
starfield behind them is rebuilt by exemplar (patch) inpainting from the surrounding band, guided
by a smooth estimate of the background. "BOOM BUDS" is then laid out along the same wave (a curve
fitted through the original letter centres) using the picture's own letters, copied pixel for
pixel: B, O, M, B from BOMBERMAN and U, S from RESULTS. The D is the flat-backed left half of the
B joined to the round right edge of the O, with one crescent counter. The new words are right-
aligned on the old N so the gap before RESULTS stays as drawn. The bomb hanging above the header,
RESULTS and the rest of the picture are untouched. Palette is untouched.
"""
import sys

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

PATCH = 9


def lum(c):
    return c[..., 0] * 0.3 + c[..., 1] * 0.59 + c[..., 2] * 0.11


def letter_faces(rgb):
    H, W = rgb.shape[:2]
    R, G, B = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    yy, xx = np.mgrid[0:H, 0:W]
    roi = (yy < 95) & (xx > 70) & (xx < 580) & (yy > 18)
    pink = (R > 170) & (B > 0.35 * R) & (G < 0.75 * R)
    yel = (R > 170) & (G > 0.6 * R) & (B < 0.5 * G)
    face = ndi.binary_closing((pink | yel) & roi, np.ones((3, 3)))
    lab, n = ndi.label(face)
    sizes = ndi.sum(face, lab, range(1, n + 1))
    keep = np.zeros(n + 1, bool); keep[1:] = sizes > 300
    face = ndi.binary_fill_holes(keep[lab])
    lab, n = ndi.label(face)
    comps = sorted([(sl[1].start, i + 1) for i, sl in enumerate(ndi.find_objects(lab))])
    return [lab == i for _, i in comps]


def norm_conv(img, known, sigma):
    w = ndi.gaussian_filter(known.astype(float), sigma)
    out = np.stack([ndi.gaussian_filter(img[..., c] * known, sigma) for c in range(3)], -1)
    return out / np.maximum(w, 1e-6)[..., None]


def silhouettes(rgb, faces, bg_est):
    """Face + dark extrusion/outline ring (pixels clearly different from the local background)."""
    allf = np.zeros(rgb.shape[:2], bool)
    for f in faces:
        allf |= f
    diff = np.linalg.norm(rgb - bg_est, axis=-1)
    out = []
    dist_all = [ndi.distance_transform_edt(~f) for f in faces]
    for i, f in enumerate(faces):
        ring = (dist_all[i] <= 3.5) & ~f
        others = np.min([d for j, d in enumerate(dist_all) if j != i], axis=0)
        ring &= dist_all[i] <= others
        s = f | (ring & (diff > 22))
        s = ndi.binary_closing(s, np.ones((2, 2))) & (dist_all[i] <= 3.5)
        out.append(s)
    return out


def inpaint(img, hole, avoid, search, guide, lam=1.0, rng=None):
    """Exemplar inpainting; candidate patches inside `search`, fully outside hole|avoid."""
    H, W, _ = img.shape
    img = img.copy(); hole = hole.copy()
    r = PATCH // 2
    conf = (~hole).astype(float)
    bad = np.pad(hole | avoid, r, constant_values=True)
    ok = ~ndi.maximum_filter(bad, size=PATCH)[r:-r, r:-r] & search
    sy, sx = np.nonzero(ok)
    offs = np.arange(-r, r + 1)
    def pidx(y, x):
        return np.broadcast_arrays(np.clip(y + offs[:, None], 0, H - 1), np.clip(x + offs[None, :], 0, W - 1))
    SP = np.stack([img[pidx(y, x)] for y, x in zip(sy, sx)])
    SG = np.stack([guide[pidx(y, x)] for y, x in zip(sy, sx)])
    gray = lum(img)
    while hole.any():
        front = hole & ndi.binary_dilation(~hole, np.ones((3, 3)))
        fy, fx = np.nonzero(front)
        gy, gx = np.gradient(np.where(hole, np.nan, gray))
        best_p, best = -1, None
        for y, x in zip(fy, fx):
            yi, xi = pidx(y, x)
            c = conf[yi, xi].mean()
            g = np.nan_to_num(np.hypot(gy[yi, xi], gx[yi, xi])).max()
            p = c * (0.3 + g / 80.0)
            if p > best_p:
                best_p, best = p, (y, x)
        y, x = best
        yi, xi = pidx(y, x)
        known = ~hole[yi, xi]
        near = (np.abs(sx - x) < 90) & (np.abs(sy - y) < 60)
        cand = np.nonzero(near)[0] if near.sum() > 50 else np.arange(len(sy))
        d = (((SP[cand] - img[yi, xi][None]) ** 2).sum(-1) * known[None]).sum((1, 2))
        d += lam * ((SG[cand] - guide[yi, xi][None]) ** 2).sum(-1).sum((1, 2))
        j = cand[int(np.argmin(d))]
        fillm = hole[yi, xi]
        img[yi[fillm], xi[fillm]] = SP[j][fillm]
        conf[yi[fillm], xi[fillm]] = conf[yi, xi][known].mean() if known.any() else 0.3
        hole[yi[fillm], xi[fillm]] = False
    return img


def nearest(col, P, idxs):
    idxs = np.asarray(idxs)
    return idxs[((P[idxs] - col) ** 2).sum(1).argmin()]


def crop(a, sil):
    ys, xs = np.nonzero(sil)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    return a[y0:y1, x0:x1].copy(), sil[y0:y1, x0:x1].copy()

def make_D(a, P, sil_B, sil_O, used):
    """D = flat left half of the B + round right edge profile of the O; one crescent counter."""
    bs, bm = crop(a, sil_B)
    os_, om = crop(a, sil_O)
    hb, wb = bm.shape
    ho, wo = om.shape
    bright = lambda s, m: (P[s][..., 0] > 180) & (lum(P[s]) > 110) & m
    fb = bright(bs, bm); fo = bright(os_, om)
    rowsb = [r for r in range(hb) if fb[r].any()]
    rowso = [r for r in range(ho) if fo[r].any()]
    tb, bb = rowsb[0], rowsb[-1]
    to, bo = rowso[0], rowso[-1]
    xlb = {r: np.nonzero(fb[r])[0].min() for r in rowsb}
    xro = {r: np.nonzero(fo[r])[0].max() for r in rowso}
    xlo = {r: np.nonzero(fo[r])[0].min() for r in rowso}
    # width of the D: the B's width; O's right contour scaled into it
    bw = max(np.nonzero(fb[r])[0].max() for r in rowsb) - min(xlb.values()) + 1
    ow = max(xro.values()) - min(xlo.values()) + 1
    W = wb + 4
    sub = np.zeros((hb, W), int)
    m = np.zeros((hb, W), bool)
    sub[:, :wb] = bs; m[:, :wb] = bm
    ocx = (max(xro.values()) + min(xlo.values())) / 2.0
    bcx = (max(np.nonzero(fb[r])[0].max() for r in rowsb) + min(xlb.values())) / 2.0
    for r in range(hb):
        if r < tb or r > bb:
            continue
        # matching O row (relative height)
        ro = int(round(to + (r - tb) * (bo - to) / max(bb - tb, 1)))
        ro = min(max(ro, to), bo)
        # O edge position mapped to B coordinates
        xe = int(round(bcx + (xro[ro] - ocx) * bw / ow))
        xe = max(xe, int(bcx) + 2)
        # clear the old right side of this row
        m[r, int(bcx):] = False
        # face from the B's own row pattern (parity preserved)
        lo = xlb.get(r, 0) + 2
        for x in range(int(bcx), xe - 1):
            cols = [c for c in range(lo, int(bcx)) if (c - x) % 2 == 0]
            src = cols[((x - int(bcx)) // 2) % len(cols)] if cols else x - 2
            sub[r, x] = sub[r, src]
            m[r, x] = True
        # edge profile of the O (last face pixel + 4 outside) at xe
        for k in range(-1, 5):
            xs_, xd = xro[ro] + k, xe + k
            if 0 <= xs_ < wo and 0 <= xd < W and (om[ro, xs_] or k <= 0):
                sub[r, xd] = os_[ro, xs_]
                m[r, xd] = True
    # bottom/top rows beyond the face rows: keep the B's (outline/extrusion) but clip to the new contour
    # remove the B's counters: dark pixels inside the face
    f = (P[sub][..., 0] > 180) & (lum(P[sub]) > 110) & m
    inside = ndi.binary_erosion(m, np.ones((5, 5)))
    for r in rowsb:
        med = np.median(lum(P[sub[r]])[f[r]])
        for x in np.nonzero(inside[r] & (lum(P[sub[r]]) < 0.8 * med))[0]:
            sx = x - 2
            while sx > 0 and lum(P[sub[r, sx]]) < 0.8 * med:
                sx -= 2
            sub[r, x] = sub[r, sx]
    # crescent counter, left of centre, middle 46 % of the height
    h = bb - tb + 1
    top, bot = tb + int(round(0.27 * h)), tb + int(round(0.73 * h))
    xstem = min(xlb.values()) + int(round(0.36 * bw))
    for y in range(top, bot + 1):
        t = (y - top) / max(bot - top, 1)
        bulge = int(round(1.4 * np.sin(np.pi * t)))
        face = (P[sub[y, xstem - 3]] + P[sub[y, xstem - 2]]) / 2
        dark = nearest(face * 0.40 + np.array([0, 0, 30]), P, used)
        mid = nearest(face * 0.68, P, used)
        x = xstem + bulge
        sub[y, x] = dark
        if 0.1 < t < 0.9:
            sub[y, x + 1] = dark if 0.3 < t < 0.7 else mid
            sub[y, x - 1] = mid if 0.25 < t < 0.75 else sub[y, x - 1]
    return sub, m


def main(src, dst):
    im = Image.open(src)
    pal_flat = im.getpalette()[:768]
    P = np.array(pal_flat, float).reshape(256, 3)
    a = np.array(im).astype(int)
    rgb = P[a]
    H, W = a.shape
    yy, xx = np.mgrid[0:H, 0:W]
    rng = np.random.default_rng(3)
    faces = letter_faces(rgb)
    assert len(faces) == 16, len(faces)
    allf = np.zeros((H, W), bool)
    for f in faces:
        allf |= f
    bg_est = norm_conv(rgb, ~ndi.binary_dilation(allf, np.ones((9, 9))), 6)
    sils = silhouettes(rgb, faces, bg_est)
    names = list('BOMBERMAN') + list('RESULTS')
    S = dict()
    for i, n_ in enumerate(names):
        S.setdefault(n_, []).append(i)
    # arc: centre y as a smooth function of centre x (through all 16 letters)
    cxs, cys = [], []
    for f in faces:
        ys, xs = np.nonzero(f)
        cxs.append((xs.min() + xs.max()) / 2); cys.append((ys.min() + ys.max()) / 2)
    arc = np.poly1d(np.polyfit(cxs, cys, 4))

    # 1) remove BOMBERMAN, rebuild background
    old = np.zeros((H, W), bool)
    for i in range(9):
        old |= sils[i]
        # wider: shadow / outline pixels up to 6 px away that differ from the smooth background
        near = ndi.distance_transform_edt(~faces[i]) <= 6
        old |= near & (np.linalg.norm(rgb - bg_est, axis=-1) > 18) & ~(lum(rgb) > lum(bg_est) + 40)
    old = ndi.binary_dilation(old, np.ones((3, 3)))
    for i in range(9, 16):
        old &= ~sils[i]
    # the bomb hanging above the header is scenery: protect it
    sat = rgb.max(-1) - rgb.min(-1)
    grey = (sat < 40) & (lum(rgb) > 6) & (lum(rgb) < 160) & (yy < 60) & (xx > 330) & (xx < 400)
    lab, n = ndi.label(ndi.binary_closing(grey, np.ones((3, 3))))
    bomb = ndi.binary_fill_holes(lab == lab[33, 372]) if lab[33, 372] else np.zeros_like(grey)
    bomb = ndi.binary_dilation(bomb, np.ones((5, 5)))
    old &= ~bomb
    keep_letters = np.zeros((H, W), bool)
    for i in range(9, 16):
        keep_letters |= ndi.binary_dilation(sils[i], np.ones((3, 3)))
    search = (yy < 110) & (xx > 40) & (xx < 600)
    guide = norm_conv(rgb, ~old & ~keep_letters & ~bomb, 5)
    bg = inpaint(rgb, old, keep_letters | bomb, search, guide, lam=2.0, rng=rng)
    out = a.copy()
    cyh, cxh = np.nonzero(old)
    used = sorted(set(np.unique(a[search]).tolist()))
    Q = P[used]
    cols = bg[cyh, cxh]
    out[cyh, cxh] = np.array(used)[((cols[:, None, :] - Q[None]) ** 2).sum(-1).argmin(1)]

    # 2) "BOOM BUDS" along the arc
    src_ids = {'B1': S['B'][0], 'O': S['O'][0], 'M': S['M'][0], 'B2': S['B'][1], 'U': names.index('U'),
               'S': 9 + names[9:].index('S')}
    used_hdr = sorted(set(np.unique(a[:100]).tolist()))
    D_sub, D_m = make_D(a, P, sils[S['B'][1]], sils[S['O'][0]], used_hdr)
    seq = ['B1', 'O', 'O', 'M', ' ', 'B2', 'U', 'D', 'S']

    def piece(k):
        if k == 'D':
            return D_sub, D_m
        i = src_ids[k]
        ys, xs = np.nonzero(sils[i])
        y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
        return a[y0:y1, x0:x1], sils[i][y0:y1, x0:x1]

    def face_w(k):
        if k == 'D':
            return D_m.shape[1] - 3
        i = src_ids[k]
        xs = np.nonzero(faces[i].any(0))[0]
        return xs.max() - xs.min() + 1

    gap, space = 4.5, 12
    total = sum(face_w(k) for k in seq if k != ' ') + gap * (len(seq) - 3) + space
    # keep the original word gap in front of RESULTS: right-align on the old N
    right_end = np.nonzero(faces[8].any(0))[0].max() + 1
    x = right_end - total
    for k in seq:
        if k == ' ':
            x += space - gap
            continue
        sub, m = piece(k)
        fw = face_w(k)
        # face box inside the piece
        if k == 'D':
            fys, fxs = np.nonzero(D_m)
        else:
            fys, fxs = np.nonzero(faces[src_ids[k]][tuple(slice(s, s + n) for s, n in zip(
                (np.nonzero(sils[src_ids[k]])[0].min(), np.nonzero(sils[src_ids[k]])[1].min()), m.shape))])
        fx0 = fxs.min(); fyc = (fys.min() + fys.max()) / 2
        cx = x + fw / 2
        ox = int(round(x)) - fx0
        oy = int(round(arc(cx) - fyc))
        ys_, xs_ = np.nonzero(m)
        out[ys_ + oy, xs_ + ox] = sub[ys_, xs_]
        x += fw + gap
    o = Image.fromarray(out.astype(np.uint8), 'P')
    o.putpalette(pal_flat)
    o.save(dst)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
