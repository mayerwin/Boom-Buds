// Measure frame rate and main-thread CPU usage of the running game in a real (headed, GPU) Chrome.
//   node tools/dev/perf.ts [url] [seconds] [width] [height] [cpuThrottle]
// Reports: frames per second (rAF), frame time percentiles, main-thread busy % (CDP TaskDuration),
// script time, and GPU info.
import { chromium } from '@playwright/test';

const url = process.argv[2] ?? 'http://localhost:5173/?bench=1';
const seconds = Number(process.argv[3] ?? 20);
const width = Number(process.argv[4] ?? 1280);
const height = Number(process.argv[5] ?? 960);
/** CPU slow-down factor (4 ~ a mid-range phone) */
const throttle = Number(process.argv[6] ?? 1);

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--autoplay-policy=no-user-gesture-required', `--window-size=${width + 16},${height + 120}`],
});
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[console.${m.type()}] ${m.text()}`); });
await page.goto(url);
await page.waitForTimeout(4000);
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
const metric = async () => {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(metrics.map((m: { name: string; value: number }) => [m.name, m.value]));
};
await page.evaluate(() => {
  const w = window as unknown as { __ft: number[]; __last: number };
  w.__ft = [];
  w.__last = performance.now();
  const loop = (t: number) => {
    w.__ft.push(t - w.__last);
    w.__last = t;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
});
// CPU time of every Chrome process (browser, renderer, GPU, utilities), in seconds
const browserCdp = await browser.newBrowserCDPSession();
const procCpu = async () => {
  const { processInfo } = await browserCdp.send('SystemInfo.getProcessInfo');
  const by: Record<string, number> = {};
  for (const p of processInfo as { type: string; cpuTime: number }[]) by[p.type] = (by[p.type] ?? 0) + p.cpuTime;
  return by;
};
const c0 = await procCpu();
const m0 = await metric();
const t0 = Date.now();
await page.waitForTimeout(seconds * 1000);
const m1 = await metric();
const c1 = await procCpu();
const wall = (Date.now() - t0) / 1000;
const processCpuPct: Record<string, number> = {};
let cpuTotal = 0;
for (const k of Object.keys(c1)) {
  const d = c1[k] - (c0[k] ?? 0);
  processCpuPct[k] = +((d / wall) * 100).toFixed(1);
  cpuTotal += d;
}
processCpuPct.total = +((cpuTotal / wall) * 100).toFixed(1);
const ft: number[] = await page.evaluate(() => (window as unknown as { __ft: number[] }).__ft.slice(2));
ft.sort((a, b) => a - b);
const pct = (p: number) => ft[Math.min(ft.length - 1, Math.floor((p / 100) * ft.length))];
const gpu = await page.evaluate(() => {
  const c = document.createElement('canvas').getContext('webgl2');
  const ext = c?.getExtension('WEBGL_debug_renderer_info');
  return ext ? c!.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
});
console.log(JSON.stringify({
  url,
  seconds: wall,
  frames: ft.length,
  fps: +(ft.length / wall).toFixed(1),
  frameMs: { p50: +pct(50).toFixed(2), p95: +pct(95).toFixed(2), p99: +pct(99).toFixed(2), max: +ft[ft.length - 1].toFixed(2) },
  mainThreadBusyPct: +(((m1.TaskDuration - m0.TaskDuration) / wall) * 100).toFixed(1),
  scriptPct: +(((m1.ScriptDuration - m0.ScriptDuration) / wall) * 100).toFixed(1),
  layoutPct: +(((m1.LayoutDuration - m0.LayoutDuration) / wall) * 100).toFixed(2),
  processCpuPct,
  jsHeapMB: +(m1.JSHeapUsedSize / 1048576).toFixed(1),
  gpu,
  cpuThrottle: throttle,
}, null, 2));
await browser.close();
