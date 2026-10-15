// The game's modal dialogs, built from GNW windows (docs/re/screens.md §0.10, docs/re/gnw-widgets.md):
// message boxes, yes/no boxes, list selection, text input, the progress window and the pause window.
// While a dialog is up the screen below stays frozen, exactly like GNW keeps the main window untouched.

import type { Ui } from './ui.ts';
import { isRealKey } from './ui.ts';
import { Gnw, GnwWindow, TEXT_NOFILL, TEXT_SHADOW, type GnwButton } from './gnw.ts';
import { K } from './menuInput.ts';
import type { TextureHandle } from '../engine/gl/Renderer.ts';
import { SCREEN_W, SCREEN_H } from '../engine/constants.ts';

/**
 * A small menu in the style of the original's boxes (a Boom Buds addition: the pause box of 1997 mode): a
 * title, an optional note and one button per choice. Its owner draws the window over the round, which may go
 * on meanwhile (network games), and passes it the keys: Up / Down and Enter, the number keys or a click
 * (the buttons' codes) choose; Esc is the first choice.
 */
export class MenuBox {
  readonly win: GnwWindow;
  private buttons: GnwButton[];
  private sel = 0;
  private dlg: Dialogs;
  private title: string;
  private note: string | null;
  private items: string[];
  private fg: number;
  private outline: number;

  constructor(dlg: Dialogs, title: string, note: string | null, items: string[], fg: number, outline: number) {
    this.dlg = dlg;
    this.title = title;
    this.note = note;
    this.items = items;
    this.fg = fg;
    this.outline = outline;
    const g = dlg.gnw;
    const fh = g.lineHeight;
    const rowH = fh + 20;
    const labelW = Math.max(...items.map((t) => g.textWidth(t)));
    const W = Math.max(g.textWidth(title), note ? g.textWidth(note) : 0, labelW + 60) + 64;
    const top = fh + (note ? fh + 4 : 0) + 52;
    const H = top + items.length * rowH + 20;
    this.win = dlg.window(Math.trunc((SCREEN_W - W) / 2), Math.trunc((SCREEN_H - H) / 2), W, H);
    this.buttons = items.map((t, i) => g.textButton(this.win, 0, top + i * rowH, t, -1, 0x31 + i));
    for (const b of this.buttons) b.x = Math.trunc((W - b.w) / 2);
    this.render();
  }

  private render(): void {
    const g = this.dlg.gnw;
    const ui = this.dlg.ui;
    const win = this.win;
    const fh = g.lineHeight;
    if (g.winz) win.buf.fillWinz(g.winz);
    g.printCentered(win, this.title, Math.trunc(win.w / 2), fh + 18, this.fg, this.outline);
    if (this.note) g.printCentered(win, this.note, Math.trunc(win.w / 2), 2 * fh + 22, ui.col.grey, ui.col.black);
    // the keyboard's choice: an arrow beside its button
    const b = this.buttons[this.sel];
    g.print(win, '>', 20, b.x - 18, b.y + Math.trunc((b.h - fh) / 2) - 1, ui.col.yellow, ui.col.black);
  }

  /** A key (or a button's code): the index of the choice made, or -1. */
  key(k: number): number {
    const n = this.items.length;
    if (isRealKey(k)) this.dlg.ui.letter();
    if (k === K.UP || k === K.DOWN) {
      this.sel = (this.sel + (k === K.UP ? n - 1 : 1)) % n;
      this.render();
      return -1;
    }
    if (k === K.ENTER || k === K.SPACE) return this.sel;
    if (k === K.ESC) return 0;
    if (k >= 0x31 && k < 0x31 + n) return k - 0x31;
    return -1;
  }
}

export class Dialogs {
  readonly ui: Ui;
  readonly gnw: Gnw;
  private snaps: TextureHandle[] = [];
  /** open progress window (progress_window_update keeps it between calls) */
  private progressWin: GnwWindow | null = null;
  private progressTitle = 'Completion';
  private progressUnder: TextureHandle | null = null;

  constructor(ui: Ui, gnw: Gnw) {
    this.ui = ui;
    this.gnw = gnw;
  }

  /**
   * win_add: GNW consumes two rand() results for every window it creates, and places it with win_move
   * (0x43d398), which keeps the window on the screen (the editor's dialogs at y = 400 move up).
   */
  window(x: number, y: number, w: number, h: number): GnwWindow {
    this.ui.rand();
    this.ui.rand();
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    if (x + w - 1 > SCREEN_W - 1) x = SCREEN_W - w;
    if (y + h - 1 > SCREEN_H - 1) y = SCREEN_H - h;
    return this.gnw.window(x, y, w, h);
  }

  /** Run a modal loop over the frozen screen until `onKey` returns true. */
  async modal(win: GnwWindow, onKey: (k: number) => boolean | Promise<boolean>): Promise<void> {
    const ui = this.ui;
    const under = ui.snapshot(this.snaps.pop() ?? null);
    ui.windows.push(win);
    try {
      for (;;) {
        ui.drawSnapshot(under);
        win.draw(ui.gfx);
        const k = await ui.flip();
        if (await onKey(k)) break;
      }
    } finally {
      const i = ui.windows.indexOf(win);
      if (i >= 0) ui.windows.splice(i, 1);
      win.dispose(ui.gfx);
      // show the screen without the dialog until the caller draws its next frame
      ui.drawSnapshot(under);
      this.snaps.push(under);
    }
  }

  // --------------------------------------------------------------------------------- message boxes

  private boxGeometry(line1: string | null, line2: string | null): { W: number; H: number } {
    const g = this.gnw;
    let w = 0;
    if (line1) w = Math.max(w, g.textWidth(line1));
    if (line2) w = Math.max(w, g.textWidth(line2));
    w = Math.max(w, 80);
    const fh = g.lineHeight;
    const H = (line1 && line2 ? 2 * fh : fh) + 4 * fh + 64;
    return { W: w + 64, H };
  }

  private boxWindow(line1: string | null, line2: string | null, fg: number, outline: number): GnwWindow {
    const g = this.gnw;
    const { W, H } = this.boxGeometry(line1, line2);
    const win = this.window(Math.trunc((SCREEN_W - W) / 2), Math.trunc((SCREEN_H - H) / 2), W, H);
    if (g.winz) win.buf.fillWinz(g.winz);
    const fh = g.lineHeight;
    if (line1) g.printCentered(win, line1, Math.trunc(W / 2), fh + 32, fg, outline);
    if (line2) g.printCentered(win, line2, Math.trunc(W / 2), fh + 32 + fh + 2, fg, outline);
    return win;
  }

  /** msgbox_ok (0x414340): Enter, Esc or Space (or the Ok button) closes it. */
  async msgboxOk(line1: string | null, line2: string | null, fg: number, outline: number): Promise<void> {
    const g = this.gnw;
    const win = this.boxWindow(line1, line2, fg, outline);
    g.textButton(win, Math.trunc(win.w / 2) - 32, win.h - g.lineHeight - 38, this.ui.msg(27), -1, K.ESC);
    await this.modal(win, (k) => {
      if (isRealKey(k)) this.ui.letter();
      return k === K.ENTER || k === K.ESC || k === K.SPACE;
    });
  }

  /** msgbox_yes_no (0x41456c): 1 for Enter/Space/Y, 0 for Esc/N/Q. */
  async msgboxYesNo(line1: string | null, line2: string | null, fg: number, outline: number): Promise<number> {
    const g = this.gnw;
    const win = this.boxWindow(line1, line2, fg, outline);
    const by = win.h - g.lineHeight - 38;
    g.textButton(win, Math.trunc(win.w / 2) - 80, by, this.ui.msg(26), -1, 0x59);
    g.textButton(win, Math.trunc(win.w / 2) + 22, by, this.ui.msg(25), -1, 0x4e);
    let r = 0;
    await this.modal(win, (k) => {
      if (isRealKey(k)) this.ui.letter();
      if (k === K.ENTER || k === K.SPACE || k === 0x59 || k === 0x79) { r = 1; return true; }
      if (k === K.ESC || k === 0x4e || k === 0x6e || k === 0x51 || k === 0x71) { r = 0; return true; }
      return false;
    });
    return r;
  }

  // --------------------------------------------------------------------------------- list selection

  /**
   * list_select_dialog (0x41485a) = GNW win_list_select_at: returns the chosen index or -1.
   * `color` may include TEXT_SHADOW (0x10000) for the drop-shadowed item text.
   */
  async listSelect(title: string, items: string[], x: number, y: number, color: number): Promise<number> {
    const ui = this.ui;
    const g = this.gnw;
    const c = g.colors;
    const fh = g.lineHeight;
    ui.mouseShow();
    let listW = 0;
    for (const s of items) listW = Math.max(listW, g.textWidth(s));
    let winW = listW + 16;
    const titleW = g.textWidth(title);
    if (titleW > winW) {
      winW = titleW;
      listW = titleW - 16;
    }
    winW += 20;
    const capacity = 10;
    const winH = 13 * fh + 22;
    const win = this.window(x, y, winW, winH);
    const b = win.buf;
    b.rect(0, 0, winW - 1, winH - 1, c.black);
    b.rectShadowed(1, 1, winW - 2, winH - 2, c.wcolor[1], c.wcolor[2]);
    b.fill(5, 5, winW - 11, fh + 3, c.wcolor[0]);
    // (BM95's GNW draws the list title with the drop shadow)
    b.text(g.font, title, winW, Math.trunc(winW / 2) - Math.trunc(titleW / 2), 8, c.wcolor[3] | TEXT_SHADOW, c);
    b.rectShadowed(5, 5, winW - 6, fh + 8, c.wcolor[2], c.wcolor[1]);
    const lx = 8;
    const ly = fh + 16;
    const lmaxY = capacity * fh + ly;
    b.fill(lx - 3, ly - 2, listW + lx - 2, capacity * fh + 2, c.wcolor[0]);
    const n = items.length;
    let top = 0;
    let sel = 0;
    const drawItems = () => {
      const cnt = Math.min(n, capacity);
      for (let i = 0; i < cnt; i++) {
        const s = items[top + i] ?? '';
        if (s) g.windowText(win, s, listW, lx, ly + i * fh, color | TEXT_NOFILL);
        else {
          b.line(lx, ly + i * fh + (fh >> 1), lx + listW - 1, ly + i * fh + (fh >> 1), c.wcolor[2]);
          b.line(lx, ly + i * fh + (fh >> 1) + 1, lx + listW - 1, ly + i * fh + (fh >> 1) + 1, c.wcolor[1]);
        }
      }
    };
    drawItems();
    b.lighten(lx, ly + sel * fh, listW, fh, c);
    b.rectShadowed(5, ly - 3, listW + 10, lmaxY, c.wcolor[2], c.wcolor[1]);
    g.textButton(win, winW - 25, ly - 3, '\x18', K.UP, -1);
    g.textButton(win, winW - 25, lmaxY - fh - 5, '\x19', K.DOWN, -1);
    g.textButton(win, Math.trunc(winW / 2) - 32, winH - 8 - fh - 6, 'Done', -1, K.ESC);
    const sbX = winW - 21;
    let sbY = ly + fh + 7;
    const knob = 14;
    const sbH = lmaxY - sbY;
    b.fill(sbX, sbY, knob + 1, sbH - fh - 8, c.wcolor[0]);
    win.addButton({ x: sbX, y: sbY, w: knob + 1, h: sbH - fh - 8, normal: null, pressed: null, downCode: 2048, upCode: -1 });
    b.rectShadowed(winW - 22, sbY - 1, sbX + knob + 1, lmaxY - fh - 9, c.wcolor[2], c.wcolor[1]);
    b.rectShadowed(sbX, sbY, sbX + knob, sbY + knob, c.wcolor[1], c.wcolor[2]);
    b.lighten(sbX, sbY, knob, knob, c);
    for (let i = 0; i < capacity; i++) {
      win.addButton({ x: lx, y: ly + i * fh, w: listW, h: fh, normal: null, pressed: null, enterCode: 512 + i, downCode: 1024 + i, upCode: -1 });
    }
    // the title strip is a drag handle
    win.addButton({ x: 0, y: 0, w: winW, h: fh + 8, normal: null, pressed: null, downCode: -1, upCode: -1, drag: true });
    const sbY0 = ly + fh + 7;
    let result = -1;
    // a row under the (possibly untouched) mouse cursor gets the highlight as soon as the list opens
    const hover0 = win.hoverCode(ui.cursorX, ui.cursorY);
    let pending = hover0 >= 512 && hover0 < 512 + capacity ? hover0 : -1;
    await this.modal(win, (k0) => {
      let k = k0;
      if (pending !== -1 && k === -1) {
        k = pending;
        pending = -1;
      }
      if (k === K.ENTER || (k >= 1024 && k < 1024 + capacity)) {
        if (k >= 1024) sel = k - 1024;
        if (top + sel < n) {
          result = top + sel;
          return true;
        }
        return false;
      }
      if (k === 2048) {
        if (win.y + sbY > ui.cursorY) k = K.PGUP;
        else if (win.y + knob + sbY < ui.cursorY) k = K.PGDN;
      }
      if (k === K.ESC) return true;
      let redraw = 0; // -3 item, -4 all
      let prev = -1;
      if (k >= 512 && k < 512 + capacity) {
        const i = k - 512;
        if (i !== sel && i < n) {
          prev = sel;
          sel = i;
          redraw = 3;
        }
      } else if (k === K.HOME) {
        if (top > 0) { top = 0; redraw = 4; }
      } else if (k === K.UP) {
        if (sel > 0) { prev = sel; sel--; redraw = 3; } else if (top > 0) { top--; redraw = 4; }
      } else if (k === K.PGUP) {
        if (top > 0) { top = Math.max(0, top - capacity); redraw = 4; }
      } else if (k === K.END) {
        if (top < n - capacity) { top = n - capacity; redraw = 4; }
      } else if (k === K.DOWN) {
        if (sel < capacity - 1 && sel < n - 1) { prev = sel; sel++; redraw = 3; } else if (top + capacity < n) { top++; redraw = 4; }
      } else if (k === K.PGDN) {
        if (top < n - capacity) { top = Math.min(n - capacity, top + capacity); redraw = 4; }
      } else if (n > capacity && ((k >= 0x61 && k <= 0x7a) || (k >= 0x41 && k <= 0x5a))) {
        const ch = String.fromCharCode(k).toLowerCase();
        const found = items.findIndex((s) => s.charAt(0).toLowerCase() === ch);
        if (found !== -1) {
          top = Math.min(found, n - capacity);
          sel = found - top;
          redraw = 4;
        }
      }
      if (redraw === 4) {
        b.fill(lx, ly, listW, lmaxY - ly, c.wcolor[0]);
        drawItems();
        b.lighten(lx, ly + sel * fh, listW, fh, c);
        if (n > capacity) {
          b.fill(sbX, sbY, knob + 1, knob + 1, c.wcolor[0]);
          sbY = Math.trunc((top * (lmaxY - ly - 2 * fh - 16 - knob - 1)) / (n - capacity)) + sbY0;
          b.rectShadowed(sbX, sbY, sbX + knob, sbY + knob, c.wcolor[1], c.wcolor[2]);
          b.lighten(sbX, sbY, knob, knob, c);
        }
      } else if (redraw === 3) {
        if (prev !== -1) {
          b.fill(lx, ly + prev * fh, listW, fh, c.wcolor[0]);
          b.text(g.font, items[top + prev], winW, lx, ly + prev * fh, color, c);
        }
        b.lighten(lx, ly + sel * fh, listW, fh, c);
      }
      return false;
    });
    ui.mouseHide();
    return result;
  }

  // --------------------------------------------------------------------------------- text input

  /** win_get_str (0x42e938): edit `initial`; returns the new text, or null when cancelled. */
  async getString(initial: string, maxLen: number, title: string, x: number, y: number): Promise<string | null> {
    const ui = this.ui;
    const g = this.gnw;
    const c = g.colors;
    const fh = g.lineHeight;
    const mouseWasShown = ui.mouseVisible;
    ui.mouseShow();
    // width: max(title + 12, widest glyph * (maxLen + 1)) + 16, at least 160 (0x42e95f; 543 px for 30 chars)
    let tw = g.textWidth(title) + 12;
    if (tw < g.font.maxWidth() * (maxLen + 1)) tw = g.font.maxWidth() * (maxLen + 1);
    let W = tw + 16;
    if (W < 160) W = 160;
    const H = 5 * fh + 16;
    const win = this.window(x, y, W, H);
    g.border(win);
    const b = win.buf;
    b.fill(14, fh + 14, W - 28, fh + 2, c.wcolor[0]);
    b.text(g.font, title, W, 8, 8, c.wcolor[4], c);
    b.rectShadowed(14, fh + 14, W - 14, 2 * fh + 16, c.wcolor[2], c.wcolor[1]);
    g.textButton(win, Math.trunc(W / 2) - 72, H - 8 - fh - 6, 'Done', -1, K.ENTER);
    g.textButton(win, Math.trunc(W / 2) + 8, H - 8 - fh - 6, 'Cancel', -1, K.ESC);
    // _win_input_str: the text is shown with a literal '_' cursor; the first Backspace clears everything
    const fx = 16, fy = fh + 16;
    const fg = c.wcolor[3], bg = c.wcolor[0];
    let text = initial.slice(0, maxLen);
    let first = true;
    const show = (prevWidth: number) => {
      const s = text + '_';
      const w = Math.max(prevWidth, g.textWidth(s));
      b.fill(fx, fy, w, fh, bg);
      b.text(g.font, s, g.textWidth(s), fx, fy, fg, c);
    };
    show(0);
    const native = openNativeKeyboard(ui, text, maxLen);
    let result: string | null = null;
    await this.modal(win, (k) => {
      const typed = native?.take();
      if (typed !== undefined && typed !== text) {
        const pw = g.textWidth(text + '_');
        text = typed.slice(0, maxLen);
        first = false;
        show(pw);
        return false;
      }
      if (k === -1 || k === -2) return false;
      if (k === K.ESC) return true;
      if (k === K.ENTER) {
        result = text;
        return true;
      }
      const pw = g.textWidth(text + '_');
      if (k === K.BACKSPACE) {
        if (text.length > 0) text = first ? '' : text.slice(0, -1);
        show(pw);
      } else if (k > 0 && k < 256 && k >= 32) {
        if (text.length < maxLen) {
          text += String.fromCharCode(k);
          show(pw);
        }
      }
      first = false;
      return false;
    });
    native?.close();
    if (!mouseWasShown) ui.mouseHide();
    return result;
  }

  /**
   * win_yes_no (0x42ede0, GNW; only the level editor uses it): `question` at (16,8) in `color` without
   * outline, buttons "Yes" (sends 'y') and "No" ('n'). Returns 1 for Enter, Space, y, Y and 0 for Esc, n, N.
   * No sounds.
   */
  async winYesNo(question: string, x: number, y: number, color: number): Promise<number> {
    const g = this.gnw;
    const fh = g.lineHeight;
    const H = 3 * fh + 16;
    let W = g.textWidth(question) + 16;
    if (W < 144) W = 144;
    W += 16;
    const win = this.window(x, y, W, H);
    g.border(win);
    win.buf.text(g.font, question, W, 16, 8, color, g.colors);
    const by = H - 8 - fh - 6;
    g.textButton(win, Math.trunc(W / 2) - 64, by, 'Yes', -1, 0x79);
    g.textButton(win, Math.trunc(W / 2) + 16, by, 'No', -1, 0x6e);
    let r = 0;
    await this.modal(win, (k) => {
      if (k === K.ESC || k === 0x6e || k === 0x4e) {
        r = 0;
        return true;
      }
      if (k === K.ENTER || k === K.SPACE || k === 0x79 || k === 0x59) {
        r = 1;
        return true;
      }
      return false;
    });
    return r;
  }

  // --------------------------------------------------------------------------------- progress window

  /** progress_set_title */
  progressTitleSet(s: string): void {
    this.progressTitle = s.slice(0, 99);
  }

  /** progress_window_update(percent): draws the window over the current screen; closes it at 100 %. */
  progressDraw(percent: number): void {
    const ui = this.ui;
    const g = this.gnw;
    const c = ui.col;
    const h = g.lineHeight;
    const hh = h >> 1;
    if (!this.progressWin) {
      this.progressWin = this.window(150, 200, 360, 8 * h);
      this.progressUnder = ui.snapshot(this.progressUnder);
    }
    const win = this.progressWin;
    const p = Math.max(0, Math.min(100, Math.trunc(percent)));
    if (g.winz) win.buf.fillWinz(g.winz);
    const tw = g.textWidth(this.progressTitle);
    g.print(win, this.progressTitle, tw, Math.trunc((360 - tw) / 2), h + hh, c.white, c.black);
    win.buf.rect(30, 5 * h + hh, 331, 6 * h + hh, c.white);
    const pct = `${p}%`;
    const pw = g.textWidth(pct);
    g.print(win, pct, pw, Math.trunc((360 - pw) / 2), 3 * h + hh, c.yellow, c.black);
    win.buf.fill(31, 5 * h + hh + 1, p * 3, h - 1, c.grey);
    win.buf.fill(31 + p * 3, 5 * h + hh + 1, (100 - p) * 3, h - 1, c.black);
    if (this.progressUnder) ui.drawSnapshot(this.progressUnder);
    win.draw(ui.gfx);
    if (p >= 100) {
      win.dispose(ui.gfx);
      this.progressWin = null;
    }
  }

  get progressOpen(): boolean {
    return this.progressWin !== null;
  }

}

/**
 * On touch devices there is no keyboard: focus a hidden <input> so the OS keyboard opens while a text
 * dialog is up; its value is mirrored into the GNW text field.
 */
function openNativeKeyboard(ui: Ui, initial: string, maxLen: number): { take(): string | undefined; close(): void } | null {
  if (!ui.app.isTouch) return null;
  const el = document.createElement('input');
  el.type = 'text';
  el.value = initial;
  el.maxLength = maxLen;
  el.autocapitalize = 'off';
  el.setAttribute('autocomplete', 'off');
  el.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;font-size:16px;';
  document.body.appendChild(el);
  el.focus();
  let changed = false;
  el.addEventListener('input', () => (changed = true));
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') ui.injectKey(K.ENTER);
  });
  return {
    take() {
      if (!changed) return undefined;
      changed = false;
      return el.value.replace(/[^\x20-\x7e]/g, '');
    },
    close() {
      el.remove();
    },
  };
}
