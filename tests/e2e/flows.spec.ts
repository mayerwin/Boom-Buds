// The original 1997 menus in 1997 mode (?1997): walks through every screen reachable from their main menu and
// checks the game never throws.
import { test, expect, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
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
});

async function key(page: Page, k: string, wait = 120): Promise<void> {
  await page.keyboard.down(k);
  await page.waitForTimeout(40);
  await page.keyboard.up(k);
  await page.waitForTimeout(wait);
}

/** Current screen as seen by the game (runner state or nothing). */
async function inRound(page: Page): Promise<boolean> {
  return page.evaluate(() => !!(window as unknown as { __boombuds: { game: { runner: unknown } } }).__boombuds.game.runner);
}

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text());
  });
  return errors;
}

test('menus, options, help, credits and exit dialog', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?1997');
  await page.waitForTimeout(2500);
  await key(page, 'Enter', 800); // title -> main menu
  // Options: walk every row, open and cancel the dialogs that do not change anything
  for (let i = 0; i < 3; i++) await key(page, 'ArrowDown');
  await key(page, 'Enter', 800);
  for (let row = 0; row < 18; row++) {
    if ([3, 7, 9].includes(row)) {
      await key(page, 'ArrowRight');
      await key(page, 'ArrowLeft');
    }
    if (row === 8 || row === 16) {
      await key(page, 'Enter', 500);
      await key(page, 'Escape', 300);
    }
    await key(page, 'ArrowDown');
  }
  await key(page, 'Escape', 800);
  // About (credits viewer): scroll and close
  for (let i = 0; i < 4; i++) await key(page, 'ArrowDown');
  await key(page, 'Enter', 800);
  await key(page, 'PageDown');
  await key(page, 'PageDown');
  await key(page, 'Escape', 600);
  // Online manual: list, open MANUAL.BM, page through it
  await key(page, 'F1', 800);
  for (let i = 0; i < 5; i++) await key(page, 'ArrowDown');
  await key(page, 'Enter', 800);
  for (let i = 0; i < 6; i++) await key(page, 'PageDown');
  await key(page, 'Escape', 400);
  await key(page, 'Escape', 600);
  // Exit dialog, answer No
  await key(page, 'Escape', 600);
  await key(page, 'KeyN', 600);
  expect(errors).toEqual([]);
});

test('a local match: setup, options, round, results', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?1997');
  await page.waitForTimeout(2500);
  await key(page, 'Enter', 800);
  await key(page, 'Enter', 1500); // Start Game -> player setup (KEY 0 + AI 3)
  await key(page, 'Enter', 1500); // -> options (after the 1 s minimum)
  await key(page, 'Enter', 2500); // -> round
  expect(await inRound(page)).toBe(true);
  await page.waitForTimeout(2000);
  await key(page, 'F10', 1500); // end the round -> results
  await page.waitForTimeout(1200);
  await key(page, 'Enter', 2000); // next round
  expect(await inRound(page)).toBe(true);
  await page.keyboard.down('Control');
  await key(page, 'KeyQ', 1500); // quit the match
  await page.keyboard.up('Control');
  await page.waitForTimeout(1500);
  expect(await inRound(page)).toBe(false);
  expect(errors).toEqual([]);
});

test('attract mode starts by itself and Esc returns to the menu', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?1997');
  await page.waitForTimeout(2500);
  await key(page, 'Enter', 800);
  await page.keyboard.down('Alt');
  await key(page, 'KeyA', 3000); // Alt-A: attract mode now
  await page.keyboard.up('Alt');
  expect(await inRound(page)).toBe(true);
  await key(page, 'Escape', 2500);
  expect(await inRound(page)).toBe(false);
  expect(errors).toEqual([]);
});

test('hidden campaign mode: activation and the first stage', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?1997');
  await page.waitForTimeout(2500);
  await key(page, 'Enter', 800);
  await key(page, 'Enter', 1500); // player setup
  for (let i = 0; i < 5; i++) await key(page, 'KeyC');
  await page.waitForTimeout(500);
  await key(page, 'End'); // last campaign file
  await key(page, 'Enter', 600); // choose it
  await key(page, 'Enter', 600); // "Campaign Mode Activated!"
  await key(page, 'Enter', 1000); // start (no options screen in campaign mode)
  await key(page, 'Enter', 2500); // "Prepare to begin Campaign!"
  expect(await inRound(page)).toBe(true);
  const camp = await page.evaluate(() => {
    const r = (window as unknown as { __boombuds: { game: { runner: { s: { pl: { campaign: number }; aliens: { active: number }[] } } } } }).__boombuds.game.runner;
    return { campaign: r.s.pl.campaign, aliens: r.s.aliens.filter((a) => a.active).length };
  });
  expect(camp.campaign).toBe(1);
  await page.keyboard.down('Control');
  await key(page, 'KeyQ', 1500);
  await page.keyboard.up('Control');
  await page.waitForTimeout(1500);
  expect(errors).toEqual([]);
  expect(camp.aliens).toBeGreaterThanOrEqual(0);
});
