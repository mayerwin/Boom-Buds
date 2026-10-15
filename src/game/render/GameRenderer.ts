// Draws one game frame exactly like the original game_frame/graf_flip pipeline:
// background (field picture + tile pictures) -> HUD text (immediate) -> plain sprites in queue order
// (timer digits, extras, power-ups, shadows, "xxx" markers, HURRY) -> player-colour remapped sprites in
// queue order (bombs, flames, players, sparkles, held bombs). See docs/re/graphics.md §5.

import type { Gfx, ScreenImage } from '../../engine/gfx.ts';
import type { GameState } from '../sim/types.ts';
import { W, H } from '../sim/types.ts';
import type { FrameCtx } from '../sim/ctx.ts';
import { DrawKind } from '../sim/ctx.ts';
import { DrawMode } from '../../engine/gl/Renderer.ts';
import { textColours, type TextColours } from './textColours.ts';
import { clipText, grafPrint, grafPrintCentered, textWidth } from '../../ui/text.ts';

/** Small pictures for the modern score lines and the "you" marker, as rows of pixels; drawn with a black outline. */
const TROPHY = iconRuns(['X.XXX.X', 'XXXXXXX', '.XXXXX.', '..XXX..', '...X...', '..XXX..', '.XXXXX.']);
const SKULL = iconRuns(['.XXXXX.', 'XXXXXXX', 'X..X..X', 'XXXXXXX', '.XX.XX.', '..XXX..', '..X.X..']);
/** the font has no "…": three dots, drawn after a cut name */
const ELLIPSIS = iconRuns(['X.X.X']);
const ELLIPSIS_W = 8;
const ARROW = iconRuns(['XXXXXXXXXXX', '.XXXXXXXXX.', '..XXXXXXX..', '...XXXXX...', '....XXX....', '.....X.....']);
/** the score lines' area: left of the timer, above the field */
const HUD_X0 = 8;
const HUD_X1 = 514;
/** the glow around this machine's bomber */
const AROUND = [[-2, 0], [2, 0], [0, -2], [0, 2], [-1, -1], [1, -1], [-1, 1], [1, 1]];

type Runs = [number, number, number][];

/** A picture's rows of pixels as runs (x, y, width), and those of its outline (the picture grown by a pixel). */
function iconRuns(rows: string[]): { fill: Runs; outline: Runs } {
  const h = rows.length;
  const w = rows[0].length;
  const on = (x: number, y: number) => y >= 0 && y < h && x >= 0 && x < w && rows[y][x] === 'X';
  const near = (x: number, y: number) => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (on(x + dx, y + dy)) return true;
    return false;
  };
  const runs = (test: (x: number, y: number) => boolean, from: number, to: number): Runs => {
    const out: Runs = [];
    for (let y = from; y < h + (to - w); y++) {
      let start = -1000;
      for (let x = from; x <= to; x++) {
        const v = x < to && test(x, y);
        if (v && start === -1000) start = x;
        else if (!v && start !== -1000) {
          out.push([start, y, x - start]);
          start = -1000;
        }
      }
    }
    return out;
  };
  return { fill: runs(on, 0, w), outline: runs(near, -1, w + 1) };
}

export class GameRenderer {
  private gfx: Gfx;
  private field: ScreenImage | null = null;
  private fieldName = '';
  private tileSeq: number[] = [0, 0, 0];
  private numericSeq = -1;
  private infinitySeq = -1;
  private xxxFrame = -1;
  private colours: TextColours;
  values: number[] = [];
  messages: Record<string, string> = {};
  /**
   * Modern menus: Boom Buds' score lines (names and icons; in team games the team scores first, then the
   * players by team) instead of the original's "S:0 K:0", which 1997 mode keeps. One name per slot.
   */
  hud: { names: string[] } | null = null;
  /**
   * Network games: the players of other machines, whose bombers are eased into place when a rollback corrects
   * their position (a jump of more than they can walk), instead of jumping there. Only the picture moves.
   */
  smooth: Set<number> | null = null;
  private ease: { x: number; y: number; tick: number; ox: number; oy: number; at: number }[] = [];

  /** A new round: no bomber is being eased. */
  easeReset(): void {
    this.ease = [];
  }
  /** Modern menus: this machine's only player, marked for the first seconds of a round (until: performance.now()) */
  you: { slot: number; until: number } | null = null;

  constructor(gfx: Gfx) {
    this.gfx = gfx;
    this.colours = textColours(gfx);
    this.numericSeq = gfx.seq('numeric font');
    this.infinitySeq = gfx.seq('infinity');
    this.xxxFrame = gfx.sprites.seqs['xxx'][0][0][0];
  }

  async prepareLevel(level: number): Promise<void> {
    const name = `FIELD${level}`;
    if (this.fieldName !== name) {
      this.field = await this.gfx.loadScreen(name);
      this.fieldName = name;
    }
    this.tileSeq = [0, this.gfx.seq(`tile ${level} solid`), this.gfx.seq(`tile ${level} brick`)];
  }

  private val(id: number): number {
    return this.values[id] ?? 0;
  }

  /** graf_print (see src/ui/text.ts) */
  print(s: string, maxw: number, x: number, y: number, fg: number, bg: number): void {
    grafPrint(this.gfx, s, maxw, x, y, fg, bg);
  }

  render(s: GameState, ctx: FrameCtx): void {
    const g = this.gfx;
    const r = g.r;
    // 1. background: field picture + tile pictures (map_draw_cell: 40x36 bitmap at the cell's top-left)
    if (this.field) g.drawScreen(this.field);
    for (let cy = 0; cy < H; cy++) {
      for (let cx = 0; cx < W; cx++) {
        const t = s.tiles[cy * W + cx];
        if (!t) continue;
        const seq = this.tileSeq[t === 1 ? 1 : 2];
        const ref = g.seqList[seq][0][0];
        const fr = g.sprites.frames[ref[0]];
        // uncropped 40x36 frame drawn with its top-left at the cell corner
        r.draw(g.atlas, fr[0], fr[1], fr[2], fr[3], fr[4], 20 + 40 * cx, 68 + 36 * cy, 0, DrawMode.Sprite);
      }
    }
    // 2. HUD text, immediate (under every sprite)
    if (this.hud) this.drawScores(s, this.hud.names);
    else {
      const msg37 = this.messages[37] ?? 'S:%d K:%d';
      for (let i = 0; i < 10; i++) {
        const p = s.players[i];
        if (p.ctrl === 0) continue;
        const x = this.val(115 + (i >> 1));
        const y = this.val(113 + (i & 1));
        const text = msg37.replace('%d', String(p.score)).replace('%d', String(p.kills));
        const [fg, bg] = this.colours.player(i, s.opts.teamPlay ? p.team : -1);
        this.print(text, 90, x, y, fg, bg);
      }
    }
    // 3. plain sprites: timer digits first (queued at the start of game_frame)
    this.drawTimer(s);
    const off = this.easeOffsets(s);
    for (const d of ctx.draws) {
      if (d.remap !== 0) continue;
      const o = d.who >= 0 ? off[d.who] : null;
      if (d.kind === DrawKind.SPRITE) g.drawFrame(d.frame, d.x + (o?.[0] ?? 0), d.y + (o?.[1] ?? 0), 0);
    }
    for (let i = 0; i < 10; i++) {
      const p = s.players[i];
      if (!this.hud && p.ctrl !== 0 && !p.alive) g.drawFrame(this.xxxFrame, this.val(115 + (i >> 1)), this.val(113 + (i & 1)), 0);
    }
    // 4. remapped sprites in queue order (this machine's only player glowing at the start of a round)
    const now = performance.now();
    const you = this.you && now < this.you.until ? this.you.slot : -1;
    const glow = Math.floor(now / 150) & 1 ? this.colours.white : this.colours.yellow;
    for (const d of ctx.draws) {
      if (d.remap === 0) continue;
      if (d.who === you && you >= 0) for (const [ox, oy] of AROUND) g.drawFrameMask(d.frame, d.x + ox, d.y + oy, glow);
      const o = d.who >= 0 ? off[d.who] : null;
      g.drawFrame(d.frame, d.x + (o?.[0] ?? 0), d.y + (o?.[1] ?? 0), d.remap);
    }
    if (you >= 0 && s.players[you].alive) this.drawYou(s.players[you].x, s.players[you].y, now);
  }

  /**
   * Where to draw the eased bombers (offsets from their real place). A move longer than the bomber could walk in
   * the ticks since the last picture (but shorter than a warp or a new round) is a correction: the picture keeps
   * the bomber where it was shown and lets it catch up within about a quarter of a second.
   */
  private easeOffsets(s: GameState): ([number, number] | null)[] {
    const out: ([number, number] | null)[] = new Array(10).fill(null);
    if (!this.smooth) return out;
    const now = performance.now();
    for (const i of this.smooth) {
      const p = s.players[i];
      const e = (this.ease[i] ??= { x: p.x, y: p.y, tick: s.tick, ox: 0, oy: 0, at: now });
      const ticks = s.tick - e.tick;
      // the offset fades (halves every 60 ms)
      const k = Math.pow(0.5, (now - e.at) / 60);
      e.ox *= k;
      e.oy *= k;
      if (Math.abs(e.ox) < 0.5 && Math.abs(e.oy) < 0.5) e.ox = e.oy = 0;
      const d = Math.abs(p.x - e.x) + Math.abs(p.y - e.y);
      if (ticks >= 0 && ticks < 30 && d > Math.max(1, ticks) * 5 + 2 && d < 100 && p.alive) {
        e.ox += e.x - p.x;
        e.oy += e.y - p.y;
      }
      if (ticks < 0 || d >= 100) e.ox = e.oy = 0;
      e.x = p.x;
      e.y = p.y;
      e.tick = s.tick;
      e.at = now;
      if (e.ox || e.oy) out[i] = [Math.round(e.ox), Math.round(e.oy)];
    }
    return out;
  }

  /** Outlined text like the original's score lines; returns where the next piece goes. */
  private say(t: string, x: number, y: number, fg: number): number {
    this.print(t, 400, x, y, fg, this.colours.black);
    return x + textWidth(this.gfx, t) + 2;
  }

  private icon(ic: { fill: Runs; outline: Runs }, x: number, y: number, colour: number): void {
    const r = this.gfx.r;
    for (const [rx, ry, w] of ic.outline) r.fillRect(x + rx, y + ry, w, 1, this.colours.black);
    for (const [rx, ry, w] of ic.fill) r.fillRect(x + rx, y + ry, w, 1, colour);
  }

  /**
   * The modern score lines, in the original's place (left of the timer, above the field). Each player in the
   * colour of their bomber (dark grey for the black one): "Name: [trophy] wins [skull] kills"; in team games the
   * team scores come first (red, then white), then the players with their kills, the red team on the first row and
   * the white team on the second. Two rows, like the original's: the bombers of the top row reach up to about
   * y = 45. A player out of the round has their name struck through.
   */
  private drawScores(s: GameState, names: string[]): void {
    const c = this.colours;
    const ids: number[] = [];
    for (let i = 0; i < 10; i++) if (s.players[i].ctrl !== 0) ids.push(i);
    const split = (list: number[]) => {
      const n = Math.ceil(list.length / 2);
      return [list.slice(0, n), list.slice(n)].filter((r) => r.length);
    };
    let rows: number[][];
    let x0 = HUD_X0;
    const team = !!s.opts.teamPlay;
    if (team) {
      const best = (t: number) => ids.reduce((m, i) => (s.players[i].team === t ? Math.max(m, s.players[i].score) : m), 0);
      let x = this.say('Team:', HUD_X0, 6, c.white) + 6;
      x = this.say(String(best(1)), x, 6, c.lightRed) + 10;
      x0 = this.say(String(best(0)), x, 6, c.white) + 18;
      const red = ids.filter((i) => s.players[i].team === 1);
      const white = ids.filter((i) => s.players[i].team !== 1);
      rows = red.length <= 5 && white.length <= 5 ? [red, white].filter((r) => r.length) : split([...red, ...white]);
    } else rows = ids.length <= 2 ? [ids] : split(ids);
    this.scoreTable(s, rows, names, x0, rows.length === 1 && !team ? 16 : 6, !team);
  }

  /**
   * The players in columns, the names of a column ending at the same place (their colons line up). The names are
   * as long as the space allows: when the columns do not fit, the longest names are cut first (with "…").
   */
  private scoreTable(s: GameState, rows: number[][], names: string[], x0: number, top: number, wins: boolean): void {
    const tw = (t: string) => textWidth(this.gfx, t);
    const cols = Math.max(1, ...rows.map((r) => r.length));
    const nameW = new Array<number>(cols).fill(0);
    const tailW = new Array<number>(cols).fill(0);
    for (const row of rows) {
      row.forEach((i, j) => {
        const p = s.players[i];
        nameW[j] = Math.max(nameW[j], tw(names[i] ?? ''));
        // [trophy] wins [skull] kills, as scoreEntry draws them (the icons take 9 px, the outlined digits 2 more)
        tailW[j] = Math.max(tailW[j], (wins ? 9 + tw(String(p.score)) + 2 + 8 : 0) + 9 + tw(String(p.kills)) + 2);
      });
    }
    const colon = tw(':') + 4;
    const gap = 14;
    const room = HUD_X1 - x0;
    const width = (cap: number) => nameW.reduce((sum, w, j) => sum + Math.min(w, cap) + colon + tailW[j], 0) + gap * (cols - 1);
    let cap = Math.max(...nameW);
    if (width(cap) > room) {
      let lo = 12;
      let hi = cap;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (width(mid) <= room) lo = mid;
        else hi = mid - 1;
      }
      cap = lo;
    }
    // what is left spreads the columns a little
    const spare = cols > 1 ? Math.min(60, Math.max(0, Math.floor((room - width(cap)) / (cols - 1)))) : 0;
    let x = x0;
    for (let j = 0; j < cols; j++) {
      const w = Math.min(nameW[j], cap);
      rows.forEach((row, k) => {
        if (j < row.length) this.scoreEntry(s, row[j], names[row[j]] ?? '', x, top + 20 * k, w, wins);
      });
      x += w + colon + tailW[j] + gap + spare;
    }
  }

  /** One player of the score lines; `nameW`: the width of its column's names (the colon goes right after it). */
  private scoreEntry(s: GameState, i: number, name: string, x: number, y: number, nameW: number, wins: boolean): void {
    const p = s.players[i];
    const c = this.colours;
    const r = this.gfx.r;
    // the colour of the bomber on the field (in team games its team's, after the first moments)
    const fg = c.hud(s.pl.trueColoursMs !== 0 ? p.index : p.colour);
    let shown = name;
    let cut = false;
    if (textWidth(this.gfx, name) > nameW) {
      shown = clipText(this.gfx, name, Math.max(0, nameW - ELLIPSIS_W));
      cut = true;
    }
    this.print(shown, 400, x, y, fg, c.black);
    const used = textWidth(this.gfx, shown) + (cut ? ELLIPSIS_W : 0);
    if (cut) this.icon(ELLIPSIS, x + textWidth(this.gfx, shown) + 2, y + 13, fg);
    // out of the round: the name struck through
    if (!p.alive) {
      r.fillRect(x, y + 8, used + 3, 3, c.black);
      r.fillRect(x + 1, y + 9, used + 1, 1, fg);
    }
    let nx = this.say(':', x + nameW, y, fg) + 2;
    if (wins) {
      this.icon(TROPHY, nx, y + 6, c.yellow);
      nx = this.say(String(p.score), nx + 9, y, fg) + 8;
    }
    this.icon(SKULL, nx, y + 6, c.rgb(27, 27, 27));
    this.say(String(p.kills), nx + 9, y, fg);
  }

  /** "YOU" and an arrow over a bomber whose feet are at (x, y), bobbing. */
  private drawYou(x: number, y: number, now: number): void {
    const bob = Math.round(Math.sin(now / 110) * 3);
    grafPrintCentered(this.gfx, 'YOU', x, y - 78 + bob, this.colours.yellow, this.colours.black);
    this.icon(ARROW, x - 5, y - 58 + bob, this.colours.yellow);
  }

  private drawTimer(s: GameState): void {
    const g = this.gfx;
    const x0 = this.val(110);
    const y = this.val(111);
    if (s.opts.playtime <= 0) {
      g.drawFrame(g.seqList[this.infinitySeq][0][0][0], x0, y, 0);
      return;
    }
    const rem = Math.max(0, s.pl.remainingS);
    const text = `${Math.floor(rem / 60)}:${String(rem % 60).padStart(2, '0')}`;
    let x = x0;
    for (const c of text) {
      const d = c.charCodeAt(0) - 48;
      if (d < 0 || d > 10) continue;
      const frame = g.seqList[this.numericSeq][d][0][0];
      g.drawFrame(frame, x, y, 0);
      x += g.sprites.frames[frame][3] + this.val(112);
    }
  }
}
