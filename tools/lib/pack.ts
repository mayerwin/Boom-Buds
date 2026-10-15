// Skyline bottom-left rectangle packer for sprite atlases.

export interface PackRect {
  id: number;
  w: number;
  h: number;
}

export interface Placement {
  id: number;
  page: number;
  x: number;
  y: number;
}

interface Segment {
  x: number;
  y: number;
  w: number;
}

class Skyline {
  segs: Segment[];
  readonly W: number;
  readonly H: number;
  constructor(W: number, H: number) {
    this.W = W;
    this.H = H;
    this.segs = [{ x: 0, y: 0, w: W }];
  }

  /** Find best position for w*h: lowest top edge, then leftmost. Returns null when it does not fit. */
  find(w: number, h: number): { x: number; y: number; i: number } | null {
    let best: { x: number; y: number; i: number } | null = null;
    for (let i = 0; i < this.segs.length; i++) {
      const x = this.segs[i].x;
      if (x + w > this.W) break;
      let y = 0;
      let remaining = w;
      let j = i;
      while (remaining > 0) {
        y = Math.max(y, this.segs[j].y);
        remaining -= this.segs[j].w;
        j++;
        if (remaining > 0 && j >= this.segs.length) { y = Infinity; break; }
      }
      if (y + h > this.H) continue;
      if (!best || y < best.y || (y === best.y && x < best.x)) best = { x, y, i };
    }
    return best;
  }

  place(x: number, y: number, w: number, h: number, i: number): void {
    const top = y + h;
    const newSeg = { x, y: top, w };
    // remove covered segments
    let end = x + w;
    let j = i;
    while (j < this.segs.length && this.segs[j].x < end) {
      const s = this.segs[j];
      const sEnd = s.x + s.w;
      if (sEnd <= end) {
        this.segs.splice(j, 1);
      } else {
        s.w = sEnd - end;
        s.x = end;
        break;
      }
    }
    this.segs.splice(i, 0, newSeg);
    // merge equal heights
    for (let k = 0; k < this.segs.length - 1; k++) {
      if (this.segs[k].y === this.segs[k + 1].y) {
        this.segs[k].w += this.segs[k + 1].w;
        this.segs.splice(k + 1, 1);
        k--;
      }
    }
  }
}

/** Pack rectangles into as many W*H pages as needed, with `pad` pixels of spacing. */
export function packRects(rects: PackRect[], W: number, H: number, pad = 1): { placements: Placement[]; pages: number } {
  const order = [...rects].sort((a, b) => b.h - a.h || b.w - a.w);
  const pages: Skyline[] = [];
  const placements: Placement[] = [];
  for (const r of order) {
    const w = r.w + pad;
    const h = r.h + pad;
    if (w > W || h > H) throw new Error(`rect ${r.id} ${r.w}x${r.h} too large for ${W}x${H}`);
    let placed = false;
    for (let p = 0; p < pages.length && !placed; p++) {
      const f = pages[p].find(w, h);
      if (f) {
        pages[p].place(f.x, f.y, w, h, f.i);
        placements.push({ id: r.id, page: p, x: f.x, y: f.y });
        placed = true;
      }
    }
    if (!placed) {
      const sk = new Skyline(W, H);
      const f = sk.find(w, h)!;
      sk.place(f.x, f.y, w, h, f.i);
      pages.push(sk);
      placements.push({ id: r.id, page: pages.length - 1, x: f.x, y: f.y });
    }
  }
  return { placements, pages: pages.length };
}
