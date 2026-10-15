// The online manual / credits viewer: help_view_file (0x41302d) and the help-file list (0x41431c),
// docs/re/screens.md §7.

import type { Ui } from './ui.ts';
import type { Dialogs } from './dialogs.ts';
import type { ScreenImage } from '../engine/gfx.ts';
import { K } from './menuInput.ts';

/** Load lines with the original's (quirky) tab expansion: a TAB leaves the column counter one ahead. */
export function helpLines(text: string): string[] {
  // read in text mode: CRLF -> LF, Ctrl-Z ends the file (the shipped files end with 0x1A)
  const eof = text.indexOf('\x1a');
  const raw = (eof >= 0 ? text.slice(0, eof) : text).replace(/\r/g, '').split('\n');
  if (raw.length && raw[raw.length - 1] === '') raw.pop();
  return raw.map((line) => {
    let out = '';
    let col = 0;
    for (let i = 0; i < line.length && col < 255; i++) {
      const ch = line[i];
      if (ch === '\t') {
        do {
          out += ' ';
          col++;
        } while (col % 4 !== 0);
      } else out += ch;
      col++;
    }
    return out;
  });
}

interface Segment {
  text: string;
  img: string | null;
}

function splitImages(line: string): Segment[] {
  const segs: Segment[] = [];
  let rest = line;
  for (;;) {
    const i = rest.indexOf('<IMG');
    if (i < 0) {
      segs.push({ text: rest, img: null });
      return segs;
    }
    const j = rest.indexOf('>', i);
    const name = j < 0 ? rest.slice(i + 4) : rest.slice(i + 4, j);
    segs.push({ text: rest.slice(0, i), img: name });
    rest = j < 0 ? '' : rest.slice(j + 1);
  }
}

/** Where Boom Buds lives (shown, and clickable, in the credits). */
export const REPO_URL = 'https://github.com/mayerwin/Boom-Buds';

/**
 * The credits open with the people behind Boom Buds; the rest of the file is the original's credits, now
 * introduced as such.
 */
const BOOM_BUDS_CREDITS = [
  'Boom Buds Credits',
  '',
  '',
  'Boom Buds, the web version (2026):',
  `    ${REPO_URL}`,
  '',
  'Producer / Director:',
  '\tErwin Mayer',
  '',
  'Lead Programmer:',
  '\tClaude Opus (Anthropic)',
  '',
  '',
  '',
  'The original game, Atomic Bomberman (Interplay, 1997):',
];

function creditsText(original: string): string {
  // the original file starts with its title line
  const nl = original.indexOf('\n');
  return [...BOOM_BUDS_CREDITS, nl >= 0 ? original.slice(nl + 1) : original].join('\r\n');
}

/** A line that is a web address: drawn in cyan, opened in a new tab when clicked or tapped. */
function linkOf(line: string): string | null {
  return /^\s*https?:\/\/\S+\s*$/.test(line) ? line.trim() : null;
}

export async function helpViewFile(ui: Ui, dlg: Dialogs, filename: string): Promise<void> {
  const g = dlg.gnw;
  const c = g.colors;
  const fh = g.lineHeight;
  const help = ui.app.text.help;
  const key = Object.keys(help).find((k) => k.toUpperCase() === filename.toUpperCase());
  const text = !key ? null : key.toUpperCase() === 'CREDITS.BM' ? creditsText(help[key]) : help[key];
  const lines = text !== null ? helpLines(text) : ['unable to open file:', filename];
  // register the pictures referenced by <IMGname> tags (missing files are skipped)
  const images = new Map<string, ScreenImage>();
  for (const line of lines) {
    for (const s of splitImages(line)) {
      if (!s.img) continue;
      const name = s.img.toUpperCase();
      if (images.has(name) || !ui.gfx.screenIndex[name]) continue;
      images.set(name, await ui.gfx.loadScreenPixels(name));
    }
  }
  const win = dlg.window(20, 20, 600, 440);
  const pageLines = Math.trunc(344 / fh);
  const white = ui.col.white;
  let top = 0;
  const render = () => {
    if (g.winz) win.buf.fillWinz(g.winz);
    const visible = Math.min(pageLines, lines.length - top);
    for (let k = -16; k < visible + 16; k++) {
      const i = top + k;
      if (i < 0 || i >= lines.length) continue;
      const line = lines[i];
      const onPage = k >= 0 && k < visible;
      if (!line.includes('<IMG')) {
        if (onPage) win.buf.text(g.font, line, 532, 34, 34 + 16 * k, linkOf(line) ? ui.col.cyan : white, c);
        continue;
      }
      let x = 34;
      let remain = 532;
      const y0 = 16 * k + 34;
      for (const seg of splitImages(line)) {
        if (onPage && seg.text) win.buf.text(g.font, seg.text, remain, x, y0, white, c);
        const tw = g.textWidth(seg.text);
        x += tw;
        remain -= tw;
        if (!seg.img) continue;
        const img = images.get(seg.img.toUpperCase());
        if (!img) continue;
        let y = y0 - Math.trunc((img.h - fh) / 2);
        if (y + img.h >= 34 && y <= win.h - 62) {
          let h = img.h;
          let sy = 0;
          if (y < 34) {
            sy = 34 - y;
            h -= 34 - y;
            y = 34;
          }
          const w = Math.min(img.w, remain);
          if (y + h > 378) h = 378 - y;
          if (w > 0 && h > 0) win.buf.blit(img.pixels, img.w, 0, sy, w, h, x, y, true);
        }
        x += img.w;
        remain -= img.w;
      }
    }
  };
  render();
  // these buttons send their key on mouse-down
  g.textButton(win, 30, 388, '\x18', K.UP, -1);
  g.textButton(win, 60, 388, '\x19', K.DOWN, -1);
  g.textButton(win, 120, 388, 'Page \x18', K.PGUP, -1);
  g.textButton(win, 190, 388, 'Page \x19', K.PGDN, -1);
  g.textButton(win, 516, 388, 'Done', K.ESC, -1);
  if (!ui.app.isTouch) ui.mouseShow();
  const maxTop = Math.max(0, lines.length - pageLines);
  await dlg.modal(win, (k) => {
    if (k === K.ENTER || k === K.ESC) return true;
    for (const t of ui.taps) {
      // the window is at (20, 20); its text lines are 16 pixels apart from y = 34 in it
      const i = top + Math.floor((t.y - 20 - 34) / 16);
      const url = i >= top && i < top + pageLines ? linkOf(lines[i] ?? '') : null;
      if (url && t.x >= 20 + 34 && t.x < 20 + 34 + g.textWidth(lines[i])) window.open(url, '_blank', 'noopener');
    }
    const old = top;
    if (k === K.UP) { if (top > 0) top--; }
    else if (k === K.DOWN) top = Math.min(top + 1, maxTop);
    else if (k === K.PGUP || k === K.LEFT) top = Math.max(0, top - 20);
    else if (k === K.PGDN || k === K.RIGHT) top = Math.min(top + 20, maxTop);
    if (top !== old) render();
    return false;
  });
  ui.mouseHide();
}

/** help_screen (0x41431c): choose among the *.BM files and view them until Esc. */
export async function helpScreen(ui: Ui, dlg: Dialogs): Promise<void> {
  const c = ui.col;
  if (ui.value(15) === 0) {
    await dlg.msgboxOk(ui.msg(95), ui.msg(5), c.lightRed, c.yellow);
    return;
  }
  const names = Object.keys(ui.app.text.help).map((n) => n.toUpperCase()).sort();
  if (!names.length) {
    await dlg.msgboxOk(ui.msg(95), ui.msg(4), c.lightRed, c.yellow);
    return;
  }
  for (;;) {
    const i = await dlg.listSelect(ui.msg(600), names, 100, 100, c.white);
    if (i === -1) break;
    await helpViewFile(ui, dlg, names[i]);
  }
}
