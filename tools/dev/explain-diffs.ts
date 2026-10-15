// Dev utility: after replaying the capture scripts (tools/dev/replay-ref.ts, one output directory per
// script under <dir>), checks that every remaining pixel difference lies in a region with a known reason
// and prints how many shots each reason affects.
//   node tools/dev/explain-diffs.ts <dir>
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';

const dir = process.argv[2];
type R = [number, number, number, number]; // x0,y0,x1,y1 inclusive
const REGIONS: { why: string; test: RegExp; rects: R[] }[] = [
  { why: '"Internet" at the top of the network protocol list', test: /^protocol_list$/, rects: [[150, 150, 420, 300]] },
  { why: 'Return to default keys: the keyboard sets right and left as Boom Buds ships them', test: /^keydefs_after_msgbox$/, rects: [[100, 60, 639, 420]] },
  { why: 'version label V1.1 (the original says V1.0)', test: /^(menu_|exit_yesno|credits|helplist|manual|firstrun)/, rects: [[0, 0, 49, 15]] },
  { why: 'main-menu cursor bomb (animation phase)', test: /^(menu_|helplist|exit_yesno|credits|manual)/, rects: [[310, 100, 352, 370]] },
  { why: 'menu dude cursor (blink phase)', test: /^(settings|setup|options|nodename|modem|protocol|memmodel|schemes|keydefs|problem|campaign)/, rects: [[18, 30, 66, 470]] },
  { why: '"Gold Bud" settings row (rebranded text)', test: /^(settings|nodename|modem|protocol|memmodel|schemes|keydefs)/, rects: [[107, 173, 231, 186]] },
  { why: '"Buds \'93" scheme name', test: /^schemes/, rects: [[230, 125, 374, 165]] },
  { why: 'memory-model question mentions Boom Buds', test: /^memmodel/, rects: [[252, 227, 553, 243]] },
  // KEY 0 -> Right -> the original's screenshot still shows KEY 0 (the next Right lands on OFF as the cycle says)
  { why: 'capture taken before the key took effect', test: /^setup_team_p1_key1$/, rects: [[184, 171, 200, 184]] },
  { why: '"AI n" skill labels', test: /^(setup|problem|campaign)/, rects: [[175, 165, 205, 410]] },
  { why: 'how to set the skill of a computer player (hint under the joystick list)', test: /^(setup|problem|campaign)/, rects: [[310, 395, 639, 420]] },
  { why: 'level preview (random bricks)', test: /^options/, rects: [[380, 82, 599, 279]] },
  { why: 'rebranded credits / manual text', test: /^(credits|manual)/, rects: [[40, 40, 600, 440]] },
  { why: 'in-round content (random layout, AI play)', test: /^(round|campaign_round)/, rects: [[0, 0, 639, 479]] },
  { why: 'debug window: browser memory figures', test: /altd_debug/, rects: [[219, 171, 442, 264]] },
  { why: '"Boom Buds Level Editor" title', test: /^editor/, rects: [[190, 11, 448, 24]] },
  { why: 'GNW cursor sticking out of the screen corner (text input)', test: /^(nodename|modem)/, rects: [[636, 476, 639, 479]] },
  // cnc-ddraw sometimes presented the final cursor blit late (caps/ref README, "Known capture artefacts")
  { why: 'capture lag: cursor drawn one step late', test: /^(editor|settings_nodename)/, rects: [[636, 476, 639, 479], [46, 69, 46, 72], [236, 415, 247, 425]] },
];
const unexplained: string[] = [];
const reasons = new Map<string, number>();
let shots = 0, identical = 0;
for (const run of readdirSync(dir)) {
  const specFile = join(dir, run, 'spec.json');
  if (!existsSync(specFile)) continue;
  for (const c of JSON.parse(readFileSync(specFile, 'utf8')) as { name: string; ref: string; web: string }[]) {
    const a = PNG.sync.read(readFileSync(c.ref));
    const b = PNG.sync.read(readFileSync(c.web));
    shots++;
    const regs = REGIONS.filter((r) => r.test.test(c.name));
    let diff = 0, bad = 0;
    const used = new Set<string>();
    let bx0 = 1e9, by0 = 1e9, bx1 = -1, by1 = -1;
    for (let y = 0; y < 480; y++) for (let x = 0; x < 640; x++) {
      const i = (y * 640 + x) * 4;
      if (a.data[i] === b.data[i] && a.data[i + 1] === b.data[i + 1] && a.data[i + 2] === b.data[i + 2]) continue;
      diff++;
      const r = regs.find((g) => g.rects.some(([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1));
      if (r) used.add(r.why);
      else { bad++; bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x); by1 = Math.max(by1, y); }
    }
    if (!diff) identical++;
    for (const u of used) reasons.set(u, (reasons.get(u) ?? 0) + 1);
    if (bad) unexplained.push(`${run}/${c.name}: ${bad} px in [${bx0},${by0}]-[${bx1},${by1}]`);
  }
}
console.log(`${shots} shots, ${identical} identical`);
for (const [k, v] of reasons) console.log(`  ${v} shots: ${k}`);
console.log(`unexplained (${unexplained.length}):`);
for (const u of unexplained) console.log('  ' + u);
