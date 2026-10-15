// Dev utility: how network games hold up under latency, jitter and loss. Two machines (isolated pages) meet
// on the local server's relay, both with simulated network conditions (?netsim, src/net/mesh.ts), and play a
// round with random input; each condition reports the frame rate, the game speed, the rollbacks and stalls,
// how often the other player's bomber visibly jumps (corrections) and whether the simulations stayed equal.
//   node tools/dev/netlag.ts <url> <seconds> <latency,jitter,loss%>...    e.g. 0,0,0 50,10,1 100,20,2
import { chromium, type Page } from '@playwright/test';

const [url = 'http://localhost:8080/', secs = '20', ...conds] = process.argv.slice(2);
const seconds = Number(secs);
const conditions = conds.length ? conds : ['0,0,0', '50,10,1', '100,20,2'];

type Stats = { tick: number; hash: number; desyncs: number; net: { rollbacks: number; maxRollback: number; stalls: number } } | null;

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });

async function open(cond: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 720 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
  await page.goto(`${url}${url.includes('?') ? '&' : '?'}netsim=${cond}`);
  return page;
}

const stats = (p: Page): Promise<Stats> =>
  p.evaluate(() => {
    const r = (window as unknown as { __boombuds: { game: { runner: { s: { tick: number }; hash(): number; desyncs: number; netStats(): unknown } | null } } }).__boombuds.game.runner;
    return r ? ({ tick: r.s.tick, hash: r.hash(), desyncs: r.desyncs, net: r.netStats() } as never) : null;
  });

/** Records every display frame: its duration, the tick, and where the other machine's bomber is. */
async function watch(p: Page, other: number): Promise<void> {
  await p.evaluate((slot) => {
    const w = window as unknown as { __lag: { dt: number[]; pos: [number, number, number][]; run: number; runTicks: number }; __boombuds: { game: { runner: { s: { tick: number; roundOver: number; players: { x: number; y: number }[] } } | null } } };
    w.__lag = { dt: [], pos: [], run: 0, runTicks: 0 };
    (w.__lag as unknown as { drawn: number[][] }).drawn = [];
    let last = performance.now();
    let lastTick = -1;
    const loop = (t: number) => {
      const dt = t - last;
      w.__lag.dt.push(dt);
      last = t;
      const r = w.__boombuds.game.runner;
      if (r) {
        w.__lag.pos.push([r.s.tick, r.s.players[slot].x, r.s.players[slot].y]);
        // where the bomber is drawn (network games ease corrections: GameRenderer.easeOffsets)
        // (as of the last picture: the place and offset it was drawn with)
        const e = (r as unknown as { gr: { ease: { x: number; y: number; tick: number; ox: number; oy: number }[] } }).gr.ease[slot];
        if (e) (w.__lag as unknown as { drawn: number[][] }).drawn.push([e.tick, e.x + Math.round(e.ox), e.y + Math.round(e.oy)]);
        // game speed: ticks played per display time while the round runs
        if (!r.s.roundOver && lastTick >= 0) {
          w.__lag.run += dt;
          w.__lag.runTicks += r.s.tick - lastTick;
        }
        lastTick = r.s.tick;
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }, other);
}

async function report(p: Page, name: string, wall: number, t0: number, s0: Stats): Promise<void> {
  const lag = await p.evaluate(() => (window as unknown as { __lag: { dt: number[]; pos: [number, number, number][]; run: number; runTicks: number } }).__lag);
  const s1 = await stats(p);
  const rtt = await p.evaluate(() => {
    const n = (window as unknown as { __boombuds: { game: { session: { net: { maxRtt(): number } | null } } } }).__boombuds.game.session.net;
    return n ? Math.round(n.maxRtt()) : -1;
  });
  const dt = lag.dt.slice(5).sort((a, b) => a - b);
  const pct = (q: number) => dt[Math.min(dt.length - 1, Math.floor(q * dt.length))] ?? 0;
  // a visible jump: the other bomber moves more in one frame than it can walk in the ticks that passed (+ slack)
  // the same jumps, as drawn
  const drawn = (lag as unknown as { drawn: [number, number, number][] }).drawn ?? [];
  let djumps = 0;
  let dworst = 0;
  for (let i = 1; i < drawn.length; i++) {
    const [ta, xa, ya] = drawn[i - 1];
    const [tb, xb, yb] = drawn[i];
    const d = Math.abs(xb - xa) + Math.abs(yb - ya);
    if (tb >= ta && d > Math.max(1, tb - ta) * 4 + 2) {
      djumps++;
      dworst = Math.max(dworst, d);
    }
  }
  let jumps = 0;
  let worst = 0;
  for (let i = 1; i < lag.pos.length; i++) {
    const [ta, xa, ya] = lag.pos[i - 1];
    const [tb, xb, yb] = lag.pos[i];
    const d = Math.abs(xb - xa) + Math.abs(yb - ya);
    const allowed = Math.max(1, tb - ta) * 4 + 2;
    if (tb >= ta && d > allowed) {
      jumps++;
      worst = Math.max(worst, d);
    }
  }
  const rb = (s1?.net.rollbacks ?? 0) - (s0?.net.rollbacks ?? 0);
  const speed = lag.run > 0 ? (lag.runTicks / (lag.run / 1000) / 60) * 100 : 0;
  console.log(
    `  ${name.padEnd(6)} fps ${(lag.dt.length / wall).toFixed(0).padStart(3)} | frame p99 ${pct(0.99).toFixed(0).padStart(3)} ms max ${pct(1).toFixed(0).padStart(4)} ms` +
      ` | game speed ${speed.toFixed(0).padStart(3)} %${lag.run / 1000 < wall * 0.9 ? ` (round over after ${(lag.run / 1000).toFixed(0)} s)` : ''} | rollbacks ${(rb / wall).toFixed(1).padStart(4)}/s max ${s1?.net.maxRollback ?? '?'}` +
      ` | stalls ${(s1?.net.stalls ?? 0) - (s0?.net.stalls ?? 0)} | jumps ${(jumps / wall).toFixed(1)}/s (worst ${worst}), drawn ${(djumps / wall).toFixed(1)}/s (worst ${dworst}) | rtt ${rtt} ms | desyncs ${s1?.desyncs ?? '?'}`,
  );
}

for (const cond of conditions) {
  const [latency, jitter, loss] = cond.split(',');
  console.log(`one-way delay ${latency} ms, jitter ${jitter ?? 0} ms, loss ${loss ?? 0} % (both ways)`);
  const host = await open(cond);
  const client = await open(cond);
  await host.getByRole('button', { name: /Network Game/ }).click();
  await host.getByRole('button', { name: 'Create a game' }).click();
  await host.waitForSelector('.code-big', { timeout: 20_000 });
  const code = (await host.locator('.code-big').textContent())!;
  await client.getByRole('button', { name: /Network Game/ }).click();
  await client.getByLabel('code letter 1').click();
  await client.keyboard.type(code.toLowerCase());
  await client.waitForSelector('.code-big', { timeout: 30_000 });
  // both players in the host's line-up, then two people only, walking around without bombs: the round lasts
  // the whole measurement
  for (let i = 0; i < 300 && (await host.locator('.pcard', { hasText: 'Keyboard right' }).count()) < 2; i++) await host.waitForTimeout(100);
  const remove = host.getByRole('button', { name: 'remove computer player' });
  for (let n = await remove.count(); n > 0; n--) {
    await remove.first().click();
    for (let i = 0; i < 50 && (await remove.count()) >= n; i++) await host.waitForTimeout(100);
  }
  await host.getByRole('button', { name: 'Start ▶' }).click();
  for (let i = 0; i < 150 && !((await stats(host)) && (await stats(client))); i++) await host.waitForTimeout(100);
  await host.waitForTimeout(2500); // the round's start
  await watch(host, 1);
  await watch(client, 0);
  const [h0, c0] = [await stats(host), await stats(client)];
  const t0 = Date.now();
  const dirs = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
  while (Date.now() - t0 < seconds * 1000) {
    for (const p of [host, client]) {
      const d = dirs[Math.floor(Math.random() * 4)];
      await p.keyboard.down(d);
      setTimeout(() => void p.keyboard.up(d).catch(() => {}), 200 + Math.random() * 400);
    }
    await host.waitForTimeout(300);
  }
  const wall = (Date.now() - t0) / 1000;
  await report(host, 'host', wall, h0?.tick ?? 0, h0);
  await report(client, 'client', wall, c0?.tick ?? 0, c0);
  await host.waitForTimeout(700); // the last keys are let go
  await host.context().close();
  await client.context().close();
}
await browser.close();
