// Rebuilds the Play Store graphics and the TV launcher banner from the game's own main screen (its key art and
// logo, without the buttons), rendered by Chrome:
//   publishing/store-assets/tv-banner-1280x720.png    Play listing TV banner
//   publishing/store-assets/feature-graphic-1024x500.png
//   publishing/store-assets/icon-512.png              the website's app icon
//   app/src/main/res/drawable-xhdpi/tv_banner.png     the Google TV launcher banner (320 x 180)
//   app/src/main/res/drawable-xxxhdpi/ic_launcher.png the launcher icon (192 x 192)
// Run from the repository with a production build served: npm start (or the LAN server), then
//   node android/tools/generate-store-graphics.ts [url]
import { chromium, type Page } from '@playwright/test';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const url = process.argv[2] ?? 'http://localhost:8080/';
const android = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(android, '..');
const out = (p: string) => {
  const f = join(android, p);
  mkdirSync(dirname(f), { recursive: true });
  return f;
};

// the main screen as a poster: the logo and the art, no buttons, links or notices
const POSTER = `
  .home-col > :not(.bb-logo), .foot, .back-today, .toast, .update { display: none !important; }
  .home-col { justify-content: center !important; }
  #menu-root a, #menu-root button { display: none !important; }
`;

async function poster(page: Page, width: number, height: number): Promise<Buffer> {
  await page.setViewportSize({ width, height });
  await page.goto(url);
  await page.addStyleTag({ content: POSTER });
  await page.waitForTimeout(2500);
  return page.screenshot({ type: 'png' });
}

/** A smaller copy, scaled by the browser (smooth). */
async function scaled(page: Page, png: Buffer, width: number, height: number): Promise<Buffer> {
  const data = await page.evaluate(
    async ([b64, w, h]) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = w as number;
      c.height = h as number;
      const ctx = c.getContext('2d')!;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, w as number, h as number);
      return c.toDataURL('image/png').split(',')[1];
    },
    [png.toString('base64'), width, height] as const,
  );
  return Buffer.from(data, 'base64');
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const banner = await poster(page, 1280, 720);
writeFileSync(out('publishing/store-assets/tv-banner-1280x720.png'), banner);
writeFileSync(out('app/src/main/res/drawable-xhdpi/tv_banner.png'), await scaled(page, banner, 320, 180));
writeFileSync(out('publishing/store-assets/feature-graphic-1024x500.png'), await poster(page, 1024, 500));
copyFileSync(join(repo, 'public/icons/icon-512.png'), out('publishing/store-assets/icon-512.png'));
copyFileSync(join(repo, 'public/icons/icon-192.png'), out('app/src/main/res/drawable-xxxhdpi/ic_launcher.png'));
await browser.close();
console.log('store graphics written');
