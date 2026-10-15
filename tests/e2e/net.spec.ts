// Network games through the modern menus: machines (isolated browser contexts) meet in a room on the dev
// server's relay (?relay=local, so the tests need no internet), by room code or by a join link, and play
// rounds whose simulations must stay identical.
import { test, expect, type Page, type Browser, type BrowserContext } from '@playwright/test';

// every test's machines leave when it ends (pages left running would load the next tests)
const opened: BrowserContext[] = [];
test.afterEach(async () => {
  for (const ctx of opened.splice(0)) await ctx.close().catch(() => {});
});

function track(page: Page, errors: string[], name: string): void {
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|WebSocket|mqtt|STUN|stun/i.test(m.text())) errors.push(`${name}: ${m.text()}`);
  });
}

async function open(browser: Browser, errors: string[], name: string, query = ''): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  opened.push(ctx);
  const page = await ctx.newPage();
  track(page, errors, name);
  await page.goto(`/?relay=local${query}`);
  return page;
}

type Snap = { tick: number; hash: number; desyncs: number } | null;
const snap = (p: Page): Promise<Snap> =>
  p.evaluate(() => {
    const r = (window as unknown as { __boombuds: { game: { runner: { s: { tick: number }; hash(): number; desyncs: number } | null } } }).__boombuds.game.runner;
    return r ? { tick: r.s.tick, hash: r.hash(), desyncs: r.desyncs } : null;
  });

async function createRoom(host: Page): Promise<string> {
  await host.getByRole('button', { name: /Network Game/ }).click();
  const create = host.getByRole('button', { name: 'Create a game' });
  await expect(create).toBeEnabled({ timeout: 10_000 });
  await create.click();
  const code = host.locator('.code-big');
  await expect(code).toHaveText(/^[A-Z0-9]{6}$/, { timeout: 10_000 });
  return (await code.textContent())!;
}

async function joinByCode(p: Page, code: string): Promise<void> {
  await p.getByRole('button', { name: /Network Game/ }).click();
  await expect(p.getByRole('button', { name: 'Create a game' })).toBeEnabled({ timeout: 10_000 });
  await p.getByLabel('code letter 1').click();
  await p.keyboard.type(code.toLowerCase());
  await expect(p.locator('.code-big')).toHaveText(code, { timeout: 15_000 });
}

/**
 * The host starts the match: waits until every machine plays the round. On failure, says what each machine
 * did meanwhile (menus or round, the match's end code, a refusal shown in the lobby) and the page errors.
 */
async function startMatch(host: Page, pages: Page[], errors: string[]): Promise<void> {
  await host.getByRole('button', { name: 'Start ▶' }).click();
  const seen: string[] = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 15_000) {
    const states = await Promise.all(
      pages.map((p) =>
        p
          .evaluate(() => {
            const g = (window as unknown as { __boombuds: { game: { runner: unknown; session: { matchEnd: number } } } }).__boombuds.game;
            const toast = document.querySelector('.toast')?.textContent;
            return `${g.runner ? 'round' : 'menus'}${g.session.matchEnd ? ` (match end ${g.session.matchEnd})` : ''}${toast ? ` "${toast}"` : ''}`;
          })
          .catch(() => 'closed'),
      ),
    );
    const line = states.map((st, i) => `${i ? `machine ${i}` : 'host'}: ${st}`).join(', ');
    if (!seen.length || !seen[seen.length - 1].endsWith(line)) seen.push(`${Date.now() - t0} ms  ${line}`);
    if (states.every((st) => st.startsWith('round'))) return;
    await host.waitForTimeout(100);
  }
  throw new Error(['The round did not start on every machine:', ...seen, ...errors].join('\n'));
}

async function bothMove(pages: Page[]): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const dir = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'][i % 4];
    await Promise.all(pages.map((p) => p.keyboard.press(dir)));
    await pages[0].waitForTimeout(250);
  }
}

test('a join link brings a machine into the room; the round runs in sync', async ({ browser }) => {
  const errors: string[] = [];
  const host = await open(browser, errors, 'host');
  const code = await createRoom(host);
  const client = await open(browser, errors, 'client', `&join=${code}`);
  await expect(client.locator('.code-big')).toHaveText(code, { timeout: 15_000 });
  // the host sees the client's player in the line-up, and starts
  await expect(host.locator('.pcard', { hasText: 'Keyboard right' })).toHaveCount(2, { timeout: 10_000 });
  await startMatch(host, [host, client], errors);
  await bothMove([host, client]);
  await host.waitForTimeout(800);
  // compare at a common tick
  let a = await snap(host);
  let b = await snap(client);
  for (let i = 0; i < 30 && a && b && a.tick !== b.tick; i++) {
    await host.waitForTimeout(16);
    [a, b] = await Promise.all([snap(host), snap(client)]);
  }
  expect(a?.desyncs ?? 0).toBe(0);
  expect(b?.desyncs ?? 0).toBe(0);
  if (a && b && a.tick === b.tick) expect(a.hash).toBe(b.hash);
  // the host ends the match: everybody is back in the lobby
  await host.keyboard.press('Escape');
  await host.getByRole('button', { name: /End the match/ }).click();
  await expect(host.locator('.code-big')).toHaveText(code, { timeout: 15_000 });
  await expect(client.locator('.code-big')).toHaveText(code, { timeout: 15_000 });
  expect(errors).toEqual([]);
});

test('three machines join by code; one leaves during the round and the others go on in sync', async ({ browser }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  const host = await open(browser, errors, 'host');
  const c1 = await open(browser, errors, 'c1');
  const c2 = await open(browser, errors, 'c2');
  const code = await createRoom(host);
  await joinByCode(c1, code);
  await joinByCode(c2, code);
  await expect(host.locator('.chip', { hasText: 'ms' })).toHaveCount(2, { timeout: 15_000 });
  await startMatch(host, [host, c1, c2], errors);
  await host.waitForTimeout(1500);
  await c2.context().close(); // a machine leaves
  const t0 = (await snap(host))!.tick;
  await bothMove([host, c1]);
  const a = await snap(host);
  const b = await snap(c1);
  expect(a!.tick).toBeGreaterThan(t0 + 60);
  expect(a?.desyncs ?? 0).toBe(0);
  expect(b?.desyncs ?? 0).toBe(0);
  expect(errors.filter((e) => !/WebRTC|ICE|DataChannel/i.test(e))).toEqual([]);
});

test('over a slow network (50 ms each way, jitter, 1 % loss) the round runs at full speed, in sync', async ({ browser }) => {
  const errors: string[] = [];
  const host = await open(browser, errors, 'host', '&netsim=50,10,1');
  const client = await open(browser, errors, 'client', '&netsim=50,10,1');
  const code = await createRoom(host);
  await joinByCode(client, code);
  await expect(host.locator('.pcard', { hasText: 'Keyboard right' })).toHaveCount(2, { timeout: 15_000 });
  // the two people only, so that nobody ends the round early
  const remove = host.getByRole('button', { name: 'remove computer player' });
  for (let n = await remove.count(); n > 0; n--) {
    await remove.first().click();
    await expect(remove).toHaveCount(n - 1);
  }
  await startMatch(host, [host, client], errors);
  await host.waitForTimeout(3000); // the clocks settle
  const [h0, c0] = await Promise.all([snap(host), snap(client)]);
  const t0 = Date.now();
  await bothMove([host, client]);
  await host.waitForTimeout(2000);
  const [h1, c1] = await Promise.all([snap(host), snap(client)]);
  const secs = (Date.now() - t0) / 1000;
  // 60 ticks a second (a clock sync blind to the network's delay once crawled at two thirds of that)
  expect((h1!.tick - h0!.tick) / secs).toBeGreaterThan(54);
  expect((c1!.tick - c0!.tick) / secs).toBeGreaterThan(54);
  expect(h1!.desyncs).toBe(0);
  expect(c1!.desyncs).toBe(0);
  expect(errors).toEqual([]);
});

test('Esc pauses a network round for everybody; anyone resumes it; a long pause drops nobody', async ({ browser }) => {
  const errors: string[] = [];
  const host = await open(browser, errors, 'host');
  const client = await open(browser, errors, 'client');
  const code = await createRoom(host);
  await joinByCode(client, code);
  await expect(host.locator('.pcard', { hasText: 'Keyboard right' })).toHaveCount(2, { timeout: 15_000 });
  await startMatch(host, [host, client], errors);
  await host.waitForTimeout(1500);
  // the client pauses: both simulations stop at the same tick, and the host's menu says who paused
  await client.keyboard.press('Escape');
  await expect(client.locator('#pause-root.open')).toBeVisible();
  await expect(host.locator('#pause-root.open')).toContainText('Paused by', { timeout: 5000 });
  await host.waitForTimeout(500);
  const [a, b] = await Promise.all([snap(host), snap(client)]);
  expect(a!.tick).toBe(b!.tick);
  expect(a!.hash).toBe(b!.hash);
  // a pause longer than a silent machine is given during play (8 s): the round stays put, nobody is dropped
  await host.waitForTimeout(9000);
  expect((await snap(host))!.tick).toBe(a!.tick);
  const members = (p: Page) =>
    p.evaluate(() => (window as unknown as { __boombuds: { game: { session: { net: { members: unknown[] } } } } }).__boombuds.game.session.net.members.length);
  expect(await members(host)).toBe(1);
  expect(await members(client)).toBe(1);
  // the host resumes: every menu closes, a countdown, then the round goes on everywhere, in sync
  await host.getByRole('button', { name: 'Resume' }).click();
  await expect(client.locator('#pause-root.open')).toHaveCount(0, { timeout: 5000 });
  await expect(client.locator('.resume-countdown')).toBeVisible();
  await expect.poll(async () => (await snap(client))!.tick, { timeout: 5000 }).toBeGreaterThan(b!.tick);
  await bothMove([host, client]);
  const [h, c] = await Promise.all([snap(host), snap(client)]);
  expect(h!.desyncs).toBe(0);
  expect(c!.desyncs).toBe(0);
  expect(errors).toEqual([]);
});

test('the lobby: chat, requests granted by the host, team balance, and the host removes a machine', async ({ browser }) => {
  const errors: string[] = [];
  const host = await open(browser, errors, 'host');
  const client = await open(browser, errors, 'client');
  const code = await createRoom(host);
  await joinByCode(client, code);
  await expect(host.locator('.chat-line.info')).toContainText(['joined'], { timeout: 10_000 });
  // a message with an emoji reaches the host
  await client.getByLabel('chat message').fill('hello 👋');
  await client.getByLabel('chat message').press('Enter');
  await expect(host.locator('.chat-line.say')).toContainText(['hello 👋'], { timeout: 5000 });
  // the client asks for a longer round and teams: it sees its requests marked, the host sees them in the chat
  const roundTime = client.locator('.setting', { hasText: 'Round time' });
  const before = await roundTime.locator('.val').textContent();
  await roundTime.getByRole('button', { name: 'next' }).click();
  await client.getByRole('switch', { name: 'Teams (white against red)' }).click();
  await expect(client.locator('.toast')).toContainText('Asked');
  await expect(client.locator('.asked-tag')).toHaveCount(2);
  const asks = host.locator('.chat-line.ask');
  await expect(asks).toHaveCount(2, { timeout: 5000 });
  await expect(asks.first()).toContainText('would like: Round time');
  // the host grants both: the client's rules are the host's again, with the changes
  for (let i = 0; i < 2; i++) await host.locator('.chat-line.ask').getByRole('button', { name: 'Apply' }).first().click();
  await expect(client.locator('.asked-tag')).toHaveCount(0, { timeout: 5000 });
  await expect(roundTime.locator('.val')).not.toHaveText(before!);
  await expect(client.locator('.chat-line.ask .granted')).toHaveCount(2);
  // teams are on: both see how many play for each side
  await expect(host.locator('.balance')).toBeVisible();
  await expect(client.locator('.balance')).toBeVisible();
  // the host removes the client: it is back on the Network Game screen, told why, and may not come back
  await host.getByRole('button', { name: /^remove .* from the game$/ }).click();
  await host.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(client.getByRole('heading', { name: 'Network Game' })).toBeVisible({ timeout: 10_000 });
  await expect(host.locator('.chat-line.info').last()).toContainText('was removed');
  await client.getByLabel('code letter 1').click();
  await client.keyboard.type(code.toLowerCase());
  await expect(client.locator('.toast')).toContainText('removed you from this game', { timeout: 15_000 });
  expect(errors).toEqual([]);
});

test('a machine dropped in the lobby comes back by itself; a 5 s stall during a round drops nobody', async ({ browser }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  const host = await open(browser, errors, 'host');
  const client = await open(browser, errors, 'client');
  const code = await createRoom(host);
  await joinByCode(client, code);
  await expect(host.locator('.chip', { hasText: 'ms' })).toHaveCount(1, { timeout: 15_000 });
  // the host gives up on the client (as after a long silence): the client gets back into the room
  await host.evaluate(() => {
    const n = (window as unknown as { __boombuds: { game: { menus: { net: { members: { id: number }[]; memberGone(id: number): void } } } } }).__boombuds.game.menus.net;
    n.memberGone(n.members[0].id);
  });
  const back = () =>
    client.evaluate(() => {
      const n = (window as unknown as { __boombuds: { game: { menus: { net: { reconnecting: boolean; members: { open: boolean }[] } } } } }).__boombuds.game.menus.net;
      return !n.reconnecting && n.members.length === 1 && n.members[0].open;
    });
  await expect.poll(back, { timeout: 20_000 }).toBe(true);
  await expect(host.locator('.chip', { hasText: 'ms' })).toHaveCount(1, { timeout: 15_000 });
  await expect(host.locator('.pcard', { hasText: 'Keyboard right' })).toHaveCount(2, { timeout: 10_000 });
  await host.waitForTimeout(1000);
  // a round: the client's page stalls for 5 s (a busy phone), both go on afterwards, in sync
  await startMatch(host, [host, client], errors);
  await host.waitForTimeout(1500);
  void client.evaluate(() => {
    const t = performance.now();
    while (performance.now() - t < 5000) {
      /* busy */
    }
  });
  // meanwhile the host says who everybody is waiting for
  await expect(host.getByText(/^Waiting for /)).toBeVisible({ timeout: 4000 });
  await host.waitForTimeout(5000);
  await expect(host.getByText(/^Waiting for /)).toHaveCount(0, { timeout: 5000 });
  const t0 = (await snap(host))!.tick;
  await host.waitForTimeout(1500);
  const a = await snap(host);
  const b = await snap(client);
  expect(a!.tick).toBeGreaterThan(t0 + 30);
  expect(b).not.toBeNull();
  expect(a?.desyncs ?? 0).toBe(0);
  expect(b?.desyncs ?? 0).toBe(0);
  const lost = await client.evaluate(() => (window as unknown as { __boombuds: { game: { menus: { net: { hostLost: boolean } } } } }).__boombuds.game.menus.net.hostLost);
  expect(lost).toBe(false);
  expect(errors).toEqual([]);
});
