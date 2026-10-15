// Rasterises tools/brand/app-icon.svg into the PWA icons and the favicon (Chrome via Playwright).
//   node tools/make-app-icons.ts
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const svg = readFileSync('tools/brand/app-icon.svg', 'utf8');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
for (const [size, out] of [[512, 'public/icons/icon-512.png'], [192, 'public/icons/icon-192.png'], [64, 'public/favicon.png']] as const) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  console.log(out);
}
await browser.close();
