// Dev utility: the game on an emulated phone in landscape through the modern menus (taps), a Local Game
// with the on-screen controls: walk with the stick, drop a bomb. Screenshots of each step.
//   node tools/dev/mobile.ts [url] [outdir] [device] [--two]   (--two: two touch players, one per side)
import { chromium, devices } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const two = process.argv.includes('--two');
const url = args[0] ?? 'http://localhost:5173/';
const out = args[1] ?? 'tmp/mobile';
const deviceName = args[2] ?? 'Pixel 7 landscape';
mkdirSync(out, { recursive: true });
const dev = devices[deviceName];
if (!dev) throw new Error(`unknown device ${deviceName}`);

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ ...dev });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(url);
console.log('viewport', page.viewportSize(), 'dpr', dev.deviceScaleFactor);
const shot = (name: string) => page.screenshot({ path: join(out, `${name}.png`) });
await page.waitForTimeout(2500);
await shot('01_home');
await page.getByRole('button', { name: 'Local Game' }).tap();
await page.waitForTimeout(600);
if (two) {
  await page.getByRole('button', { name: 'controls of Player 1' }).tap();
  await page.getByRole('button', { name: /Touch, left side/ }).tap();
  await page.getByRole('button', { name: /Add player/ }).tap();
  await page.getByRole('button', { name: /Touch, right side/ }).tap();
}
await shot('02_local');
await page.getByRole('button', { name: 'Start ▶' }).tap();
for (let i = 0; i < 50 && !(await page.evaluate(() => !!(window as unknown as { __boombuds: { game: { runner: unknown } } }).__boombuds.game.runner)); i++) await page.waitForTimeout(200);
await page.waitForTimeout(1500);
await shot('03_round');
// walk with the (first) stick: hold it pushed right, then drop a bomb with A
const cdp = await ctx.newCDPSession(page);
const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number, id = 1) =>
  cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id }] });
const stick = await page.evaluate(() => {
  const el = [...document.querySelectorAll('div')].find((d) => d.style.borderRadius === '50%' && !d.textContent && d.style.display !== 'none');
  const r = el!.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, r: r.width / 2 };
});
await touch('touchStart', stick.x, stick.y, 2);
await touch('touchMove', stick.x + stick.r * 0.8, stick.y, 2);
await page.waitForTimeout(700);
await shot('04_walking');
await touch('touchEnd', stick.x, stick.y, 2);
const a = await page.evaluate(() => {
  const el = [...document.querySelectorAll('div')].find((d) => d.textContent === 'A' && d.style.display !== 'none');
  const r = el!.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await touch('touchStart', a.x, a.y);
await page.waitForTimeout(80);
await touch('touchEnd', a.x, a.y);
await page.waitForTimeout(400);
await shot('05_bomb');
await browser.close();
