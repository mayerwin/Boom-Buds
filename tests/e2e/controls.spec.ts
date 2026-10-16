// Menus and controls with the keyboard and with gamepads (made-up ones: navigator.getGamepads answers with
// gamepads the test presses): the arrows go to the nearest control, a player's card is one stop that Enter goes
// into, a setting changes only after Enter; holding a gamepad's button adds a player while a short press stays a
// menu press; two players share a gamepad; the d-pad and sticks in the pause menus and the fast-forward; the
// original 1997 menus show the modern line-up and keep theirs; Back to today hides during rounds.
import { test, expect, type Page } from '@playwright/test';

const XBOX = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)';

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|WebSocket|mqtt|mosquitto|hivemq|emqx/i.test(m.text())) errors.push(m.text());
  });
  return errors;
}

interface FakePad {
  id: string;
  index: number;
  connected: boolean;
  mapping: string;
  axes: number[];
  buttons: { pressed: boolean; touched: boolean; value: number }[];
  timestamp: number;
}
type W = Window & { __pads: (FakePad | null)[]; __boombuds: { game: Record<string, unknown> } };

async function fakePads(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as W;
    w.__pads = [];
    Object.defineProperty(navigator, 'getGamepads', {
      configurable: true,
      value: () => w.__pads.map((p) => p && { ...p, axes: [...p.axes], buttons: p.buttons.map((b) => ({ ...b })) }),
    });
  });
}

const addPad = (page: Page, id: string) =>
  page.evaluate((id) => {
    const w = window as unknown as W;
    const p: FakePad = { id, index: w.__pads.length, connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })), timestamp: 0 };
    w.__pads.push(p);
    const ev = new Event('gamepadconnected') as Event & { gamepad: unknown };
    ev.gamepad = p;
    window.dispatchEvent(ev);
    return p.index;
  }, id);

const button = (page: Page, pad: number, n: number, on: boolean) =>
  page.evaluate(([pad, n, on]) => {
    (window as unknown as W).__pads[pad as number]!.buttons[n as number] = { pressed: !!on, touched: !!on, value: on ? 1 : 0 };
  }, [pad, n, on]);

const stick = (page: Page, pad: number, axes: number[]) =>
  page.evaluate(([pad, axes]) => {
    (window as unknown as W).__pads[pad as number]!.axes = axes as number[];
  }, [pad, axes]);

async function tap(page: Page, pad: number, n: number, ms = 90): Promise<void> {
  await button(page, pad, n, true);
  await page.waitForTimeout(ms);
  await button(page, pad, n, false);
  await page.waitForTimeout(150);
}

const focused = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    return { label: a?.getAttribute('aria-label') ?? a?.textContent?.trim() ?? '', card: !!a?.matches('[data-group]'), inCard: !!a?.parentElement?.closest('[data-group]'), editing: a?.dataset.editing !== undefined };
  });
const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('boombuds.settings.v1') ?? '{}').localPlayers as string[]);
const game = <T>(page: Page, f: string) => page.evaluate(`(()=>{const g=window.__boombuds.game;return ${f};})()`) as Promise<T>;
const cards = (page: Page) => page.locator('#menu-root .players').first().locator('.pcard[data-group]');

test('menus: the arrows go to the nearest control, a card is one stop, a setting changes after Enter', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Local Game' }).click();
  await page.keyboard.press('KeyA'); // a second player (the left keyboard set)
  await expect(cards(page)).toHaveCount(2);
  // the first card is one stop: the arrows pass over its buttons
  await cards(page).first().focus();
  await page.keyboard.press('ArrowDown');
  expect(await focused(page)).toMatchObject({ card: true, inCard: false });
  await page.keyboard.press('ArrowUp');
  // Enter goes into it, Escape comes out
  await page.keyboard.press('Enter');
  expect((await focused(page)).inCard).toBe(true);
  await page.keyboard.press('Escape');
  expect(await focused(page)).toMatchObject({ card: true });
  await expect(page.getByRole('heading', { name: 'Local Game' })).toBeVisible(); // (Escape did not leave the screen)
  // into the second card, to its ✕: the player goes, the focus stays near
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  for (let i = 0; i < 6 && !(await focused(page)).label.startsWith('remove'); i++) await page.keyboard.press(i < 3 ? 'ArrowRight' : 'ArrowUp');
  expect((await focused(page)).label).toBe('remove Player 2');
  await page.keyboard.press('Enter');
  await expect(cards(page)).toHaveCount(1);
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
  // a stepper: Left goes to the players beside it; after Enter, Right changes the value; Enter is done with it
  const time = page.locator('.stepper[aria-label="Round time"]');
  const before = await time.locator('.val').textContent();
  await time.focus();
  await page.keyboard.press('ArrowLeft');
  expect(await time.locator('.val').textContent()).toBe(before);
  expect((await focused(page)).label).not.toBe('Round time');
  await time.focus();
  await page.keyboard.press('Enter');
  expect((await focused(page)).editing).toBe(true);
  await page.keyboard.press('ArrowRight');
  expect(await time.locator('.val').textContent()).not.toBe(before);
  await page.keyboard.press('Enter');
  expect((await focused(page)).editing).toBe(false);
  expect(errors).toEqual([]);
});

test('gamepads: hold a button to join, a short press stays a menu press, two players share a gamepad', async ({ page }) => {
  const errors = trackErrors(page);
  await fakePads(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Local Game' }).click();
  const pad = await addPad(page, XBOX);
  await page.waitForTimeout(200);
  const bots = page.locator('#menu-root .players').nth(1).locator('.pcard[data-group]');
  const botsBefore = await bots.count();
  // A on "Add computer player" with a gamepad that does not play yet: a computer player, nobody joins
  await page.getByRole('button', { name: /Add computer player/ }).focus();
  await tap(page, pad, 0);
  await expect(bots).toHaveCount(botsBefore + 1);
  await expect(cards(page)).toHaveCount(1);
  // held: the gamepad joins (whole)
  await button(page, pad, 0, true);
  await page.waitForTimeout(400);
  await expect(page.locator('.hold-join')).toContainText('Keep holding to join');
  await page.waitForTimeout(700);
  await button(page, pad, 0, false);
  await expect(cards(page)).toHaveCount(2);
  const id = `pad:0:${XBOX}`;
  expect(await stored(page)).toEqual(['kb-arrows', id]);
  // LB held on that gamepad: a third player takes its left side, the second one keeps the right side
  await button(page, pad, 4, true);
  await page.waitForTimeout(1500);
  await button(page, pad, 4, false);
  await expect(cards(page)).toHaveCount(3);
  expect(await stored(page)).toEqual(['kb-arrows', `padR:0:${XBOX}`, `padL:0:${XBOX}`]);
  await expect(cards(page).nth(2)).toContainText('LB bomb');
  // a round: the left side moves with the d-pad, the right side with the right stick
  await page.getByRole('button', { name: 'Start ▶' }).click();
  await expect.poll(() => game<boolean>(page, '!!g.runner'), { timeout: 10_000 }).toBe(true);
  const ctl = await game<string[]>(page, 'g.session.slots.map((s) => s.ctl ?? "")');
  const left = ctl.indexOf(`padL:0:${XBOX}`), right = ctl.indexOf(`padR:0:${XBOX}`);
  expect(left).toBeGreaterThanOrEqual(0);
  expect(right).toBeGreaterThanOrEqual(0);
  await page.waitForTimeout(2500);
  const pos = (i: number) => game<string>(page, `g.runner.s.players[${i}].x + ',' + g.runner.s.players[${i}].y`);
  const moves = async (i: number, push: (on: boolean, dir: number) => Promise<void>) => {
    for (let dir = 0; dir < 4; dir++) {
      const a = await pos(i);
      await push(true, dir);
      await page.waitForTimeout(500);
      await push(false, dir);
      if ((await pos(i)) !== a) return true;
    }
    return false;
  };
  expect(await moves(left, (on, dir) => button(page, pad, 12 + dir, on))).toBe(true);
  const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  expect(await moves(right, (on, dir) => stick(page, pad, on ? [0, 0, dirs[dir][0], dirs[dir][1]] : [0, 0, 0, 0]))).toBe(true);
  // Start pauses; the right stick moves in the pause menu; B resumes
  await tap(page, pad, 9);
  await expect(page.locator('#pause-root.open')).toBeVisible();
  await page.waitForTimeout(400);
  await stick(page, pad, [0, 0, 0, 1]);
  await page.waitForTimeout(150);
  await stick(page, pad, [0, 0, 0, 0]);
  await expect(page.locator('#pause-root button:focus')).toHaveText(/End this round/);
  await tap(page, pad, 1);
  await expect(page.locator('#pause-root.open')).toHaveCount(0);
  // everybody out: fast-forward, and the d-pad sets its speed
  await page.evaluate(() => {
    const g = (window as unknown as W).__boombuds.game as unknown as { runner: { s: { players: { alive: number }[] } }; session: { slots: { type: number }[] } };
    g.session.slots.forEach((s, i) => {
      if (s.type === 2 || s.type === 3) g.runner.s.players[i].alive = 0;
    });
  });
  await expect(page.getByText(/▶▶ 4×/)).toBeVisible({ timeout: 5000 });
  // (↑ first: the round stands still, so that no computer player dies and ends the fast-forward meanwhile)
  await tap(page, pad, 12);
  await expect(page.getByText(/Paused · ↑↓ resume/)).toBeVisible();
  await tap(page, pad, 15);
  await expect.poll(() => game<number>(page, 'g.runner.ffSpeed')).toBe(5);
  expect(errors).toEqual([]);
});

test('1997 mode: the modern line-up shows (KEY 0, JOY 0 R, JOY 0 L), a gamepad works the pause box, Back to today hides in rounds', async ({ page }) => {
  const errors = trackErrors(page);
  await fakePads(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Local Game' }).click();
  const pad = await addPad(page, XBOX);
  await page.waitForTimeout(200);
  await button(page, pad, 0, true);
  await page.waitForTimeout(1100);
  await button(page, pad, 0, false);
  await page.waitForTimeout(200);
  await button(page, pad, 4, true);
  await page.waitForTimeout(1500);
  await button(page, pad, 4, false);
  await expect(cards(page)).toHaveCount(3);
  // the original menus, at the next visit: the same players at the player setup
  await page.goto('/?1997');
  await addPad(page, XBOX);
  await page.waitForTimeout(2500);
  await page.keyboard.press('Enter'); // title -> main menu
  await page.waitForTimeout(800);
  // a demo first (Alt-A), ended with the gamepad's A: the line-up waits for the setup
  await page.keyboard.down('Alt');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Alt');
  await expect.poll(() => game<boolean>(page, '!!g.runner'), { timeout: 10_000 }).toBe(true);
  await page.waitForTimeout(1000);
  await tap(page, 0, 0);
  await expect.poll(() => game<boolean>(page, '!!g.runner'), { timeout: 10_000 }).toBe(false);
  await page.waitForTimeout(1200);
  await page.keyboard.press('Enter'); // Start Game -> player setup
  await page.waitForTimeout(1500);
  const humans = await game<string[]>(page, 'g.session.slots.filter((s) => s.type === 2 || s.type === 3).map((s) => s.type + ":" + s.dev + ":" + s.ctl)');
  expect(humans).toEqual(['2:0:kb-arrows', `3:0:padR:0:${XBOX}`, `3:0:padL:0:${XBOX}`]);
  // Player 1: KEY 0 -> KEY 1 (Right), kept for the modern menus too
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter'); // -> options (no "Problem!!": the halves of one gamepad do not clash)
  await page.waitForTimeout(1500);
  expect(await stored(page)).toEqual(['kb-esdf', `padR:0:${XBOX}`, `padL:0:${XBOX}`]);
  await page.keyboard.press('Enter'); // -> round
  await expect.poll(() => game<boolean>(page, '!!g.runner'), { timeout: 10_000 }).toBe(true);
  // (in the bar beside the picture or over it: hidden either way, and it stays hidden)
  await expect.poll(() => page.evaluate(() => (document.querySelector('.back-today') as HTMLElement).hidden)).toBe(true);
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (document.querySelector('.back-today') as HTMLElement).hidden)).toBe(true);
  }
  // a gamepad's Start opens the 1997 box; the d-pad goes down to "End this round (draw)", A chooses it
  await tap(page, pad, 9);
  await expect.poll(() => game<boolean>(page, '!!g.runner.menu?.box')).toBe(true);
  // (the box ignores the gamepads for a moment: another player may be pressing a bomb button)
  await page.waitForTimeout(400);
  await tap(page, pad, 13);
  await tap(page, pad, 0);
  await expect.poll(() => game<number>(page, 'g.runner.s.forcedDraw')).toBe(1);
  expect(errors).toEqual([]);
});
