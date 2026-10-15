// Dev utility: replay a capture script of the original game (scratchpad caps/ref/scripts) on the web
// version and compare every shot with the original's.
//   node tools/dev/replay-ref.ts <ref-dir> <script-name> <outdir> [url]
// The web game gets the capture's options (options.ini of the game copy, node name "TNT") and the GLUE
// backgrounds the original happened to pick (detected from the reference shots, in order).
// REPLAY_ORIGINAL_PICTURES=<dir>: the game shows the pictures of that directory instead of its own, e.g. the
// unbranded ones from `node tools/extract.ts --no-brand --only screens --out <x>` (<x>/screens).
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { PNG } from 'pngjs';

const [refDir, scriptName, outDir, url = 'http://localhost:5173/'] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

function expand(name: string): string[] {
  const lines = readFileSync(join(refDir, 'scripts', name), 'utf8').split(/\r?\n/);
  const out: string[] = [];
  let skipReturn = false;
  let mx = 319, my = 239;
  for (const raw of lines) {
    const l = raw.trim();
    if (!l || l.startsWith('#')) continue;
    const [cmd, ...a] = l.split(/\s+/);
    // Boom Buds has no publisher logos: everything before the title picture is replaced by a short wait
    if (cmd === 'start') {
      skipReturn = true;
      continue;
    }
    if (skipReturn) {
      if (cmd === 'shot' && /title$/.test(a[0])) {
        skipReturn = false;
        out.push('wait 2500', l);
      }
      continue;
    }
    if (cmd === 'burst' && a[0] === 'boot') continue;
    if (cmd === 'include') {
      if (a[0] === 'boot_to_menu.inc') out.push('wait 2500', 'key RETURN', 'wait 1500');
      else out.push(...expand(a[0]));
    } else if (cmd === 'settle') out.push('wait 2700');
    else if (cmd === 'waitref') out.push('wait 1500');
    else if (['quit', 'frames', 'focus', 'burstuntil'].includes(cmd)) continue;
    else if (cmd === 'mmove') {
      // relative motion
      mx += Number(a[0]);
      my += Number(a[1]);
      out.push(`mpos ${mx} ${my}`);
    } else if (cmd === 'mpos') {
      mx = Number(a[0]);
      my = Number(a[1]);
      out.push(l);
    }
    else out.push(l);
  }
  return out;
}

// GLUE backgrounds used by the original, in order of appearance
const pal = readFileSync('public/data/palette.bin');
const origPictures = process.env.REPLAY_ORIGINAL_PICTURES;
const glueFile = (k: number) => {
  const f = origPictures ? join(origPictures, `GLUE${k}.bin.gz`) : '';
  return f && existsSync(f) ? f : `public/data/screens/GLUE${k}.bin.gz`;
};
const glues = Array.from({ length: 7 }, (_, k) => gunzipSync(readFileSync(glueFile(k))));
function glueOf(file: string): number {
  const img = PNG.sync.read(readFileSync(file));
  let best = -1, bestN = 0;
  glues.forEach((g, k) => {
    let n = 0;
    for (let i = 0; i < 640 * 480; i += 7) {
      const c = g[i];
      if (img.data[i * 4] === (pal[c * 3] & 63) << 2 && img.data[i * 4 + 1] === (pal[c * 3 + 1] & 63) << 2 && img.data[i * 4 + 2] === (pal[c * 3 + 2] & 63) << 2) n++;
    }
    if (n > bestN) { bestN = n; best = k; }
  });
  return bestN > (640 * 480) / 7 * 0.5 ? best : -1;
}

// the capture library renamed some shots with a screen prefix (e.g. settings_nodename_initial) and gave
// shots that exist in several runs the run id as suffix (setup_noteam_default_r3); a few were renamed after
// what they show (keys: shot name, or "<run>:<shot>"; '' = this run has no reference for the shot)
const refFiles = readdirSync(refDir).filter((f) => f.endsWith('.png'));
const runId = scriptName.split('_')[0];
const ALIASES: Record<string, string> = {
  settings_teamplay_off_for_setup: 'settings_teamplay_off',
  // r2 pressed Right six times: past "Infinite" back to 1:00
  'r2:settings_playtime_infinite': 'settings_playtime_wrap_60',
  // the file is the R10a recapture, made from a different main-menu position
  'r1:helplist_sel5': '',
  // kept from r4 only (r3's own shots were not saved)
  'r3:problem_need_two_players': '',
  'r3:setup_noteam_all_ai': '',
  // the files of these names come from the goldman runs (R4b/R4c); r4 had no roulette
  'r4:roulette_result': '',
  'r4:setup_after_roulette': '',
};
function refFor(shot0: string): string | null {
  const shot = ALIASES[`${runId}:${shot0}`] ?? ALIASES[shot0] ?? shot0;
  if (!shot) return null;
  if (existsSync(join(refDir, `${shot}_${runId}.png`))) return join(refDir, `${shot}_${runId}.png`);
  if (existsSync(join(refDir, `${shot}.png`))) return join(refDir, `${shot}.png`);
  const m = refFiles.filter((f) => f.toLowerCase().endsWith(`_${shot.toLowerCase()}.png`));
  return m.length === 1 ? join(refDir, m[0]) : null;
}

// runs that show behaviour Boom Buds replaces on purpose (docs/DIFFERENCES.md)
const NOT_COMPARABLE: Record<string, string> = {
  r5a: 'the original with networking switched off (CFG.INI netonoff=0); Boom Buds always offers network play',
  r5b: 'the IPX / modem / serial protocol prompt; Boom Buds connects with WebRTC',
};
if (NOT_COMPARABLE[runId]) {
  console.log(`${scriptName}: not comparable - ${NOT_COMPARABLE[runId]}`);
  process.exit(0);
}
// r7 lost synchronisation after the help list: its later shots are not comparable (r7b has those names)
const LAST_VALID: Record<string, string> = { r7: 'helplist_dragged' };

const script = expand(scriptName);
const shots = script.filter((l) => l.startsWith('shot ')).map((l) => l.split(/\s+/)[1]);
const lastValid = LAST_VALID[runId] ? shots.indexOf(LAST_VALID[runId]) : shots.length - 1;
// one GLUE per screen visit: a new visit whenever the screen (from the shot's name) changes
const screenOf = (n: string): string => {
  if (/^(settings|keydefs|nodename|schemes|modem|protocol|memmodel)/.test(n)) return 'settings';
  if (/^(setup|problem|campaign_list|campaign_activated|campaign_setup)/.test(n)) return 'setup';
  if (/^options/.test(n)) return 'options';
  // the editor menu draws a glue and the scheme editor another one (the menu keeps it after leaving)
  if (/^editor_(menu$|scheme_list)/.test(n)) return 'editor_menu';
  if (/^editor/.test(n)) return 'editor_scheme';
  if (/^net/.test(n)) return 'net';
  return 'other';
};
const visits: { screen: string; glue: number }[] = [];
for (const s of shots) {
  const scr = screenOf(s);
  const last = visits[visits.length - 1];
  if (!last || last.screen !== scr) {
    // the scheme editor is entered from the editor menu, which may not have been captured
    if (scr === 'editor_scheme' && last?.screen !== 'editor_menu') visits.push({ screen: 'editor_menu', glue: -1 });
    visits.push({ screen: scr, glue: -1 });
  }
  const v = visits[visits.length - 1];
  if (scr === 'other' || v.glue >= 0) continue;
  const f = refFor(s);
  if (f) v.glue = glueOf(f);
}
// -1 = not captured: the web version picks a random one
const queue = visits.filter((v) => v.screen !== 'other').map((v) => v.glue);
const settings = {
  levelno: -1, num_to_win_match: 3, enclosement_depth: 2, conveyor_speed: 1, team_play: 1, random_start: 1,
  stomped_bombs_detonate: 1, win_by_kills: 0, goldman: 0, schemefilename: 'BASIC.SCH', playtime: 150,
  assign_keyboards: 1, diseases_destroyable: 1, lost_net_revert_ai: 0, disable_game_music: 0, nodename: 'TNT',
  modemport: 2, modembaud: 19200, modemirq: 3, modemdial: '555-1212', netprotocol: 1, smallmemory: 0,
  // rounds at the original's speed only
  fastForward: 0,
  // the copy's options.ini: KEY 0 = arrows with '.' and ',' as actions, KEY 1 = R G F D with S and A (the original
  // menus' layouts are the keyboard sets right and left, src/app/controls.ts)
  controls: {
    sets: [
      { id: 'kb-arrows', name: 'Keyboard right', kind: 'keys', keys: ['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'Period', 'Comma'], builtin: true },
      { id: 'kb-esdf', name: 'Keyboard left', kind: 'keys', keys: ['KeyR', 'KeyG', 'KeyF', 'KeyD', 'KeyS', 'KeyA'], builtin: true },
    ],
  },
};
// per-run options.ini changes are noted in the script's header ("options.ini overrides: k=v ...")
const header = readFileSync(join(refDir, 'scripts', scriptName), 'utf8').split(/\r?\n/)[0];
const ov = /options\.ini overrides:(.*)$/.exec(header);
if (ov) {
  for (const kv of ov[1].trim().split(/\s+/)) {
    const [k, v] = kv.split('=');
    (settings as Record<string, unknown>)[k] = /^-?\d+$/.test(v) ? Number(v) : v;
  }
}
if (/netprotocol=0/.test(header)) (settings as Record<string, unknown>).netprotocol = 0;
const prelude = `eval (() => { const g = window.__boombuds.game; Object.assign(g.settings, ${JSON.stringify(settings)}); g.ui.glueQueue = ${JSON.stringify(queue)}; return 'prelude ok'; })()`;
const webScript = join(outDir, `${scriptName}.web.txt`);
writeFileSync(webScript, ['wait 300', prelude, ...script].join('\n'));
console.log(`glue queue ${JSON.stringify(queue)}, ${shots.length} shots`);
const r = spawnSync(process.execPath, ['tools/dev/drive.ts', webScript, outDir, url], {
  stdio: 'inherit',
  env: { ...process.env, DRIVE_CLASSIC: '1', ...(origPictures ? { DRIVE_SCREENS_DIR: origPictures } : {}) },
});
if (r.status !== 0) process.exit(r.status ?? 1);
const spec = shots
  .slice(0, lastValid + 1)
  .map((s) => ({ name: s, ref: refFor(s), web: join(outDir, `${s}.png`) }))
  .filter((c) => c.ref && existsSync(c.web));
writeFileSync(join(outDir, 'spec.json'), JSON.stringify(spec, null, 1));
spawnSync(process.execPath, ['tools/dev/compare.ts', join(outDir, 'spec.json'), join(outDir, 'diff')], { stdio: 'inherit' });
