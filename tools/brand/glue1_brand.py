"""Rebrand GLUE1.PCX: tiled "A.B." emblem -> "B.B.".

Usage: py -I glue1_brand.py <GLUE1.PCX> <out.png>

The picture is a 128x128 tile repeated over the screen. In one tile the "A" is removed, the
diamond plate / bomb behind it is restored by exemplar (patch) inpainting that searches the
tile itself (with wrap-around), and the tile's own "B" is copied into the A's slot (right-aligned
to the first dot, same spacing as the original B and its dot). The letters are ~82 % opaque, so
the copied B is re-composited over its new background. The edited area is then written into
every tile instance; nothing else in the picture changes. Palette is untouched.
"""
import sys

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

T = 128
ALPHA = 0.82          # opacity of the orange lettering (measured over bomb vs. plate)
PATCH = 9


def letters_mask(rgb):
    R, G, B = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    orange = (R > 120) & (R > G + 45) & (B < 0.5 * G + 20)
    red = (R > 100) & (G < 40) & (B < 40)
    return ndi.binary_closing(orange | red, np.ones((3, 3)))


def bomb_guide(rgb, letters):
    """Soft mask (0 plate .. 1 bomb) of the dark bomb disc, fitted with letters ignored."""
    H, W, _ = rgb.shape
    L = rgb @ np.array([0.3, 0.59, 0.11])
    known = ~letters
    big = lambda z: np.tile(z, (3, 3))
    w = ndi.gaussian_filter(big(known.astype(float)), 3)[H:2 * H, W:2 * W]
    Ls = ndi.gaussian_filter(big(L * known), 3)[H:2 * H, W:2 * W] / np.maximum(w, 1e-6)
    yy, xx = np.mgrid[0:H, 0:W]
    centre = np.hypot(xx - W / 2, yy - H / 2)
    lo, hi = np.median(Ls[centre < 20]), np.median(Ls[centre > 58])
    bomb = Ls < (lo + hi) / 2
    lab, n = ndi.label(bomb)
    bomb = lab == lab[H // 2, W // 2]
    bomb = ndi.binary_fill_holes(bomb)
    edge = bomb & ~ndi.binary_erosion(bomb)
    edge &= ~((yy < 30) & (xx > 85))        # ignore the fuse
    ys, xs = np.nonzero(edge)
    A = np.stack([2 * xs, 2 * ys, np.ones_like(xs)], 1).astype(float)
    (cx, cy, c), *_ = np.linalg.lstsq(A, (xs ** 2 + ys ** 2).astype(float), rcond=None)
    r = np.sqrt(c + cx ** 2 + cy ** 2)
    return np.clip((r - np.hypot(xx - cx, yy - cy)) / 3.0 + 0.5, 0, 1)


def inpaint(img, hole, avoid, rng, guide=None, lam=60.0):
    """Criminisi-style exemplar inpainting on a periodic tile (float RGB). hole: pixels to fill.
    guide: optional per-pixel structure channel known everywhere (matched over the whole patch)."""
    H, W, _ = img.shape
    img = img.copy()
    hole = hole.copy()
    conf = (~hole).astype(float)
    r = PATCH // 2
    # candidate source patches: fully outside hole and avoid (with wrap-around)
    bad = hole | avoid
    badw = np.pad(bad, r, mode='wrap')
    ok_src = ~ndi.maximum_filter(badw, size=PATCH)[r:-r, r:-r]
    sy, sx = np.nonzero(ok_src)
    offs = np.arange(-r, r + 1)
    def patch_idx(y, x):
        yi = (y + offs[:, None]) % H
        xi = (x + offs[None, :]) % W
        return np.broadcast_arrays(yi, xi)
    src_patches = np.stack([img[patch_idx(y, x)] for y, x in zip(sy, sx)])  # N,P,P,3
    if guide is not None:
        src_guide = np.stack([guide[patch_idx(y, x)] for y, x in zip(sy, sx)]) * lam
    gray = img @ np.array([0.3, 0.59, 0.11])
    while hole.any():
        front = hole & ndi.binary_dilation(~hole, np.ones((3, 3)))
        fy, fx = np.nonzero(front)
        # priority: confidence * gradient strength of the known neighbourhood
        pri = []
        gy, gx = np.gradient(np.where(hole, np.nan, gray))
        for y, x in zip(fy, fx):
            yi, xi = patch_idx(y, x)
            c = conf[yi, xi].mean()
            g = np.nan_to_num(np.hypot(gy[yi, xi], gx[yi, xi]))
            pri.append(c * (0.2 + g.max() / 64.0))
        k = int(np.argmax(pri))
        y, x = fy[k], fx[k]
        yi, xi = patch_idx(y, x)
        known = ~hole[yi, xi]
        tp = img[yi, xi]
        d = (((src_patches - tp[None]) ** 2).sum(-1) * known[None]).sum((1, 2))
        if guide is not None:
            d = d + ((src_guide - guide[yi, xi][None] * lam) ** 2).sum((1, 2))
        best = np.argsort(d)[:3]
        j = best[rng.integers(len(best))] if d[best[-1]] < d[best[0]] * 1.05 else best[0]
        sp = src_patches[j]
        fillm = hole[yi, xi]
        img[yi[fillm], xi[fillm]] = sp[fillm]
        conf[yi[fillm], xi[fillm]] = conf[yi, xi][known].mean() if known.any() else 0.5
        hole[yi[fillm], xi[fillm]] = False
    return img


def nearest_idx(cols, idxs, P):
    idxs = np.asarray(idxs)
    Q = P[idxs]
    return idxs[((cols[:, None, :] - Q[None]) ** 2).sum(-1).argmin(1)]


def main(src, dst):
    im = Image.open(src)
    pal_flat = im.getpalette()[:768]
    P = np.array(pal_flat, float).reshape(256, 3)
    a = np.array(im).astype(int)
    H, W = a.shape
    rng = np.random.default_rng(42)
    t = a[:T, :T].copy()
    rgb = P[t]
    let = letters_mask(rgb)
    lab, n = ndi.label(let)
    comps = []
    for i, sl in enumerate(ndi.find_objects(lab)):
        if (lab[sl] == i + 1).sum() > 20:
            comps.append((sl[1].start, i + 1, sl))
    comps.sort()
    (_, iA, slA), (_, iD1, slD1), (_, iB, slB), (_, iD2, slD2) = comps
    mA = lab == iA
    mB = lab == iB
    mD1 = lab == iD1
    allL = ndi.binary_dilation(let, np.ones((3, 3)))
    # where the new B goes: same gap to the first dot as the B has to its dot
    gapB = slD2[1].start - slB[1].stop
    newx0 = slD1[1].start - gapB - (slB[1].stop - slB[1].start)
    dx = newx0 - slB[1].start
    dy = 0
    # background for the whole tile without letters (A and B regions), by inpainting
    hole = ndi.binary_dilation(mA | mB, np.ones((3, 3)))
    avoid = allL & ~hole
    guide = bomb_guide(rgb, allL)
    bg = inpaint(rgb, hole, avoid, rng, guide=guide)
    # composite: start from tile with A removed (bg there)
    out_rgb = rgb.copy()
    holeA = ndi.binary_dilation(mA, np.ones((3, 3)))
    out_rgb[holeA] = bg[holeA]
    # copy B (with a 1px ring) shifted, re-compositing its translucency over the new background
    ringB = ndi.binary_dilation(mB, np.ones((3, 3)))
    ys, xs = np.nonzero(ringB)
    ty, tx = (ys + dy) % T, (xs + dx) % T
    src_px = rgb[ys, xs]
    bg_src = bg[ys, xs]
    bg_dst = out_rgb[ty, tx]
    # per-pixel opacity: full letter pixels ALPHA, ring pixels estimated from distance to bg
    cov = np.where(mB[ys, xs], ALPHA,
                   np.clip(np.linalg.norm(src_px - bg_src, axis=1) / (np.linalg.norm(np.array([168, 79, 18]) - bg_src, axis=1) + 1e-6), 0, 1) * ALPHA)
    new_px = src_px + (1 - cov)[:, None] * (bg_dst - bg_src)
    out_rgb[ty, tx] = new_px
    # quantise changed pixels; keep exact source indices where the background did not change much
    changed = np.zeros((T, T), bool)
    changed[holeA] = True
    changed[ty, tx] = True
    newt = t.copy()
    used = sorted(set(np.unique(a).tolist()))
    cy, cx = np.nonzero(changed)
    newt[cy, cx] = nearest_idx(out_rgb[cy, cx], used, P)
    # B pixels whose background is (nearly) the same keep their original index (exact copy)
    same = np.linalg.norm(bg_dst - bg_src, axis=1) < 12
    newt[ty[same], tx[same]] = t[ys[same], xs[same]]
    # write the edit into every tile instance
    res = a.copy()
    for oy in range(0, H, T):
        for ox in range(0, W, T):
            yy, xx = cy + oy, cx + ox
            ok = (yy < H) & (xx < W)
            res[yy[ok], xx[ok]] = newt[cy[ok], cx[ok]]
    o = Image.fromarray(res.astype(np.uint8), 'P')
    o.putpalette(pal_flat)
    o.save(dst)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
