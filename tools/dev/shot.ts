// Dev utility: open the game in Chrome via Playwright, wait, save a screenshot and print console output.
//   node tools/dev/shot.ts [url] [out.png] [waitMs] [width] [height]
import { chromium } from '@playwright/test';

const url = process.argv[2] ?? 'http://localhost:5173/';
const out = process.argv[3] ?? 'tmp/shot.png';
const wait = Number(process.argv[4] ?? 2000);
const width = Number(process.argv[5] ?? 640);
const height = Number(process.argv[6] ?? 480);

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
page.on('console', (m) => console.log(`[console.${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(url);
await page.waitForTimeout(wait);
await page.screenshot({ path: out });
console.log('saved', out);
await browser.close();
