// Starts Boom Buds on this computer: installs the dependencies when needed, builds the game when its sources
// changed since the last build, then serves it with the local server (server/lan-server.ts) and opens the
// browser. Launch.bat runs this on Windows; anywhere else: npm start.
//
//   node tools/launch.ts [--dev] [--rebuild] [--no-open] [--port N]
//     --dev       the development server instead (live reload on every change, port 5173)
//     --rebuild   build even if the last build looks current
//     --no-open   do not open a browser window
//     --port N    serve on port N (default 8080, or the next free one)

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const has = (flag: string) => args.includes(flag);
const portArg = args[args.indexOf('--port') + 1];
const port = has('--port') && Number(portArg) > 0 ? Number(portArg) : undefined;
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(cmd: string, cmdArgs: string[]): void {
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

/** Newest modification time of the files under the given paths. */
function newest(paths: string[]): number {
  let t = 0;
  const visit = (p: string) => {
    if (!existsSync(p)) return;
    const st = statSync(p);
    if (st.isDirectory()) for (const name of readdirSync(p)) visit(join(p, name));
    else t = Math.max(t, st.mtimeMs);
  };
  for (const p of paths) visit(join(ROOT, p));
  return t;
}

const mtime = (p: string) => (existsSync(join(ROOT, p)) ? statSync(join(ROOT, p)).mtimeMs : 0);

// dependencies: first launch, or package-lock.json changed since the last install (e.g. after a git pull)
if (mtime('package-lock.json') > mtime('node_modules/.package-lock.json')) {
  console.log('Installing what Boom Buds needs (first launch, or after an update)...');
  run(npm, ['ci', '--no-audit', '--no-fund']);
}

if (has('--dev')) {
  const devArgs = ['run', 'dev', '--'];
  if (!has('--no-open')) devArgs.push('--open');
  if (port) devArgs.push('--port', String(port));
  run(npm, devArgs);
  process.exit(0);
}

const sources = ['src', 'public', 'index.html', 'vite.config.ts', 'tools/build', 'package-lock.json'];
if (has('--rebuild') || newest(sources) > mtime('dist/index.html')) {
  console.log('Building the game...');
  run(npm, ['run', 'build']);
}

const server = spawn(process.execPath, [join(ROOT, 'server', 'lan-server.ts'), ...(has('--no-open') ? [] : ['--open'])], {
  cwd: ROOT,
  stdio: 'inherit',
  env: port ? { ...process.env, PORT: String(port) } : process.env,
});
server.on('exit', (code) => process.exit(code ?? 0));
