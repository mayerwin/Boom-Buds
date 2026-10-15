// Dev utility: generate one picture with the Antigravity CLI (agy, Google Nano Banana 2), the same way as
// the Comic-Generator project's agy backend (proxy for Google's location gate, sandboxed CLI, output found
// in the conversation's brain directory). Used to draft menu artwork.
//   node tools/dev/agy-image.mjs <out.png> <aspect 16:9|1:1|4:3|3:2|...> "<prompt>" [reference images (max 3)]
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import net from 'node:net';

const [out, aspect, prompt, ...refs] = process.argv.slice(2);
if (!out || !aspect || !prompt) {
  console.error('usage: node tools/dev/agy-image.mjs <out.png> <aspect> "<prompt>" [refs...]');
  process.exit(1);
}
const bin = process.env.AGY_BIN_PATH || join(process.env.LOCALAPPDATA ?? '', 'agy', 'bin', 'agy.exe');
const portOpen = (port) =>
  new Promise((res) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.setTimeout(400);
    s.once('connect', () => { s.destroy(); res(true); });
    s.once('error', () => res(false));
    s.once('timeout', () => { s.destroy(); res(false); });
  });
const env = { ...process.env };
if (await portOpen(10809)) {
  Object.assign(env, { ALL_PROXY: 'socks5://127.0.0.1:10808', HTTP_PROXY: 'http://127.0.0.1:10809', HTTPS_PROXY: 'http://127.0.0.1:10809', NO_PROXY: '127.0.0.1,localhost' });
  console.log('using the house proxy on 10808/10809');
}
const slashed = (p) => resolve(p).split('\\').join('/');
const refClause = refs.length ? ` and ImagePaths: [${refs.map((p) => `"${slashed(p)}"`).join(', ')}]` : '';
const instruction = `Use your generate_image tool exactly once, passing AspectRatio: "${aspect}"${refClause}: ${prompt} Then reply with the file name only. Do not run any shell command and do not edit any file on disk.`;
const t0 = Date.now();
const child = spawn(bin, ['-p', instruction, '--output-format', 'json', '--model', process.env.AGY_DRIVER_MODEL || 'gemini-3.8-flash-low', '--print-timeout', '10m', '--disable-slash-commands', '--sandbox'], { windowsHide: true, env });
let stdout = '';
let stderr = '';
child.stdout.on('data', (d) => (stdout += d));
child.stderr.on('data', (d) => (stderr += d));
child.on('exit', (code) => {
  let envelope = {};
  for (const line of stdout.trim().split('\n').reverse()) {
    const l = line.trim();
    if (l.startsWith('{') && l.endsWith('}')) {
      try {
        envelope = JSON.parse(l);
        break;
      } catch {
        /* earlier line */
      }
    }
  }
  let found = null;
  const m = /Generated image is saved at\s+([^\r\n]+?\.(?:png|jpe?g|webp))/i.exec(stdout);
  if (m && existsSync(m[1].trim())) found = m[1].trim();
  if (!found && envelope.conversation_id) {
    for (const base of ['antigravity-cli', 'antigravity-ide']) {
      const dir = join(homedir(), '.gemini', base, 'brain', envelope.conversation_id);
      if (!existsSync(dir)) continue;
      const files = readdirSync(dir)
        .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
        .map((f) => join(dir, f))
        .filter((p) => statSync(p).mtimeMs >= t0 - 1000)
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
      if (files.length) {
        found = files[0];
        break;
      }
    }
  }
  if (found) {
    copyFileSync(found, out);
    console.log(`OK ${out} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  } else {
    console.log('FAILED, exit code', code);
    console.log('response:', String(envelope.response ?? envelope.error ?? '').slice(0, 800));
    console.log('stderr:', stderr.slice(-800));
    process.exitCode = 1;
  }
});
