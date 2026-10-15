// The modern menus: Local Game with players joining by key press, pause, quitting; the Controls screen
// recording a new keyboard set; How to Play; Options.
import { test, expect, type Page } from '@playwright/test';

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|WebSocket|mqtt|mosquitto|hivemq|emqx/i.test(m.text())) errors.push(m.text());
  });
  return errors;
}

const inRound = (p: Page) => p.evaluate(() => !!(window as unknown as { __boombuds: { game: { runner: unknown } } }).__boombuds.game.runner);
const tick = (p: Page) => p.evaluate(() => (window as unknown as { __boombuds: { game: { runner: { s: { tick: number } } | null } } }).__boombuds.game.runner?.s.tick ?? -1);
const menuOpen = (p: Page) => p.evaluate(() => !!document.getElementById('menu-root')?.classList.contains('open'));

test('local game: join by key, play, pause, quit', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Local Game' }).click();
  await expect(page.getByText('Player 1')).toBeVisible();
  // a second keyboard player joins with the bomb key of the left set, a third computer player is added
  await page.keyboard.press('KeyA');
  await expect(page.getByText('Player 2')).toBeVisible();
  await page.getByRole('button', { name: /Add computer player/ }).click();
  await page.getByRole('button', { name: 'Start ▶' }).click();
  await expect.poll(() => inRound(page), { timeout: 10_000 }).toBe(true);
  const slots = await page.evaluate(() => (window as unknown as { __boombuds: { game: { session: { slots: { type: number; ctl?: string }[] } } } }).__boombuds.game.session.slots.slice(0, 4).map((s) => `${s.type}:${s.ctl ?? ''}`));
  expect(slots).toEqual(['2:kb-arrows', '2:kb-esdf', '1:', '1:']);
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(1500);
  // Esc pauses: the round stops
  await page.keyboard.press('Escape');
  await expect(page.locator('#pause-root.open')).toBeVisible();
  const t1 = await tick(page);
  await page.waitForTimeout(600);
  expect(await tick(page)).toBe(t1);
  await page.keyboard.press('Escape'); // resume
  await expect.poll(() => tick(page)).toBeGreaterThan(t1);
  // quit from the pause menu: back to the Local Game screen
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Quit the match' }).click();
  await expect.poll(() => menuOpen(page), { timeout: 10_000 }).toBe(true);
  await expect(page.getByRole('heading', { name: 'Local Game' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('local game: random special arena, a saved arena list that the match plays and Options keep', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Local Game' }).click();
  const arena = page.locator('.arena .name').first();
  // from a random arena: the special ones, then the player's own pick (the arenas to tick)
  while (!(await arena.textContent())!.startsWith('Random arena')) await page.getByRole('button', { name: 'next arena' }).click();
  await page.getByRole('button', { name: 'next arena' }).click();
  await expect(arena).toContainText('Random special arena');
  await expect(arena).toContainText('Inner City Trash');
  await page.getByRole('button', { name: 'next arena' }).click();
  await page.getByRole('button', { name: 'None' }).click();
  await page.getByRole('checkbox', { name: 'The Coal Mine' }).click();
  await page.getByRole('checkbox', { name: 'Inner City Trash' }).click();
  await page.getByLabel('name of the list').fill('Duo');
  await page.getByRole('button', { name: /Save and play these \(2\)/ }).click();
  await expect(arena).toContainText('Random from Duo (2 arenas)');
  // the match is played on one of them
  await page.getByRole('button', { name: /Add computer player/ }).click();
  await page.getByRole('button', { name: 'Start ▶' }).click();
  await expect.poll(() => inRound(page), { timeout: 10_000 }).toBe(true);
  const level = await page.evaluate(() => (window as unknown as { __boombuds: { game: { runner: { s: { opts: { level: number } } } } } }).__boombuds.game.runner.s.opts.level);
  expect([4, 10]).toContain(level);
  // the modern score lines name the players, and this device's only player is marked at the start
  const hud = await page.evaluate(() => {
    const g = (window as unknown as { __boombuds: { game: { runner: { gr: { hud: { names: string[] } | null; you: { slot: number } | null } }; session: { slots: { type: number }[] } } } }).__boombuds.game;
    return { names: g.runner.gr.hud?.names ?? null, you: g.runner.gr.you?.slot ?? -1, types: g.session.slots.map((sl) => sl.type) };
  });
  expect(hud.names?.filter((_, i) => hud.types[i] !== 0).sort()).toEqual(['CPU', 'CPU', 'P1']);
  expect(hud.types[hud.you]).toBe(2);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Quit the match' }).click();
  await expect.poll(() => menuOpen(page), { timeout: 10_000 }).toBe(true);
  // the list is kept with the options
  await page.reload();
  await page.getByRole('button', { name: 'Local Game' }).click();
  await expect(page.locator('.arena .name').first()).toContainText('Random from Duo');
  expect(errors).toEqual([]);
});

test('controls: record a keyboard set; how to play; options', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Controls' }).click();
  await page.getByRole('button', { name: /New keyboard set/ }).click();
  for (const k of ['KeyI', 'KeyL', 'KeyK', 'KeyJ', 'KeyU', 'KeyO']) await page.keyboard.press(k);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Keyboard 3', { exact: true })).toBeVisible();
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('boombuds.settings.v1') ?? '{}').controls.sets.map((s: { keys?: string[] }) => s.keys?.join(',')));
  expect(stored).toContain('KeyI,KeyL,KeyK,KeyJ,KeyU,KeyO');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'How to Play' }).click();
  await expect(page.getByText('Boxing Glove')).toBeVisible();
  const icons = await page.locator('.power img').evaluateAll((imgs) => imgs.filter((i) => (i as HTMLImageElement).naturalWidth > 8).length);
  expect(icons).toBeGreaterThanOrEqual(13);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Options' }).click();
  await expect(page.getByText('Music during rounds')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Local Game' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('local game: colours and teams; fast-forward (speed and pause) once only computer players are left', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Local Game' }).click();
  await page.getByRole('button', { name: /Add computer player/ }).click();
  await page.getByRole('switch', { name: /Teams/ }).click();
  // Player 1 takes the blue bomber; the computer player moves to the first free colour
  await page.locator('.pcard button.head').first().click();
  await page.getByRole('button', { name: 'Blue', exact: true }).click();
  // and switches team (the card takes the other team's colour)
  const card = page.locator('.pcard').first();
  const before = (await card.getAttribute('class'))!.includes('team-0') ? 'team-0' : 'team-1';
  await card.locator('.team-swap').click();
  await expect(card).not.toHaveClass(new RegExp(before));
  const chosen = (await card.getAttribute('class'))!.includes('team-0') ? '0' : '1';
  await page.getByRole('button', { name: 'Start ▶' }).click();
  await expect.poll(() => inRound(page), { timeout: 10_000 }).toBe(true);
  const slots = await page.evaluate(() => (window as unknown as { __boombuds: { game: { session: { slots: { type: number; ctl?: string; team: number }[] } } } }).__boombuds.game.session.slots.map((s) => `${s.type}:${s.ctl ?? ''}:${s.team}`));
  expect(slots[3].startsWith('2:kb-arrows:')).toBe(true);
  expect(slots[0].startsWith('1::')).toBe(true);
  expect(slots[3].split(':')[2]).toBe(chosen);
  // the person is out (the test takes them off the field): the round runs four times as fast
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const r = (window as unknown as { __boombuds: { game: { runner: { s: { players: { alive: number }[] } } } } }).__boombuds.game.runner;
    r.s.players[3].alive = 0;
  });
  await page.waitForTimeout(300);
  const t0 = await tick(page);
  await page.waitForTimeout(1000);
  const perSecond = (await tick(page)) - t0;
  expect(perSecond).toBeGreaterThan(180);
  await expect(page.getByText('▶▶ 4×')).toBeVisible();
  // → speeds up, ↑ pauses, ↓ resumes
  await page.keyboard.press('ArrowRight');
  await expect(page.getByText('▶▶ 5×')).toBeVisible();
  await page.keyboard.press('ArrowUp');
  await expect(page.getByText('Paused')).toBeVisible();
  const tp = await tick(page);
  await page.waitForTimeout(500);
  expect(await tick(page)).toBe(tp);
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => tick(page)).toBeGreaterThan(tp);
  expect(errors).toEqual([]);
});

test('1997 mode: ?1997 opens the original menus, Ctrl+M comes back', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?1997');
  await page.waitForTimeout(4000);
  expect(await page.evaluate(() => (window as unknown as { __boombuds: { game: { menus: unknown } } }).__boombuds.game.menus)).toBeNull();
  await page.keyboard.press('Control+KeyM');
  await page.waitForURL((u) => !u.search.includes('1997'), { timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'Local Game' })).toBeVisible({ timeout: 15_000 });
  expect(errors).toEqual([]);
});
