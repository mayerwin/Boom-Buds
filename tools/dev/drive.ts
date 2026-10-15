// Dev utility: drive the web game in Chrome with a script (same command set as the original-game capture
// harness) and save screenshots, so both versions can be compared screen by screen.
//   node tools/dev/drive.ts <script.txt> <outdir> [url]
// Commands: wait <ms> | key <NAME> [holdms] | down <NAME> | up <NAME> | type <text> | tap <x> <y>
//           mpos <x> <y> | mdown | mup | shot <name> | burst <name> <count> <ms> | eval <js>
// NAME uses DirectInput-style names: RETURN ESCAPE SPACE TAB BACK UP DOWN LEFT RIGHT F1 F10 LCONTROL LMENU
// LSHIFT A..Z 0..9.
import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [scriptPath, outDir, url = 'http://localhost:5173/'] = process.argv.slice(2);
if (!scriptPath || !outDir) {
  console.error('usage: node tools/dev/drive.ts <script.txt> <outdir> [url]');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const KEYS: Record<string, string> = {
  RETURN: 'Enter', ESCAPE: 'Escape', SPACE: 'Space', TAB: 'Tab', BACK: 'Backspace', UP: 'ArrowUp', DOWN: 'ArrowDown',
  LEFT: 'ArrowLeft', RIGHT: 'ArrowRight', LCONTROL: 'ControlLeft', LMENU: 'AltLeft', LSHIFT: 'ShiftLeft', HOME: 'Home',
  END: 'End', PGUP: 'PageUp', PGDN: 'PageDown', COMMA: 'Comma', PERIOD: 'Period', MINUS: 'Minus', EQUALS: 'Equal',
};
for (let i = 1; i <= 12; i++) KEYS[`F${i}`] = `F${i}`;
for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') KEYS[c] = `Key${c}`;
for (const c of '0123456789') KEYS[c] = `Digit${c}`;

const key = (n: string) => {
  const k = KEYS[n.toUpperCase()];
  if (!k) throw new Error(`unknown key ${n}`);
  return k;
};

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 });
page.on('console', (m) => console.log(`[console.${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
// DRIVE_CLASSIC=1: start with the original 1997 menus, in 1997 mode (the capture scripts of the original drive those)
if (process.env.DRIVE_CLASSIC) {
  await page.addInitScript(() => {
    const KEY = 'boombuds.settings.v1';
    let s: Record<string, unknown> = {};
    try {
      s = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    } catch {
      /* fresh */
    }
    localStorage.setItem(KEY, JSON.stringify({ ...s, classicMenus: 1 }));
  });
}
// DRIVE_SCREENS_DIR: pictures in this directory replace the game's (e.g. the original, unbranded ones)
const screensDir = process.env.DRIVE_SCREENS_DIR;
if (screensDir) {
  await page.route('**/data/screens/*', async (route) => {
    const file = join(screensDir, new URL(route.request().url()).pathname.split('/').pop()!);
    if (existsSync(file)) await route.fulfill({ body: readFileSync(file), contentType: 'application/octet-stream' });
    else await route.continue();
  });
}
// the original menus drive like 1997 (no extra cursor, original waits): ?1997
await page.goto(process.env.DRIVE_CLASSIC ? `${url}${url.includes('?') ? '&' : '?'}1997` : url);
// the screenshots compare the game's picture: no page button over it
if (process.env.DRIVE_CLASSIC) await page.addStyleTag({ content: '.back-today { display: none !important; }' });
const canvas = page.locator('#game');
for (const raw of readFileSync(scriptPath, 'utf8').split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const [cmd, ...args] = line.split(/\s+/);
  switch (cmd) {
    case 'start':
      break;
    case 'wait':
      await page.waitForTimeout(Number(args[0]));
      break;
    case 'key': {
      const k = key(args[0]);
      await page.keyboard.down(k);
      await page.waitForTimeout(args[1] ? Number(args[1]) : 60);
      await page.keyboard.up(k);
      break;
    }
    case 'down':
      await page.keyboard.down(key(args[0]));
      break;
    case 'up':
      await page.keyboard.up(key(args[0]));
      break;
    case 'type':
      await page.keyboard.type(args.join(' '), { delay: 80 });
      break;
    case 'tap':
      await page.mouse.click(Number(args[0]), Number(args[1]));
      break;
    case 'mpos':
      await page.mouse.move(Number(args[0]) + 0.5, Number(args[1]) + 0.5);
      break;
    case 'mdown':
      await page.mouse.down();
      break;
    case 'mup':
      await page.mouse.up();
      break;
    case 'shot':
      await canvas.screenshot({ path: join(outDir, `${args[0]}.png`) });
      console.log('shot', args[0]);
      break;
    case 'burst': {
      const [name, count, ms] = [args[0], Number(args[1]), Number(args[2])];
      for (let i = 0; i < count; i++) {
        const t = Date.now();
        await canvas.screenshot({ path: join(outDir, `${name}_${String(i).padStart(3, '0')}.png`) });
        await page.waitForTimeout(Math.max(0, ms - (Date.now() - t)));
      }
      break;
    }
    case 'eval':
      console.log(await page.evaluate(args.join(' ')));
      break;
    case 'quit':
      break;
    default:
      throw new Error(`unknown command ${cmd}`);
  }
}
await browser.close();
