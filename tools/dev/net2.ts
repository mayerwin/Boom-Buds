// Dev utility: a two-machine network game in one Chrome (two isolated pages) through the modern menus.
// The host creates a game; the client finds it in "Games on your network" (or, with --code, types the
// room code); both play a round with random inputs; the tool compares the two simulations and prints the
// connection route (host-to-host candidates = a direct path).
//   node tools/dev/net2.ts [url] [outdir] [seconds] [--code]
// Use ?relay=local in the url to meet on the dev server instead of the public relays; pages of the local server
// (npm start) meet through it unless the url says ?relay=public.
import { chromium, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const byCode = process.argv.includes('--code');
const url = args[0] ?? 'http://localhost:5173/';
const out = args[1] ?? 'tmp/net2';
const seconds = Number(args[2] ?? 10);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
async function open(name: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[${name}.${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => console.log(`[${name}.pageerror] ${e.message}`));
  await page.goto(url);
  return page;
}
const shot = (p: Page, name: string) => p.screenshot({ path: join(out, `${name}.png`) });
const state = (p: Page) =>
  p.evaluate(() => {
    const r = (window as unknown as { __boombuds: { game: { runner: { hash(): number; s: { tick: number }; netStats(): unknown; desyncs: number } | null } } }).__boombuds.game.runner;
    return r ? { tick: r.s.tick, hash: r.hash(), desyncs: r.desyncs, net: r.netStats() } : null;
  });

const t0 = Date.now();
const host = await open('host');
const client = await open('client');
await host.getByRole('button', { name: /Network Game/ }).click();
await client.getByRole('button', { name: /Network Game/ }).click();
const create = host.getByRole('button', { name: 'Create a game' });
await create.waitFor();
for (let i = 0; i < 200 && !(await create.isEnabled()); i++) await host.waitForTimeout(50);
await create.click();
await host.waitForSelector('.code-big', { timeout: 20_000 });
const code = (await host.locator('.code-big').textContent())!;
console.log(`room ${code} after ${Date.now() - t0} ms`);
const tj = Date.now();
if (byCode) {
  await client.getByLabel('code letter 1').click();
  await client.keyboard.type(code.toLowerCase());
} else {
  await client.waitForSelector('.game-item', { timeout: 20_000 });
  console.log(`listed on the network after ${Date.now() - tj} ms`);
  await client.locator('.game-item button').first().click();
}
await client.waitForSelector('.code-big', { timeout: 20_000 });
console.log(`client in the lobby after ${Date.now() - tj} ms`);
await host.waitForTimeout(1000);
await shot(host, 'host_lobby');
await shot(client, 'client_lobby');
await host.getByRole('button', { name: 'Start ▶' }).click();
for (let i = 0; i < 100 && !((await state(host)) && (await state(client))); i++) await host.waitForTimeout(100);
await shot(host, 'host_game');
// random play on both machines
const dirs = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
const tp = Date.now();
let i = 0;
while (Date.now() - tp < seconds * 1000) {
  for (const p of [host, client]) {
    const d = dirs[Math.floor(Math.random() * 4)];
    await p.keyboard.down(d);
    if (Math.random() < 0.3) await p.keyboard.press('Period');
    setTimeout(() => void p.keyboard.up(d), 150 + Math.random() * 300);
  }
  await host.waitForTimeout(250);
  if (++i % 8 === 0) console.log('host', JSON.stringify(await state(host)), 'client', JSON.stringify(await state(client)));
}
await shot(host, 'host_game2');
await shot(client, 'client_game2');
console.log('final host', JSON.stringify(await state(host)));
console.log('final client', JSON.stringify(await state(client)));
// the ICE candidate pair the connection uses (host candidates = direct LAN path)
console.log('host route', JSON.stringify(await host.evaluate(async () => {
  const bb = (window as unknown as { __boombuds: { game: { session: { net: { mesh: { peers: Map<number, { pc: RTCPeerConnection }> } } | null } } } }).__boombuds;
  const routes: unknown[] = [];
  for (const p of bb.game.session.net?.mesh.peers.values() ?? []) {
    const stats = await p.pc.getStats();
    const all = new Map<string, Record<string, unknown>>();
    stats.forEach((v) => all.set(v.id, v));
    for (const v of all.values()) {
      if (v.type === 'transport' && v.selectedCandidatePairId) {
        const pair = all.get(String(v.selectedCandidatePairId))!;
        const l = all.get(String(pair.localCandidateId));
        const r = all.get(String(pair.remoteCandidateId));
        routes.push({ local: `${l?.candidateType} ${l?.address ?? ''}:${l?.port}`, remote: `${r?.candidateType} ${r?.address ?? ''}:${r?.port}`, rttMs: Number(pair.currentRoundTripTime) * 1000 });
      }
    }
  }
  return routes;
})));
await browser.close();
